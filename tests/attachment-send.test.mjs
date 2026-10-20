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
}

const element = (tag, attributes, content) => new ElementFixture(tag, attributes, content)
const requestedFiles = [
  { fileName: 'api-user-auth-introspect.md', mimeType: 'text/markdown', sizeBytes: 2957 },
  { fileName: 'user_login_api.md', mimeType: 'text/markdown', sizeBytes: 3216 },
  { fileName: 'user_service_login_api_documentation.md', mimeType: 'text/markdown', sizeBytes: 5498 }
]
const shortenedNames = ['api-user-auth-intro...', 'user_login_api.md', 'user_service_login_…']
const token = 'files-offline-regression'

function fixture(files = requestedFiles, pageOverrides = {}, composerTag = 'div') {
  const composer = element(composerTag, composerTag === 'textarea' ? { placeholder: '发送消息' } : { contenteditable: 'true', role: 'textbox' })
  const cards = element('div')
  const add = element('button', { 'aria-label': '添加文件等内容' })
  const send = element('button', { 'aria-label': '发送' })
  const input = element('input', { type: 'file', multiple: '' })
  const root = element('form', {}, [cards, composer, add, send, input])
  const body = element('body', {}, [root])
  const listeners = new Map()
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
    setTimeout: () => 1, clearTimeout() {}, console: { log() {} }
  })
  const controller = window.__cmdTerminalInterceptor
  controller.configure({ enabled: true, page: { ...platformExports.CHATGPT_PAGE, ...pageOverrides } })
  assert.equal(controller.beginFileSend(token, files), 'ok')
  controller.fileSelectionApplied(token)
  return {
    controller, composer, cards, send, root, body,
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
