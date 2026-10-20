// User-run only: node --test tests/deepseek-question.test.mjs
// Synthetic data and fake session.fetch; no Electron, credentials, disk writes or network.
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
const html = load('../src/shared/deepseek-context-html.ts', { './deepseek-question': shared })
const sourceId = 'test-conversation'
const answer = '原计划 Kotlin + Compose，但无法访问 Maven，因此实际采用 Java 和原生 Android View。'
const selection = { sourcePath: `/a/chat/s/${sourceId}`, selectedText: 'Compose', question: '这是什么？', answerText: answer }
const wrap = data => ({ code: 0, data: { biz_code: 0, biz_data: data } })
const message = (id, parent_id, role, content) => ({ id, parent_id, role, content })
const history = messages => wrap({ chat_session: { id: sourceId }, chat_messages: messages })
const validHistory = () => history([
  message(1, null, 'USER', '介绍项目'), message(2, 1, 'ASSISTANT', '第一条回答'),
  message(3, 2, 'USER', '技术栈呢'), message(4, 3, 'ASSISTANT', answer),
  message(5, 4, 'USER', '稍后的问题'), message(6, 5, 'ASSISTANT', '稍后的回答'),
  message(20, 1, 'ASSISTANT', '另一个分支')
])
const category = expected => error => error instanceof shared.DeepSeekQuestionError && error.category === expected

test('shares ancestors through the selected answer, excluding later turns and sibling branches', () => {
  const ids = shared.deepSeekMessageRange(validHistory(), sourceId, selection)
  assert.deepEqual(Array.from(ids), [4, 3, 2, 1])
  assert.equal(shared.deepSeekConversation('https://chat.deepseek.com.evil.test/a/chat/s/x'), null)
  assert.equal(shared.deepSeekConversation(`https://chat.deepseek.com/a/chat/s/${sourceId}`).id, sourceId)
})

test('uses response fragments, excluding reasoning, and matches rendered Markdown', () => {
  const payload = history([message(1, null, 'USER', '技术栈'), {
    id: 2, parent_id: 1, role: 'ASSISTANT', fragments: [
      { type: 'THINK', content: '这里不是回答正文' }, { type: 'RESPONSE', content: answer.replace('Compose', '**Compose**') }
    ]
  }])
  assert.deepEqual(Array.from(shared.deepSeekMessageRange(payload, sourceId, selection)), [2, 1])
})

test('refuses empty cached history, unknown schema, another conversation and duplicate answer bodies', () => {
  assert.throws(() => shared.deepSeekMessageRange(history([]), sourceId, selection), category('empty-history'))
  assert.throws(() => shared.deepSeekMessageRange(validHistory(), 'other', selection), category('history-source'))
  assert.throws(() => shared.deepSeekMessageRange(history([{ id: 4, role: 'ASSISTANT', content: answer }]), sourceId, selection), category('history-schema'))
  assert.throws(() => shared.deepSeekMessageRange(history([
    message(1, null, 'USER', '问题'), message(2, 1, 'ASSISTANT', answer), message(4, 1, 'ASSISTANT', answer)
  ]), sourceId, selection), category('answer-match'))
})

test('refuses incomplete parent chains, cycles, duplicate IDs and a selected word in a different answer', () => {
  assert.throws(() => shared.deepSeekMessageRange(history([message(4, 3, 'ASSISTANT', answer)]), sourceId, selection), category('partial-history'))
  assert.throws(() => shared.deepSeekMessageRange(history([
    message(3, 4, 'USER', '问题'), message(4, 3, 'ASSISTANT', answer)
  ]), sourceId, selection), category('history-cycle'))
  assert.throws(() => shared.deepSeekMessageRange(history([
    message(4, null, 'USER', '问题'), message(4, null, 'ASSISTANT', answer)
  ]), sourceId, selection), category('duplicate-id'))
  assert.throws(() => shared.deepSeekMessageRange(history([message(4, null, 'ASSISTANT', 'Compose 的另一条回答')]), sourceId, selection), category('answer-match'))
})

test('validates share business status and asks about the attached context, quote and question without a URL', () => {
  const url = shared.deepSeekShareUrl(wrap({ share_id: 'synthetic-share-id' }))
  assert.equal(url, 'https://chat.deepseek.com/share/synthetic-share-id')
  assert.throws(() => shared.deepSeekShareUrl(wrap({ share_id: '../invalid' })), category('share-response'))
  assert.throws(() => shared.deepSeekShareUrl({ code: 0, data: { biz_code: 1 } }), category('provider-rejected'))
  const prompt = shared.deepSeekAttachmentPrompt(selection)
  for (const expected of ['deepseek-context.html', selection.question, selection.selectedText, '如果附件无法读取', '引用资料']) assert.ok(prompt.includes(expected))
  assert.equal(prompt.includes(url), false)
  assert.equal(prompt.includes('https://'), false)
})

test('offline HTML contains the same ancestors in reading order and escapes all conversation markup', () => {
  const payload = validHistory()
  payload.data.biz_data.chat_session.title = '<script>title</script>'
  payload.data.biz_data.chat_messages[0].content = '前文 <script>alert(1)</script> & "引号"\n```代码```'
  const snapshot = shared.deepSeekContextSnapshot(payload, shared.deepSeekMessageRange(payload, sourceId, selection),
    'https://chat.deepseek.com/share/synthetic-result', selection)
  assert.deepEqual(Array.from(snapshot.messages, item => item.id), [1, 2, 3, 4])
  assert.equal(snapshot.messages[0].role, 'user')
  const document = html.deepSeekContextHtml(snapshot)
  for (const expected of ['charset="UTF-8"', 'default-src \'none\'', '&lt;script&gt;alert(1)&lt;/script&gt;', '&amp;', '```代码```', answer, selection.question]) assert.ok(document.includes(expected))
  for (const excluded of ['<script>', '稍后的问题', '另一个分支', '<iframe', '<img', '<link']) assert.equal(document.includes(excluded), false)
  assert.ok(document.indexOf('第一条回答') < document.indexOf(answer))
  assert.throws(() => html.deepSeekContextHtml({ ...snapshot, shareUrl: 'https://evil.test/share/x' }), category('html-source'))
})

test('context fragments preserve all answer text and exclude reasoning', () => {
  const payload = history([message(1, null, 'USER', '上下文'), {
    id: 2, parent_id: 1, role: 'ASSISTANT', fragments: [
      { type: 'THINK', content: 'private reasoning' }, { type: 'RESPONSE', content: '回答开头' }, { type: 'RESPONSE', content: '回答结尾' }
    ]
  }])
  const snapshot = shared.deepSeekContextSnapshot(payload, [2, 1], 'https://chat.deepseek.com/share/synthetic', selection)
  assert.equal(snapshot.messages[1].text, '回答开头\n回答结尾')
  assert.equal(html.deepSeekContextHtml(snapshot).includes('private reasoning'), false)
})

test('HTML export writes an exclusive UTF-8 document in userData and rejects oversized attachments', async () => {
  const writes = []
  const saved = load('../src/main/deepseek-context-html.ts', {
    electron: { app: { getPath: name => { assert.equal(name, 'userData'); return '/synthetic-data' } } },
    'node:fs/promises': { mkdir: async () => {}, writeFile: async (...args) => writes.push(args) },
    'node:path': path, 'node:crypto': { randomUUID }, '../shared/deepseek-context-html': html, '../shared/deepseek-question': shared
  })
  const snapshot = shared.deepSeekContextSnapshot(validHistory(), [4, 3, 2, 1], 'https://chat.deepseek.com/share/synthetic', selection)
  const first = await saved.saveDeepSeekContextHtml(snapshot)
  const second = await saved.saveDeepSeekContextHtml(snapshot)
  assert.notEqual(first, second)
  assert.equal(path.basename(first), 'deepseek-context.html')
  assert.equal(writes[0][2].flag, 'wx')
  assert.equal(writes[0][2].encoding, 'utf8')
  assert.ok(writes[0][1].includes(answer))
  await assert.rejects(saved.saveDeepSeekContextHtml({ ...snapshot, messages: [{ id: 1, role: 'user', text: 'a'.repeat(21 * 1024 * 1024) }] }), category('html-size'))
  assert.equal(writes.length, 2)
})

function service() {
  const logs = []
  const exports = load('../src/main/deepseek-share.ts', {
    'node:fs': { appendFileSync(_file, line) { logs.push(line) }, mkdirSync() {} },
    'node:os': { tmpdir: () => '/synthetic-temp' }, 'node:path': path,
    '../shared/deepseek-question': shared
  })
  const observe = (token = 'synthetic-credential') => exports.observeDeepSeekHeaders({
    url: 'https://chat.deepseek.com/api/v0/chat/history_messages', webContentsId: 42,
    requestHeaders: { authorization: token, 'x-client-version': 'synthetic-version', Cookie: 'must-not-be-copied' }
  })
  observe()
  return { ...exports, logs, observe }
}
const response = json => new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } })
const contents = fetch => ({ id: 42, getUserAgent: () => 'Synthetic Chrome', session: { fetch } })

test('fresh history fetch drops incremental hints and creates the selected range without UI/clipboard access', async () => {
  const api = service()
  const requests = []
  let snapshot
  const wc = contents(async (url, options) => {
    requests.push({ url, options })
    return response(requests.length === 1 ? validHistory() : wrap({ share_id: 'synthetic-result' }))
  })
  const result = await api.createDeepSeekSelectionShare(wc, sourceId, selection, new AbortController().signal, () => true, async context => { snapshot = context })
  assert.equal(result, 'https://chat.deepseek.com/share/synthetic-result')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].options.method, 'GET')
  assert.deepEqual([...new URL(requests[0].url).searchParams.keys()], ['chat_session_id'])
  assert.equal(requests[0].options.headers['Cache-Control'], 'no-cache')
  assert.equal(requests[0].options.headers.Cookie, undefined)
  assert.deepEqual(JSON.parse(requests[1].options.body).message_ids, [4, 3, 2, 1])
  assert.deepEqual(Array.from(snapshot.messages, message => message.id), [1, 2, 3, 4])
  assert.equal(snapshot.shareUrl, result)
  const log = api.logs.join('')
  assert.ok(log.includes('SHARE-LINK'))
  for (const privateText of ['synthetic-credential', selection.question, answer, 'must-not-be-copied']) assert.equal(log.includes(privateText), false)
})

test('empty history or a changed account stops before the share POST', async () => {
  for (const variant of ['empty', 'account-change', 'source-change']) {
    const api = service()
    let calls = 0
    let current = true
    const wc = contents(async () => {
      calls++
      if (variant === 'account-change') api.observe('different-synthetic-credential')
      if (variant === 'source-change') current = false
      return response(variant === 'empty' ? history([]) : validHistory())
    })
    await assert.rejects(api.createDeepSeekSelectionShare(wc, sourceId, selection, new AbortController().signal, () => current),
      category(variant === 'empty' ? 'empty-history' : 'cancelled'))
    assert.equal(calls, 1)
  }
})

function controllerFixture() {
  const wc = new EventEmitter()
  wc.id = 42; wc.mainFrame = {}; wc.url = `https://chat.deepseek.com${selection.sourcePath}`
  wc.isDestroyed = () => false; wc.getURL = () => wc.url; wc.getUserAgent = () => 'Synthetic Chrome'
  wc.executeJavaScript = async source => source.includes('getSubmission()') ? selection : true
  let resolveShare
  let shareCalls = 0
  const chats = []
  const dependencies = {
    'node:crypto': { randomUUID }, '../shared/deepseek-question': shared,
    './deepseek-share': {
      questionPageCall: (webContents, source) => webContents.executeJavaScript(source),
      createDeepSeekSelectionShare: (...args) => { shareCalls++; return new Promise(resolve => { resolveShare = async url => {
        await args[5](shared.deepSeekContextSnapshot(validHistory(), [4, 3, 2, 1], url, selection)); resolve(url)
      } }) },
      releaseDeepSeekHeaders() {}, writeQuestionLog() { return '' }
    },
    './deepseek-context-html': { saveDeepSeekContextHtml: async () => '/synthetic-export/deepseek-context.html' },
    './question-chat': { QuestionChat: class { constructor(...args) { chats.push(args) } close() {} setOwnerVisible() {} } }
  }
  const { DeepSeekQuestion } = load('../src/main/deepseek-question.ts', dependencies)
  const controller = new DeepSeekQuestion(wc, { isDestroyed: () => false }, { id: 'deepseek' }, () => 'light')
  const enter = () => {
    wc.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' })
    wc.emit('console-message', { frame: wc.mainFrame, message: controller.reportTag + JSON.stringify({ event: 'question-submit' }) })
  }
  return { controller, wc, enter, chats, shareCalls: () => shareCalls, resolve: () => resolveShare('https://chat.deepseek.com/share/synthetic-result') }
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

test('repeated Enter creates one share and one sidebar chat; page reports without a gesture are ignored', async () => {
  const fixture = controllerFixture()
  fixture.wc.emit('console-message', { frame: fixture.wc.mainFrame, message: fixture.controller.reportTag + JSON.stringify({ event: 'question-submit' }) })
  await flush(); assert.equal(fixture.shareCalls(), 0)
  fixture.enter(); fixture.enter(); await flush()
  assert.equal(fixture.shareCalls(), 1)
  await fixture.resolve(); await flush()
  assert.equal(fixture.chats.length, 1)
  assert.ok(fixture.chats[0][5].includes(selection.question))
  assert.ok(fixture.chats[0][5].includes('附件'))
  assert.equal(fixture.chats[0][5].includes('https://'), false)
  assert.equal(fixture.chats[0][8], '/synthetic-export/deepseek-context.html')
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

test('sidebar sends its HTML attachment once, preserves on folding and disposes once', async () => {
  const views = [], added = [], removed = [], states = [], copied = [], released = []
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
    './deepseek-share': { questionPageCall: async () => ({ composer: true, hasHistory: false }), releaseDeepSeekHeaders: id => released.push(id), writeQuestionLog() {} },
    './question-chat-send': { sendQuestionChatAttachment: async (...args) => { sent.push(args); return 'ok' } }
  }, { setInterval: () => 1, clearInterval() {} })
  const chat = new QuestionChat(parent, { homeUrl: 'https://chat.deepseek.com/', partition: 'synthetic', page: {
    composerSelectors: ['textarea'], sendButtonSelectors: ['.synthetic-send']
  } }, 'light', 'Synthetic Chrome', 'https://chat.deepseek.com/share/synthetic', 'synthetic prompt', 'synthetic quote', state => states.push(state), '/synthetic-export/deepseek-context.html')
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
  assert.equal(sent[0][2], '/synthetic-export/deepseek-context.html')
  assert.equal(sent[0][3], 'synthetic prompt')
  assert.equal(chat.getState().error, false)
  assert.ok(chat.getState().status.includes('HTML 附件和问题'))
  chat.setOwnerVisible(false); chat.setOwnerVisible(true)
  assert.equal(views[0].visible, false, 'old bounds cannot show a chat when its owner changes')
  chat.setViewport({ x: 1000, y: 200, width: 400, height: 700 }, true)
  assert.equal(views[0].visible, true)
  chat.setViewport({ x: 0, y: 0, width: 0, height: 0 }, false)
  assert.equal(views[0].visible, false)
  assert.equal(views[0].webContents.destroyed, false, 'folding preserves the chat')
  chat.action('copy-link')
  assert.equal(copied[0], 'https://chat.deepseek.com/share/synthetic')
  chat.action('open-html'); chat.action('reveal-html')
  assert.equal(opened[0], chat.getState().htmlPath)
  assert.equal(revealed[0], chat.getState().htmlPath)
  chat.close(); chat.close()
  assert.equal(sent[0][4].aborted, true)
  assert.equal(removed.length, 1)
  assert.equal(views[0].webContents.destroyed, true)
  assert.deepEqual(released, [99])
  assert.equal(states.at(-1), null)
})

function attachmentFixture({ outcome = 'ok', navigate = false, invalid = false, initialUrl = 'https://chat.deepseek.com/' } = {}) {
  let cleanups = 0
  let url = initialUrl
  const sends = [], scripts = [], requests = []
  const attachment = { path: '/synthetic-staging/deepseek-context.html', fileName: 'deepseek-context.html', mimeType: 'text/html', sizeBytes: 100 }
  const helper = load('../src/main/question-chat-send.ts', {
    'node:path': path, 'node:crypto': { randomUUID }, './injected/send-interceptor.js?raw': { default: 'synthetic bridge' },
    './deepseek-share': { questionPageCall: async (_contents, script) => { scripts.push(script) } },
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
    send: () => helper.sendQuestionChatAttachment(wc, { id: 'deepseek', page: {} }, '/synthetic-export/deepseek-context.html', prompt, new AbortController().signal, () => true), prompt }
}

test('sidebar attachment reuses the uploader, adds the question as caption and cleans staging only', async () => {
  const fixture = attachmentFixture()
  assert.equal(await fixture.send(), 'ok')
  assert.equal(fixture.sends.length, 1)
  const args = fixture.sends[0]
  assert.equal(args[1], 'deepseek')
  assert.equal(args[2][0].mimeType, 'text/html')
  assert.equal(args[6].caption, fixture.prompt)
  assert.equal(args[6].allowNewConversation, true)
  assert.ok(fixture.scripts[0].includes('"enabled":false'))
  assert.ok(fixture.scripts[0].includes('"promptInjectionEnabled":false'))
  assert.equal(fixture.requests[0][0].files[0].path, '/synthetic-export/deepseek-context.html')
  assert.equal(fixture.cleanups(), 1)
})

test('unsupported HTML, a changed chat and a failed snapshot never trigger a URL fallback', async () => {
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
  return { calls, logs, send: () => api.sendPageFiles(wc, 'deepseek', [{ path: '/staging/context.html', fileName: 'context.html', mimeType: 'text/html', sizeBytes: 100 }],
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
