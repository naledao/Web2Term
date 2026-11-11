// User-run only: node --test tests/task-prompt-lifecycle.test.mjs
// Actual main-process report/reset methods, synthetic page events and a fixed clock.
// No Electron, browser profile, desktop input, shell, network or application storage.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = ts.createSourceFile('embed.ts', readFileSync(new URL('../src/main/embed.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ChatGptEmbed')
const methods = ['handlePageReport', 'completeTask', 'resetTaskPrompt'].map(name => {
  const method = declaration.members.find(node => node.name?.getText(source) === name)
  assert.ok(method, name)
  return method.getText(source)
}).join('\n')
let now = 1000
const traces = []
class FixedDate extends Date { static now() { return now } }
const Embed = new Script(ts.transpileModule(`class Actual { ${methods} }; Actual`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({
  URL, Date: FixedDate, INTERCEPTOR_LOG_TAG: '[cmd-terminal] ',
  console: { info() {}, warn() {} }, writeReplyDiagnostic(_platform, payload, context) { traces.push({ payload, context }) }, writePromptDiagnostic() {},
  conversationIdOf: (_platform, url) => new URL(url).pathname
})

function fixture(platformId = 'chatgpt') {
  now = 1000
  const sends = [], configurations = []
  const traceStart = traces.length
  let notifications = 0
  const embed = Object.assign(new Embed(), {
    taskPromptGeneration: 3, computerPageEpoch: 'document-a', taskPromptInjected: true,
    computerUseRecognitionEnabled: false, userSubmissions: new Set(), focusSendImages: new Map(),
    platform: { id: platformId, page: { computerUseRequests: false }, allowedOriginPattern: /^https:\/\/chat\.example\// },
    interceptor: { enabled: true, promptInjectionEnabled: true, injectedCount: 4,
      taskStartedAt: 100, taskFinishedAt: null, pendingQuestion: null, lastSentText: '帮我启动一下', prefix: 'SYSTEM' },
    liveContents: () => ({ getURL: () => 'https://chat.example/c/chat-a' }),
    getInterceptorStatus() { return { ...this.interceptor } },
    installInterceptor: async () => { configurations.push(embed.taskPromptGeneration) },
    taskActionSource: () => undefined, confirmInjection() { this.taskPromptInjected = true },
    deliverUserMessage: async () => {},
    handlers: { onInterceptor() {}, onTaskCompleted() { notifications++ }, onRawSent() {},
      onUserStarted(text, _files, _edit, submission) { sends.push({ text, submission }); return 'turn-' + sends.length } }
  })
  const report = payload => embed.handlePageReport('[cmd-terminal] ' + JSON.stringify({
    taskPromptGeneration: embed.taskPromptGeneration, computerPageEpoch: 'document-a', pagePath: '/c/chat-a', ...payload
  }))
  const complete = (messageId, patch = {}) => report({ event: 'task-finished', messageId, completed: true, live: true, ...patch })
  return { embed, sends, configurations, report, complete, notifications: () => notifications, diagnostics: () => traces.slice(traceStart) }
}

test('completion after a late background notification keeps the next human send and timer working', () => {
  for (const platform of ['chatgpt', 'deepseek', 'claude', 'gemini']) {
    const f = fixture(platform)
    f.complete('original-completion')
    assert.equal(f.embed.taskPromptGeneration, 4)
    assert.equal(f.embed.interceptor.taskFinishedAt, 1000)
    assert.equal(f.notifications(), 1)

    // The background result is sent after completion; sent-raw does not start a human task.
    now = 2000
    f.report({ event: 'sent-raw', textLength: 414, promptInjected: false })
    f.complete('background-stopped-completion')
    assert.equal(f.embed.taskPromptGeneration, 5, 'acknowledge the page advancing from 4 to 5')
    assert.equal(f.embed.interceptor.taskStartedAt, 100)
    assert.equal(f.embed.interceptor.taskFinishedAt, 1000, 'preserve the original duration')
    assert.equal(f.notifications(), 1, 'the background reply must not notify completion again')
    assert.deepEqual(f.configurations, [4, 5])

    now = 3000
    f.report({ event: 'injected', taskPromptGeneration: 5, promptInjected: true, prefixLength: 6 })
    f.report({ event: 'user-message', taskPromptGeneration: 5, submissionId: 'user:next:1', submissionKind: 'goal',
      text: '这个后台就不要通过软件了，直接使用指令吧' })
    f.report({ event: 'sent', taskPromptGeneration: 5, text: f.sends[0]?.text, promptInjected: true })
    assert.equal(f.sends.length, 1, 'the next human goal reaches task intake')
    assert.equal(f.sends[0].submission.id, 'user:next:1')
    assert.equal(f.embed.interceptor.injectedCount, 5)
    assert.equal(f.embed.interceptor.lastSentText, f.sends[0].text, 'replace the previous goal')
    assert.equal(f.embed.interceptor.taskStartedAt, 3000)
    assert.equal(f.embed.interceptor.taskFinishedAt, null, 'enable task controls for the new goal')

    // A delayed duplicate from either earlier reply cannot end this new task.
    f.complete('original-completion', { taskPromptGeneration: 3 })
    f.complete('background-stopped-completion', { taskPromptGeneration: 4 })
    assert.equal(f.embed.taskPromptGeneration, 5)
    assert.equal(f.embed.interceptor.taskFinishedAt, null)
    assert.equal(f.notifications(), 1)
    f.complete('next-goal-completion')
    assert.equal(f.embed.taskPromptGeneration, 6)
    assert.equal(f.embed.interceptor.taskFinishedAt, 3000)
    assert.equal(f.notifications(), 2)
  }
})

test('restored, stale, other-document and other-conversation completions cannot advance a boundary', () => {
  for (const finished of [false, true]) for (const patch of [
    { live: false }, { live: undefined }, { taskPromptGeneration: 2 }, { taskPromptGeneration: 4 },
    { taskPromptGeneration: undefined }, { computerPageEpoch: 'old-document' }, { computerPageEpoch: undefined },
    { pagePath: '/c/another-chat' }, { pagePath: undefined }, { messageId: '' }, { messageId: undefined }, { messageId: 'x'.repeat(513) }
  ]) {
    const f = fixture()
    if (finished) f.embed.interceptor.taskFinishedAt = 500
    f.complete('stale-completion', patch)
    assert.equal(f.embed.taskPromptGeneration, 3)
    assert.equal(f.embed.interceptor.taskFinishedAt, finished ? 500 : null)
    assert.equal(f.notifications(), 0)
    assert.deepEqual(f.configurations, [])
  }
  const f = fixture()
  f.embed.liveContents = () => ({ getURL: () => 'https://another.example/c/chat-a' })
  f.complete('wrong-origin')
  f.embed.liveContents = () => null
  f.complete('closed-page')
  assert.equal(f.embed.taskPromptGeneration, 3)
  assert.equal(f.notifications(), 0)
})

test('auxiliary replies before any human task only synchronize the prompt boundary', () => {
  const f = fixture()
  Object.assign(f.embed.interceptor, { taskStartedAt: null, taskFinishedAt: null })
  f.complete('auxiliary-completion')
  assert.equal(f.embed.taskPromptGeneration, 4)
  assert.equal(f.embed.interceptor.taskStartedAt, null)
  assert.equal(f.embed.interceptor.taskFinishedAt, null)
  assert.equal(f.notifications(), 0)
})

test('coordinator completion that already resets the embed advances the boundary once', () => {
  const f = fixture()
  f.embed.handlers.onTaskCompleted = () => { f.embed.completeTask(); return true }
  f.complete('coordinator-completion')
  assert.equal(f.embed.taskPromptGeneration, 4)
  assert.deepEqual(f.configurations, [4])
  assert.equal(f.embed.interceptor.taskFinishedAt, 1000)
})

test('refused task completions synchronize the prompt once without completing or granting task authority', () => {
  for (const rejection of ['missing-source', 'coordinator-rejected']) {
    const f = fixture()
    let completionCalls = 0
    f.embed.computerUseRecognitionEnabled = true
    f.embed.platform.page.computerUseRequests = true
    f.embed.taskActionSource = () => rejection === 'missing-source' ? undefined : { sourceSubmissionId: 'user:old:1' }
    f.embed.handlers.onTaskCompleted = () => { completionCalls++; return false }
    f.complete('refused-completion')
    assert.equal(f.embed.taskPromptGeneration, 4, 'the renderer has already advanced from 3 to 4')
    assert.equal(f.embed.interceptor.taskFinishedAt, null, 'a refused completion cannot finish the underlying task')
    assert.equal(completionCalls, rejection === 'missing-source' ? 0 : 1)
    assert.deepEqual(f.configurations, [4])
    const diagnostic = f.diagnostics().at(-1).context
    assert.equal(diagnostic.completionDisposition, rejection)
    assert.equal(diagnostic.completionBoundarySynced, true)

    f.report({ event: 'user-message', taskPromptGeneration: 3, submissionId: 'user:late:1', submissionKind: 'goal', text: '迟到的旧消息' })
    assert.equal(f.sends.length, 0, 'stale human events remain rejected')
    f.report({ event: 'user-message', taskPromptGeneration: 4, submissionId: 'user:new:1', submissionKind: 'goal', text: '我不想使用Android Studio呢' })
    assert.equal(f.sends.length, 1, 'the next real human send reaches focus/task intake')
    assert.equal(f.sends[0].submission.id, 'user:new:1')

    // A repeat with even the current generation must not advance the boundary again.
    f.complete('refused-completion')
    assert.equal(f.embed.taskPromptGeneration, 4)
    assert.equal(f.embed.interceptor.taskFinishedAt, null)
    assert.equal(f.diagnostics().at(-1).context.completionDisposition, 'duplicate')
    assert.equal(completionCalls, rejection === 'missing-source' ? 0 : 1)
  }
})

function focusModule(relative, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, Date: FixedDate, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), name)
    return dependencies[name]
  } })
  return exports
}
const sharedFocus = focusModule('../src/shared/focus-chat.ts')
let turnSerial = 0
const { FocusChat } = focusModule('../src/main/focus-chat.ts', {
  'node:crypto': { randomUUID: () => 'turn-' + ++turnSerial }, '../shared/focus-chat': sharedFocus
})

test('a human send after refused completion creates its own focus turn and cannot overwrite the preceding answer', () => {
  const f = fixture(), saved = new Map()
  const chat = new FocusChat('session-a', {
    listFocusTurns: () => [], saveFocusTurn(_session, _platform, _conversation, turn) { saved.set(turn.id, JSON.parse(JSON.stringify(turn))) }
  })
  const first = chat.begin('chatgpt', 'chat-a', '可以用安卓模拟器吗')
  chat.settled('chatgpt', 'first-answer', '推荐使用 Android Studio 模拟器。')
  f.embed.handlers.onTaskCompleted = () => false
  f.complete('first-answer')
  f.embed.handlers.onUserStarted = text => chat.begin('chatgpt', 'chat-a', text)
  f.embed.handlers.onAssistantMessage = (messageId, text) => chat.settled('chatgpt', messageId, text)
  now = 2000
  f.report({ event: 'user-message', taskPromptGeneration: 4, submissionId: 'user:next:1', submissionKind: 'goal', text: '我不想使用Android Studio呢' })
  f.report({ event: 'sent', taskPromptGeneration: 4, text: '我不想使用Android Studio呢' })
  f.report({ event: 'assistant-message', messageId: 'second-answer', text: '完全可以不安装 Android Studio。' })
  const turns = chat.turns('chatgpt', 'chat-a')
  assert.equal(turns.length, 2)
  assert.equal(turns[0].id, first)
  assert.equal(turns[0].segments[0].sourceMessageId, 'first-answer')
  assert.equal(turns[0].segments[0].answer, '推荐使用 Android Studio 模拟器。')
  assert.equal(turns[1].userText, '我不想使用Android Studio呢')
  assert.equal(turns[1].segments[0].sourceMessageId, 'second-answer')
  assert.equal(turns[1].segments[0].answer, '完全可以不安装 Android Studio。')
  assert.equal(saved.size, 2)
})
