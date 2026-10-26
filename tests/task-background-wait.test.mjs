import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/task-background-wait.test.mjs
// Actual coordinator and background waiter with synthetic monitor publications and deadlines.
// No Electron, helper, shell/process, real logs, desktop operations or network.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { taskContextModule as shared } from './fixtures/task-context-module.mjs'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, structuredClone, AbortController,
    setTimeout, clearTimeout, ...globals, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; if (name === '../shared/computer-actions') return load('../src/shared/computer-actions.ts')
      assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] } })
  return exports
}
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', { 'node:crypto': crypto })
const metadata = load('../src/shared/windows-wait.ts', { './windows-controls': load('../src/shared/windows-controls.ts') })
const protocol = load('../src/shared/computer-use-protocol.ts')
const registry = load('../src/main/computer-use-tool.ts', { '../shared/computer-use': load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol }) })
const backgroundProtocol = load('../src/shared/background-tasks.ts', { './autonomous-task': shared })
const machine = { id: 'machine-a', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\project' }
const backgroundId = '11111111-1111-4111-8111-111111111111'
const settle = () => new Promise(setImmediate)
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(t, patch = {}) {
  const saved = new Map(), history = [], timers = new Set(), consumed = []
  let service, current = true, tick = 100, failSave = false
  const store = { autonomousTaskGeneration: () => saved.size,
    latestAutonomousTask: () => [...saved.values()].at(-1) ?? null,
    autonomousTaskBySubmission: (_s, _p, id) => [...saved.values()].find(t => t.sourceSubmissionId === id) ?? null,
    saveAutonomousTasks(tasks) { if (failSave) throw new Error('disk unavailable'); for (const task of tasks) {
      assert.ok(shared.parseAutonomousTask(JSON.stringify(task)), 'dependency history must be persistable')
      saved.set(task.id, structuredClone(task)); history.push(structuredClone(task))
    } } }
  const coordinator = new TaskCoordinator('session-a', store, () => service?.reconcile())
  const submit = id => coordinator.submit({ platformId: 'deepseek', conversationId: 'chat-a', submission: { id, kind: 'goal' },
    text: '后台生成报表，准备其他工作，报表完成后打开核对。', attachments: [], machine,
    capability: { scopeSupported: true, computerUseEnabled: true, context: { sessionId: 'session-a', platformId: 'deepseek' } } })
  const task = submit('user:a'), lease = { sessionId: 'session-a', platformId: 'deepseek', conversationId: 'chat-a', taskId: task.id, generation: task.generation }
  const startup = coordinator.reserveToolStep(lease, 'launch:a', 'command', machine)
  coordinator.noteToolStep(startup, { stage: 'executing' })
  coordinator.noteToolStep(startup, { stage: 'background', execution: 'executed' })
  const background = { id: backgroundId, taskContext: startup, name: '生成报表', pid: 12345, transport: 'local', targetLabel: '本机',
    conversationId: 'chat-a', command: 'generate-report', logPath: 'C:\\Temp\\report.log', stderrPath: null, exitCodePath: 'C:\\Temp\\report.exit',
    status: 'running', exitCode: null, createdAt: 1, checkedAt: 2, message: '正在运行', output: '', errorOutput: '',
    outputTruncated: false, errorOutputTruncated: false, resultSettled: false, backgroundOptions: { kind: 'job' }, ...patch }
  const tasks = [background]
  const exports = load('../src/main/task-background-wait.ts', { 'node:perf_hooks': { performance: { now: () => tick } },
    '../shared/autonomous-task': shared, '../shared/windows-wait': metadata, './computer-use-tool': registry }, {
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer }, clearTimeout(timer) { timers.delete(timer) } })
  service = new exports.TaskBackgroundWait({ coordinator, tasks: () => tasks, consume: (id, kinds) => consumed.push({ id, kinds: [...kinds] }) })
  const abort = new AbortController()
  function context(condition = 'background_finished') {
    const p = coordinator.current('deepseek').progress, now = Date.now(), id = crypto.randomUUID()
    const token = coordinator.computerStepToken('deepseek')
    const next = { ...p, phase: 'executing-tool', stepCount: p.stepCount + 1, handledMessageIds: [...p.handledMessageIds, id],
      currentStep: { id, sourceMessageId: id, action: 'wait_for', tool: 'computer', machine, status: 'executing', execution: 'unknown', delivery: 'pending',
        message: null, resultText: null, createdAt: now, updatedAt: now } }
    assert.equal(coordinator.reserveComputerStep(lease, next, token, false), true)
    return { lease, step: { id, token, sourceMessageId: id }, signal: abort.signal, isCurrent: () => current, condition }
  }
  t.after(() => service.dispose())
  return { coordinator, service, context, startup, lease, background, tasks, timers, consumed, submit, history, store,
    parser: backgroundProtocol, belongs: exports.backgroundBelongsTo, reuse: exports.reusableBackgroundTask,
    publish(patch) { Object.assign(background, patch); tick += 4000; service.reconcile() },
    setCurrent(value) { current = value; service.reconcile() }, abort,
    setFailSave(value) { failSave = value },
    deadline() { for (const timer of [...timers]) { timers.delete(timer); tick += timer.delay; timer.callback() } }
  }
}

test('background parameters exclude desktop targets, scripts, PID and unbounded timeouts', () => {
  for (const condition of ['background_ready', 'background_finished']) {
    for (const timeout_ms of [100, 600000, 3600000]) {
      const p = { condition, background_id: backgroundId, timeout_ms }
      assert.equal(metadata.validateWaitParameters(p), null)
      assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'wait_for', step_token: 'cu_' + 'a'.repeat(32), ...p }), [metadata.WAIT_FOR_DEFINITION]).ok, true)
    }
    for (const patch of [{ background_id: 'PID:12345' }, { observation: 'window' }, { query: 'report' }, { pid: 12345 },
      { window_id: 'win_' + 'a'.repeat(32) }, { script: 'ready()' }, { timeout_ms: 99 }, { timeout_ms: 3600001 }])
      assert.ok(metadata.validateWaitParameters({ condition, background_id: backgroundId, ...patch }))
  }
  assert.ok(metadata.validateWaitParameters({ condition: 'window_present', query: 'report', background_id: backgroundId }))
  assert.ok(metadata.validateWaitParameters({ condition: 'window_present', query: 'report', timeout_ms: 30001 }))
})

test('unrelated work is accepted before the model explicitly declares a dependent wait', async t => {
  const f = fixture(t)
  assert.equal(f.coordinator.current('deepseek').progress.phase, 'waiting-model')
  const independent = f.coordinator.reserveToolStep(f.lease, 'independent:a', 'read_files', machine)
  assert.ok(independent)
  f.coordinator.noteToolStep(independent, { stage: 'delivered', execution: 'executed' })
  const c = f.context(), result = f.service.wait({ condition: c.condition, background_id: backgroundId }, c)
  const dependency = f.coordinator.current('deepseek').backgroundDependencies[0]
  assert.equal(dependency.state, 'waiting'); assert.equal(dependency.startupStepId, f.startup.stepId)
  assert.equal(dependency.waitingStepId, c.step.id)
  let finished = false; result.then(() => { finished = true })
  f.publish({ status: 'completed', exitCode: 0 }) // The monitor still owes its final log read.
  await settle(); assert.equal(finished, false); assert.equal(f.timers.size, 1)
  f.publish({ resultSettled: true, output: '报表已写入' })
  const output = await result
  assert.equal(output.data.condition_met, true); assert.equal(output.data.goal_verified, false)
  assert.equal(output.data.output, '报表已写入'); assert.equal(output.data.exit_code, 0)
  assert.equal(f.coordinator.current('deepseek').backgroundDependencies[0].state, 'satisfied')
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.consumed[0].kinds, ['created', 'ready', 'startup-timeout', 'finished'])
})

test('readiness uses verified service evidence and does not wait for service exit', async t => {
  const f = fixture(t, { backgroundOptions: { kind: 'service' }, startup: { state: 'starting' } })
  const c = f.context('background_ready'), result = f.service.wait({ condition: c.condition, background_id: backgroundId }, c)
  f.publish({ startup: { state: 'ready', readyAt: 15, evidence: '本任务进程树监听 8080', url: 'http://localhost:8080' } })
  const output = await result
  assert.equal(output.data.condition_met, true); assert.equal(output.data.result_settled, false)
  assert.equal(output.data.status, 'running'); assert.equal(output.data.ready_at, 15)
  assert.equal(output.data.evidence, '本任务进程树监听 8080')
  assert.deepEqual(f.consumed[0].kinds, ['created', 'ready', 'startup-timeout'])
})

test('failures, unknown exit codes, readiness timeouts and manual stop never satisfy dependencies', async t => {
  for (const [patch, condition, state] of [
    [{ status: 'failed', exitCode: 7, resultSettled: true }, 'background_finished', 'failed'],
    [{ status: 'exited', exitCode: null, resultSettled: true }, 'background_finished', 'unconfirmed'],
    [{ status: 'stopped', stopRequestedAt: 10 }, 'background_finished', 'cancelled'],
    [{ status: 'running', stopInProgress: true }, 'background_finished', 'cancelled'],
    [{ status: 'running', startup: { state: 'timeout' } }, 'background_ready', 'unconfirmed'],
    [{ status: 'completed', exitCode: 0, resultSettled: true }, 'background_ready', 'unconfirmed']
  ]) {
    const f = fixture(t, { backgroundOptions: { kind: 'service' } }), c = f.context(condition)
    const result = f.service.wait({ condition, background_id: backgroundId }, c)
    const check = assert.rejects(result, error => error.result?.data?.wait_status === state && error.result.data.condition_met === false)
    f.publish(patch); await check
  }
})

test('one deadline returns real state without consuming the eventual completion notification', async t => {
  const f = fixture(t), c = f.context()
  const result = f.service.wait({ condition: c.condition, background_id: backgroundId, timeout_ms: 100 }, c)
  const check = assert.rejects(result, error => error.result.code === 'wait_timeout' && error.result.data.status === 'running' && error.result.data.condition_met === false)
  f.deadline(); await check
  assert.equal(f.background.status, 'running'); assert.equal(f.consumed[0].kinds.length, 0)
  assert.equal(f.coordinator.current('deepseek').backgroundDependencies[0].state, 'timed-out')
})

test('task, startup provenance, machine and step token cannot be borrowed', async t => {
  for (const mutate of [
    f => { f.background.taskContext = null }, f => { delete f.background.taskContext },
    f => { f.background.taskContext = { ...f.startup, generation: 999 } },
    f => { f.background.taskContext = { ...f.startup, tool: 'read_files' } },
    f => { f.background.taskContext = { ...f.startup, machine: { ...machine, id: 'other-machine' } } },
    f => { f.background.transport = 'ssh' }
  ]) {
    const f = fixture(t), c = f.context(); mutate(f)
    await assert.rejects(f.service.wait({ condition: c.condition, background_id: backgroundId }, c), error => error.result.execution === 'not_executed')
    assert.equal(f.timers.size, 0)
  }
  const f = fixture(t), c = f.context()
  await assert.rejects(f.service.wait({ condition: c.condition, background_id: backgroundId }, { ...c, step: { ...c.step, token: 'cu_' + 'f'.repeat(32) } }))
  await assert.rejects(f.service.wait({ condition: 'background_ready', background_id: backgroundId }, c), error => error.result.code === 'invalid_parameters')
})

test('new goal, cancellation and scope changes discard waits and ignore late monitor events', async t => {
  for (const cancel of [f => f.submit('user:b'), f => f.abort.abort(), f => f.setCurrent(false)]) {
    const f = fixture(t), c = f.context()
    const result = f.service.wait({ condition: c.condition, background_id: backgroundId }, c)
    const check = assert.rejects(result, error => error.result.code === 'cancelled')
    cancel(f); await check
    f.publish({ status: 'completed', exitCode: 0, resultSettled: true })
    assert.equal(f.consumed.length, 0); assert.equal(f.timers.size, 0)
    assert.equal(f.background.status, 'completed') // Cancelling a wait never kills or restarts a process.
  }
})

test('dependency history survives parsing while a restart restores no live wait', async t => {
  const f = fixture(t), c = f.context(), result = f.service.wait({ condition: c.condition, background_id: backgroundId }, c)
  const check = assert.rejects(result)
  const snapshot = shared.parseAutonomousTask(JSON.stringify(f.coordinator.current('deepseek')))
  assert.equal(snapshot.backgroundDependencies[0].state, 'waiting')
  const restored = new TaskCoordinator('session-a', f.store, () => {})
  const state = restored.context('deepseek', 'chat-a')
  assert.equal(state.task.status, 'interrupted'); assert.equal(state.task.backgroundDependencies[0].state, 'cancelled')
  assert.equal(restored.owns(f.lease), false)
  f.abort.abort(); await check
  const corrupt = structuredClone(snapshot); corrupt.backgroundDependencies[0].condition = 'script'
  assert.equal(shared.parseAutonomousTask(JSON.stringify(corrupt)), null)
})

test('exact duplicate live starts reuse their real reference; stopped tasks also cannot silently restart', t => {
  const f = fixture(t)
  assert.equal(f.reuse(f.tasks, f.startup, 'generate-report', { kind: 'job' }).id, backgroundId)
  const inferred = { ...f.background, launchOptions: null, backgroundOptions: { kind: 'service' } }
  assert.equal(f.reuse([inferred], f.startup, 'generate-report').id, backgroundId, 'later service inference must not bypass startup deduplication')
  assert.equal(f.reuse(f.tasks, f.startup, 'different-command', { kind: 'job' }), undefined)
  assert.equal(f.reuse(f.tasks, { ...f.startup, generation: 99 }, 'generate-report', { kind: 'job' }), undefined)
  assert.equal(f.reuse(f.tasks, { ...f.startup, machine: { ...machine, workingDirectory: 'C:\\other' } }, 'generate-report', { kind: 'job' }), undefined)
  f.publish({ status: 'completed', exitCode: 0, resultSettled: true })
  assert.equal(f.reuse(f.tasks, f.startup, 'generate-report', { kind: 'job' }), undefined)
  f.publish({ status: 'stopped', stopRequestedAt: 5 })
  assert.equal(f.reuse(f.tasks, f.startup, 'generate-report', { kind: 'job' }).id, backgroundId)
})

test('a storage failure prevents starting a dependency wait', async t => {
  const f = fixture(t), c = f.context()
  f.setFailSave(true)
  await assert.rejects(f.service.wait({ condition: c.condition, background_id: backgroundId }, c), error => error.result.execution === 'not_executed')
  assert.equal(f.timers.size, 0); assert.equal(f.coordinator.current('deepseek'), null)
})

test('persisted background association is strict and cannot downgrade invalid context to legacy', t => {
  const f = fixture(t), stored = { task: { ...f.background, creationDeliveryStatus: 'sending' },
    target: { transport: 'local', key: 'local', label: '本机', kind: 'windows', cwd: machine.workingDirectory }, messageId: 'launch:a', identity: 'birth:a', settled: false,
    owner: { platformId: 'deepseek', conversationId: 'chat-a' } }
  const valid = f.parser.parseStoredBackgroundTask(JSON.stringify(stored))
  assert.deepEqual(plain(valid.task.taskContext), plain(f.startup))
  assert.equal(valid.task.resultSettled, undefined)
  assert.equal(valid.task.creationDeliveryStatus, 'needs-attention')
  stored.task.taskContext = { ...f.startup, machine: { ...machine, connection: 'ssh' } }
  assert.equal(f.parser.parseStoredBackgroundTask(JSON.stringify(stored)).task.taskContext, null)
})

test('wait result supersedes duplicate notices, while eventual service exit still gets one notification', async t => {
  const f = fixture(t, { backgroundOptions: { kind: 'service' } }), sends = [], statuses = [], timers = new Set()
  const { BackgroundTaskResults } = load('../src/main/background-task-results.ts', {}, {
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer }, clearTimeout(timer) { timers.delete(timer) } })
  const queue = new BackgroundTaskResults({ current: task => f.coordinator.owns(task.taskContext), canSend: () => true,
    send: async text => { sends.push(text); return 'ok' }, onStatus: (_id, status, _message, kind) => statuses.push({ kind, status }), latest: () => f.background })
  t.after(() => queue.dispose())
  queue.consume(backgroundId, ['created', 'ready', 'startup-timeout'])
  queue.capture({ platformId: 'deepseek', conversationId: 'chat-a' }, () => true, 'ready')({ ...f.background, startup: { state: 'ready', readyAt: 5 } })
  assert.equal(queue.isSending, false)
  assert.ok(statuses.some(s => s.kind === 'ready' && s.status === 'superseded'))
  assert.equal(sends.length, 0); assert.equal(timers.size, 0)
  f.publish({ status: 'completed', resultSettled: true, exitCode: 0 })
  queue.capture({ platformId: 'deepseek', conversationId: 'chat-a' })(f.background)
  for (const timer of [...timers]) { timers.delete(timer); timer.callback() }
  await settle()
  assert.equal(sends.length, 1); assert.match(sends[0], /后台任务执行结果/)
  assert.match(sends[0], /"background_id":"11111111-1111-4111-8111-111111111111"/)
})
