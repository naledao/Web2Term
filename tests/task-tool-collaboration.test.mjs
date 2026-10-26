import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/task-tool-collaboration.test.mjs
// Actual coordinator, command runner, progression and runtime routes with synthetic IO.
// No Electron, real shells/files, network, desktop or helper processes.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, structuredClone, process, console, AbortController,
    setTimeout, clearTimeout, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; if (name === '../shared/computer-diagnostics') return load('../src/shared/computer-diagnostics.ts'); if (name === '../shared/computer-actions') return load('../src/shared/computer-actions.ts')
      assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] } })
  return exports
}
function methods(path, className, names, globals = {}) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  const body = names.map(name => { const node = declaration.members.find(item => item.name?.getText(source) === name); assert.ok(node, name); return node.getText(source) }).join('\n')
  return new Script(compile(`class Subject { ${body} }\nSubject`)).runInNewContext({ structuredClone, AbortController, process, queueMicrotask, URL, ...globals })
}
const shared = load('../src/shared/autonomous-task.ts')
const files = load('../src/shared/file-requests.ts')
const background = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', { 'node:crypto': crypto })
const { TaskProgression } = load('../src/main/task-progression.ts', { 'node:crypto': crypto })
const { DesktopCoordinator } = load('../src/main/desktop-coordinator.ts')
const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', ['taskToolMachine', 'taskToolCurrent', 'routeTaskCommand', 'flushTaskTools', 'advanceComputerUse', 'noteAutonomousReply', 'keepDesktopLease'])
const Embed = methods('../src/main/embed.ts', 'ChatGptEmbed', ['taskActionSource'])
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const path = '/a/chat/s/chat-a'

function fixture(t, options = {}) {
  let runtime, runner, serial = 0, remote = null, activeConversation = 'chat-a', enabled = true
  const tasks = new Map(), records = new Map(), history = [], shells = [], runs = [], sends = [], uploads = [], prepared = [], cleaned = [], desktop = [], computerSends = [], fileSources = []
  const store = {
    autonomousTaskGeneration: () => Math.max(0, ...[...tasks.values()].map(task => task.generation)),
    latestAutonomousTask: (_s, _p, conversation) => [...tasks.values()].filter(task => task.conversationId === conversation).at(-1) ?? null,
    autonomousTaskBySubmission: (_s, _p, submission) => [...tasks.values()].find(task => task.inputs.some(input => input.id === submission)) ?? null,
    saveAutonomousTasks(values) { for (const value of values) { assert.ok(shared.parseAutonomousTask(JSON.stringify(value))); tasks.set(value.id, structuredClone(value)); history.push(structuredClone(value)) } },
    getExecution: id => records.get(id) ? structuredClone(records.get(id)) : null,
    createExecution(record) {
      if (records.has(record.messageId)) return false
      records.set(record.messageId, { ...structuredClone(record), kind: record.fileRequest ? 'read_files' : 'command', fileRequest: record.fileRequest ?? null,
        deliveryStatus: record.fileRequest ? 'pending' : null, output: '', exitCode: null, startedAt: null, finishedAt: null }); return true
    },
    saveRecentCommandJson() {},
    listExecutions: conversation => [...records.values()].filter(row => row.conversationId === conversation).map(row => structuredClone(row)),
    setExecutionStatus: (id, status) => { records.get(id).status = status },
    finishExecution: (id, result) => Object.assign(records.get(id), result),
    setFileDeliveryStatus: (id, status) => { records.get(id).deliveryStatus = status },
    appendConversationMessage() {}, interruptRunningCommands() {}
  }
  const coordinator = new TaskCoordinator('session-a', store, () => {
    runtime?.taskProgression.reconcile(); runner?.reconcileTaskTools()
    queueMicrotask(() => runtime?.flushTaskTools())
  })
  const capability = () => ({ scopeSupported: !remote, computerUseEnabled: true, enabled: !remote, available: !remote, context: { sessionId: 'session-a', platformId: 'deepseek', connection: remote ? 'ssh' : 'local' } })
  class Shell {
    constructor(config) { this.kind = 'windows'; this.alive = true; this.running = false; this.cwd = config.initialCwd; this.label = 'Synthetic shell'; shells.push(this) }
    async run(command) {
      this.running = true; runs.push(command)
      const result = options.run ? await options.run(command) : { output: 'created C:\\work\\report.xlsx', cwd: 'C:\\work\\processed', exitCode: 0 }
      this.running = false; this.cwd = result.cwd ?? this.cwd
      return { timedOut: false, sessionLost: false, interrupted: false, ...result, cwd: this.cwd }
    }
    async interrupt() { this.running = false; return true }
    async whenQuiescent() { await options.quiescent?.() }
    dispose() {}
  }
  const { CommandRunner } = load('../src/main/commands.ts', { 'node:crypto': crypto, './shell': { ConversationShell: Shell, IDLE_TIMEOUT_MS: 300000, MAX_RUNTIME_MS: 1800000 },
    '../shared/file-requests': files, '../shared/background-tasks': background })
  runner = new CommandRunner({ store, currentConversationId: () => activeConversation, terminalModeEnabled: () => enabled, remoteShell: () => remote,
    acquireLocalCommand: options.acquireLocalCommand,
    onAdmissionChanged: options.onAdmissionChanged,
    startBackgroundTask: options.startBackgroundTask,
    taskTools: { current: context => runtime.taskToolCurrent(context), event: (context, event) => coordinator.noteToolStep(context, event),
      files: (context, sources) => fileSources.push({ context, sources }),
      format: (context, text) => text + '\n\n任务工具上下文：\n' + JSON.stringify({ task_context: shared.taskToolResultContext(context, context.stepId, context.sourceMessageId, context.tool, context.machine) }) },
    onIdle: () => { runtime.flushTaskTools(); void runtime.taskProgression.wake() },
    sendRawToPage: async (text, context) => { sends.push({ text, context }); return options.send ? options.send(text, context) : 'ok' },
    filePlatform: () => ({ id: 'deepseek', label: 'DeepSeek' }), fileContext: () => ({ scope: remote ? 'ssh' : 'local', hostId: remote ? 'remote-a' : '', cwd: runner.getLocalWorkingDirectory() }),
    async prepareFiles(request, signal) {
      prepared.push({ request, signal }); if (options.prepare) await options.prepare(request, signal)
      return { text: options.noFiles ? 'File missing' : 'Read report.xlsx', summary: 'File result', attachments: options.noFiles ? [] : [{ path: 'synthetic.xlsx' }], images: [], sources: options.sources, failed: !!options.noFiles,
        cleanup: async () => { cleaned.push(request) } }
    },
    async sendFilesToPage(result, token, current, signal) { uploads.push({ result, token, current, signal }); return options.upload ? options.upload(result, current, signal) : 'ok' },
    onExecutionChanged() {}, onTerminalChanged() {}, onRemoteLine() {}, onRemoteOutput() {}, onTaskCompleted() {}
  }, 'C:\\work')
  runner.restoreMode(options.mode ?? 'auto')
  const platform = { id: 'deepseek', conversationIdFromPath: value => value === path ? 'chat-a' : null }
  const embed = { getState: () => ({ conversationId: activeConversation }), getInterceptorStatus: () => ({ enabled }) }
  runtime = Object.assign(new Runtime(), { id: 'session-a', active: true, disposed: false, activePlatformId: 'deepseek', options: { store, localMachineId: 'machine-a' },
    environment: { workingDirectory: 'C:\\work' }, lastPersistedLocalCwd: 'C:\\work', runner, taskCoordinator: coordinator, pendingTaskCommand: null, pendingTaskComputer: null, pendingTaskReply: null,
    backgroundTaskResults: { isSending: false },
    embed, embeds: new Map([['deepseek', { platform, embed, conversationId: 'chat-a' }]]), getComputerUseCapability: capability })
  const progression = new TaskProgression({ coordinator, isCurrent: () => runtime.active && !runtime.disposed, canRun: () => runner.canSendAutomaticResult(),
    machine: () => runtime.taskToolMachine('deepseek'),
    invoke: async (call, lease, signal, step) => { desktop.push({ call, lease, signal, step }); return { type: 'computer_result', version: 1, action: call.action, ok: true, execution: 'executed', code: 'ok', message: 'Observed synthetic report' } },
    send: async text => { computerSends.push(text); return options.computerSend ? options.computerSend(text) : 'ok' },
    onError: () => assert.fail('unexpected persistence error'), schedule: () => () => {} })
  runtime.taskProgression = progression
  const submit = () => coordinator.submit({ platformId: 'deepseek', conversationId: 'chat-a', submission: { id: `user:goal:${++serial}`, kind: 'goal' }, text: '生成报表并打开核对。',
    attachments: [], capability: capability(), machine: { id: 'machine-a', label: '本机', platform: process.platform, arch: process.arch, connection: 'local', workingDirectory: 'C:\\work' } })
  submit()
  const command = (messageId = 'cmd-a', patch = {}) => {
    const result = { messageId, command: 'Write-Output report', description: 'Prepare report', timeoutSeconds: 30, live: true,
      taskSource: { sourceSubmissionId: coordinator.current('deepseek').sourceSubmissionId, taskPromptGeneration: 7, pagePath: path }, ...patch }
    if (result.type === 'read_files') { delete result.command; delete result.timeoutSeconds }
    return result
  }
  const computer = (messageId = 'computer:a') => { const task = coordinator.current('deepseek'); return { sessionId: task.sessionId, platformId: task.platformId,
    conversationId: task.conversationId, taskId: task.id, generation: task.generation, sourceMessageId: messageId,
    stepToken: coordinator.computerStepToken('deepseek'), call: { action: 'observe', parameters: { target: 'window', window_id: 'synthetic-window' } } } }
  t.after(() => { progression.dispose(); runner.disposeAll() })
  return { runtime, runner, coordinator, store, records, tasks, history, shells, runs, sends, uploads, prepared, cleaned, desktop, computerSends, fileSources, command, computer, submit,
    route: action => runtime.routeTaskCommand(action), progress: () => coordinator.current('deepseek').progress,
    remote: () => { remote = { running: false, alive: true, kind: 'posix', cwd: '/remote', run: async () => ({ output: 'Synthetic remote result', exitCode: 0, cwd: '/remote' }) } }, switchConversation: () => { activeConversation = 'chat-b' }, disable: () => { enabled = false },
    async settled() { for (let n = 0; n < 30; n++) { await new Promise(resolve => setImmediate(resolve)); if (!runner.hasInFlightWork()) break } }
  }
}

function admissionFixture(t, options = {}) {
  const desktop = new DesktopCoordinator()
  let keep = true, admissions = 0
  const foreign = { sessionId: 'foreign-session', platformId: 'deepseek', conversationId: 'foreign-chat', taskId: 'foreign-goal', generation: 1, machineId: 'machine-a' }
  const holder = desktop.acquire({ owner: foreign, kind: 'desktop', signal: new AbortController().signal,
    current: () => true, eligible: () => true, keep: () => keep })
  const f = fixture(t, { ...options,
    acquireLocalCommand(record, signal, conditions) {
      admissions++
      const context = record.taskContext ?? { sessionId: 'session-a', platformId: 'deepseek', conversationId: record.conversationId, taskId: 'legacy-command', generation: 1 }
      return desktop.acquire({ owner: { ...context, machineId: record.taskContext?.machine.id ?? 'machine-a' }, kind: 'command', signal,
        current: conditions.current, eligible: conditions.eligible, keep: () => false, waiting: conditions.waiting })
    }, onAdmissionChanged: () => desktop.reconcile() })
  t.after(() => desktop.dispose())
  return { ...f, desktopCoordinator: desktop, admissions: () => admissions,
    async free() { (await holder).release(); keep = false; desktop.reconcile() } }
}

test('local model command queues before shell creation and resumes once without duplicate manual execution', async t => {
  const f = admissionFixture(t); f.route(f.command()); await f.settled()
  assert.equal(f.shells.length, 0); assert.equal(f.runs.length, 0)
  assert.equal(f.progress().phase, 'waiting-tool'); assert.equal(f.progress().currentStep.execution, 'not_executed')
  assert.match(f.progress().detail, /全局桌面/)
  await f.runner.runExecution('cmd-a'); assert.equal(f.admissions(), 1)
  await f.free(); await f.settled()
  assert.equal(f.runs.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.admissions(), 1)
  assert.equal(f.desktopCoordinator.getState().executing, 0)
})

test('legacy local model commands also queue; read-only files and remote commands use existing execution paths', async t => {
  const local = admissionFixture(t); local.route(local.command('legacy', { taskSource: undefined }))
  await local.settled(); assert.equal(local.shells.length, 0); assert.equal(local.admissions(), 1)
  await local.free(); await local.settled(); assert.equal(local.runs.length, 1)
  const files = admissionFixture(t)
  files.route(files.command('files', { type: 'read_files', files: [{ path: 'report.xlsx' }], command: undefined }))
  await files.settled(); assert.equal(files.prepared.length, 1); assert.equal(files.admissions(), 0)
  const remote = admissionFixture(t); remote.remote()
  remote.route(remote.command('remote', { taskSource: undefined })); await remote.settled()
  assert.equal(remote.admissions(), 0); assert.equal(remote.shells.length, 0)
})

test('runtime yields its sticky lease on ordinary reply, questions, pause and inactive scope without claiming completion', async t => {
  const f = fixture(t)
  f.runtime.advanceComputerUse(f.computer()); await f.runtime.taskProgression.wake()
  const task = f.coordinator.current('deepseek'), lease = { ...task, taskId: task.id }
  assert.equal(f.runtime.keepDesktopLease(lease), true)
  f.runner.setPaused(true); assert.equal(f.runtime.keepDesktopLease(lease), false)
  f.runner.setPaused(false); assert.equal(f.runtime.keepDesktopLease(lease), true)
  f.runtime.active = false; assert.equal(f.runtime.keepDesktopLease(lease), false); f.runtime.active = true
  f.coordinator.noteReply('deepseek', 'reply', 'response')
  assert.equal(f.runtime.keepDesktopLease(lease), false); assert.equal(f.coordinator.current('deepseek').status, 'recorded')
  f.coordinator.noteReply('deepseek', 'question', 'question')
  assert.equal(f.runtime.keepDesktopLease(lease), false)
})

test('switching a queued auto command to manual requires the existing explicit Run action', async t => {
  const f = admissionFixture(t); f.route(f.command()); await f.settled()
  f.runner.setMode('manual'); await f.free(); await f.settled()
  assert.equal(f.runs.length, 0); assert.equal(f.shells.length, 0)
  await f.runner.runExecution('cmd-a'); await f.settled()
  assert.equal(f.runs.length, 1); assert.equal(f.admissions(), 1)
})

test('pausing queued commands prevents execution until resume; skipping cancels without creating a shell', async t => {
  const f = admissionFixture(t); f.route(f.command()); await f.settled()
  f.runner.setPaused(true); await f.free(); await f.settled(); assert.equal(f.runs.length, 0)
  f.runner.setPaused(false); await f.settled(); assert.equal(f.runs.length, 1)
  const g = admissionFixture(t); g.route(g.command()); await g.settled()
  g.runner.skipExecution('cmd-a'); await g.free(); await g.settled()
  assert.equal(g.shells.length, 0); assert.equal(g.records.get('cmd-a').status, 'skipped')
})

test('ending or superseding a task cancels its queued local command before any shell preparation', async t => {
  for (const end of [f => f.runner.endTask(), f => { f.submit(); f.desktopCoordinator.reconcile() }, f => f.runner.resetTerminal()]) {
    const f = admissionFixture(t); f.route(f.command()); await f.settled()
    end(f); await f.free(); await f.settled()
    assert.equal(f.shells.length, 0); assert.equal(f.runs.length, 0)
    assert.equal(f.records.get('cmd-a').status, 'skipped')
  }
})

test('local command permit remains held when the result returned before process retirement', async t => {
  const drain = deferred(), f = admissionFixture(t, { quiescent: () => drain.promise })
  f.route(f.command()); await f.free(); await f.settled()
  assert.equal(f.runs.length, 1); assert.equal(f.sends.length, 1)
  assert.equal(f.desktopCoordinator.getState().executing, 1)
  f.runner.disposeAll(); assert.equal(f.desktopCoordinator.getState().executing, 1)
  drain.resolve(); await f.settled(); assert.equal(f.desktopCoordinator.getState().executing, 0)
})

test('command, file upload and desktop observation share one task, distinct steps and actual machine context', async t => {
  const f = fixture(t), task = f.coordinator.current('deepseek')
  f.route(f.command()); await f.settled()
  const record = f.records.get('cmd-a'); assert.ok(shared.parseTaskToolContext(record.taskContext))
  assert.equal(record.taskContext.taskId, task.id); assert.equal(f.progress().phase, 'waiting-model'); assert.equal(f.runs.length, 1)
  assert.equal(f.sends[0].context.stepId, record.taskContext.stepId); assert.match(f.sends[0].text, /"tool":"command"/)
  f.route(f.command('files-a', { type: 'read_files', files: [{ path: 'report.xlsx' }], command: undefined })); await f.settled()
  assert.equal(f.prepared.length, 1); assert.equal(f.uploads.length, 1); assert.match(f.uploads[0].result.text, /"tool":"read_files"/)
  assert.equal(f.uploads[0].current(), true); assert.equal(f.progress().phase, 'waiting-model')
  assert.equal(f.runtime.advanceComputerUse(f.computer()), 'accepted'); await f.runtime.taskProgression.wake()
  const result = JSON.parse(f.computerSends[0])
  assert.equal(result.task_context.task_id, task.id); assert.equal(result.task_context.machine.id, 'machine-a')
  assert.equal(result.task_context.machine.working_directory, 'C:\\work\\processed'); assert.equal(result.task_context.tool, 'computer')
  assert.equal(new Set([record.taskContext.stepId, f.records.get('files-a').taskContext.stepId, result.step_id]).size, 3)
  assert.equal(f.progress().stepCount, 3); assert.equal(f.desktop.length, 1); assert.equal(f.tasks.size, 1)
  f.route(f.command()); await f.settled(); assert.equal(f.runs.length, 1)
})

test('manual mode preserves confirmation and a stale queued task never executes on a replacement machine', async t => {
  const f = fixture(t, { mode: 'manual' }); f.route(f.command()); await f.settled()
  assert.equal(f.runs.length, 0); assert.equal(f.progress().phase, 'waiting-tool')
  await f.runner.runExecution('cmd-a'); assert.equal(f.runs.length, 1); assert.equal(f.progress().phase, 'waiting-model')
  const g = fixture(t, { mode: 'manual' }); g.route(g.command()); g.remote(); await g.runner.runExecution('cmd-a')
  assert.equal(g.runs.length, 0); assert.equal(g.records.get('cmd-a').status, 'skipped')
})

test('stale goals and routes do not downgrade tagged requests into ordinary terminal commands', async t => {
  const f = fixture(t), old = f.command(); f.submit(); f.route(old)
  f.route(f.command('wrong-path', { taskSource: { ...f.command().taskSource, pagePath: '/a/chat/s/another' } }))
  await f.settled(); assert.equal(f.records.size, 0); assert.equal(f.runs.length, 0); assert.equal(f.progress().stepCount, 0)
  f.route(f.command('legacy', { live: false, taskSource: undefined })); await f.settled()
  assert.equal(f.records.get('legacy').taskContext, undefined); assert.equal(f.progress().stepCount, 0)
})

test('late shell completion preserves execution history without sending into a new task', async t => {
  const gate = deferred(), f = fixture(t, { run: () => gate.promise })
  f.route(f.command()); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.runs.length, 1)
  f.submit(); gate.resolve({ output: 'actual old result', cwd: 'C:\\work', exitCode: 0 }); await f.settled()
  assert.equal(f.records.get('cmd-a').output, 'actual old result'); assert.equal(f.records.get('cmd-a').status, 'done')
  assert.equal(f.sends.length, 0); assert.equal(f.progress().stepCount, 0)
})

test('late file preparation is cancelled before upload and its staging result is cleaned', async t => {
  const gate = deferred(), f = fixture(t, { prepare: () => gate.promise })
  f.route(f.command('files-a', { type: 'read_files', files: [{ path: 'report.xlsx' }], command: undefined }))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.prepared.length, 1)
  f.submit(); gate.resolve(); await f.settled()
  assert.equal(f.prepared[0].signal.aborted, true); assert.equal(f.uploads.length, 0); assert.equal(f.cleaned.length, 1)
  assert.equal(f.records.get('files-a').deliveryStatus, 'cancelled'); assert.equal(f.progress().stepCount, 0)
})

test('a fast command waits for the preceding computer result acknowledgement', async t => {
  const gate = deferred(), f = fixture(t, { computerSend: () => gate.promise })
  assert.equal(f.runtime.advanceComputerUse(f.computer()), 'accepted'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.progress().currentStep.delivery, 'sending'); f.route(f.command())
  assert.equal(f.runs.length, 0); assert.ok(f.runtime.pendingTaskCommand)
  gate.resolve('ok'); await f.runtime.taskProgression.wake(); await f.settled()
  assert.equal(f.runs.length, 1); assert.equal(f.progress().stepCount, 2)
})

test('a fast computer request waits for legacy result acknowledgement and is never dispatched after uncertainty', async t => {
  for (const outcome of ['ok', 'unknown']) {
    const gate = deferred(), f = fixture(t, { send: () => gate.promise })
    f.route(f.command()); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.progress().currentStep.delivery, 'sending')
    assert.equal(f.runtime.advanceComputerUse(f.computer()), 'deferred'); assert.equal(f.desktop.length, 0)
    gate.resolve(outcome); await f.settled(); await f.runtime.taskProgression.wake()
    assert.equal(f.desktop.length, outcome === 'ok' ? 1 : 0)
    if (outcome === 'unknown') { assert.equal(f.progress().phase, 'blocked'); assert.equal(f.records.get('cmd-a').status, 'done'); assert.equal(f.runs.length, 1) }
  }
})

test('fast final replies and clarification questions retain their task state after a legacy send', async t => {
  for (const kind of ['response', 'question']) {
    const gate = deferred(), f = fixture(t, { send: () => gate.promise })
    f.route(f.command()); await new Promise(resolve => setImmediate(resolve))
    f.runtime.noteAutonomousReply('deepseek', 'final-reply', kind); gate.resolve('ok'); await f.settled()
    assert.equal(f.progress().phase, kind === 'question' ? 'waiting-user' : 'responded')
  }
})

test('retrying a busy file delivery reuses prepared bytes and step identity, while unknown is not retried', async t => {
  for (const first of ['busy', 'unknown']) {
    let sends = 0
    const f = fixture(t, { upload: () => ++sends === 1 ? first : 'ok' })
    f.route(f.command('files-a', { type: 'read_files', files: [{ path: 'report.xlsx' }], command: undefined })); await f.settled()
    const step = f.progress().currentStep.id; await f.runner.retryTaskResults(); await f.settled()
    assert.equal(f.prepared.length, 1); assert.equal(f.progress().currentStep.id, step)
    assert.equal(f.uploads.length, first === 'busy' ? 2 : 1)
    assert.equal(f.progress().phase, first === 'busy' ? 'waiting-model' : 'blocked')
  }
})

test('a missing file reports its real read error without attachments and never claims output verification', async t => {
  const f = fixture(t, { noFiles: true })
  f.route(f.command('files-a', { type: 'read_files', files: [{ path: 'missing.xlsx' }], command: undefined })); await f.settled()
  assert.equal(f.uploads.length, 0); assert.equal(f.sends.length, 1); assert.match(f.sends[0].text, /File missing/)
  assert.equal(f.records.get('files-a').status, 'failed'); assert.equal(f.progress().phase, 'waiting-model')
})

test('busy bound text delivery retries the saved result and does not run the command twice', async t => {
  let attempts = 0
  const f = fixture(t, { send: () => ++attempts === 1 ? 'busy' : 'ok' })
  f.route(f.command()); await f.settled()
  assert.equal(f.progress().phase, 'waiting-delivery'); assert.equal(f.records.get('cmd-a').status, 'done')
  const step = f.progress().currentStep.id
  await f.runner.retryTaskResults(); await f.settled()
  assert.equal(f.runs.length, 1); assert.equal(f.sends.length, 2); assert.equal(f.sends[0].text, f.sends[1].text)
  assert.equal(f.progress().currentStep.id, step); assert.equal(f.progress().phase, 'waiting-model')
  await f.runner.retryTaskResults(); assert.equal(f.sends.length, 2)
})

test('queued saved results are discarded on goal replacement and corrupt task provenance cannot execute', async t => {
  const f = fixture(t, { send: () => 'busy' })
  f.route(f.command()); await f.settled(); f.submit(); await f.runner.retryTaskResults()
  assert.equal(f.sends.length, 1); assert.equal(f.records.get('cmd-a').status, 'done')
  const g = fixture(t, { mode: 'manual' }); g.route(g.command()); g.records.get('cmd-a').taskContext = null
  await g.runner.runExecution('cmd-a'); assert.equal(g.runs.length, 0)
})

test('resetting the terminal discards its saved delivery without rerunning or resending', async t => {
  const f = fixture(t, { send: () => 'busy' })
  f.route(f.command()); await f.settled(); f.runner.resetTerminal(); await f.runner.retryTaskResults()
  assert.equal(f.runs.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.progress().phase, 'blocked')
})

test('main bridge validates task provenance separately from the original command JSON', () => {
  const embed = Object.assign(new Embed(), { computerUseRecognitionEnabled: true, taskPromptGeneration: 7,
    platform: { id: 'deepseek', allowedOriginPattern: /^https:\/\/chat\.deepseek\.com\//, conversationIdFromPath: value => value === path ? 'chat-a' : null },
    liveContents: () => ({ getURL: () => 'https://chat.deepseek.com' + path }) })
  const payload = { live: true, sourceSubmissionId: 'user:goal:1', taskPromptGeneration: 7, pagePath: path }
  assert.equal(embed.taskActionSource(payload).sourceSubmissionId, 'user:goal:1')
  for (const patch of [{ live: false }, { taskPromptGeneration: 6 }, { pagePath: '/a/chat/s/other' }, { sourceSubmissionId: 'forged' }]) assert.equal(embed.taskActionSource({ ...payload, ...patch }), undefined)
})

test('persisted task contexts have strict scope, kind and local machine contracts', () => {
  const context = { sessionId: 's', platformId: 'deepseek', conversationId: 'c', taskId: 't', generation: 1, stepId: crypto.randomUUID(), sourceMessageId: 'reply', tool: 'command',
    machine: { id: 'm', label: 'local', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\work' } }
  assert.deepEqual(plain(shared.parseTaskToolContext(context)), context)
  for (const patch of [{ generation: 0 }, { conversationId: null }, { extra: true }, { tool: 'computer' }, { machine: { ...context.machine, connection: 'ssh' } }]) assert.equal(shared.parseTaskToolContext({ ...context, ...patch }), null)
})

test('a fast computer request waits for the background notification send acknowledgement', async t => {
  const f = fixture(t), task = f.coordinator.current('deepseek')
  const lease = { sessionId: task.sessionId, platformId: task.platformId, conversationId: task.conversationId, taskId: task.id, generation: task.generation }
  const startup = f.coordinator.reserveToolStep(lease, 'background:start', 'command', task.machine)
  f.coordinator.noteToolStep(startup, { stage: 'background', execution: 'executed' })
  f.runtime.backgroundTaskResults.isSending = true
  const request = f.computer('after-background')
  assert.equal(f.runtime.advanceComputerUse(request), 'deferred')
  f.runtime.noteAutonomousReply('deepseek', request.sourceMessageId, 'response')
  f.runtime.flushTaskTools()
  assert.equal(f.desktop.length, 0)
  f.coordinator.noteBackgroundDelivery(startup, false)
  f.runtime.backgroundTaskResults.isSending = false
  f.runtime.flushTaskTools(); await f.settled()
  assert.equal(f.desktop.length, 1)
  assert.equal(f.progress().currentStep.sourceMessageId, 'after-background')
})

test('uncertain background delivery blocks its deferred command without executing it', async t => {
  const f = fixture(t), task = f.coordinator.current('deepseek')
  const lease = { sessionId: task.sessionId, platformId: task.platformId, conversationId: task.conversationId, taskId: task.id, generation: task.generation }
  const startup = f.coordinator.reserveToolStep(lease, 'background:start', 'command', task.machine)
  f.coordinator.noteToolStep(startup, { stage: 'background', execution: 'executed' })
  f.runtime.backgroundTaskResults.isSending = true
  f.route(f.command('after-background'))
  assert.equal(f.runs.length, 0)
  f.coordinator.noteBackgroundDelivery(startup, true)
  f.runtime.backgroundTaskResults.isSending = false
  f.runtime.flushTaskTools(); await f.settled()
  assert.equal(f.progress().phase, 'blocked'); assert.equal(f.runs.length, 0)
  assert.equal(f.records.has('after-background'), false)
})

test('a reused background startup is delivered as not executed and never launches a shell command', async t => {
  const f = fixture(t, { startBackgroundTask: async (_record, shell) => ({ registered: 0, reused: true,
    result: { output: 'Reuse existing background_id: task-a; no launch occurred', exitCode: 0, cwd: shell.cwd, rejected: false, interrupted: false, sessionLost: false, timedOut: false } }) })
  f.route(f.command('repeat-background', { background: true, backgroundOptions: { kind: 'job' } }))
  await f.settled()
  assert.equal(f.runs.length, 0); assert.equal(f.sends.length, 1)
  assert.equal(f.records.get('repeat-background').status, 'skipped')
  assert.equal(f.progress().currentStep.execution, 'not_executed')
  assert.equal(f.progress().phase, 'waiting-model')
  assert.match(f.sends[0].text, /no launch occurred/)
})

test('read sources reach the task index once and are not recaptured on upload retry or after a goal change', async t => {
  let deliveries = 0
  const sources = [{ path: 'C:\\work\\report.xlsx', sizeBytes: 42, sha256: 'a'.repeat(64) }]
  const f = fixture(t, { sources, upload: () => ++deliveries === 1 ? 'busy' : 'ok' })
  f.route(f.command('files-with-source', { type: 'read_files', files: [{ path: 'report.xlsx' }] })); await f.settled()
  assert.equal(f.fileSources.length, 1)
  assert.deepEqual(f.fileSources[0].sources, sources)
  await f.runner.retryTaskResults(); await f.settled()
  assert.equal(f.prepared.length, 1); assert.equal(f.fileSources.length, 1)
  const gate = deferred(), stale = fixture(t, { sources, prepare: () => gate.promise })
  stale.route(stale.command('stale-files', { type: 'read_files', files: [{ path: 'report.xlsx' }] }))
  for (let i = 0; i < 20 && !stale.prepared.length; i++) await new Promise(setImmediate)
  stale.submit(); gate.resolve(); await stale.settled()
  assert.equal(stale.fileSources.length, 0)
})


test('an empty command in an autonomous goal sends evidence requirements without running a shell or completing', async t => {
  const f = fixture(t)
  f.route(f.command('completion-claim', { command: '', description: '模型说已完成' }))
  await f.settled()
  assert.equal(f.runs.length, 0)
  assert.equal(f.records.get('completion-claim').status, 'skipped')
  assert.equal(f.sends.length, 1)
  assert.match(f.sends[0].text, /task_completion_required/)
  assert.match(f.sends[0].text, /computer.complete_task/)
  assert.equal(f.coordinator.current('deepseek').status, 'recorded')
  assert.equal(f.progress().phase, 'waiting-model')
  assert.equal(f.coordinator.completionNotificationAllowed('deepseek', 'chat-a'), false)
})
