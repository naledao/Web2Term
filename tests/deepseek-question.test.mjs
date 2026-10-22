// User-run only: node --test tests/deepseek-question.test.mjs
// DeepSeek, ChatGPT, Gemini and Claude follow-up regressions. Synthetic data; no Electron,
// credentials, real disk writes or network. Run only by the user.
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
const chatgptId = '6ad1b11e-bec4-83e8-be6f-24834af50921'
const chatgptSelection = { ...selection, sourcePath: `/g/g-p-example/c/${chatgptId}`, sourceMessageId: 'capture-answer' }
const chatgptContext = () => ({ ...savedContext(), conversationId: chatgptId,
  messages: savedContext().messages.map(message => ({ ...message, conversationId: chatgptId })) })
const geminiId = '0123456789abcdef'
const geminiSelection = { ...selection, sourcePath: `/app/${geminiId}`, sourceMessageId: 'message-content-id-r_0123456789abcdef' }
const geminiContext = () => ({ ...savedContext(), conversationId: geminiId,
  messages: savedContext().messages.map(message => ({ ...message, conversationId: geminiId,
    sourceMessageId: message.id === 'assistant-2' ? geminiSelection.sourceMessageId : message.sourceMessageId })) })
const claudeId = 'fa4e73a6-92b9-4b7b-832c-2de7b09e48bd'
const claudeSelection = { ...selection, sourcePath: `/chat/${claudeId}`, sourceMessageId: 'text:synthetic-capture:128' }
const claudeContext = () => ({ ...savedContext(), conversationId: claudeId,
  messages: savedContext().messages.map(message => ({ ...message, conversationId: claudeId,
    sourceMessageId: message.id === 'assistant-2' ? claudeSelection.sourceMessageId : message.sourceMessageId })) })
const fixtureHomes = { deepseek: 'https://chat.deepseek.com/', chatgpt: 'https://chatgpt.com/', gemini: 'https://gemini.google.com/app', claude: 'https://claude.ai/new' }
const fixtureLabels = { deepseek: 'DeepSeek', chatgpt: 'ChatGPT', gemini: 'Gemini', claude: 'Claude' }
const fixtureConversations = { deepseek: 'https://chat.deepseek.com/a/chat/s/existing', chatgpt: `https://chatgpt.com/c/${chatgptId}`, gemini: `https://gemini.google.com/app/${geminiId}`, claude: `https://claude.ai/chat/${claudeId}` }
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
  const chatgpt = markdown.savedQuestionSnapshot(chatgptContext(), chatgptId, chatgptSelection, 'chatgpt')
  const chatgptPath = await api.saveQuestionContextMarkdown(chatgpt, signal)
  assert.equal(path.basename(chatgptPath), 'chatgpt-context.md')
  assert.ok(chatgptPath.includes(path.join('exports', 'chatgpt')))
  const gemini = markdown.savedQuestionSnapshot(geminiContext(), geminiId, geminiSelection, 'gemini')
  const geminiPath = await api.saveQuestionContextMarkdown(gemini, signal)
  assert.equal(path.basename(geminiPath), 'gemini-context.md')
  assert.ok(geminiPath.includes(path.join('exports', 'gemini')))
  const claude = markdown.savedQuestionSnapshot(claudeContext(), claudeId, claudeSelection, 'claude')
  const claudePath = await api.saveQuestionContextMarkdown(claude, signal)
  assert.equal(path.basename(claudePath), 'claude-context.md')
  assert.ok(claudePath.includes(path.join('exports', 'claude')))
})
function controllerFixture(local = savedContext(), { platformId = 'deepseek', draft = selection, id = sourceId } = {}) {
  const wc = new EventEmitter()
  wc.id = 42; wc.mainFrame = {}; wc.url = new URL(fixtureHomes[platformId]).origin + draft.sourcePath
  wc.isDestroyed = () => false; wc.getURL = () => wc.url; wc.getUserAgent = () => 'Synthetic Chrome'
  const statuses = []
  wc.executeJavaScript = async source => {
    if (source.includes('getSubmission()')) return draft
    statuses.push(source); return true
  }
  wc.session = { fetch() { throw new Error('No provider history or share requests are allowed') } }
  let resolveContext
  let readCalls = 0
  const chats = [], snapshots = [], diagnostics = [], instances = [], states = []
  const dependencies = {
    'node:crypto': { randomUUID }, '../shared/deepseek-question': shared,
    './question-chat-page': {
      questionPageCall: (webContents, source) => webContents.executeJavaScript(source),
      writeQuestionLog(event, details) { diagnostics.push({ event, details }); return '' }
    },
    '../shared/deepseek-context-markdown': markdown,
    './deepseek-context-markdown': { saveQuestionContextMarkdown: async snapshot => { snapshots.push(snapshot); return `/synthetic-export/${snapshot.platformId}-context.md` } },
    './question-chat': { QuestionChat: class {
      constructor(...args) { this.id = randomUUID(); this.args = args; this.closed = false; chats.push(args); instances.push(this); args[6](this.getState()) }
      getState() { return this.closed ? null : { id: this.id, platformId: this.args[1].id, selectedText: this.args[5], contextPath: this.args[7], status: '', error: false } }
      close() { if (this.closed) return; this.closed = true; this.args[6](null) }
      action(action) { if (action === 'close') this.close() }
      setOwnerVisible(visible) { this.visible = visible }
    } }
  }
  const { DeepSeekQuestion } = load('../src/main/deepseek-question.ts', dependencies)
  const controller = new DeepSeekQuestion(wc, { isDestroyed: () => false }, { id: platformId }, () => 'light', state => states.push(state),
    requestedId => { assert.equal(requestedId, id); readCalls++; return new Promise(resolve => { resolveContext = resolve }) })
  const enter = () => {
    wc.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' })
    wc.emit('console-message', { frame: wc.mainFrame, message: controller.reportTag + JSON.stringify({ event: 'question-submit' }) })
  }
  return { controller, wc, enter, chats, snapshots, statuses, diagnostics, instances, states, readCalls: () => readCalls, resolve: () => resolveContext(local) }
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

test('the add-menu creates a new blank sidebar and releases the previous instance each time', () => {
  const fixture = controllerFixture()
  try {
    const first = fixture.controller.createChat()
    const second = fixture.controller.createChat()
    assert.notEqual(first.id, second.id)
    assert.equal(fixture.instances.length, 2)
    assert.equal(fixture.instances[0].closed, true)
    assert.equal(fixture.instances[1].closed, false)
    assert.equal(fixture.instances[1].visible, true)
    assert.equal(fixture.controller.getState().id, second.id)
    assert.equal(second.selectedText, '')
    assert.equal(second.contextPath, '')
    assert.equal(fixture.chats[1][4], '', 'a blank sidebar must not reuse an old prompt')
    assert.equal(fixture.readCalls(), 0, 'manual creation must not export the source conversation')
    assert.equal(fixture.snapshots.length, 0)
    fixture.controller.action(first.id, 'close')
    assert.equal(fixture.controller.getState().id, second.id, 'late actions from the old tab cannot close the new one')
    fixture.controller.action(second.id, 'close')
    assert.equal(fixture.controller.getState(), null)
    assert.equal(fixture.instances[1].closed, true)
  } finally { fixture.controller.destroy() }
})

test('creating a blank chat invalidates a pending selection export instead of resurrecting that older chat', async () => {
  const fixture = controllerFixture()
  try {
    fixture.enter()
    await flush()
    assert.equal(fixture.readCalls(), 1)
    const fresh = fixture.controller.createChat()
    fixture.resolve()
    await flush()
    assert.equal(fixture.instances.length, 1)
    assert.equal(fixture.controller.getState().id, fresh.id)
    assert.equal(fixture.snapshots.length, 0)
    assert.equal(fixture.chats[0][4], '')
  } finally { fixture.controller.destroy() }
})

test('selection UI diagnostics keep only allowlisted metadata and never authorize a submit', async () => {
  const fixture = controllerFixture()
  try {
    fixture.wc.emit('console-message', { frame: fixture.wc.mainFrame, message: fixture.controller.reportTag + JSON.stringify({
      event: 'question-ui', phase: 'shown', selectedLength: 9, selectedText: 'private selection', question: 'private question', answerCount: 2,
      startAnswerFound: true, errorName: 'untrusted exception text'
    }) })
    await flush()
    assert.equal(fixture.readCalls(), 0)
    assert.equal(fixture.chats.length, 0)
    assert.equal(fixture.diagnostics[0].event, 'QUESTION-UI')
    assert.equal(fixture.diagnostics[0].details.selectedLength, 9)
    assert.equal(fixture.diagnostics[0].details.answerCount, 2)
    assert.equal(JSON.stringify(fixture.diagnostics).includes('private'), false)
    assert.equal('errorName' in fixture.diagnostics[0].details, false)
  } finally { fixture.controller.destroy() }
})

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

for (const platformId of ['deepseek', 'chatgpt', 'gemini', 'claude']) {
test(`${platformId} manual sidebar starts on a fresh home page without old context or automatic messages`, async () => {
  const views = [], loaded = [], sent = [], copied = [], states = []
  let readyChecks = 0
  class FakeView {
    constructor(options) {
      this.options = options
      const contents = new EventEmitter()
      contents.setUserAgent = () => {}; contents.setWindowOpenHandler = () => {}
      contents.loadURL = async url => { loaded.push(url) }
      contents.getURL = () => fixtureHomes[platformId]
      contents.isDestroyed = () => Boolean(contents.destroyed)
      contents.close = () => { contents.destroyed = true }
      this.webContents = contents
      views.push(this)
    }
    setBackgroundColor() {}
    setBounds() {}
    setVisible() {}
  }
  const parent = new EventEmitter()
  parent.isDestroyed = () => false; parent.getContentSize = () => [1400, 900]
  parent.contentView = { addChildView() {}, removeChildView() {} }
  const { QuestionChat } = load('../src/main/question-chat.ts', {
    electron: { WebContentsView: FakeView, clipboard: { writeText: value => copied.push(value) }, shell: {} },
    'node:crypto': { randomUUID }, '../shared/deepseek-question': shared,
    './injected/question-chat-sender.js?raw': { default: '' }, './injected/theme.js?raw': { default: '' },
    './question-chat-page': { questionPageCall: async (_contents, script) => {
      if (script.includes('__questionChatReady')) readyChecks++
      return { composer: true, uploadReady: true, hasHistory: true }
    }, writeQuestionLog() {} },
    './question-chat-send': { sendQuestionChatAttachment: async (...args) => { sent.push(args); return 'ok' } }
  }, { setInterval() { assert.fail('blank chats do not poll for automatic sending') }, clearInterval() {} })
  const partition = `synthetic-${platformId}`
  const chat = new QuestionChat(parent, { id: platformId, label: fixtureLabels[platformId], homeUrl: fixtureHomes[platformId], partition,
    page: { composerKind: 'textarea', composerSelectors: [], sendButtonSelectors: [], messageSelectors: [], assistantSelectors: [] } },
  'light', 'Synthetic Chrome', '', '', state => states.push(state), '')
  try {
    assert.equal(loaded[0], fixtureHomes[platformId])
    assert.equal(views[0].options.webPreferences.partition, partition, 'reuse login state, never the old web view')
    assert.equal(chat.getState().selectedText, '')
    assert.equal(chat.getState().contextPath, '')
    chat.setOwnerVisible(true)
    chat.setViewport({ x: 1000, y: 200, width: 400, height: 700 }, true)
    views[0].webContents.emit('dom-ready')
    await flush()
    await chat.checkReady()
    chat.action('copy-prompt')
    assert.equal(readyChecks, 0)
    assert.equal(sent.length, 0)
    assert.equal(copied.length, 0)
    assert.equal(chat.getState().status, '')
  } finally { chat.close() }
  assert.equal(states.at(-1), null)
  assert.equal(views[0].webContents.destroyed, true)
})

test(`${platformId} sidebar sends its Markdown once, preserves on folding and disposes once`, async () => {
  const homeUrl = fixtureHomes[platformId]
  const views = [], added = [], removed = [], states = [], copied = []
  const sent = [], opened = [], revealed = []
  const readinessLogs = []
  let readiness = { composer: false, uploadReady: false, hasHistory: false, composerCount: 1, composerTag: 'textarea', fileInputCount: 0, uploadEntryCount: 0 }
  class FakeView {
    constructor() {
      const contents = new EventEmitter()
      contents.id = 99; contents.destroyed = false
      contents.setUserAgent = () => {}; contents.setWindowOpenHandler = () => {}
      contents.loadURL = async () => {}; contents.isDestroyed = () => contents.destroyed
      contents.getURL = () => homeUrl
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
    './question-chat-page': { questionPageCall: async () => readiness, writeQuestionLog: (event, details) => readinessLogs.push({ event, details }) },
    './question-chat-send': { sendQuestionChatAttachment: async (...args) => { sent.push(args); return 'ok' } }
  }, { setInterval: () => 1, clearInterval() {} })
  const chat = new QuestionChat(parent, { id: platformId, label: fixtureLabels[platformId], homeUrl, partition: `synthetic-${platformId}`, page: {
    composerKind: platformId === 'deepseek' ? 'textarea' : 'contenteditable',
    composerSelectors: ['textarea'], sendButtonSelectors: ['.synthetic-send'], messageSelectors: ['.synthetic-message'], assistantSelectors: ['.synthetic-assistant']
  } }, 'light', 'Synthetic Chrome', 'synthetic prompt', 'synthetic quote', state => states.push(state), `/synthetic-export/${platformId}-context.md`)
  assert.equal(views.length, 1)
  assert.equal(added.length, 1)
  assert.equal(views[0].visible, false)
  chat.setOwnerVisible(true)
  assert.equal(views[0].visible, false)
  chat.setViewport({ x: 1000, y: 200, width: 800, height: 900 }, true)
  assert.equal(views[0].visible, true)
  assert.equal(views[0].bounds.width, 400)
  await chat.checkReady(); await chat.checkReady()
  assert.equal(sent.length, 0, 'a bootstrap composer never consumes the only send attempt')
  assert.equal(readinessLogs.filter(log => log.event === 'CHAT-READY-STATE').length, 1, 'unchanged waiting states are not logged every poll')
  readiness = { ...readiness, composerCount: 2 }
  await chat.checkReady()
  assert.equal(sent.length, 0, 'genuinely ambiguous composers never receive an automatic message')
  assert.ok(chat.getState().status.includes('输入框以继续发送'), 'the user can resolve real ambiguity by focusing the intended composer')
  readiness = { ...readiness, composer: true, composerCount: 1, composerTag: platformId === 'deepseek' ? 'textarea' : 'div' }
  await chat.checkReady()
  assert.equal(sent.length, 0, 'the full editor must also have its attachment input ready')
  assert.equal(chat.getState().error, false, 'loading the uploader is a waiting state')
  readiness = { ...readiness, uploadReady: true, fileInputCount: 1 }
  await chat.checkReady(); await chat.checkReady()
  assert.equal(sent.length, 1)
  assert.equal(sent[0][2], `/synthetic-export/${platformId}-context.md`)
  assert.equal(sent[0][3], 'synthetic prompt')
  assert.equal(chat.getState().error, false)
  assert.equal(chat.getState().platformId, platformId)
  assert.equal(chat.getState().status, '', 'a successful send does not leave a redundant description')
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
}

function attachmentFixture({ outcome = 'ok', navigate = false, invalid = false, platformId = 'deepseek',
  initialUrl = fixtureHomes[platformId] } = {}) {
  let cleanups = 0
  let url = initialUrl
  const sends = [], scripts = [], requests = []
  const filename = `${platformId}-context.md`
  const attachment = { path: '/synthetic-staging/' + filename, fileName: filename, mimeType: 'text/markdown', sizeBytes: 100 }
  const helper = load('../src/main/question-chat-send.ts', {
    'node:path': path, 'node:crypto': { randomUUID }, './injected/send-interceptor.js?raw': { default: 'synthetic bridge' },
    '../shared/deepseek-question': shared,
    './question-chat-page': { questionPageCall: async (_contents, script) => { scripts.push(script) } },
    './file-access': { prepareFiles: async (...args) => {
      requests.push(args)
      if (navigate) url = fixtureConversations[platformId]
      return { failed: invalid, attachments: [attachment], cleanup: async () => { cleanups++ } }
    } },
    './page-files': { sendPageFiles: async (...args) => { sends.push(args); return outcome } }
  })
  const wc = { getURL: () => url, isDestroyed: () => false }
  const prompt = shared.selectionQuestionPrompt(selection, platformId)
  return { sends, scripts, requests, cleanups: () => cleanups,
    send: () => helper.sendQuestionChatAttachment(wc, { id: platformId, page: {} }, '/synthetic-export/' + filename, prompt, new AbortController().signal, () => true), prompt }
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

function uploadFixture({ nextUrl = 'https://chat.deepseek.com/a/chat/s/new-synthetic', allow = true, captionAccepted = true, changeBeforeSubmit = false, platformId = 'deepseek',
  confirmationUrls = [], confirmationStatuses = [], chooserStates = [true] } = {}) {
  let now = 10000, submitted = false, confirmationReads = 0, chooserReads = 0
  let url = fixtureHomes[platformId]
  const calls = [], logs = [], commands = []
  class Clock extends Date { static now() { return now } }
  const debuggerApi = new EventEmitter()
  debuggerApi.attached = false
  debuggerApi.isAttached = () => debuggerApi.attached
  debuggerApi.attach = () => { debuggerApi.attached = true }
  debuggerApi.detach = () => { debuggerApi.attached = false }
  debuggerApi.sendCommand = async (method, params) => {
    commands.push({ method, params })
    return method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : method === 'DOM.querySelector' ? { nodeId: 2 } : {}
  }
  const wc = { debugger: debuggerApi, getURL: () => url, isDestroyed: () => false, executeJavaScript: async source => {
    const method = /Interceptor\?\.([\w]+)\(/.exec(source)?.[1]
    calls.push(method)
    if (method === 'beginFileSend') return 'ok'
    if (method === 'openFileChooser') {
      const state = chooserStates[Math.min(chooserReads++, chooserStates.length - 1)]
      if (state === true) debuggerApi.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 7, mode: 'selectMultiple' })
      return state
    }
    if (method === 'fileChooserDiagnostics') return { rootFound: true, menuCount: 0, localEntryCount: 0 }
    if (method === 'refreshFileInput' || method === 'fileSelectionApplied' || method === 'releaseFileSend') return true
    if (method === 'prepareFileSendCaption') {
      if (changeBeforeSubmit) url = nextUrl
      return captionAccepted
    }
    if (method === 'submitFileSend') { submitted = true; url = nextUrl; return true }
    if (method === 'fileSendStatus') {
      if (!submitted) return { status: 'ready', namesSeen: true }
      const index = confirmationReads++
      if (index < confirmationUrls.length) url = confirmationUrls[index]
      return { status: confirmationStatuses[index] || 'sent' }
    }
    throw new Error('Unexpected method ' + method)
  } }
  const api = load('../src/main/page-files.ts', {
    'node:fs': { mkdirSync() {}, appendFileSync: (_path, line) => logs.push(line) },
    'node:os': { tmpdir: () => '/synthetic-temp' }, 'node:path': path, '../shared/deepseek-question': shared
  }, { Date: Clock, console: { warn() {} }, setTimeout: (callback, delay) => {
    // Advance only actual polling pauses, not unused CDP timeout races.
    const handle = { active: true }
    if (delay <= 250) queueMicrotask(() => { if (handle.active) { now += delay; callback() } })
    return handle
  }, clearTimeout: handle => { handle.active = false } })
  return { calls, logs, commands, send: () => api.sendPageFiles(wc, platformId, [{ path: '/staging/context.md', fileName: 'context.md', mimeType: 'text/markdown', sizeBytes: 100 }],
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

test('ChatGPT ordinary and project conversations identify the same local source, rejecting other providers and invalid routes', () => {
  for (const sourcePath of [`/c/${chatgptId}`, chatgptSelection.sourcePath, `/g/g-custom/c/%36${chatgptId.slice(1)}`]) {
    assert.equal(shared.selectionQuestionConversation('chatgpt', 'https://chatgpt.com' + sourcePath)?.id, chatgptId)
    const snapshot = markdown.savedQuestionSnapshot(chatgptContext(), chatgptId, { ...chatgptSelection, sourcePath }, 'chatgpt')
    assert.equal(snapshot.platformId, 'chatgpt')
    assert.deepEqual(Array.from(snapshot.messages, message => message.id), ['user-1', 'assistant-1', 'user-2', 'assistant-2'])
  }
  for (const url of [`https://chatgpt.com.evil.test/c/${chatgptId}`, `https://chat.deepseek.com/c/${chatgptId}`,
    'https://chatgpt.com/g/g-p-project', 'https://chatgpt.com/c/placeholder', 'https://chatgpt.com/c/%E0%A4']) {
    assert.equal(shared.selectionQuestionConversation('chatgpt', url), null)
  }
  assert.throws(() => markdown.savedQuestionSnapshot(chatgptContext(), chatgptId, selection, 'chatgpt'), category('local-source'))
  assert.equal(shared.isQuestionChatHome('chatgpt', 'https://chatgpt.com/?model=example'), true)
  assert.equal(shared.isQuestionChatHome('chatgpt', `https://chatgpt.com/c/${chatgptId}`), false)
  assert.equal(shared.supportsSelectionQuestion('unsupported'), false)
})

test('ChatGPT selection creates a separate sidebar with the selected-answer snapshot and correct Markdown prompt exactly once', async () => {
  const fixture = controllerFixture(chatgptContext(), { platformId: 'chatgpt', draft: chatgptSelection, id: chatgptId })
  try {
    fixture.enter(); fixture.enter(); await flush()
    assert.equal(fixture.readCalls(), 1)
    fixture.resolve(); await flush()
    assert.equal(fixture.chats.length, 1)
    assert.equal(fixture.snapshots[0].platformId, 'chatgpt')
    assert.equal(fixture.snapshots[0].messages.length, 4)
    assert.equal(fixture.chats[0][1].id, 'chatgpt')
    assert.equal(fixture.chats[0][7], '/synthetic-export/chatgpt-context.md')
    assert.ok(fixture.chats[0][4].includes('chatgpt-context.md'))
    assert.ok(fixture.chats[0][4].includes('引用资料'))
    assert.equal(fixture.chats[0][4].includes('deepseek-context.md'), false)
  } finally { fixture.controller.destroy() }
})

test('changing the ChatGPT source while local history loads prevents a late sidebar', async () => {
  const fixture = controllerFixture(chatgptContext(), { platformId: 'chatgpt', draft: chatgptSelection, id: chatgptId })
  try {
    fixture.enter(); await flush()
    fixture.wc.url = 'https://chatgpt.com/'
    fixture.wc.emit('did-navigate-in-page', {}, fixture.wc.url, true)
    fixture.resolve(); await flush()
    assert.equal(fixture.chats.length, 0)
    assert.equal(fixture.snapshots.length, 0)
  } finally { fixture.controller.destroy() }
})

test('ChatGPT attachment uses its own uploader and does not enable terminal commands or prompt injection', async () => {
  const fixture = attachmentFixture({ platformId: 'chatgpt' })
  assert.equal(await fixture.send(), 'ok')
  assert.equal(fixture.sends[0][1], 'chatgpt')
  assert.equal(fixture.requests[0][3], 'chatgpt')
  assert.equal(fixture.sends[0][2][0].fileName, 'chatgpt-context.md')
  assert.equal(fixture.sends[0][6].caption, fixture.prompt)
  assert.equal(fixture.cleanups(), 1)
  for (const expected of ['"enabled":false', '"promptInjectionEnabled":false']) assert.ok(fixture.scripts[0].includes(expected))
  const old = attachmentFixture({ platformId: 'chatgpt', initialUrl: `https://chatgpt.com/c/${chatgptId}` })
  assert.equal(await old.send(), 'cancelled')
  assert.equal(old.sends.length, 0)
})

test('ChatGPT initial sends accept a new same-origin conversation only after the explicit submit', async () => {
  for (const destination of [`https://chatgpt.com/c/${chatgptId}`, `https://chatgpt.com/g/g-p-example/c/${chatgptId}`]) {
    const fixture = uploadFixture({ platformId: 'chatgpt', nextUrl: destination })
    assert.equal(await fixture.send(), 'ok')
    assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, 1)
  }
  for (const options of [{ allow: false }, { nextUrl: `https://evil.test/c/${chatgptId}` }, { nextUrl: 'https://chatgpt.com/c/placeholder' }, { changeBeforeSubmit: true }]) {
    const fixture = uploadFixture({ platformId: 'chatgpt', nextUrl: `https://chatgpt.com/c/${chatgptId}`, ...options })
    assert.equal(await fixture.send(), options.changeBeforeSubmit ? 'cancelled' : 'unknown')
    assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, options.changeBeforeSubmit ? 0 : 1)
  }
})

test('ChatGPT confirms the owned message through home parameters, intermediate routes and conversation URL normalization', async () => {
  const conversation = `https://chatgpt.com/c/${chatgptId}`
  for (const transition of [
    { nextUrl: 'https://chatgpt.com/?model=synthetic', confirmationUrls: ['https://chatgpt.com/?model=synthetic#chat', conversation] },
    { nextUrl: 'https://chatgpt.com/c/pending', confirmationUrls: ['https://chatgpt.com/c/pending', conversation] },
    { nextUrl: `${conversation}?model=synthetic`, confirmationUrls: [`${conversation}#chat`, conversation] },
    { nextUrl: `https://chatgpt.com/g/g-p-example/c/${chatgptId}`, confirmationUrls: [conversation, `${conversation}/`] }
  ]) {
    const fixture = uploadFixture({ platformId: 'chatgpt', ...transition, confirmationStatuses: ['confirming', 'confirming'] })
    assert.equal(await fixture.send(), 'ok')
    assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, 1, 'navigation never retries the submit')
    assert.ok(fixture.logs.some(log => log.includes('message-confirmed')))
    assert.equal(fixture.logs.join('').includes(chatgptId), false, 'route diagnostics omit conversation identities')
    assert.equal(fixture.logs.join('').includes('model=synthetic'), false, 'route diagnostics omit query values')
  }
})

test('ChatGPT confirmation never succeeds on another origin, a different conversation or a route that stays unrecognized', async () => {
  const conversation = `https://chatgpt.com/c/${chatgptId}`
  const another = 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000002'
  for (const transition of [
    { nextUrl: conversation, confirmationUrls: [another] },
    { nextUrl: conversation, confirmationUrls: ['https://chatgpt.com/'] },
    { nextUrl: conversation, confirmationUrls: [`https://evil.test/c/${chatgptId}`] },
    { nextUrl: 'https://chatgpt.com/c/pending' },
    { nextUrl: `${conversation}?model=synthetic`, allow: false }
  ]) {
    const fixture = uploadFixture({ platformId: 'chatgpt', ...transition })
    assert.equal(await fixture.send(), 'unknown', 'a sent token alone cannot override a changed or unrecognized destination')
    assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, 1)
    assert.equal(fixture.logs.some(log => log.includes('message-confirmed')), false)
  }
})

test('Gemini uses its measured app routes and exports only saved messages through the selected answer', () => {
  assert.equal(shared.supportsSelectionQuestion('gemini'), true)
  for (const url of ['https://gemini.google.com/app', 'https://gemini.google.com/app/', 'https://gemini.google.com/app?synthetic=1']) {
    assert.equal(shared.isQuestionChatHome('gemini', url), true)
  }
  assert.equal(shared.isQuestionChatHome('gemini', fixtureConversations.gemini), false)
  for (const sourcePath of [geminiSelection.sourcePath, `${geminiSelection.sourcePath}/`, `/app/%30${geminiId.slice(1)}`]) {
    assert.equal(shared.selectionQuestionConversation('gemini', 'https://gemini.google.com' + sourcePath)?.id, geminiId)
  }
  for (const url of ['https://gemini.google.com/', 'https://gemini.google.com/app/pending',
    `https://gemini.google.com/app/${chatgptId}`, `https://gemini.google.com/app/${geminiId}/another`,
    `https://gemini.google.com.evil.test/app/${geminiId}`, `https://accounts.google.com/app/${geminiId}`, 'https://gemini.google.com/app/%E0%A4']) {
    assert.equal(shared.selectionQuestionConversation('gemini', url), null)
  }
  const snapshot = markdown.savedQuestionSnapshot({ ...geminiContext(), title: '' }, geminiId, geminiSelection, 'gemini')
  assert.equal(snapshot.title, 'Gemini 对话')
  assert.deepEqual(Array.from(snapshot.messages, message => message.id), ['user-1', 'assistant-1', 'user-2', 'assistant-2'])
  const document = markdown.questionContextMarkdown(snapshot)
  assert.ok(document.startsWith('# Gemini 对话'))
  assert.equal(document.includes('稍后的回答'), false)
  assert.throws(() => markdown.savedQuestionSnapshot(chatgptContext(), geminiId, geminiSelection, 'gemini'), category('local-source'))
})

test('Gemini trusted selection opens one Gemini sidebar with its Markdown context; switching away cancels a pending export', async () => {
  for (const cancel of [false, true]) {
    const fixture = controllerFixture(geminiContext(), { platformId: 'gemini', draft: geminiSelection, id: geminiId })
    try {
      fixture.enter(); fixture.enter(); await flush()
      assert.equal(fixture.readCalls(), 1)
      if (cancel) {
        fixture.wc.url = fixtureHomes.gemini
        fixture.wc.emit('did-navigate-in-page', {}, fixture.wc.url, true)
      }
      fixture.resolve(); await flush()
      assert.equal(fixture.chats.length, cancel ? 0 : 1)
      if (!cancel) {
        assert.equal(fixture.chats[0][1].id, 'gemini')
        assert.equal(fixture.chats[0][7], '/synthetic-export/gemini-context.md')
        assert.ok(fixture.chats[0][4].includes('gemini-context.md'))
        assert.ok(fixture.chats[0][4].includes(geminiSelection.question))
        assert.equal(fixture.snapshots[0].messages.length, 4)
      }
    } finally { fixture.controller.destroy() }
  }
})

test('Gemini prepares Markdown for its uploader with terminal execution and prompt injection disabled', async () => {
  const fixture = attachmentFixture({ platformId: 'gemini' })
  assert.equal(await fixture.send(), 'ok')
  assert.equal(fixture.sends[0][1], 'gemini')
  assert.equal(fixture.sends[0][2][0].fileName, 'gemini-context.md')
  assert.equal(fixture.requests[0][3], 'gemini')
  assert.equal(fixture.sends[0][6].caption, fixture.prompt)
  assert.equal(fixture.sends[0][6].allowNewConversation, true)
  assert.equal(fixture.cleanups(), 1)
  for (const expected of ['"enabled":false', '"promptInjectionEnabled":false']) assert.ok(fixture.scripts[0].includes(expected))
  const old = attachmentFixture({ platformId: 'gemini', initialUrl: fixtureConversations.gemini })
  assert.equal(await old.send(), 'cancelled')
  assert.equal(old.sends.length, 0)
})

test('Gemini uses its transient native chooser, then sends the caption once and confirms the new app conversation', async () => {
  const fixture = uploadFixture({ platformId: 'gemini', nextUrl: fixtureConversations.gemini + '?synthetic=1',
    chooserStates: ['waiting', 'waiting', true], confirmationUrls: [fixtureConversations.gemini], confirmationStatuses: ['confirming'] })
  assert.equal(await fixture.send(), 'ok')
  assert.equal(fixture.calls.filter(call => call === 'openFileChooser').length, 3)
  assert.equal(fixture.calls.includes('refreshFileInput'), false, 'Gemini has no persistent file input')
  const selected = fixture.commands.find(command => command.method === 'DOM.setFileInputFiles')
  assert.equal(selected.params.backendNodeId, 7)
  assert.equal(selected.params.files[0], '/staging/context.md')
  assert.equal(fixture.commands.filter(command => command.method === 'DOM.querySelector').length, 0)
  assert.equal(fixture.commands.filter(command => command.method === 'Page.setInterceptFileChooserDialog').length, 2)
  assert.ok(fixture.calls.indexOf('prepareFileSendCaption') < fixture.calls.indexOf('submitFileSend'))
  assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, 1)
  const blocked = uploadFixture({ platformId: 'gemini', chooserStates: [false] })
  assert.equal(await blocked.send(), 'upload-failed')
  assert.equal(blocked.calls.includes('submitFileSend'), false)
})

test('Gemini cannot confirm a changed account origin or another conversation after submission', async () => {
  for (const options of [{ nextUrl: 'https://accounts.google.com/app' },
    { nextUrl: fixtureConversations.gemini, confirmationUrls: ['https://gemini.google.com/app/fedcba9876543210'] },
    { nextUrl: fixtureConversations.gemini, changeBeforeSubmit: true }]) {
    const fixture = uploadFixture({ platformId: 'gemini', ...options })
    assert.equal(await fixture.send(), options.changeBeforeSubmit ? 'cancelled' : 'unknown')
    assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, options.changeBeforeSubmit ? 0 : 1)
  }
})

test('Claude recognizes only its own chat UUIDs and snapshots the local transcript through the selected answer', () => {
  assert.equal(shared.supportsSelectionQuestion('claude'), true)
  assert.equal(shared.selectionQuestionTarget('claude').label, 'Claude')
  for (const url of ['https://claude.ai/new', 'https://claude.ai/new/', 'https://claude.ai/new?synthetic=1']) {
    assert.equal(shared.isQuestionChatHome('claude', url), true)
  }
  for (const url of ['https://claude.ai/', 'https://claude.ai/login', 'https://claude.ai/logout?involuntary=1',
    'https://claude.ai/project/synthetic', 'https://claude.ai.evil.test/new', 'https://anthropic.com/new', fixtureConversations.claude]) {
    assert.equal(shared.isQuestionChatHome('claude', url), false)
  }
  for (const sourcePath of [claudeSelection.sourcePath, claudeSelection.sourcePath + '/', `/chat/%66${claudeId.slice(1)}`]) {
    assert.equal(shared.selectionQuestionConversation('claude', 'https://claude.ai' + sourcePath)?.id, claudeId)
  }
  for (const url of ['https://claude.ai/new', 'https://claude.ai/chat/pending', `https://claude.ai/chat/${geminiId}`,
    `https://claude.ai/chat/${claudeId}/another`, `https://claude.ai.evil.test/chat/${claudeId}`,
    `https://anthropic.com/chat/${claudeId}`, 'https://claude.ai/chat/%E0%A4']) {
    assert.equal(shared.selectionQuestionConversation('claude', url), null)
  }
  const context = { ...claudeContext(), title: '' }
  context.messages[3].content = answer.replace('Compose', '**Compose**')
  const snapshot = markdown.savedQuestionSnapshot(context, claudeId, claudeSelection, 'claude')
  assert.equal(snapshot.title, 'Claude 对话')
  assert.deepEqual(Array.from(snapshot.messages, message => message.id), ['user-1', 'assistant-1', 'user-2', 'assistant-2'])
  assert.ok(markdown.questionContextMarkdown(snapshot).startsWith('# Claude 对话'))
  assert.equal(markdown.questionContextMarkdown(snapshot).includes('稍后的回答'), false)
  assert.throws(() => markdown.savedQuestionSnapshot(chatgptContext(), claudeId, claudeSelection, 'claude'), category('local-source'))
})

test('Claude trusted selection opens one native sidebar with its Markdown context and cancels if the source changes', async () => {
  for (const cancel of [false, true]) {
    const fixture = controllerFixture(claudeContext(), { platformId: 'claude', draft: claudeSelection, id: claudeId })
    try {
      fixture.enter(); fixture.enter(); await flush()
      assert.equal(fixture.readCalls(), 1)
      if (cancel) {
        fixture.wc.url = fixtureHomes.claude
        fixture.wc.emit('did-navigate-in-page', {}, fixture.wc.url, true)
      }
      fixture.resolve(); await flush()
      assert.equal(fixture.chats.length, cancel ? 0 : 1)
      if (!cancel) {
        assert.equal(fixture.chats[0][1].id, 'claude')
        assert.equal(fixture.chats[0][7], '/synthetic-export/claude-context.md')
        assert.ok(fixture.chats[0][4].includes('claude-context.md'))
        assert.ok(fixture.chats[0][4].includes(claudeSelection.question))
        assert.equal(fixture.snapshots[0].messages.length, 4)
      }
    } finally { fixture.controller.destroy() }
  }
})

test('Claude prepares its Markdown and question for the native uploader, refusing existing chats', async () => {
  const fixture = attachmentFixture({ platformId: 'claude' })
  assert.equal(await fixture.send(), 'ok')
  assert.equal(fixture.sends[0][1], 'claude')
  assert.equal(fixture.sends[0][2][0].fileName, 'claude-context.md')
  assert.equal(fixture.requests[0][3], 'claude')
  assert.equal(fixture.sends[0][6].caption, fixture.prompt)
  assert.equal(fixture.sends[0][6].allowNewConversation, true)
  for (const expected of ['"enabled":false', '"promptInjectionEnabled":false']) assert.ok(fixture.scripts[0].includes(expected))
  for (const initialUrl of [fixtureConversations.claude, 'https://claude.ai/login']) {
    const old = attachmentFixture({ platformId: 'claude', initialUrl })
    assert.equal(await old.send(), 'cancelled')
    assert.equal(old.sends.length, 0)
  }
})

test('Claude uploads through its persistent file input and confirms a new chat once across URL normalization', async () => {
  const fixture = uploadFixture({ platformId: 'claude', nextUrl: fixtureConversations.claude + '?synthetic=1',
    confirmationUrls: [fixtureConversations.claude], confirmationStatuses: ['confirming'] })
  assert.equal(await fixture.send(), 'ok')
  assert.ok(fixture.calls.includes('refreshFileInput'))
  assert.equal(fixture.calls.includes('openFileChooser'), false)
  assert.ok(fixture.commands.some(command => command.method === 'DOM.setFileInputFiles' && command.params.nodeId === 2))
  assert.equal(fixture.calls.filter(call => call === 'submitFileSend').length, 1)
  assert.ok(fixture.calls.indexOf('prepareFileSendCaption') < fixture.calls.indexOf('submitFileSend'))
  for (const options of [
    { nextUrl: 'https://anthropic.com/new' },
    { nextUrl: fixtureConversations.claude, confirmationUrls: [`https://claude.ai/chat/${chatgptId}`] },
    { nextUrl: fixtureConversations.claude, confirmationUrls: [fixtureHomes.claude] },
    { nextUrl: fixtureConversations.claude, changeBeforeSubmit: true }
  ]) {
    const changed = uploadFixture({ platformId: 'claude', ...options })
    assert.equal(await changed.send(), options.changeBeforeSubmit ? 'cancelled' : 'unknown')
    assert.equal(changed.calls.filter(call => call === 'submitFileSend').length, options.changeBeforeSubmit ? 0 : 1)
  }
})

test('sidebar readiness checks adapter-provided message markers and rejects ambiguous composers', () => {
  const window = {}
  const editor = { tagName: 'DIV', isContentEditable: true, getClientRects: () => [{}] }
  let messages = [], inputs = [editor], fileInputs = []
  new Script(readFileSync(new URL('../src/main/injected/question-chat-sender.js', import.meta.url), 'utf8'))
    .runInNewContext({ window, document: { querySelectorAll: selector => selector === '.synthetic-composer' ? inputs
      : selector === 'input[type="file"]' ? fileInputs : messages },
      getComputedStyle: () => ({ visibility: 'visible' }) })
  const page = { composerKind: 'contenteditable', composerSelectors: ['.synthetic-composer'], messageSelectors: ['[data-chatgpt-selection-message-id]'], assistantSelectors: [], ignoreHiddenReplyNodes: true }
  assert.equal(window.__questionChatReady(page).composer, true)
  assert.equal(window.__questionChatReady(page).uploadReady, false, 'an editor alone cannot receive an attachment')
  fileInputs = [{ disabled: true }]
  assert.equal(window.__questionChatReady(page).uploadReady, false, 'a disabled uploader is still loading')
  fileInputs = [{ disabled: false }]
  assert.equal(window.__questionChatReady(page).uploadReady, true)
  inputs = [{ tagName: 'TEXTAREA', isContentEditable: false, getClientRects: () => [{}] }]
  assert.equal(window.__questionChatReady(page).composer, false, 'ChatGPT pending-home-input is not the full editor')
  assert.equal(window.__questionChatReady({ ...page, composerKind: 'textarea' }).composer, true, 'DeepSeek keeps its native textarea composer')
  inputs = [editor]
  assert.equal(window.__questionChatReady(page).hasHistory, false)
  messages = [{ getClientRects: () => [] }]
  assert.equal(window.__questionChatReady(page).hasHistory, false, 'hidden ChatGPT cache does not make a new chat non-empty')
  messages.push({ getClientRects: () => [{}] })
  assert.equal(window.__questionChatReady(page).hasHistory, true)
  inputs = [...inputs, { ...editor }]
  assert.equal(window.__questionChatReady(page).composer, false)
})

test('Gemini readiness waits for its scoped upload toolbar without requiring a permanent file input or clicking controls', () => {
  const window = {}
  let entries = [], local = [], messages = []
  const root = { querySelectorAll: () => entries }
  const editor = { tagName: 'DIV', isContentEditable: true, getClientRects: () => [{}], closest: () => root }
  const upload = { getClientRects: () => [{}], closest: () => null, getAttribute: () => null, disabled: false,
    matches: () => false, click() { throw new Error('readiness must not click the uploader') } }
  const page = { composerKind: 'contenteditable', composerSelectors: ['.synthetic-composer'], messageSelectors: ['message-content'],
    fileLocalUploadSelector: '.synthetic-local', fileComposerRootSelector: '.synthetic-root', fileUploadMenuSelectors: ['.synthetic-menu'] }
  new Script(readFileSync(new URL('../src/main/injected/question-chat-sender.js', import.meta.url), 'utf8'))
    .runInNewContext({ window, document: { querySelectorAll: selector => selector === '.synthetic-composer' ? [editor]
      : selector === '.synthetic-local' ? local : selector === 'message-content' ? messages : [] },
      getComputedStyle: () => ({ visibility: 'visible' }) })
  assert.equal(window.__questionChatReady(page).composer, true)
  assert.equal(window.__questionChatReady(page).uploadReady, false)
  entries = [upload]
  assert.equal(window.__questionChatReady(page).uploadReady, true)
  assert.equal(window.__questionChatReady(page).fileInputCount, 0)
  upload.disabled = true
  assert.equal(window.__questionChatReady(page).uploadReady, false)
  entries = []; local = [{ ...upload, disabled: false }]
  assert.equal(window.__questionChatReady(page).uploadReady, true)
  messages = [{ getClientRects: () => [{}] }]
  assert.equal(window.__questionChatReady(page).hasHistory, true, 'an existing Gemini chat is never used as the new sidebar chat')
})

test('Gemini readiness prefers its measured composer over extra generic editables and ignores inactive ancestors', () => {
  const window = {}
  const primary = 'div.ql-editor[contenteditable="true"]', alternate = 'rich-textarea div[contenteditable="true"]', generic = 'div[contenteditable="true"]'
  const menuSelector = 'button[aria-label="上传和工具"]', scopeSelector = 'fieldset.input-area-fieldset'
  const menu = { getClientRects: () => [{}], closest: () => null, getAttribute: () => null, matches: () => false, disabled: false }
  const root = { querySelectorAll: selector => selector === menuSelector ? [menu] : [] }
  const editor = { tagName: 'DIV', isContentEditable: true, isConnected: true, getClientRects: () => [{}],
    closest: selector => selector === scopeSelector ? root : null }
  let inactive = false
  const extra = { ...editor, closest: selector => selector === scopeSelector ? root
    : inactive && selector === '[hidden], [inert], [aria-hidden="true"]' ? root : null }
  let preferred = [editor], broad = [editor, extra]
  const document = { activeElement: null, querySelectorAll: selector => selector === primary || selector === alternate ? preferred
    : selector === generic ? broad : [] }
  const page = { composerKind: 'contenteditable', composerSelectors: [primary, alternate, generic], messageSelectors: ['message-content'],
    fileLocalUploadSelector: 'button[data-test-id="local-images-files-uploader-button"]',
    fileComposerRootSelector: scopeSelector, fileUploadMenuSelectors: [menuSelector] }
  new Script(readFileSync(new URL('../src/main/injected/question-chat-sender.js', import.meta.url), 'utf8'))
    .runInNewContext({ window, document, getComputedStyle: () => ({ visibility: 'visible' }) })
  let ready = window.__questionChatReady(page)
  assert.equal(ready.composer, true, 'the broad fallback does not invalidate the unique measured Quill composer')
  assert.equal(ready.composerCandidateCount, 2)
  assert.equal(ready.composerCount, 1)
  assert.equal(ready.composerSelectorIndex, 0)
  assert.equal(ready.uploadReady, true, 'the upload toolbar is discovered within the selected composer owner')

  preferred = [editor, extra]
  assert.equal(window.__questionChatReady(page).composer, false, 'two equally specific live editors remain ambiguous')
  inactive = true
  ready = window.__questionChatReady(page)
  assert.equal(ready.composer, true, 'aria-hidden/inert owners exclude their editors even if layout rectangles remain')
  assert.equal(ready.composerCandidateCount, 1)
  inactive = false
  preferred = []
  assert.equal(window.__questionChatReady(page).composer, false, 'multiple generic fallbacks cannot be chosen arbitrarily')
  preferred = [editor, extra]
  document.activeElement = { closest: selector => selector === primary ? extra : null }
  assert.equal(window.__questionChatReady(page).composer, true, 'the native focus owner resolves the editor as it does in the sending bridge')
})
