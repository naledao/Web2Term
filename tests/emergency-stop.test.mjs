// User-run only. Synthetic streams/executors and actual coordination code. No Electron/helper/desktop/shell.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Script } from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { fixture, deferred, plain, shared } from './fixtures/computer-action-runtime.mjs'

function load(file, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
    .runInNewContext({ exports, structuredClone, require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] } })
  return exports
}
const metadata = load('../src/shared/emergency-stop.ts')
const { EmergencyStopController } = load('../src/main/emergency-stop.ts', { '../shared/emergency-stop': metadata })
const { DesktopCoordinator } = load('../src/main/desktop-coordinator.ts')
function control(options = {}) {
  const calls = [], updates = []
  const flags = { desktopExecuting: 0, nativeBlocked: false, pid: null, draining: false, release: 'not-needed', gestureAvailable: true }
  let latch = false
  const session = { interruptComputerUse() { calls.push('session'); assert.equal(latch, true); return options.stop?.() ?? Promise.resolve() },
    isComputerUseDraining: () => flags.draining, releaseEmergencyStop() { calls.push('release-session') } }
  const controller = new EmergencyStopController({
    desktop: { setEmergencyStopped(value) { latch = value; calls.push(value ? 'close-desktop' : 'open-desktop') }, getState: () => flags },
    helper: { emergencyStop() { calls.push('stop-helper'); flags.release = flags.pid === null ? 'not-needed' : 'pending' },
      resetEmergencyStop() { calls.push('reset-helper'); return flags.pid === null }, getState: () => flags, inputReleaseStatus: () => flags.release },
    sessions: () => options.sessions ?? [session], gestureAvailable: () => flags.gestureAvailable, changed(state) { updates.push(state) }
  })
  return { controller, calls, updates, flags }
}

test('global admission closes synchronously, before cancelling helpers or sessions; repeated stop is idempotent', async () => {
  const held = deferred(), f = control({ stop: () => held.promise })
  const stopped = f.controller.trigger('mouse-gesture')
  assert.equal(stopped.active, true)
  assert.equal(stopped.source, 'mouse-gesture')
  assert.equal(stopped.gestureAvailable, false)
  assert.deepEqual(f.calls, ['close-desktop', 'stop-helper', 'session'])
  assert.equal(stopped.pendingSessions, 1)
  assert.equal(f.controller.reset().ok, false)
  f.controller.trigger('button'); assert.equal(f.calls.length, 3)
  held.resolve(); await new Promise(setImmediate)
  assert.equal(f.controller.getState().canReset, true)
  assert.equal(f.controller.reset().ok, true)
  assert.deepEqual(f.calls.slice(-3), ['reset-helper', 'release-session', 'open-desktop'])
})

test('reset waits for real native exit and running desktop permits, not cancellation acknowledgement', async () => {
  const f = control(); f.flags.pid = 9000; f.flags.desktopExecuting = 1
  f.controller.trigger('button'); await new Promise(setImmediate)
  f.flags.release = 'released'
  assert.equal(f.controller.getState().canReset, false)
  f.flags.pid = null
  assert.equal(f.controller.getState().canReset, false)
  f.flags.desktopExecuting = 0; f.flags.draining = true
  assert.equal(f.controller.getState().canReset, false)
  f.flags.draining = false
  assert.equal(f.controller.getState().canReset, true)
})

test('one failed stop does not prevent other cancellations, and unknown input release stays visible', async () => {
  let called = 0
  const f = control({ sessions: [
    { interruptComputerUse() { throw new Error('failed') }, isComputerUseDraining: () => false, releaseEmergencyStop() {} },
    { interruptComputerUse() { called++; return Promise.resolve() }, isComputerUseDraining: () => false, releaseEmergencyStop() {} }
  ] })
  f.controller.trigger('button'); await new Promise(setImmediate)
  assert.equal(called, 1); assert.equal(f.controller.getState().failedSessions, 1)
  f.flags.release = 'unconfirmed'
  assert.match(f.controller.getState().message, /释放结果未确认/)
  f.flags.gestureAvailable = false
  assert.equal(f.controller.getState().gestureAvailable, false)
})

test('global stop rejects queued desktop work while command permits remain available', async () => {
  const desktop = new DesktopCoordinator()
  const owner = { sessionId: 's', platformId: 'deepseek', conversationId: 'c', taskId: 't', generation: 1, machineId: 'm' }
  const args = { owner, kind: 'desktop', signal: new AbortController().signal, current: () => true, eligible: () => true, keep: () => true }
  const permit = await desktop.acquire(args)
  const commandPromise = desktop.acquire({ ...args, kind: 'command' })
  const queued = desktop.acquire(args); const rejection = assert.rejects(queued, /cancelled/)
  desktop.setEmergencyStopped(true); await rejection
  assert.equal(desktop.authorizes(permit, owner, 'desktop'), false)
  assert.equal(desktop.getState().executing, 1)
  assert.equal(desktop.getState().draining, true)
  await assert.rejects(desktop.acquire(args), /cancelled/)
  permit.release()
  const command = await commandPromise
  assert.equal(desktop.authorizes(command, owner, 'command'), true)
  command.release()
  assert.equal(desktop.getState().executing, 0)
  desktop.setEmergencyStopped(false)
  const fresh = await desktop.acquire(args)
  assert.notEqual(fresh, permit)
  fresh.release(); desktop.dispose()
})

test('task cancellation persists its cause and preserves a late actual receipt without continuing the old goal', async t => {
  const held = deferred(), f = fixture(t, { execute: () => held.promise })
  const owner = f.lease(), request = f.request()
  f.loop.enqueue(request); const running = f.loop.wake()
  for (let n = 0; n < 10 && !f.executions.length; n++) await new Promise(setImmediate)
  f.coordinator.stop('deepseek', 'stopped', 'global-emergency')
  assert.equal(f.coordinator.computerStepToken('deepseek'), null)
  assert.equal(f.coordinator.owns(owner), false)
  assert.equal(f.submit(), null)
  held.resolve({ type: 'computer_result', version: 1, action: 'observe', ok: true, code: 'ok', execution: 'executed', message: 'actual late receipt' })
  await running
  const task = JSON.parse(f.payload())
  assert.equal(task.status, 'stopped'); assert.equal(task.stop.reason, 'global-emergency')
  assert.ok(shared.parseAutonomousTask(f.payload()))
  assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.sends.length, 0)
  assert.equal(f.coordinator.current('deepseek'), null)
  assert.ok(f.submit())
})

function runtimeSubject() {
  const source = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionRuntime')
  const names = ['endTask', 'interruptComputerUse', 'isComputerUseDraining', 'releaseEmergencyStop', 'stopAutomation']
  const body = names.map(name => cls.members.find(n => n.name?.getText(source) === name).getText(source)).join('\n')
  const Subject = new Script(ts.transpileModule(`class Subject { ${body} }; Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({})
  const held = deferred(), calls = [], pages = new Map(['deepseek', 'chatgpt'].map(id => [id, { conversationId: 'chat-' + id, embed: {
    getState: () => ({ conversationId: 'chat-' + id }), getInterceptorStatus: () => ({ enabled: true }),
    completeTask: () => calls.push('complete:' + id), endTask: async () => { calls.push('page:' + id); return held.promise }
  } }]))
  const subject = Object.assign(new Subject(), { id: 's', activePlatformId: 'deepseek', embeds: pages, stoppingTask: null,
    computerUseStop: null, focusUploadAbort: new AbortController(), legacyToolSend: { abort: new AbortController() }, deferredCommands: new Map([['old', {}]]),
    taskCoordinator: { current: () => null, invalidateComputerStepToken: (...args) => calls.push(['invalidate', ...args]) },
    stopAutonomousTask: (...args) => calls.push(['stop', ...args]),
    focusChat: { currentTurnId: () => 'turn', stop: () => {} }, backgroundTaskResults: { cancel: () => calls.push('cancel-delivery'), cancelAll: () => calls.push('cancel-all-deliveries') },
    backgroundTasks: { cancelNotifications: () => calls.push('cancel-notifications'), cancelAllNotifications: () => calls.push('cancel-all-notifications') }, taskProgression: { cancel: () => calls.push('cancel-progression') },
    taskBackgroundWait: { reconcile: () => calls.push('cancel-wait') }, runner: { hasInFlightWork: () => false, endTask: () => { calls.push('runner'); return held.promise } },
    options: { desktopCoordinator: { releaseSession: () => calls.push('release-session') } }, refreshComputerUseCapabilities() { calls.push('refresh-capabilities') } })
  return { subject, held, calls }
}

test('ending a task invalidates buffers and sends parallel page/shell cancellation before awaiting either', async () => {
  const f = runtimeSubject(), stopping = f.subject.endTask()
  assert.equal(f.subject.taskEnded, true)
  assert.equal(f.subject.focusUploadAbort.signal.aborted, true)
  assert.equal(f.subject.legacyToolSend.abort.signal.aborted, true)
  assert.equal(f.subject.deferredCommands.size, 0)
  assert.ok(f.calls.includes('runner')); assert.ok(f.calls.includes('page:deepseek'))
  assert.ok(!f.calls.includes('page:chatgpt'))
  assert.ok(f.subject.stoppingTask)
  f.held.resolve(); await stopping
  assert.equal(f.subject.stoppingTask, null)
})

test('global emergency interrupts only active Computer Use steps and does not stop shell or background work', async () => {
  const f = runtimeSubject(), task = { id: 'task-a', generation: 1, status: 'recorded', progress: { currentStep: { tool: 'computer', status: 'executing' } } }
  f.subject.taskCoordinator.current = platformId => platformId === 'deepseek' ? task : null
  const stopping = f.subject.interruptComputerUse()
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'stop' && call[1] === 'deepseek'))
  assert.ok(f.calls.includes('complete:deepseek')); assert.ok(f.calls.includes('page:deepseek'))
  assert.ok(!f.calls.includes('page:chatgpt'))
  assert.ok(f.calls.includes('cancel-progression'))
  assert.equal(f.calls.includes('runner'), false)
  assert.equal(f.calls.includes('cancel-all-notifications'), false)
  assert.equal(f.subject.isComputerUseDraining(), true)
  f.held.resolve(); await stopping
  assert.equal(f.subject.isComputerUseDraining(), false)
})


test('a new session created while latched interrupts only Computer Use before reset', async () => {
  const f = control(); f.controller.trigger('button'); await new Promise(setImmediate)
  const held = deferred(); let releases = 0
  f.controller.sessionAdded({ interruptComputerUse: () => held.promise, isComputerUseDraining: () => false, releaseEmergencyStop: () => { releases++ } })
  assert.equal(f.controller.getState().pendingSessions, 1)
  assert.equal(f.controller.reset().ok, false)
  held.resolve(); await new Promise(setImmediate)
  assert.equal(f.controller.getState().pendingSessions, 0)
  assert.equal(releases, 0)
})


test('page stop invalidates the main generation immediately and bounds an unresponsive renderer acknowledgement', async () => {
  const ast = ts.createSourceFile('embed.ts', readFileSync(new URL('../src/main/embed.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'ChatGptEmbed')
  const method = cls.members.find(n => n.name?.getText(ast) === 'endTask').getText(ast)
  let deadline, cleared = false, generation = 0
  const Subject = new Script(ts.transpileModule(`class Subject { ${method} }; Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)
    .runInNewContext({ console: { warn() {} }, setTimeout(fn) { deadline = fn; return 1 }, clearTimeout() { cleared = true } })
  const page = deferred()
  const subject = Object.assign(new Subject(), { computerUseProtocolContext: { definitions: [], stepToken: 'old-token' },
    liveContents: () => ({ executeJavaScript: () => page.promise }), completeTask: () => { generation++; return { enabled: true } } })
  const stopping = subject.endTask()
  assert.equal(generation, 1)
  assert.equal(subject.computerUseProtocolContext.stepToken, null)
  deadline()
  assert.equal((await stopping).stopRequestAcknowledged, false)
  assert.equal(cleared, true)
  page.resolve(true); await new Promise(setImmediate)
  assert.equal(generation, 1)
})


test('state revisions keep an older reset response from replacing a later emergency event', async () => {
  const f = control()
  const stopped = f.controller.trigger('button'); await new Promise(setImmediate)
  const reset = f.controller.reset().state
  const stoppedAgain = f.controller.trigger('mouse-gesture')
  assert.ok(reset.revision > stopped.revision)
  assert.ok(stoppedAgain.revision > reset.revision)
  assert.equal(stoppedAgain.active, true)
})


test('a pending Computer Use request is invalidated without cancelling unrelated work', async () => {
  const f = runtimeSubject(), task = { id: 'task-a', generation: 2, status: 'recorded', progress: { currentStep: null } }
  f.subject.taskCoordinator.current = platformId => platformId === 'deepseek' ? task : null
  f.subject.pendingTaskComputer = { platformId: 'deepseek' }
  const stopping = f.subject.interruptComputerUse()
  assert.equal(f.subject.pendingTaskComputer, null)
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'invalidate' && call[1] === 'deepseek' && call[2] === 'task-a' && call[3] === 2))
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'stop' && call[1] === 'deepseek'))
  assert.ok(f.calls.includes('complete:deepseek') && f.calls.includes('page:deepseek'))
  assert.ok(!f.calls.includes('page:chatgpt'))
  assert.ok(!f.calls.includes('runner'))
  f.held.resolve(); await stopping
})
