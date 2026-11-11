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
class FixedDate extends Date { static now() { return now } }
const Embed = new Script(ts.transpileModule(`class Actual { ${methods} }; Actual`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({
  URL, Date: FixedDate, INTERCEPTOR_LOG_TAG: '[cmd-terminal] ',
  console: { info() {}, warn() {} }, writeReplyDiagnostic() {}, writePromptDiagnostic() {},
  conversationIdOf: (_platform, url) => new URL(url).pathname
})

function fixture(platformId = 'chatgpt') {
  now = 1000
  const sends = [], configurations = []
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
  return { embed, sends, configurations, report, complete, notifications: () => notifications }
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
    { pagePath: '/c/another-chat' }, { pagePath: undefined }
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
