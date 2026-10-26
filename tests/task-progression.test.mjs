import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/task-progression.test.mjs
// Actual state machine, coordinator, dispatcher and bridge methods, using synthetic IO.
// No Electron startup, user desktop, real page, shell, network or test runner subprocess.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, AbortController, structuredClone, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; if (name === '../shared/computer-diagnostics') return load('../src/shared/computer-diagnostics.ts');
      if (name === '../shared/computer-actions') return load('../src/shared/computer-actions.ts')
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return exports
}
const shared = load('../src/shared/autonomous-task.ts')
const protocol = load('../src/shared/computer-use-protocol.ts')
const computer = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const crypto = { 'node:crypto': { createHash, randomUUID } }
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', crypto)
const { TaskProgression } = load('../src/main/task-progression.ts', crypto)
const { ComputerUseTool, ComputerUseActionError } = load('../src/main/computer-use-tool.ts', { '../shared/computer-use': computer })
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(options = {}) {
  const records = new Map(), snapshots = [], sends = [], executions = [], timers = [], releases = []
  let live = true, paused = false, submissionSerial = 0, loop
  const store = {
    autonomousTaskGeneration: () => Math.max(0, ...[...records.values()].map(task => task.generation)),
    latestAutonomousTask: (sessionId, platformId, conversationId) => structuredClone([...records.values()]
      .filter(task => task.sessionId === sessionId && task.platformId === platformId && task.conversationId === conversationId)
      .sort((a, b) => b.generation - a.generation)[0] ?? null),
    autonomousTaskBySubmission: (sessionId, platformId, id) => structuredClone([...records.values()]
      .find(task => task.sessionId === sessionId && task.platformId === platformId && task.inputs.some(input => input.id === id)) ?? null),
    saveAutonomousTasks(tasks) {
      for (const task of tasks) {
        options.beforeSave?.(task)
        const parsed = shared.parseAutonomousTask(JSON.stringify(task))
        assert.ok(parsed, 'state written by the actual coordinator must be readable')
        records.set(task.id, parsed)
        snapshots.push(structuredClone(parsed))
      }
    }
  }
  const coordinator = new TaskCoordinator('session-A', store, () => loop?.reconcile())
  const tool = new ComputerUseTool()
  tool.register({ action: options.action ?? 'observe', description: 'Synthetic tool', parameters: [], example: {} }, {
    validate: () => null,
    async execute(parameters, context) {
      executions.push({ parameters, context })
      return options.execute ? options.execute(parameters, context) : { message: 'Observed actual synthetic state', data: { observation_id: 'obs-A' } }
    }
  })
  const capability = () => computer.resolveComputerUseCapability({ computerUseEnabled: true, desktopControlEnabled: true }, {
    sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local'
  }, tool.definitions())
  const dependencies = {
    coordinator,
    acquire: options.acquire,
    isCurrent: () => live,
    canRun: () => !paused,
    invoke: (call, lease, signal, step, permit) => tool.invoke(call, { capability, lease, step, desktopPermit: permit,
      isCurrent: () => live && coordinator.owns(lease), signal }),
    async send(text, lease, signal, attachments) {
      sends.push({ text, lease, signal, attachments })
      assert.equal(coordinator.current('deepseek').progress.currentStep.delivery, 'sending', 'sending is durable before IO')
      return options.send ? options.send(text, lease, signal, attachments) : 'ok'
    },
    release(attachments, lease) { releases.push({ attachments, lease }) },
    onError: lease => coordinator.fail(lease.platformId, lease.conversationId),
    schedule(callback) {
      const timer = { active: true, callback }
      timers.push(timer)
      return () => { timer.active = false }
    }
  }
  loop = new TaskProgression(dependencies)
  const submit = (overrides = {}) => coordinator.submit({
    platformId: 'deepseek', conversationId: 'conversation-A', submission: { id: `human-${++submissionSerial}`, kind: 'goal' },
    text: '下载报表并检查 Excel 产物。', attachments: [], capability: capability(),
    machine: { id: 'machine-A', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\reports' },
    ...overrides
  })
  const first = submit()
  const request = (sourceMessageId = 'reply-1', overrides = {}) => {
    const task = coordinator.current('deepseek') ?? first
    return { sessionId: task.sessionId, platformId: task.platformId, conversationId: task.conversationId,
      taskId: task.id, generation: task.generation, sourceMessageId, call: { action: options.action ?? 'observe', parameters: {} }, ...overrides }
  }
  return { loop, coordinator, store, dependencies, first, request, submit, records, snapshots, executions, sends, timers, releases,
    progress: () => coordinator.current('deepseek')?.progress,
    pause(value) { paused = value }, setLive(value) { live = value; loop.reconcile() },
    async retry() {
      const timer = timers.find(item => item.active)
      assert.ok(timer, 'a retry should be scheduled only for pending work')
      timer.active = false
      timer.callback()
      await loop.wake()
    }
  }
}

test('global admission keeps a step unexecuted; busy delivery retries without reacquiring or rerunning', async () => {
  const gate = deferred(), outcomes = ['busy', 'ok']
  let admissions = 0, released = 0
  const permit = { release: () => released++ }
  const f = fixture({ acquire: (_call, _lease, _signal, waiting) => { admissions++; waiting(); return gate.promise }, send: () => outcomes.shift() })
  f.loop.enqueue(f.request())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.progress().phase, 'waiting-tool'); assert.equal(f.progress().currentStep.execution, 'not_executed')
  assert.equal(f.progress().currentStep.status, 'queued'); assert.equal(f.executions.length, 0)
  assert.match(f.progress().detail, /全局桌面/)
  gate.resolve(permit); await f.loop.wake()
  assert.equal(f.executions.length, 1); assert.equal(f.executions[0].context.desktopPermit, permit)
  assert.equal(released, 1); assert.equal(f.progress().phase, 'waiting-delivery')
  await f.retry(); assert.equal(f.sends.length, 2); assert.equal(admissions, 1); assert.equal(released, 1)
  f.loop.dispose()
})

test('a replaced goal waiting for global admission cannot dispatch even if its old grant arrives late', async () => {
  const gate = deferred(); let released = 0
  const f = fixture({ acquire: () => gate.promise })
  f.loop.enqueue(f.request()); await new Promise(resolve => setImmediate(resolve))
  f.submit(); gate.resolve({ release: () => released++ }); await f.loop.wake()
  assert.equal(f.executions.length, 0); assert.equal(f.sends.length, 0); assert.equal(released, 1)
  f.loop.dispose()
})

test('cancellation after dispatch retains its permit until the synthetic executor actually returns', async () => {
  const gate = deferred(); let released = 0
  const f = fixture({ acquire: async () => ({ release: () => released++ }), execute: () => gate.promise })
  f.loop.enqueue(f.request()); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.executions.length, 1)
  f.submit(); assert.equal(f.executions[0].context.signal.aborted, true); assert.equal(released, 0)
  gate.resolve({ message: 'Actual old input result' }); await f.loop.wake()
  assert.equal(released, 1); assert.equal(f.sends.length, 0)
  f.loop.dispose()
})

test('two model-selected rounds stay in one task and execute each source reply once', async () => {
  const f = fixture()
  assert.equal(f.loop.enqueue(f.request()), 'accepted')
  await f.loop.wake()
  assert.equal(f.progress().phase, 'waiting-model')
  assert.equal(f.loop.enqueue(f.request()), 'duplicate')
  assert.equal(f.loop.enqueue(f.request('reply-2')), 'accepted')
  await f.loop.wake()
  assert.equal(f.executions.length, 2)
  assert.equal(f.sends.length, 2)
  assert.equal(f.records.size, 1)
  assert.equal(f.progress().stepCount, 2)
  for (const [index, sent] of f.sends.entries()) {
    const result = JSON.parse(sent.text)
    assert.equal(result.type, 'computer_result')
    assert.equal(result.task_id, f.first.id)
    assert.equal(result.task_generation, f.first.generation)
    assert.equal(result.source_message_id, `reply-${index + 1}`)
    assert.equal(result.execution, 'executed')
  }
  assert.notEqual(JSON.parse(f.sends[0].text).step_id, JSON.parse(f.sends[1].text).step_id)
  assert.equal(f.progress().currentStep.resultText, null, 'confirmed delivery clears the pending payload')
  f.loop.noteReply('deepseek', 'final-answer', 'response')
  assert.equal(f.progress().phase, 'responded')
  assert.equal(f.coordinator.current('deepseek').status, 'recorded', 'model text is not verified task completion')
})

test('busy page and unavailable composer retry the saved result, never the desktop action', async () => {
  const outcomes = ['busy', 'no-composer', 'ok']
  const f = fixture({ send: () => outcomes.shift() })
  f.loop.enqueue(f.request())
  await f.loop.wake()
  assert.equal(f.progress().phase, 'waiting-delivery')
  assert.equal(f.progress().currentStep.execution, 'executed')
  assert.ok(f.progress().currentStep.resultText)
  await f.retry()
  await f.retry()
  assert.equal(f.progress().phase, 'waiting-model')
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends.length, 3)
  assert.equal(new Set(f.sends.map(item => item.text)).size, 1)
  assert.equal(f.timers.some(timer => timer.active), false)
})

test('a configured result delay waits once before delivery; retries and cancellation never rerun the action', async () => {
  const withDelay = options => {
    const f = fixture(options), deadlines = []
    f.dependencies.resultDelaySeconds = () => 2
    f.dependencies.scheduleDeadline = (callback, delay) => {
      const timer = { active: true, callback, delay }
      deadlines.push(timer)
      return () => { timer.active = false }
    }
    return { f, delays: () => deadlines.filter(timer => timer.delay === 2000) }
  }
  const outcomes = ['busy', 'ok']
  const { f, delays } = withDelay({ send: () => outcomes.shift() })
  f.loop.enqueue(f.request())
  await f.loop.wake()
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends.length, 0, 'the saved result waits for the configured delay')
  assert.equal(f.progress().phase, 'waiting-delivery')
  assert.match(f.progress().detail, /等待 2 秒/)
  await f.loop.wake()
  assert.equal(f.sends.length, 0, 'an unrelated wake does not cut the delay short')
  const [timer] = delays()
  assert.ok(timer?.active)
  timer.active = false
  timer.callback()
  await f.loop.wake()
  assert.equal(f.sends.length, 1)
  await f.retry()
  assert.equal(f.sends.length, 2)
  assert.equal(delays().length, 1, 'a busy retry does not wait again')
  assert.equal(f.executions.length, 1)
  assert.equal(f.progress().phase, 'waiting-model')

  const { f: g, delays: gDelays } = withDelay()
  g.loop.enqueue(g.request())
  await g.loop.wake()
  g.setLive(false)
  assert.equal(gDelays()[0].active, false, 'leaving the task cancels the pending delay')
  assert.equal(g.sends.length, 0)
})

test('uncertain submission blocks automatic resubmission and preserves the unsent evidence', async () => {
  for (const outcome of ['unknown', 'stuck', 'stale']) {
    const f = fixture({ send: () => outcome })
    f.loop.enqueue(f.request())
    await f.loop.wake()
    await f.loop.wake()
    assert.equal(f.executions.length, 1)
    assert.equal(f.sends.length, 1)
    assert.equal(f.progress().phase, 'blocked')
    assert.equal(f.progress().currentStep.delivery, 'uncertain')
    assert.ok(f.progress().currentStep.resultText)
    assert.equal(f.loop.enqueue(f.request('next-reply')), 'busy')
    assert.equal(f.timers.some(timer => timer.active), false)
  }
})

test('an executor failure is reported to the model as unknown without automatically rerunning it', async () => {
  const f = fixture({ execute: async () => { throw new Error('lost helper after input') } })
  f.loop.enqueue(f.request())
  await f.loop.wake()
  const result = JSON.parse(f.sends[0].text)
  assert.equal(result.execution, 'unknown')
  assert.equal(result.code, 'executor_error')
  assert.equal(f.executions.length, 1)
  assert.equal(f.progress().phase, 'waiting-model', 'the model receives the failure and decides what to observe next')
})

test('the existing pause gate holds queued actions and already executed results', async () => {
  const f = fixture()
  f.pause(true)
  f.loop.enqueue(f.request())
  await f.loop.wake()
  assert.equal(f.executions.length, 0)
  assert.equal(f.progress().phase, 'waiting-tool')
  f.pause(false)
  await f.loop.wake()
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends.length, 1)

  const output = deferred()
  const g = fixture({ execute: () => output.promise })
  g.loop.enqueue(g.request())
  g.pause(true)
  output.resolve({ message: 'observed while pause was requested' })
  await g.loop.wake()
  assert.equal(g.progress().phase, 'waiting-delivery')
  assert.equal(g.sends.length, 0)
  g.pause(false)
  await g.loop.wake()
  assert.equal(g.executions.length, 1)
  assert.equal(g.sends.length, 1)
})

test('stopping or navigating away aborts the lease and discards late execution results', async () => {
  for (const interrupt of [f => f.coordinator.stop('deepseek'), f => f.coordinator.context('deepseek', 'another-chat')]) {
    const output = deferred()
    const f = fixture({ execute: () => output.promise })
    const request = f.request()
    f.loop.enqueue(request)
    interrupt(f)
    assert.equal(f.executions[0].context.signal.aborted, true)
    output.resolve({ message: 'too late' })
    await f.loop.wake()
    assert.equal(f.sends.length, 0)
    assert.equal(f.loop.enqueue(request), 'inactive')
    const saved = f.records.get(f.first.id)
    assert.equal(saved.progress.currentStep.execution, 'unknown')
    assert.equal(saved.progress.currentStep.status, 'interrupted')
  }
})

test('a new human goal supersedes the old generation without attributing its late result to the new task', async () => {
  const output = deferred()
  let count = 0
  const f = fixture({ execute: () => ++count === 1 ? output.promise : Promise.resolve({ message: 'new goal state' }) })
  const old = f.request()
  f.loop.enqueue(old)
  const next = f.submit({ text: '改为处理另一份报表。' })
  assert.equal(f.loop.enqueue(old), 'inactive')
  assert.equal(f.loop.enqueue(f.request('new-goal-reply')), 'accepted')
  output.resolve({ message: 'old goal result' })
  await f.loop.wake()
  await f.loop.wake()
  assert.equal(f.sends.length, 1)
  assert.equal(JSON.parse(f.sends[0].text).task_id, next.id)
  assert.equal(f.records.get(f.first.id).status, 'superseded')
})

test('current task, conversation, session and generation are all required for dispatch', async () => {
  const f = fixture()
  for (const patch of [{ taskId: 'other' }, { generation: 999 }, { sessionId: 'session-B' },
    { platformId: 'chatgpt' }, { conversationId: 'another-chat' }, { conversationId: null }]) {
    assert.equal(f.loop.enqueue(f.request('bad-reply', patch)), 'inactive')
  }
  assert.equal(f.executions.length, 0)
  assert.equal(f.progress().stepCount, 0)
})

test('a next request received before send acknowledgement waits and then advances automatically', async () => {
  const ack = deferred(), started = deferred()
  let count = 0
  const f = fixture({ send: () => { if (++count > 1) return 'ok'; started.resolve(); return ack.promise } })
  f.loop.enqueue(f.request())
  await started.promise
  assert.equal(f.loop.enqueue(f.request('reply-2')), 'deferred')
  assert.equal(f.loop.enqueue(f.request('reply-2')), 'duplicate')
  assert.equal(f.loop.enqueue(f.request('reply-3')), 'busy')
  assert.equal(f.executions.length, 1)
  ack.resolve('ok')
  await f.loop.wake()
  await f.loop.wake()
  assert.equal(f.executions.length, 2)
  assert.equal(f.sends.length, 2)
  assert.equal(f.progress().stepCount, 2)
})

test('an early next request is never executed after an uncertain acknowledgement', async () => {
  const ack = deferred(), started = deferred()
  const f = fixture({ send: () => { started.resolve(); return ack.promise } })
  f.loop.enqueue(f.request())
  await started.promise
  assert.equal(f.loop.enqueue(f.request('reply-2')), 'deferred')
  ack.resolve('unknown')
  await f.loop.wake()
  await f.loop.wake()
  assert.equal(f.executions.length, 1)
  assert.equal(f.progress().phase, 'blocked')
})

test('questions received before acknowledgement remain associated with this task; clarification keeps the goal', async () => {
  const ack = deferred(), started = deferred()
  const f = fixture({ send: () => { started.resolve(); return ack.promise } })
  f.loop.enqueue(f.request())
  await started.promise
  f.loop.noteReply('deepseek', 'question-2', 'question')
  f.loop.noteReply('deepseek', 'question-2', 'response')
  ack.resolve('ok')
  await f.loop.wake()
  assert.equal(f.progress().phase, 'waiting-user')
  const clarified = f.submit({ submission: { id: 'answer-1', kind: 'clarification' }, text: '保存在 D:\\报表。' })
  assert.equal(clarified.id, f.first.id)
  assert.equal(clarified.generation, f.first.generation)
  assert.equal(clarified.progress.phase, 'waiting-model')
  assert.equal(clarified.originalRequest, f.first.originalRequest)
  assert.equal(clarified.inputs.length, 2)
})

test('a question keeps its state when the same message is also reported as a normal settled answer', () => {
  for (const kinds of [['question', 'response'], ['response', 'question']]) {
    const f = fixture()
    for (const kind of kinds) f.loop.noteReply('deepseek', 'question-1', kind)
    assert.equal(f.progress().phase, 'waiting-user')
    assert.equal(f.progress().lastReply.kind, 'question')
  }
})

test('restoring pending results interrupts them; it never replays a desktop action or sends old text', async () => {
  const f = fixture({ send: () => 'busy' })
  f.loop.enqueue(f.request())
  await f.loop.wake()
  f.loop.dispose()
  const restored = new TaskCoordinator('session-A', f.store, () => {})
  const state = restored.context('deepseek', 'conversation-A')
  const loop = new TaskProgression({ ...f.dependencies, coordinator: restored })
  await loop.wake()
  assert.equal(state.task.status, 'interrupted')
  assert.equal(state.task.progress.phase, 'interrupted')
  assert.equal(state.task.progress.currentStep.delivery, 'cancelled')
  assert.equal(loop.enqueue(f.request('new-reply')), 'inactive')
  assert.equal(f.executions.length, 1)
  assert.equal(f.sends.length, 1)
})

test('a storage failure before dispatch prevents execution', async () => {
  const f = fixture({ beforeSave(task) { if (task.progress?.phase === 'waiting-tool') throw new Error('disk full') } })
  assert.equal(f.loop.enqueue(f.request()), 'inactive')
  await f.loop.wake()
  assert.equal(f.executions.length, 0)
  assert.ok(f.coordinator.context('deepseek', 'conversation-A').error)
})

test('unserializable output sends bounded failure information without repeating input', async () => {
  const f = fixture({ execute: async () => ({ message: 'done', data: { unsupported: 1n } }) })
  f.loop.enqueue(f.request())
  await f.loop.wake()
  const output = JSON.parse(f.sends[0].text)
  assert.equal(output.code, 'executor_error')
  assert.equal(output.execution, 'executed')
  assert.equal(Object.hasOwn(output, 'data'), false)
  assert.equal(f.executions.length, 1)
})

const screenshotReference = { id: 'img_' + 'a'.repeat(32), mime_type: 'image/png', sha256: 'b'.repeat(64) }
test('screenshot delivery retries the same task-bound result and image without another observation', async () => {
  let deliveries = 0
  const f = fixture({ execute: async () => ({ message: 'Captured', data: { observation_id: 'obs-A' }, attachments: [screenshotReference] }),
    send: () => ++deliveries === 1 ? 'busy' : 'ok' })
  f.loop.enqueue(f.request()); await f.loop.wake()
  assert.equal(f.releases.length, 0); assert.equal(f.progress().phase, 'waiting-delivery')
  assert.deepEqual(plain(f.sends[0].attachments), [screenshotReference])
  await f.retry()
  assert.equal(f.executions.length, 1); assert.equal(f.sends[0].text, f.sends[1].text)
  assert.deepEqual(plain(f.sends[1].attachments), [screenshotReference]); assert.equal(f.releases.length, 1)
  assert.equal(f.progress().phase, 'waiting-model'); assert.equal(f.progress().currentStep.resultText, null)
})

test('cancelling a pending image releases its original-task file and prevents deferred upload', async () => {
  const f = fixture({ execute: async () => ({ message: 'Captured', attachments: [screenshotReference] }), send: () => 'busy' })
  f.loop.enqueue(f.request()); await f.loop.wake(); f.setLive(false)
  assert.equal(f.releases.length, 1); assert.equal(f.releases[0].lease.taskId, f.first.id)
  assert.ok(f.timers.every(timer => !timer.active)); assert.equal(f.sends.length, 1)
})

test('late image creation from an old task is cleaned without a new-task send', async () => {
  const pending = deferred(), started = deferred()
  const f = fixture({ execute: () => { started.resolve(); return pending.promise } })
  f.loop.enqueue(f.request()); await started.promise; const second = f.submit()
  pending.resolve({ message: 'Late screenshot', attachments: [screenshotReference] }); await f.loop.wake()
  assert.equal(f.sends.length, 0); assert.equal(f.releases.length, 1)
  assert.equal(f.releases[0].lease.taskId, f.first.id); assert.notEqual(second.id, f.first.id)
})

test('uncertain image upload blocks automatic resubmission and releases the local capture', async () => {
  const f = fixture({ execute: async () => ({ message: 'Captured', attachments: [screenshotReference] }), send: () => 'unknown' })
  f.loop.enqueue(f.request()); await f.loop.wake(); await f.loop.wake()
  assert.equal(f.progress().phase, 'blocked'); assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.releases.length, 1)
})

test('trusted consumed step provenance reaches adapters separately from model parameters', async () => {
  const f = fixture(), token = f.coordinator.computerStepToken('deepseek')
  f.loop.enqueue(f.request('reply-bound', { stepToken: token })); await f.loop.wake()
  const invocation = f.executions[0], result = JSON.parse(f.sends[0].text)
  assert.equal(invocation.context.step.id, result.step_id); assert.equal(invocation.context.step.token, token)
  assert.equal(invocation.context.step.sourceMessageId, 'reply-bound'); assert.equal(invocation.context.lease.taskId, f.first.id)
  assert.deepEqual(plain(invocation.parameters), {})
})

test('stale observation carries its one refreshed attachment through ordinary error delivery', async () => {
  let attempts = 0
  const f = fixture({ execute: async () => { throw new ComputerUseActionError({ code: 'stale_observation', execution: 'executed', message: 'Reobserve once',
    data: { validation: { valid: false, action_not_executed: true }, refreshed_observation: { observation_id: 'new-observation' } }, attachments: [screenshotReference] }) },
    send: () => ++attempts === 1 ? 'busy' : 'ok' })
  f.loop.enqueue(f.request()); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.code, 'stale_observation'); assert.equal(result.ok, false); assert.equal(result.data.validation.action_not_executed, true)
  assert.deepEqual(plain(f.sends[1].attachments), [screenshotReference]); assert.equal(f.executions.length, 1); assert.equal(f.releases.length, 1)
})

test('uncertain click delivery retries only its receipt and post-observation image with the same consumed step', async () => {
  let attempts = 0
  const f = fixture({ action: 'click', execute: async () => { throw new ComputerUseActionError({ code: 'click_failed', execution: 'unknown',
    message: 'Partial button sequence; inspect the new observation', data: { click: { click_attempted: true, click_completed: false, button_events_accepted: 1 }, observation: { observation_id: 'after-click' } },
    attachments: [screenshotReference] }) }, send: () => ++attempts === 1 ? 'busy' : 'ok' })
  const token = f.coordinator.computerStepToken('deepseek')
  f.loop.enqueue(f.request('click-reply', { stepToken: token })); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.action, 'click'); assert.equal(result.execution, 'unknown'); assert.equal(result.code, 'click_failed')
  assert.equal(f.executions.length, 1); assert.equal(f.sends[0].text, f.sends[1].text)
  assert.deepEqual(plain(f.sends[0].attachments), plain(f.sends[1].attachments)); assert.equal(f.releases.length, 1)
  assert.notEqual(f.coordinator.computerStepToken('deepseek'), token); assert.equal(f.progress().phase, 'waiting-model')
})

test('partial text delivery retries the same receipt and image without retyping the accepted prefix', async () => {
  let attempts = 0
  const f = fixture({ action: 'type_text', execute: async () => { throw new ComputerUseActionError({ code: 'type_text_failed', execution: 'unknown',
    message: 'Partial Unicode input; inspect current content', data: { type_text: { input_attempted: true, input_completed: false, batches: [{ accepted: 1 }] }, observation: { observation_id: 'after-text' } },
    attachments: [screenshotReference] }) }, send: () => ++attempts === 1 ? 'busy' : 'ok' })
  const token = f.coordinator.computerStepToken('deepseek')
  f.loop.enqueue(f.request('text-reply', { stepToken: token })); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.action, 'type_text'); assert.equal(result.execution, 'unknown'); assert.equal(result.code, 'type_text_failed')
  assert.equal(f.executions.length, 1); assert.equal(f.sends[0].text, f.sends[1].text); assert.equal(f.releases.length, 1)
  assert.deepEqual(plain(f.sends[0].attachments), plain(f.sends[1].attachments)); assert.notEqual(f.coordinator.computerStepToken('deepseek'), token)
})

test('uncertain shortcut delivery retries only its receipt and post-image without pressing the primary key again', async () => {
  let attempts = 0
  const f = fixture({ action: 'press_key', execute: async () => { throw new ComputerUseActionError({ code: 'press_key_failed', execution: 'unknown',
    message: 'Partial shortcut; inspect current state', data: { press_key: { key: 'Control+S', events_accepted: 2, release_keys: ['S', 'Control'], release_accepted: 2 }, observation: { observation_id: 'after-key' } },
    attachments: [screenshotReference] }) }, send: () => ++attempts === 1 ? 'busy' : 'ok' })
  const token = f.coordinator.computerStepToken('deepseek')
  f.loop.enqueue(f.request('key-reply', { stepToken: token })); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.action, 'press_key'); assert.equal(result.execution, 'unknown'); assert.equal(result.code, 'press_key_failed')
  assert.equal(f.executions.length, 1); assert.equal(f.sends[0].text, f.sends[1].text); assert.equal(f.releases.length, 1)
  assert.deepEqual(plain(f.sends[0].attachments), plain(f.sends[1].attachments)); assert.notEqual(f.coordinator.computerStepToken('deepseek'), token)
})

test('uncertain scroll delivery retries the same receipt and observation without another wheel event', async () => {
  let attempts = 0
  const f = fixture({ action: 'scroll', execute: async () => { throw new ComputerUseActionError({ code: 'scroll_failed', execution: 'unknown',
    message: 'Wheel acknowledgement lost; inspect current state', data: { scroll: { move_accepted: 1, scroll_attempted: true, scroll_completed: false,
      wheel_events_accepted: null, scroll_verified: false }, observation: { observation_id: 'after-scroll' } },
    attachments: [screenshotReference] }) }, send: () => ++attempts === 1 ? 'busy' : 'ok' })
  const token = f.coordinator.computerStepToken('deepseek')
  f.loop.enqueue(f.request('scroll-reply', { stepToken: token })); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.action, 'scroll'); assert.equal(result.execution, 'unknown'); assert.equal(result.code, 'scroll_failed')
  assert.equal(result.data.scroll.wheel_events_accepted, null); assert.equal(f.executions.length, 1)
  assert.equal(f.sends[0].text, f.sends[1].text); assert.deepEqual(plain(f.sends[0].attachments), plain(f.sends[1].attachments))
  assert.equal(f.releases.length, 1); assert.notEqual(f.coordinator.computerStepToken('deepseek'), token)
})

test('interrupted drag delivery retries only the saved receipt and post-image without holding or dragging again', async () => {
  let attempts = 0
  const f = fixture({ action: 'drag', execute: async () => { throw new ComputerUseActionError({ code: 'drag_failed', execution: 'unknown',
    message: 'Interrupted gesture; inspect current state', data: { drag: { down_accepted: 1, segments: [{ index: 1, accepted: 1, arrived: true }],
      release_required: true, release_attempted: true, release_accepted: 1, drag_completed: false }, observation: { observation_id: 'after-drag' } },
    attachments: [screenshotReference] }) }, send: () => ++attempts === 1 ? 'busy' : 'ok' })
  const token = f.coordinator.computerStepToken('deepseek')
  f.loop.enqueue(f.request('drag-reply', { stepToken: token })); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.action, 'drag'); assert.equal(result.execution, 'unknown'); assert.equal(result.code, 'drag_failed')
  assert.equal(result.data.drag.release_accepted, 1); assert.equal(f.executions.length, 1)
  assert.equal(f.sends[0].text, f.sends[1].text); assert.deepEqual(plain(f.sends[0].attachments), plain(f.sends[1].attachments))
  assert.equal(f.releases.length, 1); assert.notEqual(f.coordinator.computerStepToken('deepseek'), token)
})

test('interaction discovery result delivery retries the same references without rescanning or confirming a dialog', async () => {
  let attempts = 0
  const f = fixture({ action: 'inspect_interactions', execute: async () => ({ message: 'Read-only dialog and menu discovery',
    data: { parent_window_id: 'parent', windows: [{ kind: 'dialog', is_modal: true, window: { window_id: 'new-dialog' } }], goal_verified: false } }),
    send: () => ++attempts === 1 ? 'busy' : 'ok' })
  f.loop.enqueue(f.request('interaction-reply')); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.action, 'inspect_interactions'); assert.equal(result.data.windows[0].window.window_id, 'new-dialog')
  assert.equal(f.executions.length, 1); assert.equal(f.sends[0].text, f.sends[1].text); assert.equal(f.progress().phase, 'waiting-model')
})

test('busy wait result delivery reuses saved evidence without polling the condition again', async () => {
  let attempts = 0
  const f = fixture({ action: 'wait_for', execute: async () => { throw new ComputerUseActionError({ code: 'wait_timeout', execution: 'executed',
    message: 'Bounded wait ended', data: { condition: 'text_present', condition_met: false, checks: 4,
      last_check: { status: 'not_met' }, observation: { observation_id: 'after-wait' }, goal_verified: false }, attachments: [screenshotReference] }) },
    send: () => ++attempts === 1 ? 'busy' : 'ok' })
  const token = f.coordinator.computerStepToken('deepseek')
  f.loop.enqueue(f.request('wait-reply', { stepToken: token })); await f.loop.wake(); await f.retry()
  const result = JSON.parse(f.sends[1].text)
  assert.equal(result.action, 'wait_for'); assert.equal(result.code, 'wait_timeout'); assert.equal(result.data.condition_met, false)
  assert.equal(result.data.observation.observation_id, 'after-wait'); assert.equal(f.executions.length, 1)
  assert.equal(f.sends[0].text, f.sends[1].text); assert.deepEqual(plain(f.sends[0].attachments), plain(f.sends[1].attachments))
  assert.equal(f.releases.length, 1); assert.notEqual(f.coordinator.computerStepToken('deepseek'), token)
})

function actualClass(path, className, names, globals = {}) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  const methods = names.map(name => {
    const method = declaration.members.find(node => node.name?.getText(source) === name)
    assert.ok(method, name)
    return method.getText(source)
  }).join('\n')
  return new Script(compile(`class Actual { ${methods} }; Actual`)).runInNewContext({ structuredClone, ...globals })
}

const Runtime = actualClass('../src/main/session-runtime.ts', 'SessionRuntime', ['advanceComputerUse'])
test('the actual session entry delegates only current supported live tool requests to progression', () => {
  const requests = []
  const runtime = Object.assign(new Runtime(), {
    id: 'session-A', disposed: false, active: true, activePlatformId: 'deepseek',
    taskCoordinator: { current: () => null, owns: () => false }, backgroundTaskResults: { isSending: false },
    getComputerUseCapability: () => ({ available: true }), taskProgression: { enqueue(request) { requests.push(request); return 'accepted' } }
  })
  const request = fixture().request()
  assert.equal(runtime.advanceComputerUse(request), 'accepted')
  runtime.active = false
  assert.equal(runtime.advanceComputerUse(request), 'inactive')
  runtime.active = true
  assert.equal(runtime.advanceComputerUse({ ...request, sessionId: 'another-session' }), 'inactive')
  runtime.getComputerUseCapability = () => ({ available: false })
  assert.equal(runtime.advanceComputerUse(request), 'inactive')
  assert.equal(requests.length, 1)
})

const Embed = actualClass('../src/main/embed.ts', 'ChatGptEmbed', ['sendTaskResult'])
test('actual screenshot bridge submits one image with its result caption to the owned conversation', async () => {
  const calls = []
  const ObservationEmbed = actualClass('../src/main/embed.ts', 'ChatGptEmbed', ['sendTaskObservation'], {
    URL, sendPageFiles: async (...args) => { calls.push(args); return 'ok' }
  })
  let url = 'https://chat.deepseek.com/a/chat/original'
  const embed = Object.assign(new ObservationEmbed(), { taskPromptGeneration: 7,
    liveContents: () => ({ getURL: () => url, isDestroyed: () => false }),
    platform: { id: 'deepseek', homeUrl: 'https://chat.deepseek.com/', conversationIdFromPath: path => path.endsWith('/original') ? 'original' : 'other' } })
  const image = { path: 'synthetic-only.png', mimeType: 'image/png', sizeBytes: 100, sha256: screenshotReference.sha256 }, abort = new AbortController()
  assert.equal(await embed.sendTaskObservation('result JSON', 'original', abort.signal, [image], screenshotReference.id, () => true), 'ok')
  assert.equal(calls.length, 1); assert.equal(calls[0][2][0], image); assert.equal(calls[0][6].caption, 'result JSON')
  assert.equal(calls[0][6].computerResult.generation, 7); assert.equal(calls[0][6].computerResult.path, '/a/chat/original')
  url = 'https://chat.deepseek.com/a/chat/other'
  assert.equal(calls[0][4](), false)
  assert.equal(await embed.sendTaskObservation('result JSON', 'original', abort.signal, [image], screenshotReference.id, () => true), 'stale')
  assert.equal(calls.length, 1)
})
function pageFixture(outcome = 'ok') {
  const scripts = []
  const contents = { isDestroyed: () => false, getURL: () => 'https://chat.deepseek.com/a/chat/original',
    async executeJavaScript(script) { scripts.push(script); if (outcome instanceof Error) throw outcome; return outcome } }
  const embed = Object.assign(new Embed(), { taskPromptGeneration: 4, liveContents: () => contents,
    platform: { homeUrl: 'https://chat.deepseek.com/', conversationIdFromPath: path => path.endsWith('/original') ? 'original' : null } })
  return { embed, scripts, contents }
}

test('strict result sending pins path and page generation, and treats lost IPC as unknown', async () => {
  const f = pageFixture()
  assert.equal(await f.embed.sendTaskResult('result', 'another-chat', new AbortController().signal), 'stale')
  assert.equal(f.scripts.length, 0)
  assert.equal(await f.embed.sendTaskResult('result', 'original', new AbortController().signal), 'ok')
  assert.match(f.scripts[0], /"path":"\/a\/chat\/original"/)
  assert.match(f.scripts[0], /"generation":4/)
  assert.match(f.scripts[0], /"requireIdle":true/)
  assert.match(f.scripts[0], /computerResultToken/)
  const g = pageFixture(new Error('IPC was lost after submission'))
  assert.equal(await g.embed.sendTaskResult('result', 'original', new AbortController().signal), 'unknown')
  g.embed.liveContents = () => null
  assert.equal(await g.embed.sendTaskResult('result', 'original', new AbortController().signal), 'no-composer')
})

test('aborting an in-flight strict send cancels page retries and rejects its late acknowledgement', async () => {
  const f = pageFixture(), ack = deferred(), abort = new AbortController()
  f.contents.executeJavaScript = script => { f.scripts.push(script); return f.scripts.length === 1 ? ack.promise : Promise.resolve() }
  const sending = f.embed.sendTaskResult('result', 'original', abort.signal)
  abort.abort()
  assert.match(f.scripts[1], /cancelComputerResult/)
  ack.resolve('ok')
  assert.equal(await sending, 'stale')
})

const pageSource = ts.createSourceFile('send-interceptor.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'),
  ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
const pageMethods = new Map()
let submitNode
function findPageMethods(node) {
  if (ts.isMethodDeclaration(node) && ['sendComputerResult', 'cancelComputerResult', 'sendRaw'].includes(node.name.getText(pageSource))) {
    pageMethods.set(node.name.getText(pageSource), node.getText(pageSource))
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(pageSource) === 'submitWithRetry') submitNode = node.initializer
  ts.forEachChild(node, findPageMethods)
}
findPageMethods(pageSource)
assert.equal(pageMethods.size, 3)
assert.ok(submitNode)
function nativeSendFixture() {
  const state = { programmatic: false, taskPromptGeneration: 1, awaitingReplySince: 0, replyActionDetected: true, pendingQuestion: null }
  const composer = { value: '' }, submissions = []
  const globals = {
    PAGE: { computerUseRequests: false },
    state, location: { pathname: '/a/chat/original' }, getComposer: () => composer,
    readComposer: element => element.value, collapse: text => text.trim(), report() {},
    findStopButton: () => null, hasDraftImageAttachment: () => false, attachmentSnapshot: () => ({}), draftAttachmentEvidence: () => false,
    normalizeLineEndings: text => text, composerMatches: (element, text) => element.value === text,
    insertText(element, text) { element.value = text; return true },
    setTimeout: () => 1, clearTimeout() {}, SEND_TIMEOUT_MS: 10000, SEND_BUTTON_GRACE_MS: 700,
    submitWithRetry(...args) { submissions.push(args) },
    lastAssistantId: () => 'prior-answer', latestReplyNode: () => null, queryAllAssistant: () => [], isAssistantTurn: () => true,
    focusRowPosition: () => null, discardUserImageCapture() {},
    findSendButton() { assert.fail('a cancelled desktop result must not reach page input dispatch') }
  }
  const actual = new Script(`let computerResultToken = null;
    const controller = { ${[...pageMethods.values()].join(',\n')} };
    const retry = ${submitNode.getText(pageSource)};
    ({ controller, retry });`).runInNewContext(globals)
  return { ...actual, state, composer, submissions }
}

test('the actual native sender preserves a user draft, and cancellation prevents a delayed Send', async () => {
  const f = nativeSendFixture()
  const options = { path: '/a/chat/original', generation: 1, requireIdle: true, computerResultToken: 'step-A' }
  f.composer.value = '用户正在输入的内容'
  assert.equal(await f.controller.sendComputerResult('result', options), 'busy')
  assert.equal(f.composer.value, '用户正在输入的内容')
  assert.equal(f.submissions.length, 0)
  f.composer.value = ''
  const sending = f.controller.sendComputerResult('result', options)
  assert.equal(f.submissions.length, 1)
  const submission = f.submissions[0]
  assert.equal(submission.at(-1).computerResultToken, 'step-A')
  f.controller.cancelComputerResult('step-A')
  // An unrelated new send may now own this flag. An old retry cannot clear it.
  f.state.programmatic = true
  let lateOutcome
  f.retry('old result', 0, true, outcome => { lateOutcome = outcome }, 0, 0, 0, null, submission.at(-1))
  assert.equal(lateOutcome, 'stuck')
  assert.equal(f.state.programmatic, true)
  submission[3]('stuck')
  assert.equal(await sending, 'stuck')
})
