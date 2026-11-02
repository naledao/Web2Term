// User-run only: node --test tests/focus-html-preview.test.mjs tests/focus-code.test.mjs
// Real document generation and window lifecycle with synthetic Electron/DOM; no app or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Script } from 'node:vm'
import { test } from 'node:test'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import ts from 'typescript'

function load(file, dependencies = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(code).runInNewContext({ exports, URL, Buffer, console, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/focus-html-preview.ts')
const shell = readFileSync(new URL('../src/main/focus-html-preview.html', import.meta.url), 'utf8')
const parse = html => fromHtmlIsomorphic(html)
const find = (tree, tag) => [
  ...(tree.type === 'element' && tree.tagName === tag ? [tree] : []),
  ...(tree.children ?? []).flatMap(child => find(child, tag))
]
const textOf = tree => tree.type === 'text' ? tree.value : (tree.children ?? []).map(textOf).join('')

function fixture({ failLoad = false, failProxy = false, slowFrame = false } = {}) {
  const previews = [], partitions = [], cleanups = []
  let resourceHandler, permissionRequest, permissionCheck, proxy, sequence = 0
  const ses = new EventEmitter()
  Object.assign(ses, {
    webRequest: { onBeforeRequest(handler) { resourceHandler = handler } },
    async setProxy(value) { proxy = value; if (failProxy) throw new Error('proxy error') },
    setPermissionRequestHandler(handler) { permissionRequest = handler },
    setPermissionCheckHandler(handler) { permissionCheck = handler },
    async closeAllConnections() { cleanups.push('connections') },
    async clearStorageData() { cleanups.push('storage') }
  })
  class Preview extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = handler => { this.openWindow = handler }
      previews.push(this)
    }
    isDestroyed() { return this.destroyed }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
    setMenu(menu) { this.menu = menu }
    async loadURL(url) {
      this.url = url
      if (failLoad) throw new Error('load error')
      if (slowFrame) { this.webContents.emit('dom-ready'); return new Promise(() => {}) }
    }
    show() { this.shown = true }
  }
  const parent = new EventEmitter()
  parent.isDestroyed = () => parent.destroyed === true
  const api = load('../src/main/focus-html-preview.ts', {
    'node:crypto': { randomUUID: () => 'snapshot-' + ++sequence },
    electron: { BrowserWindow: Preview, session: { fromPartition(partition, options) { partitions.push({ partition, options }); return ses } } },
    '../shared/focus-html-preview': shared,
    './focus-html-preview.html?raw': { default: shell }
  })
  return { api, parent, previews, partitions, ses, cleanups, proxy: () => proxy,
    resource: () => resourceHandler, permissionRequest: () => permissionRequest, permissionCheck: () => permissionCheck,
    open: request => api.openFocusHtmlPreview(parent, request, 'http://127.0.0.1:7897') }
}
const request = { html: '<!DOCTYPE html><html><body><button onclick="this.textContent=123">运行</button></body></html>', theme: 'light' }

test('HTML aliases and unlabelled documents work without treating other languages as HTML', () => {
  for (const language of ['html', 'HTML', 'htm', 'xhtml', '', 'text', 'plaintext', 'xml', 'markup']) {
    assert.equal(shared.isFocusHtmlCode(language, request.html), true, language)
  }
  assert.equal(shared.isFocusHtmlCode('', '<!--说明-->\n<section>片段</section>'), true)
  for (const [language, text] of [['html', ' \n'], ['javascript', request.html], ['jsx', '<div>组件</div>'],
    ['xml', '<config><path>value</path></config>'], ['', '<svg></svg>'], ['markup', '<svg></svg>'],
    ['', 'const value = "<html></html>"'], ['', '这里有 <div>示例</div>']]) {
    assert.equal(shared.isFocusHtmlCode(language, text), false, language + ': ' + text)
  }
})

test('invalid and oversized IPC requests create no session or window', async () => {
  const f = fixture()
  for (const value of [null, '', {}, { html: 123, theme: 'light' }, { html: ' ', theme: 'light' }, { ...request, theme: 'custom' }]) {
    assert.equal(await f.open(value), 'invalid')
  }
  assert.equal(await f.open({ ...request, html: 'a'.repeat(shared.FOCUS_HTML_PREVIEW_MAX_CHARS + 1) }), 'too-large')
  assert.equal(shared.validateFocusHtmlPreview({ ...request, html: 'a'.repeat(shared.FOCUS_HTML_PREVIEW_MAX_CHARS) }), 'ok')
  assert.equal(f.partitions.length, 0); assert.equal(f.previews.length, 0)
})

test('hostile HTML cannot escape the frame or source text into the preview toolbar', () => {
  const f = fixture()
  const html = '</pre><script>globalThis.escaped = true</script><iframe src="file:///C:/private"></iframe>' +
    '<img src=x onerror="attack()">&quot; {{theme}} {{document}} {{source}} $& 中文'
  const output = f.api.focusHtmlPreviewDocument({ html, theme: 'dark' })
  const tree = parse(output)
  assert.equal(find(tree, 'script').length, 1, 'Only the trusted shell script is in the outer document')
  assert.equal(find(tree, 'img').length, 0)
  const [frame] = find(tree, 'iframe')
  assert.equal(find(tree, 'iframe').length, 1)
  assert.equal(frame.properties.sandbox.join(' '), 'allow-scripts')
  assert.equal(frame.properties.referrerPolicy, 'no-referrer')
  assert.equal(textOf(find(tree, 'pre')[0]), html)
  assert.equal(find(tree, 'html')[0].properties.dataTheme, 'dark')
  const document = frame.properties.srcDoc
  assert.ok(document.endsWith(html))
  const policyIndex = document.indexOf('Content-Security-Policy')
  assert.ok(policyIndex > 0 && policyIndex < document.indexOf('<script>'))
  assert.match(document, /script-src 'unsafe-inline' https:/)
  assert.match(document, /frame-src 'none'/)
  assert.match(document, /base-uri 'none'; form-action 'none'/)
  assert.doesNotMatch(output, /allow-same-origin|preload=|window\.api/)
})

test('opening creates a sandboxed snapshot with a unique memory session and no preload', async () => {
  const f = fixture()
  assert.equal(await f.open(request), 'ok')
  const [preview] = f.previews
  const preferences = preview.options.webPreferences
  assert.equal(preferences.session, f.ses)
  assert.equal(preferences.preload, undefined)
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(preferences[key], true)
  for (const key of ['nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'webviewTag', 'allowRunningInsecureContent']) {
    assert.equal(preferences[key], false)
  }
  assert.ok(f.partitions[0].partition.startsWith('focus-html-preview-'))
  assert.ok(!f.partitions[0].partition.startsWith('persist:'))
  assert.equal(f.partitions[0].options.cache, false)
  assert.equal(f.proxy().proxyRules, 'http://127.0.0.1:7897')
  assert.equal(preview.shown, true)
  const html = Buffer.from(preview.url.split(',')[1], 'base64').toString('utf8')
  assert.equal(textOf(find(parse(html), 'pre')[0]), request.html)
  assert.equal(preview.openWindow({ url: 'https://example.com/' }).action, 'deny')
  assert.equal(f.permissionCheck()(), false)
  let granted
  f.permissionRequest()(null, 'media', value => { granted = value })
  assert.equal(granted, false)
  await f.open({ ...request, html: '<h1>第二段代码</h1>' })
  assert.notEqual(f.partitions[0].partition, f.partitions[1].partition)
})

test('navigation, local protocols, permissions and downloads stay inside the preview boundary', async () => {
  const f = fixture()
  await f.open(request)
  const [preview] = f.previews
  function event(name, values = {}) {
    let prevented = false
    preview.webContents.emit(name, { ...values, preventDefault() { prevented = true } })
    return prevented
  }
  assert.equal(event('will-navigate', { url: 'https://example.com/' }), true)
  assert.equal(event('will-frame-navigate', { url: 'about:srcdoc', isMainFrame: false }), false)
  assert.equal(event('will-frame-navigate', { url: 'https://example.com/', isMainFrame: false }), true)
  assert.equal(event('will-frame-navigate', { url: 'about:srcdoc', isMainFrame: true }), true)
  assert.equal(event('will-attach-webview'), true)
  let cancelled = false
  f.ses.emit('will-download', { preventDefault() { cancelled = true } })
  assert.equal(cancelled, true)
  for (const [url, allowed] of [['https://cdn.example.com/app.js', true], ['data:image/png;base64,AAA', true],
    ['blob:null/1234', true], ['http://example.com/app.js', false], ['file:///C:/private.txt', false],
    ['pdf-asset:private', false], ['javascript:attack()', false], ['not a url', false]]) {
    let result
    f.resource()({ url }, value => { result = value })
    assert.equal(result.cancel, !allowed, url)
  }
  assert.equal(f.parent.listenerCount('closed'), 1)
  f.parent.destroyed = true; f.parent.emit('closed')
  assert.equal(preview.isDestroyed(), true)
  assert.equal(f.parent.listenerCount('closed'), 0)
  assert.equal(f.ses.listenerCount('will-download'), 0)
  assert.equal(f.resource(), null)
  assert.deepEqual(f.cleanups, ['connections', 'storage'])
})

test('a slow resource in the frame does not prevent showing the preview shell', async () => {
  const f = fixture({ slowFrame: true })
  assert.equal(await f.open(request), 'ok')
  assert.equal(f.previews[0].shown, true)
  f.previews[0].destroy()
  assert.deepEqual(f.cleanups, ['connections', 'storage'])
})

test('load/proxy failures, destroyed parents and Escape clean up without leaving hidden windows', async () => {
  const failed = fixture({ failLoad: true })
  assert.equal(await failed.open(request), 'unavailable')
  assert.equal(failed.previews[0].isDestroyed(), true)
  assert.equal(failed.parent.listenerCount('closed'), 0)
  assert.deepEqual(failed.cleanups, ['connections', 'storage'])
  const proxy = fixture({ failProxy: true })
  assert.equal(await proxy.open(request), 'unavailable')
  assert.equal(proxy.previews.length, 0)
  assert.deepEqual(proxy.cleanups, ['connections', 'storage'])
  const gone = fixture(); gone.parent.destroyed = true
  assert.equal(await gone.open(request), 'unavailable')
  assert.equal(gone.partitions.length, 0)
  const escape = fixture(); await escape.open(request)
  let prevented = false
  escape.previews[0].webContents.emit('before-input-event', { preventDefault() { prevented = true } }, { key: 'Escape', type: 'keyDown' })
  assert.equal(prevented, true); assert.equal(escape.previews[0].isDestroyed(), true)
})

test('preview controls preserve the snapshot, switch viewport and ignore messages from other windows', () => {
  const f = fixture()
  const tree = parse(f.api.focusHtmlPreviewDocument(request))
  const elements = new Map()
  for (const tag of ['iframe', 'pre', 'button', 'span']) for (const node of find(tree, tag)) {
    const attrs = { ...node.properties }, listeners = new Map()
    if (!attrs.id) continue
    elements.set(attrs.id, { hidden: attrs.hidden ?? false, textContent: textOf(node), contentWindow: {},
      getAttribute(name) { return name === 'srcdoc' ? attrs.srcDoc : attrs[name] },
      setAttribute(name, value) { attrs[name] = value }, addEventListener(name, listener) { listeners.set(name, listener) },
      click() { listeners.get('click')() }, attrs })
  }
  const body = { dataset: {} }, events = new Map()
  let closed = false
  new Script(textOf(find(tree, 'script')[0])).runInNewContext({
    document: { body, getElementById: id => elements.get(id) }, window: { close() { closed = true } },
    addEventListener(name, callback) { events.set(name, callback) }
  })
  elements.get('mobile').click()
  assert.equal(body.dataset.viewport, 'mobile')
  assert.equal(elements.get('mobile').attrs['aria-pressed'], 'true')
  elements.get('source-toggle').click()
  assert.equal(elements.get('preview').hidden, true)
  assert.equal(elements.get('source').hidden, false)
  const snapshot = elements.get('preview').getAttribute('srcdoc')
  elements.get('rerun').click()
  assert.equal(elements.get('preview').srcdoc, snapshot)
  assert.equal(elements.get('preview').hidden, false)
  events.get('message')({ source: {}, data: { type: 'focus-html-preview-error', message: 'spoofed' } })
  assert.equal(elements.get('error').textContent, '')
  events.get('message')({ source: elements.get('preview').contentWindow,
    data: { type: 'focus-html-preview-error', message: '<script>text only</script>' } })
  assert.equal(elements.get('error').textContent, '<script>text only</script>')
  elements.get('close').click(); assert.equal(closed, true)
})
