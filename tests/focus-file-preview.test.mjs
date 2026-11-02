// User-run only: node --test tests/focus-file-preview.test.mjs tests/focus-file-links.test.mjs tests/focus-layout.test.mjs tests/focus-math.test.mjs
// Actual page extraction/actions, byte capture, renderer isolation and save guards. All I/O and Electron objects are synthetic.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 as path } from 'node:path'
import { EventEmitter } from 'node:events'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const compile = (source, fileName = 'module.ts') => ts.transpileModule(source, { fileName,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
function load(file, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(file, import.meta.url), 'utf8'), file)).runInNewContext({ exports, URL, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
    require(name) { if (name.endsWith('.css')) return {}; assert.ok(name in dependencies, name); return dependencies[name] } })
  return exports
}
const shared = load('../src/shared/focus-file-links.ts')
const focus = load('../src/shared/focus-chat.ts')
const native = load('../src/main/focus-file-link.ts', { '../shared/focus-file-links': shared,
  'node:crypto': { randomUUID: () => '11111111-2222-4333-8444-555555555555' } })
const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const ast = ts.createSourceFile('page.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function declaration(file, name, method = false) {
  const find = node => (method ? ts.isMethodDeclaration(node) : ts.isVariableDeclaration(node)) && node.name.getText(file) === name
    ? node : ts.forEachChild(node, find)
  const node = find(file); assert.ok(node, name)
  return method ? '({' + node.getText(file) + '}).' + name : '(' + node.initializer.getText(file) + ')'
}
const plain = value => JSON.parse(JSON.stringify(value))
class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.attrs = attrs; this.visible = true; this.disabled = false; this.isConnected = true
    this.childNodes = children.map(child => typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child)
    for (const child of this.childNodes) child.parentElement = this
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1) }
  get textContent() { return this.childNodes.map(child => child.nodeValue ?? child.textContent).join('') }
  get id() { return this.attrs.id || '' }
  getAttribute(key) { return this.attrs[key] ?? null }
  hasAttribute(key) { return key in this.attrs }
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  matches(selector) {
    return selector.split(',').some(part => {
      const match = /^([a-z]+)?((?:\[[^\]]+\])*)$/i.exec(part.trim())
      return match && (!match[1] || this.tagName.toLowerCase() === match[1]) &&
        [...match[2].matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)].every(([, key, value]) => value === undefined ? this.hasAttribute(key) : this.getAttribute(key) === value)
    })
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  getClientRects() { return [{ left: 100, top: this.attrs.role === 'link' ? 100 : 10, width: 120, height: 20 }] }
  scrollIntoView() {}
  click() { this.onclick?.({ isTrusted: false }) }
}
const fileRules = { nativeLinkSelector: 'span[data-d-component="pressable"][role="link"][tabindex="0"]',
  viewerSelector: '[role="tabpanel"][data-app-shell-tab-panel-controller]', headerSelector: '[data-testid="viewer-header"]', downloadLabel: '下载', closeLabel: '关闭' }
function page() {
  let opens = 0, downloads = 0, panels = []
  const listeners = new Map()
  const link = new Element('span', { 'data-d-component': 'pressable', role: 'link', tabindex: '0', 'aria-label': '下载 HTML 页面' },
    [new Element('span', { 'data-d-component': 'text' }, ['下载 HTML 页面'])])
  link.onclick = event => { if (event?.isTrusted) { opens++; panels = [panel] } }
  const dil = new Element('div', { 'data-dil-message-id': 'answer-1' }, [new Element('p', {}, [link])])
  const answer = new Element('article', {}, [dil])
  const download = new Element('button', { 'aria-label': '下载', 'aria-busy': 'false' })
  download.onclick = event => { if (event?.isTrusted) downloads++ }
  const close = new Element('button', { 'aria-label': '关闭文件预览' })
  close.onclick = () => { panels = [] }
  const panel = new Element('div', { role: 'tabpanel', 'data-app-shell-tab-panel-controller': 'true',
    'data-tab-id': 'native-file-1', 'aria-label': 'article_views_ii.html' }, [new Element('header', { 'data-testid': 'viewer-header' }, [download, close]), new Element('iframe')])
  const context = createContext({ PAGE: { focus: { files: fileRules, smartUi: { rootSelector: '[data-dil-message-id]', sourceIdAttr: 'data-dil-message-id' } } },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, URL, location: { pathname: '/c/one' }, state: { programmatic: false },
    focusCitationOperation: null, focusEditing: null, focusModeChanging: null, focusFileControl: null, fileSend: null,
    innerWidth: 1000, innerHeight: 800, setTimeout, clearTimeout, queueMicrotask,
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(), isVisibleElement: node => node.visible,
    messageIdOf: () => 'answer-1', queryAllAssistant: () => [answer], replyRootOf: () => answer,
    smartUiCardsOf: () => [], smartUiLayoutsOf: () => [],
    document: { querySelectorAll: () => panels, elementFromPoint: (_x, y) => y < 50 ? download : link,
      addEventListener(type, fn) { listeners.set(type, fn) }, removeEventListener(type) { listeners.delete(type) } } })
  for (const name of ['focusNativeFileLinksOf', 'focusNativeFileHref', 'focusFileLinkElement', 'focusFileViewersOf']) {
    context[name] = new Script(declaration(ast, name)).runInContext(context)
  }
  const api = Object.fromEntries(['openFocusFileLink', 'prepareFocusFileControl', 'finishFocusFileControl', 'prepareFocusFileViewer', 'readFocusFileViewer', 'downloadFocusFileViewer', 'closeFocusFileViewer']
    .map(name => [name, new Script(declaration(ast, name, true)).runInContext(context)]))
  const target = plain(context.focusNativeFileLinksOf(answer)[0].data)
  const dispatch = (type, element, trusted = true) => {
    const event = { type, target: element, isTrusted: trusted, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() { this.stopped = true } }
    listeners.get(type)?.(event)
    if (type === 'click' && !event.stopped) element.onclick?.(event)
    return event
  }
  return { context, api, target, link, dil, answer, panel, download, close, dispatch, listeners, counts: () => ({ opens, downloads }),
    markdown: new Script(declaration(ast, 'readReplyMarkdown')).runInContext(context) }
}

test('the observed href-less pressable requires an acknowledged native click to open its viewer', () => {
  const f = page(), markdown = f.markdown(f.answer)
  assert.match(markdown, /\[下载 HTML 页面\]\(#web2term-native-file=/)
  const href = markdown.match(/\]\((#[^)]*)\)/)[1]
  assert.deepEqual(plain(shared.parseFocusNativeFileHref(href)), f.target)
  assert.equal(shared.cleanFocusFileLinkCopy(markdown), '下载 HTML 页面')
  assert.equal(f.api.prepareFocusFileViewer(f.target, '/c/one'), 'ok')
  assert.equal(f.api.openFocusFileLink(f.target, '/c/one'), 'unavailable')
  f.link.click()
  assert.deepEqual(f.counts(), { opens: 0, downloads: 0 })
  const click = (kind, target, element) => {
    const point = f.api.prepareFocusFileControl({ kind, target, token }, '/c/one')
    assert.equal(point.outcome, 'ok')
    f.dispatch('click', element, false)
    assert.equal(f.api.finishFocusFileControl(token, false).outcome, 'pending')
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) f.dispatch(type, element)
    assert.equal(f.api.finishFocusFileControl(token, true).outcome, 'ok')
    assert.equal(f.listeners.size, 0)
  }
  click('source', f.target, f.link)
  const viewer = f.api.readFocusFileViewer('/c/one')
  assert.equal(viewer.fileName, 'article_views_ii.html')
  click('download', viewer, f.download)
  assert.deepEqual(f.counts(), { opens: 1, downloads: 1 })
  f.api.closeFocusFileViewer(viewer, '/c/one')
  assert.equal(f.api.readFocusFileViewer('/c/one').outcome, 'pending')
})

test('changed controls, ambiguous entries and another file tab cannot be activated by old metadata', () => {
  const f = page()
  f.link.attrs['aria-label'] = '另一个文件'
  assert.equal(f.api.openFocusFileLink(f.target, '/c/one'), 'unavailable')
  assert.equal(f.api.prepareFocusFileControl({ kind: 'source', target: f.target, token }, '/c/one').outcome, 'unavailable')
  assert.deepEqual(f.counts(), { opens: 0, downloads: 0 })
  const g = page()
  const duplicate = new Element('span', { ...g.link.attrs }, ['下载 HTML 页面']); duplicate.onclick = () => assert.fail('ambiguous action')
  duplicate.parentElement = g.dil; g.dil.childNodes.push(duplicate)
  assert.equal(g.api.openFocusFileLink(g.target, '/c/one'), 'unavailable')
  assert.equal(g.api.prepareFocusFileControl({ kind: 'source', target: g.target, token }, '/c/one').outcome, 'unavailable')
  const h = page()
  h.dispatch('click', h.link)
  const viewer = h.api.readFocusFileViewer('/c/one')
  h.panel.attrs['data-tab-id'] = 'another-file'
  assert.equal(h.api.downloadFocusFileViewer(viewer, '/c/one'), 'unavailable')
  assert.equal(h.api.downloadFocusFileViewer(viewer, '/c/other'), 'cancelled')
  assert.equal(h.counts().downloads, 0)
  assert.equal(shared.validFocusFileLinkTarget({ ...f.target, href: 'sandbox:/mnt/data/a.html' }), false)
})

test('native input blocks a shifted target and does not acknowledge a synthetic click', () => {
  const f = page()
  assert.equal(f.api.prepareFocusFileControl({ kind: 'source', target: f.target, token }, '/c/one').outcome, 'ok')
  assert.equal(f.dispatch('pointerdown', f.download).defaultPrevented, true)
  assert.equal(f.api.finishFocusFileControl(token, true).outcome, 'unavailable')
  assert.deepEqual(f.counts(), { opens: 0, downloads: 0 })
  assert.equal(f.listeners.size, 0)
  assert.equal(f.api.prepareFocusFileControl({ kind: 'source', target: f.target, token }, '/c/other').outcome, 'cancelled')
})

test('a download becoming busy after pointerdown still acknowledges its own click', () => {
  const f = page()
  f.dispatch('click', f.link)
  const viewer = f.api.readFocusFileViewer('/c/one')
  assert.equal(f.api.prepareFocusFileControl({ kind: 'download', target: viewer, token }, '/c/one').outcome, 'ok')
  f.dispatch('pointerdown', f.download)
  f.download.attrs['aria-busy'] = 'true'
  for (const type of ['pointerup', 'mouseup', 'click']) f.dispatch(type, f.download)
  assert.equal(f.api.finishFocusFileControl(token, true).outcome, 'ok')
  assert.equal(f.counts().downloads, 1)
})

test('dispatch alone cannot report success without a target acknowledgement or retry by click()', async () => {
  const events = [], diagnostics = [], calls = []
  let now = 0
  const bridge = load('../src/main/focus-file-link.ts', { '../shared/focus-file-links': shared,
    'node:crypto': { randomUUID: () => '11111111-2222-4333-8444-555555555555' } },
    { Date: { now: () => (now += 500) } })
  const contents = { isDestroyed: () => false, getURL: () => 'https://chatgpt.com/c/one', getZoomFactor: () => 1,
    sendInputEvent: event => events.push(event),
    async executeJavaScript(script) {
      calls.push(script)
      return script.includes('prepareFocusFileControl') ? { outcome: 'ok', x: 100, y: 200 } : { outcome: 'pending' }
    } }
  const target = { sourceMessageId: 'answer-1', nativeIndex: 0, signature: '12345678', label: '下载 HTML 页面' }
  const result = await bridge.openNativeFocusFileLink(contents, target, () => true,
    { focused: () => true, diagnose: details => diagnostics.push(details) })
  assert.equal(result, 'unavailable')
  assert.equal(events.filter(event => event.type === 'mouseUp').length, 1)
  assert.ok(diagnostics.some(row => row.reason === 'native-click-not-received' && row.nativeClickReceived === false))
  assert.ok(calls.at(-1).includes('finishFocusFileControl'))
  assert.doesNotMatch(calls.join('\n'), /\.click\(/)
})

const owner = { sessionId: 'session-1', platformId: 'chatgpt', conversationId: 'chat-1' }
const token = '11111111-2222-4333-8444-555555555555'
const original = Buffer.from('<!doctype html><html><body><button onclick="this.textContent=123">运行</button></body></html>')
function captureFixture({ direct = false, large = false, stalled = false, wrongName = false } = {}) {
  const files = new Map(), removed = [], calls = [], inputs = [], diagnostics = [], ses = new EventEmitter()
  let current = true, phase = 'closed', item, control = null, received = false
  const wc = { session: ses, isDestroyed: () => false, getURL: () => 'https://chatgpt.com/c/one',
    getZoomFactor: () => 1.25, isFocused: () => true,
    sendInputEvent(event) {
      inputs.push(event)
      if (event.type !== 'mouseUp') return
      received = true
      if (control.kind === 'source') { phase = 'open'; if (direct) begin() }
      else begin()
    } }
  class Item extends EventEmitter {
    getFilename() { return wrongName ? 'another.html' : 'article_views_ii.html' }
    getURL() { return 'blob:https://chatgpt.com/file-1' }
    getTotalBytes() { return large ? shared.MAX_FOCUS_FILE_PREVIEW_BYTES + 1 : original.length }
    getReceivedBytes() { return this.getTotalBytes() }
    setSavePath(file) { files.set(file, original); queueMicrotask(() => this.emit('done', {}, 'completed')) }
    cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled') }
  }
  const begin = () => { item = new Item(); ses.emit('will-download', {}, item, wc) }
  const methods = {
    prepareFocusFileViewer() { phase = 'closed'; return 'ok' },
    readFocusFileViewer() { return phase === 'open' && !stalled ? { outcome: 'ok', fileName: 'article_views_ii.html', signature: '12345678' } : { outcome: 'pending' } },
    prepareFocusFileControl(request) { control = request; received = false; return { outcome: 'ok', x: 160, y: 110 } },
    finishFocusFileControl(_token, release) { const result = { outcome: received ? 'ok' : 'pending' }; if (release) control = null; return result },
    closeFocusFileViewer() { phase = 'closed' }
  }
  wc.executeJavaScript = async (script, gesture) => { calls.push({ script, gesture }); return new Script(script).runInNewContext({ window: { __cmdTerminalInterceptor: methods } }) }
  const module = load('../src/main/focus-file-preview.ts', {
    '../shared/focus-file-links': shared, './focus-file-link': native, 'node:path': path, 'node:os': { tmpdir: () => 'C:\\temp' },
    'node:fs/promises': { mkdtemp: async prefix => prefix + 'fixture',
      stat: async file => ({ size: files.get(file).length }), readFile: async file => files.get(file),
      unlink: async file => { removed.push(file); files.delete(file) }, rmdir: async dir => { removed.push(dir) } }
  })
  const target = { sourceMessageId: 'answer-1', nativeIndex: 0, signature: '12345678', label: '下载 HTML 页面' }
  return { calls, files, removed, ses, inputs, diagnostics, get item() { return item }, cancel() { current = false },
    capture: (ms = 1000) => module.captureNativeFocusFile(wc, target, () => current, ms,
      { focused: () => true, diagnose: details => diagnostics.push(details) }) }
}

test('preview acquisition retains original bytes and cleans its temporary file and session listener', async () => {
  for (const direct of [false, true]) {
    const f = captureFixture({ direct }), result = await f.capture()
    assert.equal(result.outcome, 'ok')
    assert.deepEqual(result.file.bytes, original)
    assert.equal(result.file.fileName, 'article_views_ii.html')
    assert.equal(f.ses.listenerCount('will-download'), 0)
    assert.equal(f.files.size, 0)
    assert.equal(f.removed.length, 2)
    assert.equal(f.calls.filter(call => call.script.includes('prepareFocusFileControl') && call.script.includes('"kind":"download"')).length, direct ? 0 : 1)
    assert.equal(f.inputs.filter(event => event.type === 'mouseUp').length, direct ? 1 : 2)
    assert.ok(f.inputs.every(event => event.x === 200 && event.y === 138))
    assert.ok(f.diagnostics.some(row => row.nativeClickReceived === true && row.clickTrusted === true))
  }
})

test('oversized files and timeouts clean up without returning another file or retaining listeners', async () => {
  const large = captureFixture({ large: true })
  const result = await large.capture()
  assert.equal(result.outcome, 'unavailable'); assert.equal(result.reason, 'too-large')
  assert.equal(large.item.cancelled, true); assert.equal(large.ses.listenerCount('will-download'), 0)
  const stalled = captureFixture({ stalled: true })
  const timed = await stalled.capture(30)
  assert.equal(timed.outcome, 'unavailable'); assert.equal(timed.reason, 'timeout')
  assert.equal(timed.fileStage, 'viewer')
  assert.equal(stalled.ses.listenerCount('will-download'), 0)
  const cancelled = captureFixture(); cancelled.cancel()
  assert.equal((await cancelled.capture()).outcome, 'cancelled')
  assert.equal(cancelled.calls.length, 0)
  const wrong = captureFixture({ wrongName: true })
  assert.equal((await wrong.capture()).outcome, 'unavailable')
  assert.equal(wrong.item.cancelled, true)
  assert.equal(wrong.ses.listenerCount('will-download'), 0)
})

test('the focus pane renders isolated HTML with a download control in its own header', () => {
  let stateIndex = 0
  const file = { token, fileName: 'article_views_ii.html', sizeBytes: original.length, kind: 'html', text: original.toString() }
  const hooks = { ...React, useRef: value => ({ current: value }), useCallback: fn => fn, useEffect() {}, useMemo: fn => fn(),
    useState() { const states = [{ token, file, error: '' }, false, '']; return [states[stateIndex++], () => {}] } }
  const module = load('../src/renderer/src/components/FocusFilePreview.tsx', { react: hooks, 'react/jsx-runtime': jsxRuntime, '@shared/focus-chat': focus })
  const tree = module.default({ owner, visible: true, children: React.createElement('p', null, '专注会话') })
  const html = renderToStaticMarkup(tree)
  assert.match(html, /focus-file-preview__header[\s\S]*focus-file-preview__download[\s\S]*>下载<\/button>/)
  assert.match(html, /<iframe[^>]+sandbox="allow-scripts"/)
  assert.doesNotMatch(html, /allow-same-origin|<script>/)
  assert.ok(module.focusFilePreviewDocument('<script>test()</script>').indexOf('Content-Security-Policy') < module.focusFilePreviewDocument('<script>test()</script>').indexOf('<script>'))
})

test('saving uses the owned cached bytes and revokes a dialog result after a conversation change', async () => {
  const file = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const writes = []
  let conversation = owner.conversationId, changeInDialog = false, deactivateInDialog = false
  const save = new Script(compile(declaration(file, 'saveFocusFilePreview', true))).runInNewContext({
    validFocusFilePreviewToken: shared.validFocusFilePreviewToken, focusOwnerKey: focus.focusOwnerKey,
    writeFocusDiagnostic() {}, writeFile: async (...args) => writes.push(args),
    dialog: { async showSaveDialog() {
      if (changeInDialog) conversation = 'other'
      if (deactivateInDialog) runtime.active = false
      return { canceled: false, filePath: 'C:\\chosen\\page.html' }
    } }
  })
  const runtime = { active: true, window: null, focusFileCache: { token, ownerKey: focus.focusOwnerKey(owner), file: { fileName: 'article_views_ii.html', bytes: original } },
    ownsFocus: request => request.conversationId === conversation }
  assert.equal(await save.call(runtime, { ...owner, token }), 'ok')
  assert.equal(writes.length, 1); assert.deepEqual(writes[0][1], original)
  changeInDialog = true
  assert.equal(await save.call(runtime, { ...owner, token }), 'cancelled')
  assert.equal(writes.length, 1)
  changeInDialog = false; conversation = owner.conversationId; deactivateInDialog = true
  assert.equal(await save.call(runtime, { ...owner, token }), 'cancelled')
  assert.equal(writes.length, 1)
  assert.equal(await save.call(runtime, { ...owner, token }), 'unavailable')
  assert.equal(writes.length, 1)
})
