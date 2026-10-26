// User-run only. Actual coordinator/journal/runtime/bridge code with synthetic pages and receipts.
// No Electron/helper processes, desktop input, browser profile, real shell, artifacts or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { fixture, deferred } from './fixtures/computer-action-runtime.mjs'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'

const presentation = progressVmModules['../shared/task-presentation']
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function actualClass(path, name, names, globals = {}) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === name)
  const body = names.map(name => cls.members.find(n => n.name?.getText(source) === name).getText(source)).join('\n')
  return new Script(compile(`class Subject { ${body} }; Subject`)).runInNewContext({ URL, AbortController, structuredClone,
    console: { info() {}, warn() {} }, ...presentation, ...globals })
}
const Runtime = actualClass('../src/main/session-runtime.ts', 'SessionRuntime', [
  'stopAutonomousTask', 'interruptTaskControl', 'setActive', 'switchPlatform', 'embedHandlers'
], { supportsFocusView: () => false, buildTerminalPromptParts: () => ({ prefix: 'unchanged', suffix: '' }),
  DEEPSEEK_PLATFORM: { id: 'deepseek' }, IpcChannels: { embedState: 'embed', interceptorEvent: 'interceptor', questionChatState: 'question' },
  process: { platform: 'win32', arch: 'x64' } })

function runtime(f) {
  const calls = [], runtime = new Runtime(), mutable = { conversationId: 'chat-a' }
  const embed = { getState: () => ({ conversationId: mutable.conversationId }), getInterceptorStatus: () => ({}),
    getComputerUsePageEpoch: () => 'document-a', getQuestionChatState: () => ({}), setPromptParts() {}, armCommandBaseline: async () => {},
    completeTask: () => calls.push('revoke-page-generation'), resetTaskPrompt: () => calls.push('reset-prompt') }
  const next = { ...embed, getState: () => ({ conversationId: 'chat-b' }) }
  const deepseek = { id: 'deepseek', label: 'DeepSeek' }, chatgpt = { id: 'chatgpt', label: 'ChatGPT' }
  Object.assign(runtime, { id: f.first.sessionId, active: true, disposed: false, activePlatformId: 'deepseek', taskEnded: false, focusSending: false,
    taskCoordinator: f.coordinator, taskProgression: f.loop, computerUseTool: {}, environment: { workingDirectory: 'C:\\work' }, preferredSendDelaySeconds: 4,
    taskBackgroundWait: { reconcile: () => calls.push('wait-reconcile') },
    embeds: new Map([['deepseek', { platform: deepseek, conversationId: 'chat-a', embed }], ['chatgpt', { platform: chatgpt, conversationId: 'chat-b', embed: next }]]),
    deferredCommands: new Map([['pending', {}]]),
    options: { store: f.store, localMachineId: 'machine-a', onSummaryChanged() {},
      computerUseObservations: { invalidateInput: (_tool, lease) => calls.push(['invalidate', lease]) }, desktopCoordinator: { reconcile: () => calls.push('desktop-reconcile') } },
    backgroundTaskResults: { cancel: owner => calls.push(['cancel-result', owner]) }, backgroundTasks: { cancelNotifications: owner => calls.push(['cancel-notification', owner]) },
    runner: { reconcileTaskTools: () => calls.push('runner-reconcile'), setSendDelay() {}, getAutomation: () => ({ mode: 'manual' }), getTerminalState: () => ({ cwd: 'C:\\work' }) },
    focusChat: { begin: () => 'original-history-turn' }, syncWindowsHelperDemand() {}, applyVisibility() {}, send() {}, toolPrompt: () => 'original tools',
    syncAutonomousTask: (platform, conversation) => f.coordinator.context(platform, conversation), taskRunning: () => true,
    getComputerUseCapability: platform => ({ scopeSupported: true, computerUseEnabled: true, context: { sessionId: f.first.sessionId, platformId: platform } }),
    ensureEmbed: platform => runtime.embeds.get(platform) })
  return { runtime, calls, mutable, embed, handlers: runtime.embedHandlers(deepseek) }
}

test('session handover cancels the owned queues, input bindings and page generation without resuming on return', t => {
  const f = fixture(t), g = runtime(f), lease = f.lease(), controller = new AbortController()
  Object.assign(g.runtime, { pendingTaskCommand: { lease }, pendingTaskComputer: lease, pendingTaskReply: { lease },
    taskRecoverySend: { request: lease }, legacyToolSend: { context: lease, abort: controller } })
  g.runtime.setActive(false)
  assert.equal(JSON.parse(f.payload()).status, 'interrupted'); assert.equal(controller.signal.aborted, true)
  assert.equal(g.runtime.taskEnded, true); assert.equal(g.runtime.deferredCommands.size, 0)
  for (const field of ['pendingTaskCommand', 'pendingTaskComputer', 'pendingTaskReply', 'taskRecoverySend']) assert.equal(g.runtime[field], null)
  assert.ok(g.calls.some(c => c === 'revoke-page-generation')); assert.ok(g.calls.some(c => Array.isArray(c) && c[0] === 'invalidate'))
  g.runtime.setActive(true)
  assert.equal(f.coordinator.current('deepseek'), null); assert.equal(g.runtime.taskEnded, true)
})

test('a task-associated model switch interrupts the old task before selecting the new platform', t => {
  const f = fixture(t), g = runtime(f)
  assert.equal(g.runtime.switchPlatform('chatgpt'), true)
  assert.equal(JSON.parse(f.payload()).status, 'interrupted'); assert.equal(g.runtime.activePlatformId, 'chatgpt')
  assert.equal(g.runtime.taskEnded, true); assert.equal(f.executions.length, 0)
  assert.ok(g.calls.includes('revoke-page-generation'))
})

test('switching remains blocked for an unassociated legacy task or a human message still being submitted', t => {
  const f = fixture(t), g = runtime(f)
  g.runtime.focusSending = true; assert.equal(g.runtime.switchPlatform('chatgpt'), false)
  assert.ok(f.coordinator.current('deepseek'))
  g.runtime.focusSending = false; f.coordinator.stop('deepseek', 'interrupted')
  assert.equal(g.runtime.switchPlatform('chatgpt'), false)
  assert.equal(g.runtime.activePlatformId, 'deepseek')
})

test('a real conversation change cancels original task authority before loading the other conversation', t => {
  const f = fixture(t), g = runtime(f)
  g.mutable.conversationId = 'chat-b'
  g.handlers.onState({ url: '', conversationId: 'chat-b' })
  assert.equal(JSON.parse(f.payload()).status, 'interrupted'); assert.equal(g.runtime.embeds.get('deepseek').conversationId, 'chat-b')
  assert.equal(g.runtime.taskEnded, true); assert.ok(g.calls.includes('revoke-page-generation'))
})

test('the SPA assigning the first conversation preserves the confirmed pending goal and its generation', t => {
  const f = fixture(t), pending = f.submit({ conversationId: null }), g = runtime(f)
  g.runtime.embeds.get('deepseek').conversationId = null
  g.handlers.onState({ url: '', conversationId: 'chat-a' })
  const bound = f.coordinator.current('deepseek')
  assert.equal(bound.id, pending.id); assert.equal(bound.generation, pending.generation); assert.equal(bound.conversationId, 'chat-a')
  assert.equal(g.runtime.taskEnded, false); assert.equal(g.calls.includes('revoke-page-generation'), false)
})

test('late confirmed sends from inactive, switched or disposed control pages cannot reopen the task', t => {
  const f = fixture(t), g = runtime(f)
  g.runtime.setActive(false)
  const generation = f.store.autonomousTaskGeneration(f.first.sessionId)
  for (const patch of [{ active: false, disposed: false, activePlatformId: 'deepseek' }, { active: true, disposed: false, activePlatformId: 'chatgpt' }, { active: true, disposed: true, activePlatformId: 'deepseek' }]) {
    Object.assign(g.runtime, patch)
    assert.equal(g.handlers.onUserStarted('late goal', [], undefined, { id: 'user:late', kind: 'goal' }), patch.disposed ? undefined : 'original-history-turn')
    assert.equal(g.runtime.taskEnded, true)
    assert.equal(f.store.autonomousTaskGeneration(f.first.sessionId), generation)
  }
  g.runtime.embeds.clear()
  assert.doesNotThrow(() => g.handlers.onState({ url: '', conversationId: 'closed-page' }))
  assert.doesNotThrow(() => g.handlers.onComputerDocumentChanged())
})

test('a document replacement revokes the original task even when its conversation identifier is unchanged', t => {
  const f = fixture(t), g = runtime(f), token = f.coordinator.computerStepToken('deepseek'), lease = f.lease()
  g.handlers.onComputerDocumentChanged()
  assert.equal(f.coordinator.current('deepseek'), null); assert.equal(f.coordinator.isComputerStepToken(lease, token, true), false)
  assert.equal(g.mutable.conversationId, 'chat-a'); assert.ok(g.calls.includes('revoke-page-generation'))
})

test('an old hidden platform being invalidated does not cancel the new platform pending work', t => {
  const f = fixture(t), g = runtime(f), other = { platformId: 'chatgpt', taskId: 'another-task' }, abort = new AbortController()
  g.runtime.activePlatformId = 'chatgpt'
  g.runtime.pendingTaskComputer = other; g.runtime.pendingTaskCommand = { lease: other }; g.runtime.legacyToolSend = { context: other, abort }
  g.handlers.onComputerDocumentChanged()
  assert.equal(g.runtime.pendingTaskComputer, other); assert.equal(g.runtime.pendingTaskCommand.lease, other)
  assert.equal(abort.signal.aborted, false); assert.equal(g.runtime.taskEnded, false)
})

test('a late native result refines original journal facts after handover but cannot send to the new control page', async t => {
  const held = deferred(), f = fixture(t, { execute: () => held.promise }), g = runtime(f), lease = f.lease()
  const request = f.request(); assert.equal(f.loop.enqueue(request), 'accepted')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.executions.length, 1)
  g.runtime.setActive(false)
  held.resolve({ type: 'computer_result', version: 1, action: request.call.action, ok: true, code: 'ok', execution: 'executed', message: 'Actual synthetic late receipt' })
  await f.loop.wake()
  assert.equal(f.state().execution_fact, 'executed'); assert.equal(f.sends.length, 0)
  assert.equal(f.store.listComputerActions(lease)[0].generation, lease.generation)
  assert.equal(JSON.parse(f.payload()).status, 'interrupted')
})

const Embed = actualClass('../src/main/embed.ts', 'ChatGptEmbed', ['sendTaskResult', 'sendTaskObservation'])
function textPage() {
  const held = deferred(), scripts = [], mutable = { url: 'https://chat.deepseek.com/a/chat/s/chat-a', current: true }
  const contents = { getURL: () => mutable.url, isDestroyed: () => false, executeJavaScript: script => { scripts.push(script); return held.promise } }
  const embed = Object.assign(new Embed(), { taskPromptGeneration: 2, computerPageEpoch: 'document-a', liveContents: () => contents,
    platform: { homeUrl: 'https://chat.deepseek.com/', conversationIdFromPath: path => path.endsWith('/chat-a') ? 'chat-a' : null } })
  return { embed, held, mutable, scripts }
}

test('text delivery rejects another origin with an identical conversation path before running page JavaScript', async () => {
  const g = textPage(); g.mutable.url = 'https://business.example/a/chat/s/chat-a'
  assert.equal(await g.embed.sendTaskResult('tool result', 'chat-a', new AbortController().signal), 'stale')
  assert.equal(g.scripts.length, 0)
})

test('text receipt cannot authorize follow-up after task, document, generation or conversation changes', async () => {
  for (const change of [g => { g.mutable.current = false }, g => { g.embed.computerPageEpoch = 'document-b' },
    g => { g.embed.taskPromptGeneration++ }, g => { g.mutable.url = 'https://chat.deepseek.com/a/chat/s/chat-b' }]) {
    const g = textPage(), pending = g.embed.sendTaskResult('tool result', 'chat-a', new AbortController().signal, () => g.mutable.current)
    assert.equal(g.scripts.length, 1); change(g); g.held.resolve('ok')
    assert.equal(await pending, 'stale')
  }
})

test('screenshot transfer current predicate is revoked by a same-conversation document replacement', async () => {
  let guard
  const Subject = actualClass('../src/main/embed.ts', 'ChatGptEmbed', ['sendTaskObservation'], { sendPageFiles: async (...args) => { guard = args[4]; return 'busy' } })
  const contents = { getURL: () => 'https://chat.deepseek.com/a/chat/s/chat-a', isDestroyed: () => false }
  const embed = Object.assign(new Subject(), { taskPromptGeneration: 2, computerPageEpoch: 'document-a', liveContents: () => contents,
    platform: { id: 'deepseek', homeUrl: 'https://chat.deepseek.com/', conversationIdFromPath: () => 'chat-a' } })
  await embed.sendTaskObservation('result', 'chat-a', new AbortController().signal, [{}], 'img-a', () => true)
  assert.equal(guard(), true); embed.computerPageEpoch = 'document-b'; assert.equal(guard(), false)
})

test('privileged controller routing requires the actual manager main frame', () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const functions = ['runtimeForEvent', 'isManagerEvent'].map(name => source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(source)).join('\n')
  const main = {}, other = {}, contents = { mainFrame: main }, current = {}, exports = {}
  new Script(compile(`${functions}; exports.route = runtimeForEvent; exports.manager = isManagerEvent`)).runInNewContext({ exports,
    managerWindow: { isDestroyed: () => false, webContents: contents }, currentSessionId: 'session-a', runtimes: new Map([['session-a', current]]) })
  assert.equal(exports.route({ sender: contents, senderFrame: main }), current)
  for (const event of [{ sender: contents, senderFrame: other }, { sender: { mainFrame: main }, senderFrame: main }, { sender: contents, senderFrame: null }]) {
    assert.equal(exports.route(event), null); assert.equal(exports.manager(event), false)
  }
})
