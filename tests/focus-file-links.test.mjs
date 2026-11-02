// User-run only: node --test tests/focus-file-links.test.mjs tests/focus-layout.test.mjs tests/focus-math.test.mjs
// Real Markdown plugin, link component, page action and main-process guards with synthetic state.
// No Electron launch, real page, user profile, UI input or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const previewRequire = createRequire(require.resolve('@uiw/react-markdown-preview'))
const { default: ReactMarkdown } = await import(previewRequire.resolve('react-markdown'))
const compile = (source, fileName = 'module.ts') => ts.transpileModule(source, {
  fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'), path)).runInNewContext({ exports, URL, ...globals,
    require(name) { if (name.endsWith('.css')) return {}; assert.ok(name in dependencies, name); return dependencies[name] } })
  return exports
}
const shared = load('../src/shared/focus-file-links.ts')
const native = load('../src/main/focus-file-link.ts', { '../shared/focus-file-links': shared })
const owner = { sessionId: 'session-1', platformId: 'chatgpt', conversationId: 'chat-1' }
const href = 'sandbox:/mnt/data/article-views-ii-replica.html'
const marker = '#web2term-file=' + encodeURIComponent(href)
const target = { sourceMessageId: 'answer-1', href, label: '下载完整 HTML 页面' }
const CitationContext = React.createContext(null)
const citation = { FocusCitationContext: CitationContext,
  default: props => React.createElement('a', { href: props.href, title: props.title }, props.children) }
const dependencies = { react: React, 'react/jsx-runtime': jsxRuntime, '@shared/focus-file-links': shared, './FocusCitationLink': citation }
const messageLinks = load('../src/renderer/src/components/FocusMessageLink.tsx', dependencies)
const context = { owner, ownerKey: 'session-1:chatgpt:chat-1', visible: true, onOriginal() {} }
const render = markdown => renderToStaticMarkup(React.createElement(CitationContext.Provider, { value: context },
  React.createElement(ReactMarkdown, { skipHtml: true, rehypePlugins: [shared.rehypeFocusFileLinks], components: { a: messageLinks.default } }, markdown)))

test('download, preview and reference-style sandbox links become file controls while ordinary links remain links', () => {
  const html = render(`[下载完整 HTML 页面](${href})\n\n[查看页面预览][file]\n\n[file]: ${href}\n\n[说明](https://example.com/guide)`)
  assert.equal((html.match(/class="focus-file-link__trigger"/g) ?? []).length, 2)
  assert.match(html, /<button[^>]+title="sandbox:\/mnt\/data\/article-views-ii-replica.html"/)
  assert.match(html, /<a href="https:\/\/example.com\/guide">说明<\/a>/)
  assert.doesNotMatch(html, /<a[^>]+href="sandbox:/)
  assert.equal(shared.parseFocusFileHref(marker), href)
})

test('file adaptation preserves URL filtering, code literals and the image URL boundary', () => {
  const html = render('`[代码](sandbox:/mnt/data/a.html)`\n\n[脚本](javascript:alert%281%29)\n\n[本机](file:///C:/secret)\n\n![图片](sandbox:/mnt/data/a.png)')
  assert.doesNotMatch(html, /focus-file-link__trigger|href="(?:javascript:|file:)|src="sandbox:/)
  assert.match(html, /<code>\[代码\]\(sandbox:/)
  for (const value of ['file:///C:/secret', 'javascript:alert(1)', 'https://example.com/', 'sandbox://other/file',
    'sandbox:relative', 'sandbox:/mnt/data/a\n.html', 'sandbox:/' + 'a'.repeat(4096)]) {
    assert.equal(shared.normalizeFocusFileHref(value), null, value)
    assert.equal(shared.parseFocusFileHref('#web2term-file=' + encodeURIComponent(value)), null)
  }
  assert.equal(shared.parseFocusFileHref('#web2term-file=%zz'), null)
  assert.ok(shared.validFocusFileLinkTarget(target))
  for (const change of [{ sourceMessageId: '' }, { sourceMessageId: '../other' }, { href: 'file:///C:/secret' }, { label: '' }, { label: '  下载  ' }]) {
    assert.equal(shared.validFocusFileLinkTarget({ ...target, ...change }), false)
  }
})

function method(path, name) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const find = node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name ? node : ts.forEachChild(node, find)
  const found = find(ast)
  assert.ok(found, name)
  return compile('({' + found.getText(ast) + '}).' + name)
}
const pageAction = method('../src/main/injected/send-interceptor.js', 'openFocusFileLink')
function page() {
  const clicks = [], navigation = [], listeners = new Map()
  const link = (label, url = href) => ({ textContent: label, visible: true, code: false, disabled: false,
    getAttribute(key) { return key === 'href' ? url : key === 'aria-disabled' && this.disabled ? 'true' : null },
    closest() { return this.code ? {} : null }, contains: () => false,
    click() {
      clicks.push(label)
      let prevented = false
      listeners.get('click')?.({ target: this, preventDefault() { prevented = true } })
      navigation.push({ label, prevented })
    } })
  const links = [link(target.label), link('查看页面预览')]
  const root = { matches: () => false, querySelectorAll: () => links }
  const nodes = [{ id: 'answer-1', visible: true, root }]
  const sandbox = createContext({ PAGE: { focus: {} }, URL, location: { pathname: '/c/one' },
    focusCitationOperation: null, focusEditing: null, focusModeChanging: null, state: { programmatic: false }, fileSend: null,
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(), queryAllAssistant: () => nodes,
    messageIdOf: node => node.id, isVisibleElement: node => node.visible, replyRootOf: node => node.root,
    document: { addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: type => listeners.delete(type) } })
  const open = new Script(pageAction).runInContext(sandbox)
  sandbox.window = { __cmdTerminalInterceptor: { openFocusFileLink: open } }
  return { sandbox, nodes, links, clicks, navigation, listeners, link, open: (request = target, path = '/c/one') => open(request, path) }
}

test('the original reply disambiguates download and preview links that share the same file path', () => {
  const f = page()
  assert.equal(f.open(), 'ok')
  assert.deepEqual(f.clicks, [target.label])
  assert.equal(f.open({ ...target, label: '查看页面预览' }), 'ok')
  assert.deepEqual(f.clicks, [target.label, '查看页面预览'])
  assert.ok(f.navigation.every(event => event.prevented), 'raw sandbox paths never fall through to OS navigation')
  assert.equal(f.listeners.size, 0, 'the navigation guard is scoped to one click')
  const unicode = page(), raw = 'sandbox:/mnt/data/中文 页面.html'
  unicode.links.splice(0, 2, unicode.link(target.label, raw))
  assert.equal(unicode.open({ ...target, href: new URL(raw).href }), 'ok')
})

test('stale, changed, ambiguous, hidden, disabled and code links never dispatch a file action', () => {
  for (const change of [
    f => { f.sandbox.location.pathname = '/c/two' },
    f => { f.nodes[0].id = 'different-answer' },
    f => { f.nodes.push({ ...f.nodes[0] }) },
    f => { f.links[0].textContent = '已更改的链接' },
    f => { f.links[0] = f.link(target.label, 'sandbox:/mnt/data/another.html') },
    f => { f.links.push(f.link(target.label)) },
    f => { f.links[0].visible = false },
    f => { f.links[0].disabled = true },
    f => { f.links[0].code = true }
  ]) {
    const f = page(); change(f)
    assert.notEqual(f.open(), 'ok')
    assert.deepEqual(f.clicks, [])
  }
  const f = page()
  f.sandbox.state.programmatic = true
  assert.equal(f.open(), 'busy')
  assert.deepEqual(f.clicks, [])
  assert.equal(f.open({ ...target, href: 'javascript:alert(1)' }), 'invalid')
})

test('the main-process bridge uses the existing page with a user gesture and revokes stale owners', async () => {
  const f = page(), calls = []
  let current = true
  const contents = { isDestroyed: () => false, getURL: () => 'https://chatgpt.com/c/one',
    async executeJavaScript(script, gesture) { calls.push({ script, gesture }); return new Script(script).runInContext(f.sandbox) } }
  assert.equal(await native.openNativeFocusFileLink(contents, target, () => current), 'ok')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].gesture, true)
  assert.deepEqual(f.clicks, [target.label])
  current = false
  assert.equal(await native.openNativeFocusFileLink(contents, target, () => current), 'cancelled')
  assert.equal(calls.length, 1)
  assert.equal(await native.openNativeFocusFileLink(contents, { ...target, href: 'file:///C:/secret' }, () => true), 'invalid')
  contents.executeJavaScript = async () => { current = false; return 'ok' }
  current = true
  assert.equal(await native.openNativeFocusFileLink(contents, target, () => current), 'cancelled')
})

test('the runtime blocks cross-conversation, malformed and concurrent requests and releases its lock after failure', async () => {
  const runtimeOpen = new Script(method('../src/main/session-runtime.ts', 'openFocusFileLink')).runInNewContext({
    validFocusFileLinkTarget: shared.validFocusFileLinkTarget })
  let calls = 0
  const runtime = { focusSending: false, focusRevision: null,
    ownsFocus: request => request.sessionId === owner.sessionId && request.conversationId === owner.conversationId,
    embed: { async openFocusFileLink() { calls++; throw new Error('page unavailable') } } }
  const request = { ...owner, ...target }
  assert.equal(await runtimeOpen.call(runtime, { ...request, conversationId: 'other' }), 'unavailable')
  assert.equal(await runtimeOpen.call(runtime, { ...request, href: 'https://example.com/' }), 'invalid')
  runtime.focusSending = true
  assert.equal(await runtimeOpen.call(runtime, request), 'busy')
  assert.equal(calls, 0)
  runtime.focusSending = false
  await assert.rejects(runtimeOpen.call(runtime, request), /page unavailable/)
  assert.equal(runtime.focusSending, false)
})

function fileControl(label = target.label) {
  let cursor = 0, pendingEffects = []
  const slots = [], requests = [], responses = [], exports = {}
  const ctx = { ...context, onOriginal() { ctx.originals++ }, originals: 0 }
  const hooks = { useContext: () => ctx,
    useRef(initial) { return (slots[cursor++] ??= { current: initial }) },
    useState(initial) { const at = cursor++; slots[at] ??= { value: initial }; return [slots[at].value, value => { slots[at].value = value }] },
    useEffect(callback, deps) {
      const at = cursor++, before = slots[at]
      if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) {
        pendingEffects.push(() => { before?.cleanup?.(); slots[at] = { deps, cleanup: callback() } })
      }
    } }
  const source = readFileSync(new URL('../src/renderer/src/components/FocusMessageLink.tsx', import.meta.url), 'utf8')
  new Script(compile(source + '\nexport { FileLink };', 'FocusMessageLink.tsx')).runInNewContext({ exports,
    window: { api: { openFocusFileLink(request) { requests.push(request); return new Promise(resolve => responses.push(resolve)) } } },
    require(name) { return name === 'react' ? hooks : name.endsWith('.css') ? {} : dependencies[name] } })
  let tree
  const render = () => { cursor = 0; pendingEffects = []; tree = exports.FileLink({ href, children: label }); pendingEffects.forEach(run => run()); return tree }
  const elements = node => !React.isValidElement(node) ? [] : [node, ...React.Children.toArray(node.props.children).flatMap(elements)]
  const trigger = () => elements(tree).find(node => node.props.className === 'focus-file-link__trigger')
  const click = () => trigger().props.onClick({ currentTarget: { textContent: label,
    closest: () => ({ getAttribute: () => target.sourceMessageId }) } })
  render()
  return { ctx, requests, responses, render, trigger, click, elements: () => elements(tree) }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('the file control dispatches its answer and owner once, and exposes the original-view fallback on failure', async () => {
  const f = fileControl()
  f.click(); f.click(); f.render()
  assert.equal(f.requests.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0])), { ...owner, ...target })
  assert.equal(f.trigger().props.disabled, true)
  f.responses[0]('unavailable'); await flush(); f.render()
  assert.ok(f.elements().some(node => node.props.role === 'alert'))
  const fallback = f.elements().find(node => node.type === 'button' && node.props.children === '查看原始链接')
  assert.ok(fallback); fallback.props.onClick()
  assert.equal(f.ctx.originals, 1)
  assert.equal(f.trigger().props.disabled, false)
})

test('hiding the view discards a late file-action result', async () => {
  const f = fileControl()
  f.click()
  f.ctx.visible = false; f.render()
  f.responses[0]('unavailable'); await flush(); f.render()
  assert.equal(f.elements().some(node => node.props.role === 'alert'), false)
  assert.equal(f.requests.length, 1)
})

test('a native preview is revealed while downloading keeps the focus view open', async () => {
  for (const label of [target.label, '查看页面预览', 'Preview HTML']) {
    const f = fileControl(label)
    f.click(); f.responses[0]('ok'); await flush(); f.render()
    assert.equal(f.ctx.originals, label === target.label ? 0 : 1)
    assert.equal(f.elements().some(node => node.props.role === 'alert'), false)
  }
})
