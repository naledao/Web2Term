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

test('takeover checkpoint retains original requirements, late effects and explicit fresh-generation recovery', async t => {
  const held = deferred(), f = fixture(t, { action: 'click', parameters: {}, execute: () => held.promise })
  const lease = f.lease(), runningRequest = f.request(); f.loop.enqueue(runningRequest)
  const running = f.loop.wake()
  for (let n = 0; n < 10 && !f.executions.length; n++) await new Promise(setImmediate)
  f.coordinator.stop('deepseek', 'stopped', 'human-takeover')
  held.resolve({ type: 'computer_result', version: 1, action: 'click', ok: false, execution: 'executed', code: 'human_takeover', message: 'Actual receipt' })
  await running
  const paused = JSON.parse(f.payload())
  assert.equal(paused.stop.reason, 'human-takeover'); assert.equal(paused.status, 'stopped')
  assert.ok(shared.parseAutonomousTask(f.payload())); assert.equal(f.coordinator.owns(lease), false)
  assert.equal(f.state().execution_fact, 'executed'); assert.equal(f.sends.length, 0)
  const summary = recovery.computerRecoveryMessage(paused, f.store.listComputerActions(lease, 33))
  assert.equal(JSON.parse(summary.slice(summary.indexOf('\n') + 1)).pause_reason, 'human_takeover')
  const resumed = f.submit({ resume: { taskId: paused.id, generation: paused.generation } })
  assert.equal(resumed.generation, paused.generation + 1); assert.equal(resumed.stop, undefined)
  assert.equal(resumed.originalRequest, f.first.originalRequest); assert.deepEqual(plain(resumed.inputs.slice(0, f.first.inputs.length)), plain(f.first.inputs))
  assert.equal(resumed.recovery.requiresObservation, true); assert.equal(resumed.progress.currentStep, null)
})

test('an explicit end or emergency takes precedence over a preceding takeover from the same button click', t => {
  const f = fixture(t)
  f.coordinator.stop('deepseek', 'stopped', 'human-takeover')
  f.coordinator.stop('deepseek', 'stopped', 'user-ended')
  assert.equal(JSON.parse(f.payload()).stop.reason, 'user-ended')
  f.coordinator.stop('deepseek', 'stopped', 'human-takeover')
  assert.equal(JSON.parse(f.payload()).stop.reason, 'user-ended', 'historical ended tasks are not relabelled as takeovers')
  f.submit(); f.coordinator.stop('deepseek', 'stopped', 'human-takeover'); f.coordinator.stop('deepseek', 'stopped', 'global-emergency')
  assert.equal(f.coordinator.context('deepseek', 'chat-a').task.stop.reason, 'global-emergency')
})

test('external interference and unexplained focus loss demand real observation without asserting human takeover', () => {
  const context = { actions: ['list_windows', 'observe', 'focus_window', 'click'], otherTools: [] }
  for (const patch of [{ code: 'external_input' }, { code: 'inactive_context', data: { helper_code: 'external_input' } }, { code: 'focus_denied' }]) {
    const result = { type: 'computer_result', version: 1, action: 'click', ok: false, execution: 'not_executed', message: 'Actual receipt', ...patch }
    const d = diagnostics.diagnoseComputerResult(result, context)
    assert.equal(d.category, 'focus_unconfirmed'); assert.equal(d.requires_fresh_observation, true)
    assert.equal(d.candidate_paths.some(p => p.action === 'click' || p.action === 'focus_window'), false)
    assert.equal(result.execution, 'not_executed')
  }
  const human = diagnostics.diagnoseComputerResult({ type: 'computer_result', version: 1, action: 'click', ok: false, execution: 'unknown', code: 'human_takeover', message: '' }, context)
  assert.equal(human.category, 'context_ended'); assert.equal(human.candidate_paths.length, 0)
})

test('runtime only pauses the exact active machine, conversation and generation', async () => {
  const source = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
  const method = cls.members.find(node => node.name?.getText(source) === 'humanTakeover').getText(source)
  const Subject = new Script(compile(`class Subject { ${method} }; Subject`)).runInNewContext({})
  const calls = [], subject = Object.assign(new Subject(), { id: owner.sessionId, active: true, disposed: false, activePlatformId: 'deepseek',
    options: { localMachineId: 'machine-a' }, taskCoordinator: { owns: value => value.taskId === owner.taskId && value.generation === owner.generation },
    embeds: new Map([['deepseek', { embed: { getState: () => ({ conversationId: owner.conversationId }) } }]]),
    stopAutomation: async (...args) => calls.push(args) })
  for (const patch of [{ sessionId: 'foreign' }, { machineId: 'foreign' }, { conversationId: 'foreign' }, { generation: 2 }, { platformId: 'chatgpt' }])
    await subject.humanTakeover({ ...owner, ...patch })
  assert.equal(calls.length, 0)
  await subject.humanTakeover(owner); assert.deepEqual(plain(calls), [['human-takeover', false]])
})
