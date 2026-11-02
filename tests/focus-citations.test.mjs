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
  }).outputText).runInNewContext({ exports, URL, setTimeout, clearTimeout, require: name => dependencies[name] ?? {} })
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
      const match = /^([a-z]+)?((?:\[[^\]]+\])*)$/i.exec(part)
      if (!match || match[1] && match[1].toUpperCase() !== this.tagName) return false
      return [...match[2].matchAll(/\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]/g)].every(([, key, operator, value]) => {
        const attr = this.getAttribute(key)
        return !operator ? attr !== null : operator === '*=' ? attr?.includes(value) :
          operator === '^=' ? attr?.startsWith(value) : operator === '$=' ? attr?.endsWith(value) : attr === value
      })
    })
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 20 } }
  scrollIntoView() {}
  dispatchEvent() {}
}
const link = (url, title) => new Element('a', { href: url }, [title])
function fixture({ native = false } = {}) {
  let open = false, linked = false, wrongPopup = false, now = 0, hitTarget = null
  const group = native ? new Element('span', { 'data-d-inline-text': '', role: 'button', tabindex: '0',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-state': 'closed' }, [
    new Element('div', { 'data-d-component': 'badge', 'data-pill': '' }, ['DeepSeek API Docs'])
  ]) : link('https://manpages.ubuntu.com/apt-get', 'command-line +2')
  if (native) group.onclick = () => {}
  const ordinary = link('https://example.com/guide', '普通链接')
  const answer = new Element('div', native ? { 'data-dil-message-id': 'answer-1' } : {}, [new Element('p', {}, ['清理工具说明。']), group, ordinary])
  const popup = new Element('div', { id: 'citation-popup', role: 'tooltip' }, [
    link('https://manpages.ubuntu.com/apt-get', 'Ubuntu Manpage: apt-get - APT package handling utility'),
    link('https://www.freedesktop.org/journalctl', 'journalctl'),
    link('https://manpages.ubuntu.com/logrotate', 'Ubuntu Manpage: logrotate - rotates, compresses, and mails system logs')
  ])
  if (native) {
    popup.attrs.role = 'dialog'
    const row = new Element('div', { 'data-d-component': 'row' }, [
      new Element('div', { 'data-d-component': 'favicon' }, [new Element('img', { src: 'https://images.example.com/favicon.png' })]),
      new Element('span', { 'data-d-component': 'text' }, ['DeepSeek API Docs'])
    ])
    const card = new Element('button', { 'data-d-component': 'pressable', 'aria-label': '打开 DeepSeek API Docs' }, [
      row, new Element('span', { 'data-d-component': 'text', 'data-d-weight': 'medium' }, ['Models & Pricing']),
      new Element('div', { 'data-d-component': 'col' }, [new Element('span', { 'data-d-component': 'text' }, ['Total lines: 98'])]),
      new Element('div', { 'data-d-component': 'image' }, [new Element('img', { src: 'https://images.example.com/thumbnail.png' })])
    ])
    card.onclick = () => assert.fail('reading a preview never clicks its source button')
    popup.childNodes = [card]; card.parentElement = popup
  }
  const unrelated = new Element('div', {}, [link('https://unrelated.example/one', '另一个来源'), link('https://unrelated.example/two', '二'), link('https://unrelated.example/three', '三')])
  const listeners = new Map()
  const dismissals = []
  for (const element of [popup, unrelated]) element.dispatchEvent = event => {
    dismissals.push({ element, event })
    if (event.type === 'keydown' && event.key === 'Escape') open = false
    return true
  }
  const context = createContext({
    PAGE: { focus: { citations: CHATGPT_PAGE.focus.citations, ...(native ? { smartUi: {
      rootSelector: '[data-dil-message-id]', sourceIdAttr: 'data-dil-message-id' } } : {}) } }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL,
    location: { pathname: '/c/one', href: 'https://chatgpt.com/c/one' }, state: { taskPromptGeneration: 1, programmatic: false },
    focusCitationOperation: null, focusEditing: null, focusModeChanging: null, fileSend: null,
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(), replyRootOf: node => node,
    messageIdOf: () => 'answer-1', queryAllAssistant: () => [answer], isVisibleElement: node => node.visible && node.isConnected,
    Date: { now: () => now }, setTimeout(callback, delay) { now += delay; queueMicrotask(callback) },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
    document: {
      querySelectorAll: () => open ? [wrongPopup ? unrelated : popup] : [],
      getElementById: id => open && linked && id === 'citation-popup' ? popup : null,
      elementFromPoint: () => hitTarget ?? group,
      addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type)
    }
  })
  for (const name of ['focusCitationSourcesOf', 'focusCitationGroupsOf', 'focusCitationHref', 'focusCitationMarkdown', 'focusCitationNativeSourcesOf']) context[name] = actual(name, context)
  context.smartUiCardsOf = () => []; context.smartUiLayoutsOf = () => []
  const api = Object.fromEntries(['prepareFocusCitation', 'prepareFocusCitationClick', 'prepareFocusCitationSourceClick',
    'finishFocusCitationSourceClick', 'finishFocusCitation', 'closeFocusCitation'].map(name => [name, actual(name, context, true)]))
  const data = context.focusCitationGroupsOf(answer)[0].data
  return { context, group, ordinary, answer, popup, unrelated, listeners, dismissals, api, data, isOpen: () => open,
    hit(element) { hitTarget = element },
    open(value = true, useLinked = false) {
      open = value; linked = useLinked
      if (linked) group.attrs[native ? 'aria-controls' : 'aria-describedby'] = 'citation-popup'
      else { delete group.attrs['aria-describedby']; delete group.attrs['aria-controls'] }
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

test('the measured href-less DIL badge and its button-only dialog retain the full source preview', async () => {
  const f = fixture({ native: true }), markdown = actual('readReplyMarkdown', f.context)(f.answer)
  assert.match(markdown, /\[DeepSeek API Docs\]\(#web2term-citation=/)
  assert.equal(f.context.focusCitationGroupsOf(f.answer)[0].native, true)
  assert.equal(f.api.prepareFocusCitation(f.request, '/c/one').outcome, 'pending')
  f.open(true, true)
  const result = await f.api.finishFocusCitation('read-token', 900)
  assert.equal(result.outcome, 'ok')
  const parsed = shared.parseFocusCitationSources(plain(result.sources))
  assert.equal(parsed[0].native.index, 0)
  assert.match(parsed[0].native.signature, /^[a-f0-9]{8}$/)
  assert.deepEqual(plain(parsed.map(({ native, ...source }) => source)), [{ kind: 'preview', title: 'Models & Pricing', site: 'DeepSeek API Docs',
    description: 'Total lines: 98', icon: 'https://images.example.com/favicon.png', image: 'https://images.example.com/thumbnail.png' }])
  assert.equal(parsed[0].url, undefined)
  f.api.closeFocusCitation('read-token')
  assert.equal(f.listeners.size, 0)
  assert.equal(f.isOpen(), false)
})

test('button previews require the owning badge and its explicit ARIA-linked dialog', async () => {
  const f = fixture({ native: true })
  f.api.prepareFocusCitation(f.request, '/c/one'); f.open(true, false)
  assert.equal((await f.api.finishFocusCitation('read-token', 0)).outcome, 'unavailable')
  f.api.closeFocusCitation('read-token')
  const g = fixture({ native: true })
  g.group.childNodes = [new Element('span', {}, ['普通对话框'])]
  assert.equal(g.context.focusCitationGroupsOf(g.answer).length, 0)
  const h = fixture({ native: true })
  h.answer.attrs['data-dil-message-id'] = 'another-message'
  assert.equal(h.context.focusCitationGroupsOf(h.answer).length, 0)
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

function nativeFixture({ hover = false, linked = false, cancelAfterPrepare = false, nativeCards = false } = {}) {
  const f = fixture({ native: nativeCards }), inputs = [], calls = [], navigationListeners = new Set()
  let current = true, focused = true, sourceControl = null, sourceClick = () => {}
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
      else if (method === 'prepareFocusCitationSourceClick') {
        const args = JSON.parse('[' + code.slice(code.indexOf('(') + 1, -1) + ']')
        f.hit(f.popup.children[args[1].index])
        result = f.api.prepareFocusCitationSourceClick(...args)
        sourceControl = result ? f.context.focusCitationOperation.sourceClick.element : null
      }
      else if (method === 'finishFocusCitationSourceClick') result = f.api.finishFocusCitationSourceClick('read-token')
      else if (method === 'closeFocusCitation') result = f.api.closeFocusCitation('read-token')
      else assert.fail(method)
      return result
    },
    sendInputEvent(event) {
      inputs.push(event)
      if (sourceControl) {
        const types = event.type === 'mouseDown' ? ['pointerdown', 'mousedown'] : event.type === 'mouseUp' ? ['pointerup', 'mouseup', 'click'] : []
        let stopped = false
        for (const type of types) f.listeners.get(type)?.({ type, isTrusted: true, target: sourceControl,
          preventDefault() {}, stopImmediatePropagation() { stopped = true } })
        if (event.type === 'mouseUp' && !stopped) sourceClick(sourceControl)
        return
      }
      if (event.type === 'mouseMove' && hover && (event.x !== 0 || event.y !== 0)) f.open(true, linked)
      if (event.type === 'mouseUp') f.open(!f.isOpen(), linked)
    },
    on(event, listener) { assert.equal(event, 'will-navigate'); navigationListeners.add(listener) },
    removeListener(event, listener) { assert.equal(event, 'will-navigate'); navigationListeners.delete(listener) }
  }
  return { f, inputs, calls, navigationListeners,
    run: action => readNativeFocusCitation(contents, f.data, 'read-token', () => current, () => focused, action),
    onSourceClick(callback) { sourceClick = callback }, cancel() { current = false },
    navigate(url) {
      let prevented = false
      for (const listener of navigationListeners) listener({ preventDefault() { prevented = true } }, url)
      return prevented
    }, unfocus() { focused = false } }
}

function nativeSourceAction(native, { destination = 'https://ai.google.dev/gemini-api/docs/pricing', sameWindow = false, cancel = false, sourceIndex = 0, emit = true } = {}) {
  const source = plain(native.f.context.focusCitationNativeSourcesOf(native.f.popup)[sourceIndex].native)
  const opened = [], diagnostics = [], clicked = []
  let receive, stopped = 0, prevented = false
  native.onSourceClick(element => {
    clicked.push(element)
    if (!emit) return
    if (sameWindow) prevented = native.navigate(destination)
    else receive(destination)
    if (cancel) native.cancel()
  })
  return { opened, diagnostics, clicked, get stopped() { return stopped }, get prevented() { return prevented },
    action: { source, timeoutMs: 50, captureUrl(callback) { receive = callback; return () => { stopped++; receive = null } },
      openExternal: async url => { opened.push(url) }, diagnose: details => diagnostics.push(details) } }
}

test('a preview card activates its own native button once and opens only the URL returned by the page', async () => {
  for (const sameWindow of [false, true]) {
    const native = nativeFixture({ hover: true, linked: true, nativeCards: true })
    const action = nativeSourceAction(native, { sameWindow })
    assert.equal((await native.run(action.action)).outcome, 'ok')
    assert.deepEqual(action.opened, ['https://ai.google.dev/gemini-api/docs/pricing'])
    assert.equal(native.inputs.filter(event => event.type === 'mouseDown').length, 1)
    assert.equal(native.inputs.filter(event => event.type === 'mouseUp').length, 1)
    assert.equal(action.prevented, sameWindow)
    assert.equal(action.stopped, 1)
    assert.equal(native.navigationListeners.size, 0)
    assert.equal(native.f.listeners.size, 0)
    assert.equal(native.f.isOpen(), false)
  }
})

test('selecting the second preview opens that source, and a missing navigation does not retry the click', async () => {
  const native = nativeFixture({ hover: true, linked: true, nativeCards: true })
  const second = new Element('button', { 'data-d-component': 'pressable', 'aria-label': '打开第二个来源' }, [
    new Element('div', { 'data-d-component': 'row' }, [new Element('span', { 'data-d-component': 'text' }, ['Google AI for Developers'])]),
    new Element('span', { 'data-d-component': 'text', 'data-d-weight': 'medium' }, ['Second source'])
  ])
  second.onclick = () => {}; second.parentElement = native.f.popup; native.f.popup.childNodes.push(second)
  const action = nativeSourceAction(native, { sourceIndex: 1, destination: 'https://docs.example.com/second' })
  assert.equal((await native.run(action.action)).outcome, 'ok')
  assert.deepEqual(action.clicked, [second])
  assert.deepEqual(action.opened, ['https://docs.example.com/second'])
  const missing = nativeFixture({ hover: true, linked: true, nativeCards: true }), absent = nativeSourceAction(missing, { emit: false })
  assert.equal((await missing.run(absent.action)).outcome, 'unavailable')
  assert.equal(missing.inputs.filter(event => event.type === 'mouseDown').length, 1)
  assert.equal(absent.opened.length, 0)
  assert.ok(absent.diagnostics.some(row => row.reason === 'source-navigation-timeout'))
  assert.equal(absent.stopped, 1)
  assert.equal(missing.navigationListeners.size, 0)
})

test('unsafe native destinations and ownership loss never reach the system browser', async () => {
  for (const destination of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,test', 'https://user:pass@example.com/']) {
    const native = nativeFixture({ hover: true, linked: true, nativeCards: true }), action = nativeSourceAction(native, { destination })
    assert.equal((await native.run(action.action)).outcome, 'unavailable')
    assert.equal(action.opened.length, 0)
    assert.ok(action.diagnostics.some(row => row.reason === 'invalid-source-url'))
    assert.equal(action.stopped, 1)
    assert.equal(native.navigationListeners.size, 0)
  }
  const native = nativeFixture({ hover: true, linked: true, nativeCards: true }), action = nativeSourceAction(native, { cancel: true })
  assert.equal((await native.run(action.action)).outcome, 'cancelled')
  assert.equal(action.opened.length, 0)
  assert.equal(action.stopped, 1)
  assert.equal(native.navigationListeners.size, 0)
})

test('stale and ambiguous preview identities cannot activate another source button', async () => {
  const f = fixture({ native: true })
  f.api.prepareFocusCitation(f.request, '/c/one'); f.open(true, true)
  const result = await f.api.finishFocusCitation('read-token', 0), source = result.sources[0].native
  const card = f.popup.children[0]
  f.hit(card)
  assert.ok(f.api.prepareFocusCitationSourceClick('read-token', source))
  assert.equal(f.api.prepareFocusCitationSourceClick('read-token', source), null)
  let stopped = false
  f.listeners.get('pointerdown')({ type: 'pointerdown', isTrusted: true, target: f.ordinary,
    preventDefault() {}, stopImmediatePropagation() { stopped = true } })
  assert.equal(stopped, true)
  assert.equal(f.api.finishFocusCitationSourceClick('read-token').outcome, 'unavailable')
  f.api.closeFocusCitation('read-token')

  const g = fixture({ native: true })
  const old = g.context.focusCitationNativeSourcesOf(g.popup)[0].native
  g.popup.children[0].attrs['aria-label'] = '另一个来源'
  g.api.prepareFocusCitation(g.request, '/c/one'); g.open(true, true)
  await g.api.finishFocusCitation('read-token', 0); g.hit(g.popup.children[0])
  assert.equal(g.api.prepareFocusCitationSourceClick('read-token', old), null)
  g.api.closeFocusCitation('read-token')
  const h = fixture({ native: true })
  const clone = node => node.nodeType === 3 ? node.nodeValue : new Element(node.tagName, { ...node.attrs }, node.childNodes.map(clone))
  const duplicate = clone(h.popup.children[0]); duplicate.onclick = () => {}; duplicate.parentElement = h.popup; h.popup.childNodes.push(duplicate)
  h.api.prepareFocusCitation(h.request, '/c/one'); h.open(true, true)
  const ambiguous = await h.api.finishFocusCitation('read-token', 0)
  h.hit(h.popup.children[0])
  assert.equal(h.api.prepareFocusCitationSourceClick('read-token', ambiguous.sources[0].native), null)
  h.api.closeFocusCitation('read-token')
})

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
  const preview = { kind: 'preview', title: 'Models & Pricing', site: 'DeepSeek API Docs', description: 'Total lines: 98' }
  assert.ok(shared.parseFocusCitationSources([preview]))
  for (const change of [{ kind: undefined }, { url: 'https://example.com/' }, { description: 'a'.repeat(2001) },
    { image: 'file:///C:/secret.png' }, { icon: 'data:image/svg+xml,<svg/>' }, { image: 'https://user:pass@example.com/a.png' },
    { native: { index: 40, signature: '1234abcd' } }, { native: { index: 0, signature: 'invalid' } }]) {
    assert.equal(shared.parseFocusCitationSources([{ ...preview, ...change }]), null)
  }
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

test('opening a native source requires the active owner, valid card identity and a free interaction lock', async () => {
  const file = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const context = createContext({ validFocusCitationTarget: shared.validFocusCitationTarget,
    validFocusCitationSourceTarget: shared.validFocusCitationSourceTarget, randomUUID: () => 'open-token', writeFocusDiagnostic() {} })
  const open = actual('openFocusCitationSource', context, true, file)
  let owner = true, calls = 0, release
  const request = { sessionId: 'session', platformId: 'chatgpt', conversationId: 'one', sourceMessageId: 'answer-1',
    index: 0, signature: '12345678', source: { index: 1, signature: '1234abcd' } }
  const runtime = { active: false, ownsFocus: () => owner, focusSending: false, focusRevision: null,
    embed: { async openFocusCitationSource() { calls++; return await new Promise(resolve => { release = resolve }) } } }
  assert.equal(await open.call(runtime, request), 'unavailable')
  runtime.active = true
  assert.equal(await open.call(runtime, { ...request, source: { ...request.source, index: 40 } }), 'unavailable')
  owner = false
  assert.equal(await open.call(runtime, request), 'unavailable')
  owner = true; runtime.focusSending = true
  assert.equal(await open.call(runtime, request), 'busy')
  assert.equal(calls, 0)
  runtime.focusSending = false
  const pending = open.call(runtime, request)
  assert.equal(runtime.focusSending, true)
  runtime.active = false; release('ok')
  assert.equal(await pending, 'cancelled')
  assert.equal(runtime.focusSending, false)
})
