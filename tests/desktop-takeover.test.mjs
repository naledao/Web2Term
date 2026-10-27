// User-run only. Actual coordinator, task checkpoint and runtime methods with synthetic IO.
// No Electron, native process, OS input, external network or real user database.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { fixture, deferred, shared, recovery, diagnostics, plain } from './fixtures/computer-action-runtime.mjs'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const desktopExports = {}
new Script(compile(readFileSync(new URL('../src/main/desktop-coordinator.ts', import.meta.url), 'utf8'))).runInNewContext({ exports: desktopExports })
const owner = { sessionId: 'session-a', platformId: 'deepseek', conversationId: 'chat-a', taskId: 'goal-a', generation: 1, machineId: 'machine-a' }
const admission = (desktop, value = owner) => desktop.acquire({ owner: value, kind: 'desktop', signal: new AbortController().signal,
  current: () => true, eligible: () => true, keep: () => true })

test('human control blocks other queued goals even after the original executor drains; only explicit continuation opens it', async () => {
  const desktop = new desktopExports.DesktopCoordinator(), first = await admission(desktop)
  let granted = false
  const next = admission(desktop, { ...owner, taskId: 'goal-b', sessionId: 'session-b' }).then(permit => { granted = true; return permit })
  assert.equal(desktop.takeHumanControl({ ...owner, generation: 0 }), false)
  assert.equal(desktop.takeHumanControl(owner), true)
  assert.equal(desktop.authorizes(first, owner, 'desktop'), false)
  assert.equal(desktop.releaseHumanControl(), false)
  first.release(); await new Promise(setImmediate)
  assert.equal(desktop.getState().humanControl, true); assert.equal(granted, false)
  desktop.setNativeBlocked(true); assert.equal(desktop.releaseHumanControl(), false)
  desktop.setNativeBlocked(false); await new Promise(setImmediate); assert.equal(granted, false)
  assert.equal(desktop.releaseHumanControl(), true)
  const second = await next; assert.equal(granted, true); second.release(); desktop.dispose()
})

test('input pause checkpoint retains original requirements, late effects and explicit fresh-generation recovery', async t => {
  const held = deferred(), f = fixture(t, { action: 'click', parameters: {}, execute: () => held.promise })
  const lease = f.lease(), runningRequest = f.request(); f.loop.enqueue(runningRequest)
  const running = f.loop.wake()
  for (let n = 0; n < 10 && !f.executions.length; n++) await new Promise(setImmediate)
  f.coordinator.stop('deepseek', 'stopped', 'input-paused')
  held.resolve({ type: 'computer_result', version: 1, action: 'click', ok: false, execution: 'executed', code: 'human_paused', message: 'Actual receipt' })
  await running
  const paused = JSON.parse(f.payload())
  assert.equal(paused.stop.reason, 'input-paused'); assert.equal(paused.status, 'stopped')
  assert.ok(shared.parseAutonomousTask(f.payload())); assert.equal(f.coordinator.owns(lease), false)
  assert.equal(f.state().execution_fact, 'executed'); assert.equal(f.sends.length, 0)
  const summary = recovery.computerRecoveryMessage(paused, f.store.listComputerActions(lease, 33))
  assert.equal(JSON.parse(summary.slice(summary.indexOf('\n') + 1)).pause_reason, 'human_paused')
  const resumed = f.submit({ resume: { taskId: paused.id, generation: paused.generation } })
  assert.equal(resumed.generation, paused.generation + 1); assert.equal(resumed.stop, undefined)
  assert.equal(resumed.originalRequest, f.first.originalRequest); assert.deepEqual(plain(resumed.inputs.slice(0, f.first.inputs.length)), plain(f.first.inputs))
  assert.equal(resumed.recovery.requiresObservation, true); assert.equal(resumed.progress.currentStep, null)
})

test("the user's next message continues a paused task with their own text; old 'human-takeover' records read as paused", t => {
  const f = fixture(t)
  f.coordinator.stop('deepseek', 'stopped', 'input-paused')
  const paused = f.coordinator.latest('deepseek')
  assert.equal(shared.taskPausedByInput(paused), true); assert.equal(f.coordinator.current('deepseek'), null)
  const resumed = f.submit({ text: '先打开设置页再继续。', resume: { taskId: paused.id, generation: paused.generation, userText: true } })
  assert.equal(resumed.generation, paused.generation + 1); assert.equal(resumed.status, 'recorded')
  assert.deepEqual(plain(resumed.inputs.at(-1)).text, '先打开设置页再继续。'); assert.equal(resumed.inputs.at(-1).kind, 'clarification')
  assert.equal(resumed.recovery.requiresObservation, true); assert.equal(shared.taskPausedByInput(f.coordinator.latest('deepseek')), false)
  const legacy = JSON.parse(f.payload()); legacy.stop.reason = 'human-takeover'
  assert.equal(shared.parseAutonomousTask(JSON.stringify(legacy)).stop.reason, 'input-paused')
})

test('an explicit end or emergency takes precedence over a preceding input pause from the same button click', t => {
  const f = fixture(t)
  f.coordinator.stop('deepseek', 'stopped', 'input-paused')
  f.coordinator.stop('deepseek', 'stopped', 'user-ended')
  assert.equal(JSON.parse(f.payload()).stop.reason, 'user-ended')
  f.coordinator.stop('deepseek', 'stopped', 'input-paused')
  assert.equal(JSON.parse(f.payload()).stop.reason, 'user-ended', 'historical ended tasks are not relabelled as paused')
  f.submit(); f.coordinator.stop('deepseek', 'stopped', 'input-paused'); f.coordinator.stop('deepseek', 'stopped', 'global-emergency')
  assert.equal(f.coordinator.context('deepseek', 'chat-a').task.stop.reason, 'global-emergency')
})

test('external interference and unexplained focus loss demand real observation without asserting an input pause', () => {
  const context = { actions: ['list_windows', 'observe', 'focus_window', 'click'], otherTools: [] }
  for (const patch of [{ code: 'external_input' }, { code: 'inactive_context', data: { helper_code: 'external_input' } }, { code: 'focus_denied' }]) {
    const result = { type: 'computer_result', version: 1, action: 'click', ok: false, execution: 'not_executed', message: 'Actual receipt', ...patch }
    const d = diagnostics.diagnoseComputerResult(result, context)
    assert.equal(d.category, 'focus_unconfirmed'); assert.equal(d.requires_fresh_observation, true)
    assert.equal(d.candidate_paths.some(p => p.action === 'click' || p.action === 'focus_window'), false)
    assert.equal(result.execution, 'not_executed')
  }
  const human = diagnostics.diagnoseComputerResult({ type: 'computer_result', version: 1, action: 'click', ok: false, execution: 'unknown', code: 'human_paused', message: '' }, context)
  assert.equal(human.category, 'context_ended'); assert.equal(human.candidate_paths.length, 0)
})

test('runtime only pauses the exact active machine, conversation and generation', async () => {
  const source = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
  const method = cls.members.find(node => node.name?.getText(source) === 'pauseForUserInput').getText(source)
  const Subject = new Script(compile(`class Subject { ${method} }; Subject`)).runInNewContext({})
  const calls = [], subject = Object.assign(new Subject(), { id: owner.sessionId, active: true, disposed: false, activePlatformId: 'deepseek',
    options: { localMachineId: 'machine-a' }, taskCoordinator: { owns: value => value.taskId === owner.taskId && value.generation === owner.generation },
    embeds: new Map([['deepseek', { embed: { getState: () => ({ conversationId: owner.conversationId }) } }]]),
    stopAutomation: async (...args) => calls.push(args) })
  for (const patch of [{ sessionId: 'foreign' }, { machineId: 'foreign' }, { conversationId: 'foreign' }, { generation: 2 }, { platformId: 'chatgpt' }])
    await subject.pauseForUserInput({ ...owner, ...patch })
  assert.equal(calls.length, 0)
  await subject.pauseForUserInput(owner); assert.deepEqual(plain(calls), [['input-paused', false]])
})
