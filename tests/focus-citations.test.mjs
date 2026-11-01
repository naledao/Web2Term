// User-run only: node --test tests/focus-citations.test.mjs
// Actual extraction, page methods, boundary validation and native input coordinator.
// Synthetic page/input only; no Electron launch, real browser, profile or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function moduleAt(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, URL, require: name => dependencies[name] ?? {} })
  return exports
}
const shared = moduleAt('../src/shared/focus-citations.ts')
const { CHATGPT_PAGE } = moduleAt('../src/shared/platforms.ts')
const { readNativeFocusCitation } = moduleAt('../src/main/focus-citation-read.ts', { '../shared/focus-citations': shared })
const pagePath = '../src/main/injected/send-interceptor.js'
const ast = ts.createSourceFile(pagePath, readFileSync(new URL(pagePath, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
function actual(name, context, method = false, file = ast) {
  function find(node) {
    if ((method ? ts.isMethodDeclaration(node) : ts.isVariableDeclaration(node)) && node.name?.getText(file) === name) return node
    return ts.forEachChild(node, find)
  }
  const node = find(file)
  assert.ok(node, name)
  const code = method ? '({' + node.getText(file).replace(/^(?:private|public|protected)\s+/, '') + '}).' + name : '(' + node.initializer.getText(file) + ')'
  return new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context)
}
const plain = value => JSON.parse(JSON.stringify(value))

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs; this.isConnected = true; this.visible = true
    this.childNodes = children.map(child => typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child)
    for (const child of this.childNodes) child.parentElement = this
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1) }
  get textContent() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.textContent).join('') }
  get innerText() { return this.textContent }
  getAttribute(key) { return this.attrs[key] ?? null }
  hasAttribute(key) { return key in this.attrs }
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim()
      if (part === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href')
      if (part === '[data-citation-group]') return this.hasAttribute('data-citation-group')
      return part.toUpperCase() === this.tagName
    })
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 20 } }
  scrollIntoView() {}
  dispatchEvent() {}
}
const link = (url, title) => new Element('a', { href: url }, [title])
function fixture() {
  let open = false, linked = false, wrongPopup = false, now = 0
  const group = link('https://manpages.ubuntu.com/apt-get', 'command-line +2')
  const ordinary = link('https://example.com/guide', '普通链接')
  const answer = new Element('div', {}, [new Element('p', {}, ['清理工具说明。']), group, ordinary])
  const popup = new Element('div', { id: 'citation-popup', role: 'tooltip' }, [
    link('https://manpages.ubuntu.com/apt-get', 'Ubuntu Manpage: apt-get - APT package handling utility'),
    link('https://www.freedesktop.org/journalctl', 'journalctl'),
    link('https://manpages.ubuntu.com/logrotate', 'Ubuntu Manpage: logrotate - rotates, compresses, and mails system logs')
  ])
  const unrelated = new Element('div', {}, [link('https://unrelated.example/one', '另一个来源'), link('https://unrelated.example/two', '二'), link('https://unrelated.example/three', '三')])
  const listeners = new Map()
  const dismissals = []
  for (const element of [popup, unrelated]) element.dispatchEvent = event => {
    dismissals.push({ element, event })
    if (event.type === 'keydown' && event.key === 'Escape') open = false
    return true
  }
  const context = createContext({
    PAGE: { focus: { citations: CHATGPT_PAGE.focus.citations } }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL,
    location: { pathname: '/c/one', href: 'https://chatgpt.com/c/one' }, state: { taskPromptGeneration: 1, programmatic: false },
    focusCitationOperation: null, focusEditing: null, focusModeChanging: null, fileSend: null,
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(), replyRootOf: node => node,
    messageIdOf: () => 'answer-1', queryAllAssistant: () => [answer], isVisibleElement: node => node.visible && node.isConnected,
    Date: { now: () => now }, setTimeout(callback, delay) { now += delay; queueMicrotask(callback) },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
    document: {
      querySelectorAll: () => open ? [wrongPopup ? unrelated : popup] : [],
      getElementById: id => open && linked && id === 'citation-popup' ? popup : null,
      elementFromPoint: () => group,
      addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type)
    }
  })
  for (const name of ['focusCitationSourcesOf', 'focusCitationGroupsOf', 'focusCitationMarkdown']) context[name] = actual(name, context)
  const api = Object.fromEntries(['prepareFocusCitation', 'prepareFocusCitationClick', 'finishFocusCitation', 'closeFocusCitation'].map(name => [name, actual(name, context, true)]))
  const data = context.focusCitationGroupsOf(answer)[0].data
  return { context, group, ordinary, answer, popup, unrelated, listeners, dismissals, api, data, isOpen: () => open,
    open(value = true, useLinked = false) {
      open = value; linked = useLinked
      if (linked) group.attrs['aria-describedby'] = 'citation-popup'
      else delete group.attrs['aria-describedby']
    },
    wrong() { wrongPopup = true; open = true }, request: { ...data, token: 'read-token' } }
}

test('source groups become clickable markers while ordinary links stay ordinary and copy keeps the label', () => {
  const f = fixture(), extract = actual('readReplyMarkdown', f.context)
  const markdown = extract(f.answer)
  assert.match(markdown, /\[command-line \+2\]\(#web2term-citation=/)
  assert.match(markdown, /\[普通链接\]\(https:\/\/example.com\/guide\)/)
  const href = markdown.match(/\]\((#web2term-citation=[^)]*)\)/)[1]
  assert.deepEqual(plain(shared.parseFocusCitationHref(href)), plain(f.data))
  assert.doesNotMatch(shared.cleanFocusCitationCopy(markdown), /web2term-citation|signature|sourceMessageId/)
  assert.match(shared.cleanFocusCitationCopy(markdown), /command-line \+2/)
  const bracketed = f.context.focusCitationMarkdown({ ...f.data, label: '文档 [Linux] +2' })
  assert.equal(shared.cleanFocusCitationCopy(bracketed), '文档 [Linux] +2')
})

test('a source list reads all three native destinations and cleans up its navigation guard', async () => {
  const f = fixture()
  assert.equal(f.api.prepareFocusCitation(f.request, '/c/one').outcome, 'pending')
  assert.equal(f.listeners.size, 5)
  f.open(true, true)
  const result = await f.api.finishFocusCitation('read-token', 900)
  assert.equal(result.outcome, 'ok')
  assert.equal(result.sources.length, 3)
  assert.equal(result.sources[1].title, 'journalctl')
  let prevented = false
  f.listeners.get('click')({ type: 'click', target: f.group, preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'native source trigger must not navigate the conversation')
  f.api.closeFocusCitation('read-token')
  assert.equal(f.listeners.size, 0)
  assert.equal(f.context.focusCitationOperation, null)
  assert.equal(f.isOpen(), false)
  assert.equal(f.dismissals.length, 1)
})

test('an unrelated popup, a changed reply and a changed conversation cannot supply sources', async () => {
  const f = fixture()
  f.api.prepareFocusCitation(f.request, '/c/one'); f.wrong()
  assert.equal((await f.api.finishFocusCitation('read-token', 0)).outcome, 'unavailable')
  f.context.location.pathname = '/c/two'
  assert.equal((await f.api.finishFocusCitation('read-token', 0)).outcome, 'cancelled')
  f.api.closeFocusCitation('read-token')
  const g = fixture()
  g.api.prepareFocusCitation(g.request, '/c/one')
  g.group.attrs.href = 'https://different.example/source'
  assert.equal(g.api.prepareFocusCitationClick('read-token'), null)
  assert.equal((await g.api.finishFocusCitation('read-token', 0)).outcome, 'cancelled')
  g.api.closeFocusCitation('read-token')
})

test('incomplete groups, invalid targets and concurrent operations fail without clicking', async () => {
  const f = fixture()
  assert.equal(f.api.prepareFocusCitation({ ...f.request, signature: 'wrong' }, '/c/one'), null)
  f.context.focusEditing = {}
  assert.equal(f.api.prepareFocusCitation(f.request, '/c/one').outcome, 'busy')
  f.context.focusEditing = null
  f.api.prepareFocusCitation(f.request, '/c/one')
  assert.equal(f.api.prepareFocusCitation(f.request, '/c/one').outcome, 'busy')
  f.popup.childNodes = [f.popup.children[0]]; f.open()
  assert.equal((await f.api.finishFocusCitation('read-token', 0)).outcome, 'unavailable')
  assert.ok(f.api.prepareFocusCitationClick('read-token'))
  assert.equal(f.api.prepareFocusCitationClick('read-token'), null, 'at most one native click')
  f.api.closeFocusCitation('read-token')
})

test('a layout shift between measurement and native input cannot click another page control', async () => {
  const f = fixture()
  f.api.prepareFocusCitation(f.request, '/c/one')
  assert.ok(f.api.prepareFocusCitationClick('read-token'))
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    let prevented = false, stopped = false
    f.listeners.get(type)({ type, target: f.ordinary, preventDefault() { prevented = true }, stopImmediatePropagation() { stopped = true } })
    assert.equal(prevented, true)
    assert.equal(stopped, true)
  }
  f.open()
  assert.equal((await f.api.finishFocusCitation('read-token', 0)).outcome, 'unavailable')
  f.api.closeFocusCitation('read-token')
  assert.equal(f.listeners.size, 0)
})

function nativeFixture({ hover = false, linked = false, cancelAfterPrepare = false } = {}) {
  const f = fixture(), inputs = [], calls = []
  let current = true, focused = true
  const contents = {
    getURL: () => 'https://chatgpt.com/c/one', isDestroyed: () => false, getZoomFactor: () => 2,
    async executeJavaScript(code) {
      calls.push(code)
      const method = code.match(/\?\.([A-Za-z]+)\(/)[1]
      let result
      if (method === 'prepareFocusCitation') { result = f.api.prepareFocusCitation(f.request, '/c/one'); if (cancelAfterPrepare) current = false }
      else if (method === 'finishFocusCitation') {
        const args = JSON.parse('[' + code.slice(code.indexOf('(') + 1, -1) + ']')
        result = await f.api.finishFocusCitation(...args)
      }
      else if (method === 'prepareFocusCitationClick') result = f.api.prepareFocusCitationClick('read-token')
      else if (method === 'closeFocusCitation') result = f.api.closeFocusCitation('read-token')
      else assert.fail(method)
      return result
    },
    sendInputEvent(event) {
      inputs.push(event)
      if (event.type === 'mouseMove' && hover && (event.x !== 0 || event.y !== 0)) f.open(true, linked)
      if (event.type === 'mouseUp') f.open(!f.isOpen(), linked)
    }
  }
  return { f, inputs, calls, run: () => readNativeFocusCitation(contents, f.data, 'read-token', () => current, () => focused),
    unfocus() { focused = false } }
}

test('the native coordinator handles hover and click-only lists with scaled, single input and cleanup', async () => {
  for (const hover of [true, false]) {
    const f = nativeFixture({ hover }), result = await f.run()
    assert.equal(result.outcome, 'ok')
    assert.equal(result.sources.length, 3)
    assert.equal(f.inputs.filter(event => event.type === 'mouseDown').length, hover ? 0 : 1)
    assert.equal(f.inputs.filter(event => event.type === 'mouseUp').length, hover ? 0 : 1)
    assert.equal(f.inputs[0].x, 120)
    assert.equal(f.inputs[0].y, 60)
    assert.equal(f.f.listeners.size, 0)
  }
})

test('a timed-out click-only list is dismissed so a retry can read all sources', async () => {
  for (const linked of [false, true]) {
    const native = nativeFixture({ linked }), f = native.f
    const complete = f.popup.childNodes
    f.popup.childNodes = [complete[0]]
    assert.equal((await native.run()).outcome, 'unavailable')
    assert.equal(f.isOpen(), false, 'a partial native list must close on failure')
    assert.equal(f.dismissals.length, 1)
    assert.equal(f.dismissals[0].element, f.popup)
    assert.equal(f.listeners.size, 0)
    assert.equal(f.context.focusCitationOperation, null)

    f.popup.childNodes = complete
    const retry = await native.run()
    assert.equal(retry.outcome, 'ok')
    assert.equal(retry.sources.length, 3)
    assert.equal(native.inputs.filter(event => event.type === 'mouseDown').length, 2, 'one click per attempt')
    assert.equal(f.isOpen(), false)
    assert.equal(f.dismissals.length, 2)
    assert.equal(f.listeners.size, 0)
  }
})

test('an ARIA-linked loading popup is dismissed even before it exposes any links', async () => {
  const f = fixture()
  f.popup.childNodes = []
  f.api.prepareFocusCitation(f.request, '/c/one')
  f.open(true, true)
  assert.equal((await f.api.finishFocusCitation('read-token', 2200)).outcome, 'unavailable')
  f.api.closeFocusCitation('read-token')
  assert.equal(f.isOpen(), false)
  assert.equal(f.dismissals.length, 1)
  assert.equal(f.listeners.size, 0)
})

test('failed reads leave unrelated and already-open unlinked popups untouched', async () => {
  for (const preexisting of [false, true]) {
    const f = fixture()
    if (preexisting) f.open()
    f.api.prepareFocusCitation(f.request, '/c/one')
    if (!preexisting) f.wrong()
    assert.equal((await f.api.finishFocusCitation('read-token', 2200)).outcome, 'unavailable')
    f.api.closeFocusCitation('read-token')
    assert.equal(f.isOpen(), true)
    assert.equal(f.dismissals.length, 0)
    assert.equal(f.listeners.size, 0)
  }
})

test('ownership loss and an unfocused window prevent native input and remove armed listeners', async () => {
  const f = nativeFixture({ cancelAfterPrepare: true })
  assert.equal((await f.run()).outcome, 'cancelled')
  assert.equal(f.inputs.length, 0)
  assert.equal(f.f.listeners.size, 0)
  const g = nativeFixture(); g.unfocus()
  assert.equal((await g.run()).outcome, 'unavailable')
  assert.equal(g.inputs.length, 0)
})

test('citation boundaries reject dangerous destinations, malformed markers and excessive source lists', () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,secret', 'https://user:pass@example.com/', 'https://example.com/\nsecret']) {
    assert.equal(shared.parseFocusCitationSources([{ title: 'source', site: 'site', url }]), null)
  }
  assert.equal(shared.parseFocusCitationSources(Array.from({ length: 41 }, (_, index) => ({ title: 'source', site: '', url: 'https://example.com/' + index }))), null)
  for (const value of ['#web2term-citation=%ZZ', '#web2term-citation=' + encodeURIComponent('{"index":0}'), 'https://example.com/']) assert.equal(shared.parseFocusCitationHref(value), null)
  assert.equal(shared.validFocusCitationTarget({ sourceMessageId: 'reply', index: 100, signature: '12345678' }), false)
})

test('the runtime rejects other owners and drops a result if the session changes during a read', async () => {
  const file = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const context = createContext({ validFocusCitationTarget: shared.validFocusCitationTarget, randomUUID: () => 'read-token' })
  const read = actual('readFocusCitation', context, true, file)
  const target = { sessionId: 'session', platformId: 'chatgpt', conversationId: 'one', sourceMessageId: 'answer-1', index: 0, signature: '12345678' }
  let owner = true, calls = 0, release
  const runtime = { ownsFocus: () => owner, focusSending: false, focusRevision: null,
    embed: { async readFocusCitation() { calls++; return await new Promise(resolve => { release = resolve }) } } }
  owner = false
  assert.equal((await read.call(runtime, target)).outcome, 'unavailable')
  assert.equal(calls, 0)
  owner = true
  const pending = read.call(runtime, target)
  assert.equal(runtime.focusSending, true)
  assert.equal((await read.call(runtime, target)).outcome, 'busy')
  owner = false; release({ outcome: 'ok', sources: [{ title: 'source', url: 'https://example.com/', site: 'example.com' }] })
  assert.equal((await pending).outcome, 'cancelled')
  assert.equal(runtime.focusSending, false)
})
