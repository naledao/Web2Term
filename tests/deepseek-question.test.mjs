// User-run only: node --test tests/deepseek-question.test.mjs
// Synthetic saved transcripts; no Electron, credentials, disk writes or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import ts from 'typescript'

function load(relative, dependencies = {}, globals = {}) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
    .runInNewContext({ exports, URL, Buffer, AbortController, setTimeout, clearTimeout, Date, process: { pid: 12345 },
      require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name] }, ...globals })
  return exports
}
const shared = load('../src/shared/deepseek-question.ts')
const markdown = load('../src/shared/deepseek-context-markdown.ts', { './deepseek-question': shared })
const sourceId = 'test-conversation'
const answer = '原计划 Kotlin + Compose，但无法访问 Maven，因此实际采用 Java 和原生 Android View。'
const selection = { sourcePath: `/a/chat/s/${sourceId}`, selectedText: 'Compose', question: '这是什么？', answerText: answer }
const savedMessage = (id, role, content, sourceMessageId = null) => ({
  id, conversationId: sourceId, role, content, sourceMessageId, attachments: [], createdAt: 1
})
const savedContext = () => ({ conversationId: sourceId, title: '项目介绍', messages: [
  savedMessage('user-1', 'user', '介绍项目'), savedMessage('assistant-1', 'assistant', '第一条回答'),
  savedMessage('user-2', 'user', '技术栈呢'), savedMessage('assistant-2', 'assistant', answer, 'capture-answer'),
  savedMessage('user-later', 'user', '稍后的问题'), savedMessage('assistant-later', 'assistant', '稍后的回答')
] })
const category = expected => error => error instanceof shared.DeepSeekQuestionError && error.category === expected

test('exports only saved messages through the selected answer, preserving database reading order', () => {
  const snapshot = markdown.savedQuestionSnapshot(savedContext(), sourceId, selection)
  assert.deepEqual(Array.from(snapshot.messages, item => item.id), ['user-1', 'assistant-1', 'user-2', 'assistant-2'])
  assert.equal(snapshot.messages.at(-1).content, answer)
  assert.equal(snapshot.title, '项目介绍')
  assert.equal(shared.deepSeekConversation('https://chat.deepseek.com.evil.test/a/chat/s/x'), null)
})

test('matches a captured source key across Markdown differences, and handles old Markdown-only captures', () => {
  const context = savedContext()
  context.messages[3].content = answer.replace('Compose', '**Compose**')
  const snapshot = markdown.savedQuestionSnapshot(context, sourceId, { ...selection, sourceMessageId: 'capture-answer' })
  assert.equal(snapshot.messages.at(-1).content, context.messages[3].content)
  assert.equal(markdown.savedQuestionSnapshot(context, sourceId, selection).messages.length, 4)
  const code = { ...selection, selectedText: 'hello', answerText: 'console.log("hello")' }
  context.messages[3].content = '```javascript\nconsole.log("hello")\n```'
  assert.equal(markdown.savedQuestionSnapshot(context, sourceId, code).messages.length, 4)
})

test('missing, mixed or ambiguous local records fail instead of requesting a share or fetching history', () => {
  assert.throws(() => markdown.savedQuestionSnapshot(null, sourceId, selection), category('local-source'))
  assert.throws(() => markdown.savedQuestionSnapshot({ ...savedContext(), conversationId: 'another' }, sourceId, selection), category('local-source'))
  const mixed = savedContext(); mixed.messages[0].conversationId = 'another'
  assert.throws(() => markdown.savedQuestionSnapshot(mixed, sourceId, selection), category('local-source'))
  assert.throws(() => markdown.savedQuestionSnapshot({ ...savedContext(), messages: [] }, sourceId, selection), category('local-empty'))
  const absent = savedContext(); absent.messages.splice(3, 1)
  assert.throws(() => markdown.savedQuestionSnapshot(absent, sourceId, selection), category('local-answer'))
  const duplicate = savedContext(); duplicate.messages.push(savedMessage('duplicate', 'assistant', answer))
  assert.throws(() => markdown.savedQuestionSnapshot(duplicate, sourceId, selection), category('local-answer'))
  assert.equal(markdown.savedQuestionSnapshot(duplicate, sourceId, { ...selection, sourceMessageId: 'capture-answer' }).messages.length, 4)
})

test('Markdown is a clean transcript with preserved code and tables, without HTML layout or share metadata', () => {
  const context = savedContext()
  context.title = '项目\n介绍'
  context.messages[0].content = '## 原始标题\n\n```java\nnew LruCache<>(10);\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |'
  const document = markdown.questionContextMarkdown(markdown.savedQuestionSnapshot(context, sourceId, selection))
  for (const expected of ['# 项目 介绍', '## 1. 用户', '## 4. AI', context.messages[0].content, answer]) assert.ok(document.includes(expected))
  for (const absent of ['稍后的问题', '<!doctype', '<style', 'chat.deepseek.com/share', 'sourceMessageId', 'capture-answer', selection.question]) assert.equal(document.includes(absent), false)
  const prompt = shared.deepSeekAttachmentPrompt(selection)
  for (const expected of ['deepseek-context.md', selection.selectedText, selection.question, '引用资料']) assert.ok(prompt.includes(expected))
  assert.equal(prompt.includes('https://'), false)
})

test('Markdown export writes a unique UTF-8 file and rejects oversized or cancelled exports', async () => {
  const writes = []
  const api = load('../src/main/deepseek-context-markdown.ts', {
    electron: { app: { getPath: name => { assert.equal(name, 'userData'); return '/synthetic-data' } } },
    'node:fs/promises': { mkdir: async () => {}, writeFile: async (...args) => writes.push(args) },
    'node:path': path, 'node:crypto': { randomUUID }, '../shared/deepseek-context-markdown': markdown, '../shared/deepseek-question': shared
  })
  const snapshot = markdown.savedQuestionSnapshot(savedContext(), sourceId, selection)
  const signal = new AbortController().signal
  const first = await api.saveQuestionContextMarkdown(snapshot, signal)
  assert.notEqual(first, await api.saveQuestionContextMarkdown(snapshot, signal))
  assert.equal(path.basename(first), 'deepseek-context.md')
  assert.equal(writes[0][2].flag, 'wx'); assert.equal(writes[0][2].encoding, 'utf8')
  assert.ok(writes[0][1].includes(answer))
  await assert.rejects(api.saveQuestionContextMarkdown({ ...snapshot, messages: [{ id: 'large', role: 'user', content: 'a'.repeat(21 * 1024 * 1024) }] }, signal), category('context-size'))
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(api.saveQuestionContextMarkdown(snapshot, cancelled.signal), { name: 'AbortError' })
  assert.equal(writes.length, 2)
})
function controllerFixture(local = savedContext()) {
  const wc = new EventEmitter()
  wc.id = 42; wc.mainFrame = {}; wc.url = `https://chat.deepseek.com${selection.sourcePath}`
  wc.isDestroyed = () => false; wc.getURL = () => wc.url; wc.getUserAgent = () => 'Synthetic Chrome'
  const statuses = []
  wc.executeJavaScript = async source => {
    if (source.includes('getSubmission()')) return selection
    statuses.push(source); return true
  }
  wc.session = { fetch() { throw new Error('No provider history or share requests are allowed') } }
  let resolveContext
  let readCalls = 0
  const chats = [], snapshots = []
  const dependencies = {
    'node:crypto': { randomUUID }, '../shared/deepseek-question': shared,
    './question-chat-page': {
      questionPageCall: (webContents, source) => webContents.executeJavaScript(source),
      writeQuestionLog() { return '' }
    },
    '../shared/deepseek-context-markdown': markdown,
    './deepseek-context-markdown': { saveQuestionContextMarkdown: async snapshot => { snapshots.push(snapshot); return '/synthetic-export/deepseek-context.md' } },
    './question-chat': { QuestionChat: class { constructor(...args) { chats.push(args) } close() {} setOwnerVisible() {} } }
  }
  const { DeepSeekQuestion } = load('../src/main/deepseek-question.ts', dependencies)
  const controller = new DeepSeekQuestion(wc, { isDestroyed: () => false }, { id: 'deepseek' }, () => 'light', () => {},
    id => { assert.equal(id, sourceId); readCalls++; return new Promise(resolve => { resolveContext = resolve }) })
  const enter = () => {
    wc.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' })
    wc.emit('console-message', { frame: wc.mainFrame, message: controller.reportTag + JSON.stringify({ event: 'question-submit' }) })
  }
  return { controller, wc, enter, chats, snapshots, statuses, readCalls: () => readCalls, resolve: () => resolveContext(local) }
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

test('repeated Enter reads local data once and opens one sidebar; page reports without a gesture are ignored', async () => {
  const fixture = controllerFixture()
  fixture.wc.emit('console-message', { frame: fixture.wc.mainFrame, message: fixture.controller.reportTag + JSON.stringify({ event: 'question-submit' }) })
  await flush(); assert.equal(fixture.readCalls(), 0)
  fixture.enter(); fixture.enter(); await flush()
  assert.equal(fixture.readCalls(), 1)
  await fixture.resolve(); await flush()
  assert.equal(fixture.chats.length, 1)
  assert.ok(fixture.chats[0][4].includes(selection.question))
  assert.ok(fixture.chats[0][4].includes('附件'))
  assert.equal(fixture.chats[0][4].includes('https://'), false)
  assert.equal(fixture.chats[0][7], '/synthetic-export/deepseek-context.md')
  assert.equal(fixture.snapshots[0].messages.length, 4)
  fixture.controller.destroy()
})

test('missing local history displays an actionable error without exporting or opening a new chat', async () => {
  const fixture = controllerFixture(null)
  fixture.enter(); await flush(); fixture.resolve(); await flush()
  assert.equal(fixture.chats.length, 0)
  assert.equal(fixture.snapshots.length, 0)
  assert.ok(fixture.statuses.some(text => text.includes('未找到当前会话的本地对话数据')))
  fixture.controller.destroy()
})

test('closing selection or changing the source conversation prevents a late sidebar chat', async () => {
  for (const variant of ['cancel', 'navigate']) {
    const fixture = controllerFixture()
    fixture.enter(); await flush()
    if (variant === 'cancel') fixture.controller.cancel()
    else {
      fixture.wc.url = 'https://chat.deepseek.com/a/chat/s/other'
      fixture.wc.emit('did-navigate-in-page', {}, fixture.wc.url, true)
    }
    await fixture.resolve(); await flush()
    assert.equal(fixture.chats.length, 0)
    fixture.controller.destroy()
  }
})

test('native sidebar bounds reject malformed rectangles and clamp to the owning window', () => {
  assert.equal(shared.questionChatBounds({ x: NaN, y: 0, width: 480, height: 700 }, 1400, 900), null)
  assert.equal(shared.questionChatBounds({ x: 0, y: 0, width: -10, height: 700 }, 1400, 900), null)
  assert.equal(shared.questionChatBounds({ x: '900', y: 0, width: 480, height: 700 }, 1400, 900), null)
  const clamped = shared.questionChatBounds({ x: 1000, y: 200, width: 800, height: 900 }, 1400, 900)
  assert.deepEqual(JSON.parse(JSON.stringify(clamped)), { x: 1000, y: 200, width: 400, height: 700 })
  const hidden = shared.questionChatBounds({ x: 0, y: 0, width: 0, height: 0 }, 1400, 900)
  assert.equal(hidden.width, 0)
  assert.equal(hidden.height, 0)
})

test('sidebar sends its Markdown attachment once, preserves on folding and disposes once', async () => {
  const views = [], added = [], removed = [], states = [], copied = []
  const sent = [], opened = [], revealed = []
  class FakeView {
    constructor() {
      const contents = new EventEmitter()
      contents.id = 99; contents.destroyed = false
      contents.setUserAgent = () => {}; contents.setWindowOpenHandler = () => {}
      contents.loadURL = async () => {}; contents.isDestroyed = () => contents.destroyed
      contents.getURL = () => 'https://chat.deepseek.com/'
      contents.close = () => { contents.destroyed = true }
      this.webContents = contents
      views.push(this)
    }
    setBackgroundColor() {}
    setBounds(bounds) { this.bounds = bounds }
    setVisible(visible) { this.visible = visible }
  }
  const parent = new EventEmitter()
  parent.isDestroyed = () => false; parent.getContentSize = () => [1400, 900]
  parent.contentView = { addChildView: view => added.push(view), removeChildView: view => removed.push(view) }
  const { QuestionChat } = load('../src/main/question-chat.ts', {
    electron: { WebContentsView: FakeView, clipboard: { writeText: value => copied.push(value) }, shell: {
      openPath: async value => { opened.push(value); return '' }, showItemInFolder: value => revealed.push(value)
    } },
    'node:crypto': { randomUUID }, '../shared/deepseek-question': shared,
    './injected/question-chat-sender.js?raw': { default: '' }, './injected/theme.js?raw': { default: '' },
    './question-chat-page': { questionPageCall: async () => ({ composer: true, hasHistory: false }), writeQuestionLog() {} },
    './question-chat-send': { sendQuestionChatAttachment: async (...args) => { sent.push(args); return 'ok' } }
  }, { setInterval: () => 1, clearInterval() {} })
  const chat = new QuestionChat(parent, { homeUrl: 'https://chat.deepseek.com/', partition: 'synthetic', page: {
    composerSelectors: ['textarea'], sendButtonSelectors: ['.synthetic-send']
  } }, 'light', 'Synthetic Chrome', 'synthetic prompt', 'synthetic quote', state => states.push(state), '/synthetic-export/deepseek-context.md')
  assert.equal(views.length, 1)
  assert.equal(added.length, 1)
  assert.equal(views[0].visible, false)
  chat.setOwnerVisible(true)
  assert.equal(views[0].visible, false)
  chat.setViewport({ x: 1000, y: 200, width: 800, height: 900 }, true)
  assert.equal(views[0].visible, true)
  assert.equal(views[0].bounds.width, 400)
  await chat.checkReady(); await chat.checkReady()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][2], '/synthetic-export/deepseek-context.md')
  assert.equal(sent[0][3], 'synthetic prompt')
  assert.equal(chat.getState().error, false)
  assert.ok(chat.getState().status.includes('Markdown 附件和问题'))
  chat.setOwnerVisible(false); chat.setOwnerVisible(true)
  assert.equal(views[0].visible, false, 'old bounds cannot show a chat when its owner changes')
  chat.setViewport({ x: 1000, y: 200, width: 400, height: 700 }, true)
  assert.equal(views[0].visible, true)
  chat.setViewport({ x: 0, y: 0, width: 0, height: 0 }, false)
  assert.equal(views[0].visible, false)
  assert.equal(views[0].webContents.destroyed, false, 'folding preserves the chat')
  chat.action('copy-prompt')
  assert.equal(copied[0], 'synthetic prompt')
  chat.action('open-context'); chat.action('reveal-context')
  assert.equal(opened[0], chat.getState().contextPath)
  assert.equal(revealed[0], chat.getState().contextPath)
  chat.close(); chat.close()
  assert.equal(sent[0][4].aborted, true)
  assert.equal(removed.length, 1)
  assert.equal(views[0].webContents.destroyed, true)
  assert.equal(states.at(-1), null)
})

function attachmentFixture({ outcome = 'ok', navigate = false, invalid = false, initialUrl = 'https://chat.deepseek.com/' } = {}) {
  let cleanups = 0
  let url = initialUrl
  const sends = [], scripts = [], requests = []
  const attachment = { path: '/synthetic-staging/deepseek-context.md', fileName: 'deepseek-context.md', mimeType: 'text/markdown', sizeBytes: 100 }
  const helper = load('../src/main/question-chat-send.ts', {
    'node:path': path, 'node:crypto': { randomUUID }, './injected/send-interceptor.js?raw': { default: 'synthetic bridge' },
    './question-chat-page': { questionPageCall: async (_contents, script) => { scripts.push(script) } },
    './file-access': { prepareFiles: async (...args) => {
      requests.push(args)
      if (navigate) url = 'https://chat.deepseek.com/a/chat/s/existing'
      return { failed: invalid, attachments: [attachment], cleanup: async () => { cleanups++ } }
    } },
    './page-files': { sendPageFiles: async (...args) => { sends.push(args); return outcome } }
  })
  const wc = { getURL: () => url, isDestroyed: () => false }
  const prompt = shared.deepSeekAttachmentPrompt(selection)
  return { sends, scripts, requests, cleanups: () => cleanups,
    send: () => helper.sendQuestionChatAttachment(wc, { id: 'deepseek', page: {} }, '/synthetic-export/deepseek-context.md', prompt, new AbortController().signal, () => true), prompt }
}

test('sidebar attachment reuses the uploader, adds the question as caption and cleans staging only', async () => {
  const fixture = attachmentFixture()
  assert.equal(await fixture.send(), 'ok')
  assert.equal(fixture.sends.length, 1)
  const args = fixture.sends[0]
  assert.equal(args[1], 'deepseek')
  assert.equal(args[2][0].mimeType, 'text/markdown')
  assert.equal(args[6].caption, fixture.prompt)
  assert.equal(args[6].allowNewConversation, true)
  assert.ok(fixture.scripts[0].includes('"enabled":false'))
  assert.ok(fixture.scripts[0].includes('"promptInjectionEnabled":false'))
  assert.equal(fixture.requests[0][0].files[0].path, '/synthetic-export/deepseek-context.md')
  assert.equal(fixture.cleanups(), 1)
})

test('unsupported Markdown, a changed chat and a failed snapshot never trigger a URL fallback', async () => {
  for (const options of [{ outcome: 'unsupported-file-type' }, { navigate: true }, { invalid: true }, { initialUrl: 'https://chat.deepseek.com/a/chat/s/existing' }]) {
    const fixture = attachmentFixture(options)
    const result = await fixture.send()
    assert.equal(result, options.outcome || (options.invalid ? 'upload-failed' : 'cancelled'))
    assert.equal(fixture.sends.length, options.outcome ? 1 : 0)
    assert.equal(fixture.cleanups(), options.initialUrl ? 0 : 1)
    assert.equal(fixture.prompt.includes('https://'), false)
  }
})

function uploadFixture({ nextUrl = 'https://chat.deepseek.com/a/chat/s/new-synthetic', allow = true, captionAccepted = true, changeBeforeSubmit = false } = {}) {
  let now = 10000, submitted = false
  let url = 'https://chat.deepseek.com/'
  const calls = [], logs = []
  class Clock extends Date { static now() { return now } }
  const debuggerApi = new EventEmitter()
  debuggerApi.attached = false
  debuggerApi.isAttached = () => debuggerApi.attached
  debuggerApi.attach = () => { debuggerApi.attached = true }
  debuggerApi.detach = () => { debuggerApi.attached = false }
  debuggerApi.sendCommand = async method => method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : method === 'DOM.querySelector' ? { nodeId: 2 } : {}
  const wc = { debugger: debuggerApi, getURL: () => url, isDestroyed: () => false, executeJavaScript: async source => {
    const method = /Interceptor\?\.([\w]+)\(/.exec(source)?.[1]
    calls.push(method)
    if (method === 'beginFileSend') return 'ok'
    if (method === 'refreshFileInput' || method === 'fileSelectionApplied' || method === 'releaseFileSend') return true
    if (method === 'prepareFileSendCaption') {
      if (changeBeforeSubmit) url = nextUrl
      return captionAccepted
    }
    if (method === 'submitFileSend') { submitted = true; url = nextUrl; return true }
    if (method === 'fileSendStatus') return { status: submitted ? 'sent' : 'ready', namesSeen: true }
    throw new Error('Unexpected method ' + method)
  } }
  const api = load('../src/main/page-files.ts', {
    'node:fs': { mkdirSync() {}, appendFileSync: (_path, line) => logs.push(line) },
    'node:os': { tmpdir: () => '/synthetic-temp' }, 'node:path': path
  }, { Date: Clock, console: { warn() {} }, setTimeout: (callback, delay) => {
    // Advance only actual polling pauses, not unused CDP timeout races.
    const handle = { active: true }
    if (delay <= 250) queueMicrotask(() => { if (handle.active) { now += delay; callback() } })
    return handle
  }, clearTimeout: handle => { handle.active = false } })
  return { calls, logs, send: () => api.sendPageFiles(wc, 'deepseek', [{ path: '/staging/context.md', fileName: 'context.md', mimeType: 'text/markdown', sizeBytes: 100 }],
    'synthetic-upload', () => true, new AbortController().signal, { caption: 'synthetic question', allowNewConversation: allow }) }
}

test('attachment caption is prepared before exactly one submit and the initial new-chat route is acknowledged', async () => {
  const fixture = uploadFixture()
  assert.equal(await fixture.send(), 'ok')
  assert.ok(fixture.calls.indexOf('prepareFileSendCaption') < fixture.calls.indexOf('submitFileSend'))
  assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, 1)
  assert.equal(fixture.calls.at(-1), 'releaseFileSend')
  assert.equal(fixture.logs.join('').includes('synthetic question'), false)
})

test('navigation is permitted only after submitting into an opted-in new DeepSeek chat', async () => {
  for (const options of [{ allow: false }, { nextUrl: 'https://evil.test/a/chat/s/x' }, { changeBeforeSubmit: true }]) {
    const fixture = uploadFixture(options)
    assert.equal(await fixture.send(), options.changeBeforeSubmit ? 'cancelled' : 'unknown')
    assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, options.changeBeforeSubmit ? 0 : 1)
  }
  const changed = uploadFixture({ captionAccepted: false })
  assert.equal(await changed.send(), 'busy')
  assert.equal(changed.calls.includes('submitFileSend'), false)
})
