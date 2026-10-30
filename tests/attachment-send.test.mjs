// User-run offline regression tests for the actual injected script. No Electron,
// browser session or network. Run: node --test tests/attachment-send.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const interceptorSource = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const platformExports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({
  exports: platformExports,
  require(name) {
    assert.equal(name, './types')
    return { isConversationId() { throw new Error('Unexpected conversation validation') } }
  }
})

class ElementFixture {
  nodeType = 1
  isConnected = true
  parentElement = null
  disabled = false
  clicks = 0
  files = []

  constructor(tag, attributes = {}, content = []) {
    this.tagName = tag.toUpperCase()
    this.attributes = { ...attributes }
    this.replaceChildren(...(Array.isArray(content) ? content : [content]))
  }
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join('') }
  get innerText() { return this.textContent }
  get value() { return this.textContent }
  set value(value) { this.replaceChildren(value) }
  get type() { return this.getAttribute('type') || '' }
  get accept() { return this.getAttribute('accept') || '' }
  get multiple() { return this.getAttribute('multiple') !== null }
  getAttribute(name) { return this.attributes[name] ?? null }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  removeAttribute(name) { delete this.attributes[name] }
  getClientRects() { return [{}] }
  focus() {}
  dispatchEvent() { return true }
  click() { this.clicks++; this.onClick?.() }

  replaceChildren(...children) {
    for (const child of this.childNodes || []) child.parentElement = null
    this.childNodes = children.map((child) => typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child)
    for (const child of this.childNodes) child.parentElement = this
  }
  cloneNode(deep) {
    return new ElementFixture(this.tagName, this.attributes, deep ? this.childNodes.map((child) =>
      child.nodeType === 3 ? child.nodeValue : child.cloneNode(true)) : [])
  }
  remove() {
    if (!this.parentElement) return
    this.parentElement.childNodes = this.parentElement.childNodes.filter((child) => child !== this)
    this.parentElement = null
  }
  descendants() {
    return this.childNodes.filter((child) => child.nodeType === 1).flatMap((child) => [child, ...child.descendants()])
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()))
    const excluded = [...selector.matchAll(/:not\(([^()]*)\)/g)].map((match) => match[1])
    if (excluded.some((part) => this.matches(part))) return false
    selector = selector.replace(/:not\([^()]*\)/g, '')
    selector = selector.replace(/(\[[^\]]*\])|\.([a-zA-Z_][\w-]*)/g, (all, attribute, name) => attribute || '[class~="' + name + '"]')
    if (selector === '*') return true
    const tag = /^[a-z][\w-]*/i.exec(selector)?.[0] || ''
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false
    const attributes = [...selector.matchAll(/\[([\w-]+)(?:([*^$~]?=)"([^"]*)")?\]/g)]
    // Unsupported selectors intentionally fall through to the adapter's simpler selectors.
    if (selector.slice(tag.length).replace(/\[([^\]]*)\]/g, '') !== '') return false
    return attributes.every(([, name, operator, expected]) => {
      const value = this.getAttribute(name)
      if (value === null) return false
      if (!operator) return true
      if (operator === '*=') return value.includes(expected)
      if (operator === '^=') return value.startsWith(expected)
      if (operator === '$=') return value.endsWith(expected)
      if (operator === '~=') return value.split(/\s+/).includes(expected)
      return value === expected
    })
  }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node
    return null
  }
  contains(node) { return this === node || this.descendants().includes(node) }
  compareDocumentPosition(other) {
    if (this === other) return 0
    let root = this
    while (root.parentElement) root = root.parentElement
    const nodes = [root, ...root.descendants()]
    return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2
  }
}

const element = (tag, attributes, content) => new ElementFixture(tag, attributes, content)
const requestedFiles = [
  { fileName: 'api-user-auth-introspect.md', mimeType: 'text/markdown', sizeBytes: 2957 },
  { fileName: 'user_login_api.md', mimeType: 'text/markdown', sizeBytes: 3216 },
  { fileName: 'user_service_login_api_documentation.md', mimeType: 'text/markdown', sizeBytes: 5498 }
]
const shortenedNames = ['api-user-auth-intro...', 'user_login_api.md', 'user_service_login_…']
const token = 'files-offline-regression'

function fixture(files = requestedFiles, pageOverrides = {}, composerTag = 'div', inputAccept = '') {
  const composer = element(composerTag, composerTag === 'textarea' ? { placeholder: '发送消息' } : { contenteditable: 'true', role: 'textbox' })
  const cards = element('div')
  const add = element('button', { 'aria-label': '添加文件等内容' })
  const send = element('button', { 'aria-label': '发送' })
  const input = element('input', { type: 'file', multiple: '', accept: inputAccept })
  const root = element('form', {}, [cards, composer, add, send, input])
  const body = element('body', {}, [root])
  const listeners = new Map(), reports = []
  const document = {
    body, activeElement: composer,
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (_command, _ui, text) => { composer.replaceChildren(text); return true },
    addEventListener(type, callback) {
      listeners.set(type, [...(listeners.get(type) || []), callback])
    },
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
    getElementById: (id) => body.descendants().find((node) => node.getAttribute('id') === id) || null
  }
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) }
  new Script(interceptorSource).runInNewContext({
    window, document, location: { pathname: '/c/offline-fixture' },
    Element: ElementFixture, HTMLInputElement: ElementFixture, HTMLTextAreaElement: ElementFixture,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    MouseEvent: class { constructor(type) { this.type = type } },
    Event: class { constructor(type) { this.type = type } },
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout: () => 1, clearTimeout() {}, console: { log(line) {
      if (line.startsWith('[cmd-terminal] ')) reports.push(JSON.parse(line.slice('[cmd-terminal] '.length)))
    } }
  })
  const controller = window.__cmdTerminalInterceptor
  controller.configure({ enabled: true, page: { ...platformExports.CHATGPT_PAGE, ...pageOverrides } })
  assert.equal(controller.beginFileSend(token, files), 'ok')
  controller.fileSelectionApplied(token)
  return {
    controller, composer, cards, send, root, body, reports,
    render(names, attributes = []) {
      cards.replaceChildren(...names.map((name, index) => element('div', { 'data-fixture-card': '' }, [
        element('span', attributes[index] || {}, name)
      ])))
    },
    status: () => controller.fileSendStatus(token),
    submit: () => controller.submitFileSend(token),
    confirmOnSend({ includeCaption = true } = {}) {
      send.onClick = () => {
        const caption = composer.textContent
        composer.replaceChildren()
        const selectedCards = [...cards.childNodes]
        cards.replaceChildren()
        const sentCards = element('div', {}, selectedCards)
        const turnAttributes = pageOverrides.fileTurnPositionAttr ? { [pageOverrides.fileTurnPositionAttr]: '0' }
          : { class: 'group/user-message', 'data-chatgpt-search-unit-key': 'new-user' }
        const userTurn = element('div', turnAttributes,
          [sentCards, ...(includeCaption && caption ? [element('p', {}, caption)] : [])])
        body.replaceChildren(userTurn, root)
      }
    },
    editAttachments() {
      for (const callback of listeners.get('change') || []) callback({ target: input, isTrusted: true })
    }
  }
}

test('Markdown and its question are acknowledged only when both appear in the same user turn', () => {
  for (const includeCaption of [true, false]) {
    const app = fixture([{ fileName: 'deepseek-context.md', mimeType: 'text/markdown', sizeBytes: 100 }])
    app.render(['deepseek-context.md'])
    const caption = '请读取附件。\n我的问题：Compose 是什么？'
    assert.equal(app.controller.prepareFileSendCaption(token, caption), true)
    assert.equal(app.composer.textContent, caption)
    assert.equal(app.controller.prepareFileSendCaption(token, caption), false, 'never insert twice')
    assert.equal(app.status().status, 'ready')
    app.confirmOnSend({ includeCaption })
    assert.equal(app.submit(), true)
    assert.equal(app.status().status, includeCaption ? 'sent' : 'confirming')
    if (!includeCaption) {
      assert.equal(app.status().turnFilesSeen, true)
      assert.equal(app.status().captionSeen, false)
    }
    assert.equal(app.submit(), false)
    assert.equal(app.send.clicks, 1)
  }
})

test('a user-edited caption stops automatic submission without replacing the edit', () => {
  const app = fixture()
  app.render(requestedFiles.map(file => file.fileName))
  assert.equal(app.controller.prepareFileSendCaption(token, '原问题'), true)
  app.composer.replaceChildren('用户修改后的问题')
  assert.equal(app.status().status, 'busy')
  assert.equal(app.submit(), false)
  assert.equal(app.composer.textContent, '用户修改后的问题')
  assert.equal(app.send.clicks, 0)
})

test('DeepSeek textarea uploads Markdown before inserting its caption and acknowledges both in the new virtual row', () => {
  const app = fixture([{ fileName: 'deepseek-context.md', mimeType: 'text/markdown', sizeBytes: 100 }], {
    ...platformExports.DEEPSEEK_PAGE, sendButtonSelectors: ['button[aria-label="发送"]']
  }, 'textarea')
  app.render(['deepseek-context.md'])
  assert.equal(app.composer.value, '')
  assert.equal(app.controller.prepareFileSendCaption(token, '附件上下文\r\n问题：Compose 是什么？'), true)
  assert.equal(app.composer.value, '附件上下文\n问题：Compose 是什么？')
  assert.equal(app.status().status, 'ready')
  app.confirmOnSend()
  assert.equal(app.submit(), true)
  assert.equal(app.status().status, 'sent')
  assert.equal(app.send.clicks, 1)
})

test('DeepSeek confirms a focus upload when user and assistant messages share a virtual row', () => {
  const file = { fileName: 'screen.png', mimeType: 'image/png', sizeBytes: 40991 }
  for (const key of ['0', '-2', 'message-pair']) {
    const app = fixture([file], { ...platformExports.DEEPSEEK_PAGE, sendButtonSelectors: ['button[aria-label="发送"]'] }, 'textarea')
    // Start the actual focus path so confirmation must report the original user text and owned token.
    app.controller.releaseFileSend(token)
    app.controller.configure({ prefix: 'SYSTEM\n\n' })
    const text = '请帮我检查图片中的配置管理用途。'
    assert.equal(app.controller.beginFocusFileSend(token, [file], text, '/c/offline-fixture'), 'ok')
    app.controller.fileSelectionApplied(token)
    app.render([file.fileName])
    assert.equal(app.controller.prepareFocusFileSendCaption(token), true)
    app.send.onClick = () => {
      const caption = app.composer.value
      app.composer.replaceChildren()
      const cards = [...app.cards.childNodes]
      app.cards.replaceChildren()
      const user = element('div', { class: 'ds-message' }, [...cards, element('p', {}, caption)])
      const assistant = element('div', { class: 'ds-message' }, [element('div', { class: 'ds-think-content' }, '正在思考…')])
      app.body.replaceChildren(element('div', { 'data-virtual-list-item-key': key }, [user, assistant]), app.root)
    }
    assert.equal(app.submit(), true)
    assert.equal(app.status().status, 'sent', key)
    assert.equal(app.status().status, 'sent', 'polling the same acknowledgement is idempotent')
    assert.equal(app.send.clicks, 1)
    const confirmed = app.reports.filter(report => report.event === 'user-message')
    assert.equal(confirmed.length, 1)
    assert.equal(confirmed[0].text, text)
    assert.equal(confirmed[0].focusSendToken, token)
    assert.equal(confirmed[0].focusFiles[0].fileName, file.fileName)
  }
})

test('DeepSeek ignores old user messages and a new assistant quoting the caption and filename', () => {
  const file = { fileName: 'screen.png', mimeType: 'image/png', sizeBytes: 40991 }
  const app = fixture([file], { ...platformExports.DEEPSEEK_PAGE, sendButtonSelectors: ['button[aria-label="发送"]'] }, 'textarea')
  app.render([file.fileName])
  const caption = '请分析这张配置图片。'
  assert.equal(app.controller.prepareFileSendCaption(token, caption), true)
  const oldUser = element('div', { class: 'ds-message' }, [file.fileName, caption])
  const oldAnswer = element('div', { class: 'ds-message' }, [element('div', { class: 'ds-assistant-message-main-content' }, '之前的回复')])
  app.body.replaceChildren(element('div', { 'data-virtual-list-item-key': '4' }, [oldUser, oldAnswer]), app.root)
  app.send.onClick = () => {
    app.composer.replaceChildren(); app.cards.replaceChildren()
    const answer = element('div', { class: 'ds-message' }, [
      element('div', { class: 'ds-assistant-message-main-content' }, [file.fileName, caption])])
    app.body.replaceChildren(element('div', { 'data-virtual-list-item-key': '4' }, [oldUser, oldAnswer]),
      element('div', { 'data-virtual-list-item-key': '6' }, [answer]), app.root)
  }
  assert.equal(app.submit(), true)
  const status = app.status()
  assert.equal(status.status, 'confirming')
  assert.equal(status.userTurnCount, 1)
  assert.equal(status.newTurnSeen, false)
})

test('DeepSeek accepts and acknowledges a JSONC text alias through an extension-restricted input', () => {
  const file = { fileName: 'opencode.jsonc.txt', mimeType: 'text/plain', sizeBytes: 5020 }
  const app = fixture([file], {
    ...platformExports.DEEPSEEK_PAGE, sendButtonSelectors: ['button[aria-label="发送"]']
  }, 'textarea', '.json,.txt')
  app.render([file.fileName])
  assert.equal(app.status().status, 'ready')
  app.confirmOnSend()
  assert.equal(app.submit(), true)
  assert.equal(app.status().status, 'sent')
  assert.equal(app.send.clicks, 1)
})

test('Gemini preserves the native answer identity and confirms its document and question in the same user query', () => {
  for (const includeCaption of [true, false]) {
    const file = { fileName: 'gemini-context.md', mimeType: 'text/markdown', sizeBytes: 100 }
    const app = fixture([file], {
      ...platformExports.GEMINI_PAGE,
      // The synthetic fixture uses a form for the composer scope; native card,
      // answer, user-query and row selectors use the measured Gemini adapter.
      fileComposerRootSelector: 'form'
    })
    const answer = element('message-content', { id: 'message-content-id-r_0123456789abcdef' }, '已保存的原回答')
    app.body.replaceChildren(answer, app.root)
    assert.equal(app.controller.questionSourceMessageId(answer), 'message-content-id-r_0123456789abcdef')
    app.cards.replaceChildren(element('uploader-file-preview', {}, file.fileName))
    assert.equal(app.status().status, 'ready')
    const question = '请读取附件 gemini-context.md。\n我的问题：这段是什么意思？'
    assert.equal(app.controller.prepareFileSendCaption(token, question), true)
    app.send.onClick = () => {
      app.composer.replaceChildren()
      app.cards.replaceChildren()
      const query = element('user-query', {}, [element('user-query-file-preview', {}, file.fileName),
        ...(includeCaption ? [element('p', {}, question)] : [])])
      app.body.replaceChildren(element('div', { class: 'conversation-container', id: '0' }, [query]), app.root)
    }
    assert.equal(app.submit(), true)
    assert.equal(app.status().status, includeCaption ? 'sent' : 'confirming')
    if (!includeCaption) {
      assert.equal(app.status().turnFilesSeen, true)
      assert.equal(app.status().captionSeen, false)
    }
    assert.equal(app.submit(), false)
    assert.equal(app.send.clicks, 1)
  }
})

test('Claude identifies prose and code-only answers and confirms the file and question in the same native user row', () => {
  for (const mode of ['sent', 'missing-caption', 'split-turns']) {
    const file = { fileName: 'claude-context.md', mimeType: 'text/markdown', sizeBytes: 100 }
    const app = fixture([file], {
      ...platformExports.CLAUDE_PAGE, sendButtonSelectors: ['button[aria-label="发送"]']
    })
    const prose = element('div', { class: 'font-claude-response' }, '已保存的原回答')
    const answer = element('div', { 'data-testid': 'assistant-message' }, [
      element('span', { class: 'sr-only' }, 'Claude responded: '), prose
    ])
    const codeOnly = element('div', { 'data-testid': 'assistant-message' }, [element('pre', {}, 'console.log("hello")')])
    app.body.replaceChildren(answer, codeOnly, app.root)
    const sourceKey = app.controller.questionSourceMessageId(prose)
    assert.ok(sourceKey.startsWith('text:'), 'Claude uses the exact capture hash of its owning assistant turn')
    assert.equal(app.controller.questionSourceMessageId(answer), null, 'prose uses the narrower stored answer root')
    assert.ok(app.controller.questionSourceMessageId(codeOnly).startsWith('text:'), 'code-only capture falls back to the explicit assistant turn')
    app.cards.replaceChildren(element('div', { 'data-testid': 'file-thumbnail' }, file.fileName))
    assert.equal(app.status().status, 'ready')
    const question = '请读取附件 claude-context.md。\n我的问题：这段是什么意思？'
    assert.equal(app.controller.prepareFileSendCaption(token, question), true)
    app.send.onClick = () => {
      app.composer.replaceChildren()
      app.cards.replaceChildren()
      const row = element('div', { class: 'group/message-row ms-auto' }, [
        element('div', { 'data-testid': 'file-thumbnail' }, file.fileName),
        ...(mode === 'sent' ? [element('div', { 'data-testid': 'user-message' }, question)] : [])
      ])
      const rows = [element('div', { 'data-testid': 'transcript-row', 'data-rs-index': '0' }, [row])]
      if (mode === 'split-turns') rows.push(element('div', { 'data-testid': 'transcript-row', 'data-rs-index': '1' }, [
        element('div', { class: 'group/message-row ms-auto' }, [element('div', { 'data-testid': 'user-message' }, question)])
      ]))
      app.body.replaceChildren(...rows, app.root)
    }
    assert.equal(app.submit(), true)
    assert.equal(app.status().status, mode === 'sent' ? 'sent' : 'confirming')
    if (mode !== 'sent') {
      assert.equal(app.status().turnFilesSeen, true)
      assert.equal(app.status().captionSeen, false)
    }
    assert.equal(app.submit(), false)
    assert.equal(app.send.clicks, 1)
  }
})

test('DeepSeek hidden remote decorations do not block Markdown upload or sent confirmation', () => {
  for (const mode of ['no-layout', 'zero-area', 'aria-hidden']) {
    const files = [{ fileName: 'deepseek-context.md', mimeType: 'text/markdown', sizeBytes: 1582 }]
    const app = fixture(files, {
      ...platformExports.DEEPSEEK_PAGE, sendButtonSelectors: ['button[aria-label="发送"]']
    }, 'textarea')
    app.controller.releaseFileSend(token)
    const image = element('img', mode === 'aria-hidden' ? { 'aria-hidden': 'true' } : {})
    Object.assign(image, { src: 'https://static.deepseek.com/offline-decoration.png', naturalWidth: 132, naturalHeight: 132 })
    if (mode === 'no-layout') image.getClientRects = () => []
    image.getBoundingClientRect = () => ({ width: mode === 'aria-hidden' ? 132 : 0, height: mode === 'aria-hidden' ? 132 : 0 })
    app.root.replaceChildren(...app.root.childNodes, image)

    const nextToken = `${token}-${mode}`
    assert.equal(app.controller.beginFileSend(nextToken, files), 'ok', mode)
    app.controller.fileSelectionApplied(nextToken)
    app.render(['deepseek-context.md'])
    assert.equal(app.controller.prepareFileSendCaption(nextToken, '附件上下文\n问题：KVM 是什么？'), true)
    app.confirmOnSend()
    assert.equal(app.controller.submitFileSend(nextToken), true)
    assert.equal(app.controller.fileSendStatus(nextToken).status, 'sent', mode)
    assert.equal(app.send.clicks, 1)
  }
})

test('a collapsed sidebar without conversation links cannot supply draft images', () => {
  for (const [tag, attributes] of [['nav', {}], ['aside', {}], ['div', { role: 'navigation' }]]) {
    for (const source of ['https://example.test/avatar.png', 'blob:offline-avatar']) {
      const app = fixture()
      app.controller.releaseFileSend(token)
      const avatar = element('img')
      Object.assign(avatar, { src: source, naturalWidth: 96, naturalHeight: 96 })
      avatar.getBoundingClientRect = () => ({ width: 32, height: 32 })
      const sidebar = element(tag, attributes, [element('button', {}, [avatar])])
      const shell = element('div', {}, [sidebar, element('div', {}, [app.root])])
      app.body.replaceChildren(shell)

      const snapshot = app.controller.attachmentDiagnostics([])
      assert.equal(snapshot.rootIsForm, true)
      assert.equal(snapshot.images, 0)
      assert.equal(snapshot.inputFiles, 0)
      assert.equal(app.controller.beginFileSend(`${token}-${tag}-${source}`, requestedFiles), 'ok')
      assert.equal(app.send.clicks, 0)
      assert.equal(sidebar.contains(avatar), true, 'navigation must remain untouched')
    }
  }
})

test('the ignored model picker cannot supply draft images even inside the composer root', () => {
  const app = fixture()
  app.controller.releaseFileSend(token)
  const icon = element('img')
  Object.assign(icon, { src: 'data:image/png;base64,AA==', naturalWidth: 128, naturalHeight: 128 })
  icon.getBoundingClientRect = () => ({ width: 24, height: 24 })
  const model = element('button', { 'aria-label': '选择 ChatGPT 模型' }, [icon])
  app.root.replaceChildren(...app.root.childNodes, model)

  assert.equal(app.controller.attachmentDiagnostics([]).images, 0)
  assert.equal(app.controller.beginFileSend(`${token}-model-icon`, requestedFiles), 'ok')
  assert.equal(model.contains(icon), true)
  assert.equal(app.send.clicks, 0)
})

test('adapter assistant and fallback user wrappers bound attachment discovery before history', () => {
  for (const marker of ['assistant', 'user-fallback']) {
    const page = {
      messageSelectors: [], assistantSelectors: marker === 'assistant' ? ['[data-fixture-history]'] : [],
      assistantReplySelectors: [], fileUserTurnSelector: '',
      fileUserTurnFallbackSelector: marker === 'user-fallback' ? '[data-fixture-history]' : ''
    }
    const app = fixture(requestedFiles, page)
    app.controller.releaseFileSend(token)
    const image = element('img')
    Object.assign(image, { src: 'https://example.test/sent.png', naturalWidth: 640, naturalHeight: 480 })
    image.getBoundingClientRect = () => ({ width: 320, height: 240 })
    app.body.replaceChildren(element('div', {}, [element('div', { 'data-fixture-history': '' }, [image]), app.root]))

    assert.equal(app.controller.attachmentDiagnostics([]).images, 0)
    assert.equal(app.controller.beginFileSend(`${token}-${marker}`, requestedFiles), 'ok')
    assert.equal(app.send.clicks, 0)
  }
})

test('an actual image preview button still blocks raw result delivery without touching the draft', async () => {
  const app = fixture()
  app.controller.releaseFileSend(token)
  const image = element('img')
  Object.assign(image, { src: 'blob:offline-user-preview', naturalWidth: 0, naturalHeight: 0 })
  image.getClientRects = () => []
  app.cards.replaceChildren(element('button', {}, [image]))

  assert.equal(app.controller.attachmentDiagnostics([]).images, 1)
  assert.equal(await app.controller.sendRaw('command result'), 'busy')
  assert.equal(app.composer.textContent, '')
  assert.equal(app.cards.contains(image), true)
  assert.equal(app.send.clicks, 0)
})

test('visible remote images, hidden local previews and native draft cards still block a new file send', () => {
  for (const mode of ['visible-remote', 'hidden-blob', 'hidden-data', 'hidden-card']) {
    const app = fixture(requestedFiles, mode === 'hidden-card' ? { fileDraftCardSelector: '[data-fixture-card]' } : {})
    app.controller.releaseFileSend(token)
    const image = element('img')
    Object.assign(image, {
      src: mode === 'hidden-blob' ? 'blob:offline-preview' : mode === 'hidden-data' ? 'data:image/png;base64,AA==' : 'https://example.test/upload.png',
      naturalWidth: mode === 'hidden-blob' || mode === 'hidden-data' ? 0 : 132,
      naturalHeight: mode === 'hidden-blob' || mode === 'hidden-data' ? 0 : 132
    })
    image.getBoundingClientRect = () => ({ width: 132, height: 132 })
    if (mode !== 'visible-remote') image.getClientRects = () => []
    const draft = mode === 'hidden-card' ? element('div', { 'data-fixture-card': '' }, [image]) : image
    app.root.replaceChildren(...app.root.childNodes, draft)

    assert.equal(app.controller.beginFileSend(`${token}-${mode}`, requestedFiles), 'busy', mode)
    assert.equal(app.send.clicks, 0)
    assert.equal(app.root.contains(image), true)
  }
})

test('the three docs can transition from full upload labels to shortened labels and be sent once', () => {
  const app = fixture()
  app.render(requestedFiles.map((file) => file.fileName))
  const progress = element('div', { role: 'progressbar' })
  app.root.replaceChildren(...app.root.childNodes, progress)
  app.send.disabled = true
  assert.deepEqual(Array.from(app.status().nameEvidence, (name) => name.method), ['exact', 'exact', 'exact'])
  assert.equal(app.status().status, 'uploading')

  app.render(shortenedNames)
  progress.remove()
  app.send.disabled = false
  assert.equal(app.status().status, 'ready')
  assert.deepEqual(Array.from(app.status().nameEvidence, (name) => name.method), ['truncated', 'exact', 'truncated'])
  assert.equal(app.status().missingNameCount, 0)
  app.confirmOnSend()
  assert.equal(app.submit(), true)
  assert.equal(app.status().status, 'sent', 'sent-card confirmation must handle the same shortened names')
  assert.equal(app.submit(), false)
  assert.equal(app.send.clicks, 1)
})

test('names on adjacent nodes remain independent even when parent textContent has no separators', () => {
  const app = fixture()
  app.render(shortenedNames)
  assert.equal(app.cards.textContent, shortenedNames.join(''))
  assert.equal(app.status().status, 'ready')
})

test('full title and aria-label hints take precedence over shortened display text', () => {
  const app = fixture()
  app.render(['api…', 'user_login_api.md', 'user…'], [
    { title: requestedFiles[0].fileName }, {}, { 'aria-label': `附件 ${requestedFiles[2].fileName}` }
  ])
  assert.equal(app.status().status, 'ready')
  assert.deepEqual(Array.from(app.status().nameEvidence, (name) => name.method), ['exact', 'exact', 'exact'])
})

test('ChatGPT duplicate counters on all three docs allow submission and sent-card confirmation', () => {
  const app = fixture()
  app.render(requestedFiles.map((file) => file.fileName))
  assert.equal(app.status().status, 'ready')
  app.render([
    'api-user-auth-introspect(1).md', 'user_login_api(1).md', 'user_service_login_api_documentation(1).md'
  ])
  assert.equal(app.status().status, 'ready')
  assert.equal(app.status().missingNameCount, 0)
  assert.deepEqual(Array.from(app.status().nameEvidence, (name) => name.method), ['renamed', 'renamed', 'renamed'])
  app.confirmOnSend()
  assert.equal(app.submit(), true)
  assert.equal(app.status().status, 'sent')
  assert.equal(app.send.clicks, 1)
})

test('duplicate counters work with shortened names, suffixes, and a space before the counter', () => {
  const app = fixture()
  app.render(['api-user-auth-intro…(1).md', 'user_login_api (2).md', 'user_service_login_…documentation(3).md'])
  assert.equal(app.status().status, 'ready')
  assert.deepEqual(Array.from(app.status().nameEvidence, (name) => name.method), ['truncated', 'renamed', 'truncated'])
})

test('a duplicate alias cannot also acknowledge an explicitly requested numbered file', () => {
  const files = ['user_login_api.md', 'user_login_api(1).md']
    .map((fileName) => ({ fileName, mimeType: 'text/markdown', sizeBytes: 1 }))
  const app = fixture(files)
  app.render(['user_login_api(1).md'])
  assert.deepEqual(Array.from(app.status().nameEvidence, (name) => name.method), ['missing', 'exact'])
  assert.equal(app.submit(), false)
  app.render(['user_login_api(2).md', 'user_login_api(1)(1).md'])
  assert.equal(app.status().status, 'ready')
})

test('duplicate-name compatibility is opt-in and does not carry across page reconfiguration', () => {
  const file = requestedFiles[1]
  const disabled = fixture([file], { fileDuplicateNameSuffix: false })
  disabled.render(['user_login_api(1).md'])
  assert.equal(disabled.status().namesSeen, false)
  const app = fixture([file])
  app.render(['user_login_api(1).md'])
  assert.equal(app.status().status, 'ready')
  const { fileDuplicateNameSuffix, ...page } = platformExports.CHATGPT_PAGE
  assert.equal(fileDuplicateNameSuffix, true)
  app.controller.configure({ page })
  assert.equal(app.status().namesSeen, false)
})

test('unrelated names, invalid counters, and changed extensions are not duplicate aliases', () => {
  const file = requestedFiles[1]
  for (const name of [
    'user_login_api(0).md', 'user_login_api(01).md', 'user_login_api(copy).md',
    'user_login_api(1).txt', 'user_login_api(1).md.bak', 'other-user_login_api(1).md',
    'user_login_api…(1).txt', 'user_login_api…(copy).md'
  ]) {
    const app = fixture([file])
    app.render([name])
    assert.equal(app.status().namesSeen, false, name)
    assert.equal(app.submit(), false, name)
  }
})

test('inline fragments of a complete name still match as one name', () => {
  const app = fixture()
  app.render(requestedFiles.map((file) => [
    element('span', {}, file.fileName.slice(0, -3)), element('span', {}, '.md')
  ]))
  assert.equal(app.status().status, 'ready')
})

test('normalized Unicode names and image-alt filename hints still match', () => {
  const fileName = 'café.md'
  const normalized = fixture([{ fileName, mimeType: 'text/markdown', sizeBytes: 1 }])
  normalized.render(['cafe\u0301.md'])
  assert.equal(normalized.status().status, 'ready')
  assert.equal(normalized.status().nameEvidence[0].method, 'normalized')

  const pdf = fixture([{ fileName: 'design-document.pdf', mimeType: 'application/pdf', sizeBytes: 1 }], {
    fileDraftCardSelector: '[data-fixture-card]'
  })
  pdf.render([[element('img', { alt: 'design-document.pdf' })]])
  assert.equal(pdf.status().status, 'ready')
  assert.equal(pdf.status().nameEvidence[0].method, 'exact')
})

test('shared shortened prefixes cannot acknowledge two different files', () => {
  const files = ['user_service_login_api_documentation.md', 'user_service_login_api_reference.md']
    .map((fileName) => ({ fileName, mimeType: 'text/markdown', sizeBytes: 1 }))
  const app = fixture(files)
  app.render(['user_service_login_…', 'user_service_login_…'])
  assert.equal(app.status().namesSeen, false)
  assert.equal(app.status().missingNameCount, 2)
  assert.equal(app.status().readyBlockReason, 'attachment-names-missing')
  assert.equal(app.submit(), false)
  assert.equal(app.send.clicks, 0)
})

test('a shortened prefix and suffix can distinguish files with a shared prefix', () => {
  const files = ['user_service_login_api_documentation.md', 'user_service_login_api_reference.md']
    .map((fileName) => ({ fileName, mimeType: 'text/markdown', sizeBytes: 1 }))
  const app = fixture(files)
  app.render(['user_service_login_…documentation.md', 'user_service_login_…reference.md'])
  assert.equal(app.status().status, 'ready')
})

test('one longer filename cannot also acknowledge its shorter filename substring', () => {
  const files = ['report.md', 'annual-report.md'].map((fileName) => ({ fileName, mimeType: 'text/markdown', sizeBytes: 1 }))
  const app = fixture(files)
  app.render(['annual-report.md'])
  assert.deepEqual(Array.from(app.status().nameEvidence, (name) => name.method), ['missing', 'exact'])
  assert.equal(app.submit(), false)
})

test('too-short prefixes, missing cards and mismatched suffixes do not permit sending', () => {
  for (const names of [
    ['api…', 'user_login_api.md', 'user…'],
    shortenedNames.slice(0, 2),
    ['api-user-auth-intro…wrong.md', 'user_login_api.md', 'user_service_login_…']
  ]) {
    const app = fixture()
    app.render(names)
    assert.equal(app.status().status, 'uploading')
    assert.equal(app.status().namesSeen, false)
    assert.equal(app.submit(), false)
  }
})

test('composer text, history and the model selector cannot supply missing attachment names', () => {
  const app = fixture()
  app.render(shortenedNames.slice(1))
  const model = element('button', { 'aria-label': '选择 ChatGPT 模型', title: requestedFiles[0].fileName }, requestedFiles[0].fileName)
  app.root.replaceChildren(...app.root.childNodes, model)
  const history = element('div', { 'data-content-search-unit-key': 'old:user' }, requestedFiles[0].fileName)
  const tooltip = element('div', { role: 'tooltip' }, requestedFiles[0].fileName)
  app.body.replaceChildren(history, app.root, tooltip)
  assert.equal(app.status().namesSeen, false)
  app.composer.replaceChildren(requestedFiles[0].fileName)
  assert.equal(app.status().status, 'busy')
  assert.equal(app.submit(), false)
  assert.equal(app.send.clicks, 0)
})

test('upload progress, disabled send controls and generation still block a matched batch', () => {
  const app = fixture()
  app.render(shortenedNames)
  const progress = element('div', { role: 'progressbar' })
  app.root.replaceChildren(...app.root.childNodes, progress)
  assert.equal(app.status().readyBlockReason, 'upload-in-progress')
  assert.equal(app.submit(), false)
  progress.remove()
  app.send.disabled = true
  assert.equal(app.status().readyBlockReason, 'send-button-disabled')
  assert.equal(app.submit(), false)
  app.send.disabled = false
  const stop = element('button', { 'aria-label': '停止' })
  app.root.replaceChildren(...app.root.childNodes, stop)
  assert.equal(app.status().readyBlockReason, 'still-generating')
  assert.equal(app.submit(), false)
  stop.remove()
  assert.equal(app.status().status, 'ready')
  assert.equal(app.send.clicks, 0)
})

test('user attachment edits are preserved and block programmatic submission', () => {
  const app = fixture()
  app.render(shortenedNames)
  app.editAttachments()
  assert.equal(app.status().status, 'busy')
  assert.equal(app.submit(), false)
  assert.equal(app.cards.childNodes.length, 3)
  assert.equal(app.send.clicks, 0)
})

test('native draft-card scope and card-linked filename tooltips remain supported', () => {
  const app = fixture(requestedFiles, {
    fileDraftCardSelector: '[data-fixture-card]', fileDraftNameReferenceAttribute: 'aria-describedby'
  })
  app.render(['api…', 'user_login_api.md', 'user…'], [
    { 'aria-describedby': 'filename-0' }, {}, { 'aria-describedby': 'filename-2' }
  ])
  const tooltips = [0, 2].map((index) => element('div', { id: `filename-${index}`, role: 'tooltip' }, requestedFiles[index].fileName))
  app.body.replaceChildren(app.root, ...tooltips)
  assert.equal(app.status().status, 'ready')
  app.cards.childNodes[0].remove()
  assert.equal(app.status().namesSeen, false, 'an unreferenced tooltip must not stand in for a removed card')
})
