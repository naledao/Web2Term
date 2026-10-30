// User-run only: node --test tests/hidden-embed-rendering.test.mjs tests/focus-model-settings.test.mjs
// Real embed methods with synthetic native views and page snapshots. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const sharedExports = {}
new Script(compile(readFileSync(new URL('../src/shared/focus-chat.ts', import.meta.url), 'utf8'))).runInNewContext({ exports: sharedExports })
const source = readFileSync(new URL('../src/main/embed.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('embed.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ChatGptEmbed')
const methods = ['applyBounds', 'setBounds', 'setVisible', 'keepRenderingWhileHidden', 'readFocusSnapshot']
const code = compile('export class Embed {\n' +
  declaration.members.filter(node => methods.includes(node.name?.getText(ast))).map(node => node.getText(ast)).join('\n') + '}')

function fixture() {
  let destroyed = false, url = 'https://chat.deepseek.com/a/chat/s/chat-a'
  const calls = [], state = { nativeVisible: true, painting: true, viewport: null }
  const raw = { path: '/a/chat/s/chat-a', ready: true, nativeDraft: false, waiting: true, generating: 'idle', reply: null }
  const contents = { isDestroyed: () => destroyed, getURL: () => url, executeJavaScript: async script => {
    assert.equal(script, 'window.__cmdTerminalInterceptor?.focusSnapshot() ?? null')
    return raw
  }, setBackgroundThrottling(value) { calls.push(['throttle', value]); if (!value) state.painting = true } }
  const view = { webContents: contents,
    setBounds(bounds) { calls.push(['bounds']); state.viewport = { ...bounds } },
    setVisible(visible) { calls.push(['visible', visible]); state.nativeVisible = visible; state.painting = visible },
    focus() { assert.fail('Rendering keepalive must never focus a native view') } }
  const exports = {}
  new Script(code).runInNewContext({ exports, ...sharedExports, URL, Promise, setTimeout, clearTimeout })
  const embed = Object.assign(new exports.Embed(), { view, visible: false, bounds: { x: 10.4, y: 20.6, width: 1200.2, height: 800.3 },
    liveContents: () => destroyed ? null : contents, focusPage: () => destroyed ? null : contents,
    dismissSelectionQuestion() { calls.push(['dismiss-selection']) } })
  return { embed, calls, state, raw, destroy() { destroyed = true }, navigate(value) { url = value } }
}

test('the declared and locked Electron baseline includes the renderer visibility synchronization fix', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const baseline = manifest.devDependencies.electron
  assert.match(baseline, /^\^?\d+\.\d+\.\d+$/)
  const includesFix = version => {
    const [major, minor] = version.replace(/^\^/, '').split('.').map(Number)
    return major > 44 || major === 44 && minor >= 5
  }
  assert.ok(includesFix(baseline), 'Electron 44.4.3 leaves initially hidden documents hidden despite unthrottled frames')
  assert.equal(lock.packages[''].devDependencies.electron, baseline)
  assert.ok(includesFix(lock.packages['node_modules/electron'].version), 'the lock must install a runtime containing #54341')
})

test('a hidden native view gets its real viewport before painting is re-enabled after hide', () => {
  const f = fixture()
  f.embed.applyBounds()
  assert.deepEqual(f.calls, [['bounds'], ['visible', false], ['throttle', false]])
  assert.deepEqual(f.state.viewport, { x: 10, y: 21, width: 1200, height: 800 })
  assert.equal(f.state.nativeVisible, false)
  assert.equal(f.state.painting, true)
})

test('switching from original to focus reasserts painting without showing or focusing the page', () => {
  const f = fixture()
  f.embed.visible = true
  f.embed.applyBounds()
  f.calls.length = 0
  f.embed.setVisible(false)
  assert.equal(f.embed.visible, false)
  assert.equal(f.state.nativeVisible, false)
  assert.equal(f.state.painting, true)
  assert.deepEqual(f.calls.slice(-3), [['bounds'], ['visible', false], ['throttle', false]])
})

test('a temporarily zero-sized slot preserves its last real viewport and recovers again on layout', () => {
  const f = fixture()
  f.embed.applyBounds()
  f.calls.length = 0
  f.embed.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  assert.deepEqual(f.calls, [['visible', false], ['throttle', false]])
  assert.equal(f.state.viewport.width, 1200)
  f.embed.setBounds({ x: 20, y: 30, width: 1000, height: 700 })
  assert.deepEqual(f.calls.slice(-3), [['bounds'], ['visible', false], ['throttle', false]])
  assert.equal(f.state.viewport.width, 1000)
  assert.equal(f.state.nativeVisible, false)
})

test('reading a waiting snapshot stays passive instead of repeatedly changing background settings', async () => {
  const f = fixture()
  assert.equal(await f.embed.readFocusSnapshot(), f.raw)
  await f.embed.readFocusSnapshot()
  assert.deepEqual(f.calls, [])
  assert.equal(f.embed.visible, false)
})

test('idle pages, visible pages, rendered replies and known send errors remain passive reads', async () => {
  for (const setup of [
    f => { f.raw.waiting = false },
    f => { f.embed.visible = true },
    f => { f.raw.reply = { sourceMessageId: 'reply-a', parts: [], answer: '已回答' } },
    f => { f.raw.sendFailure = { id: 'failed', message: '消息发送过于频繁，请稍后重试', retryable: true } }
  ]) {
    const f = fixture()
    setup(f)
    assert.equal(await f.embed.readFocusSnapshot(), f.raw)
    assert.deepEqual(f.calls, [])
  }
})

test('invalid snapshots and destroyed pages cannot trigger repair or cross a navigation boundary', async () => {
  const f = fixture()
  f.navigate('https://chat.deepseek.com/a/chat/s/other')
  assert.equal(await f.embed.readFocusSnapshot(), null)
  assert.deepEqual(f.calls, [])
  f.destroy()
  f.embed.applyBounds()
  assert.equal(await f.embed.readFocusSnapshot(), null)
  assert.deepEqual(f.calls, [])
})

// Exercise the real lazy-platform creation method and the real attach navigation
// boundary against the measured native-host behavior: resizing while hidden leaves
// the inner viewport unchanged. No native Electron instance or URL request is used.
function lazyPlatformFixture(windowReady = true) {
  const attach = declaration.members.find(node => node.name?.getText(ast) === 'attach')
  const startup = attach.body.statements.filter(node => node.getText(ast) === 'this.applyBounds()' ||
    node.getText(ast).startsWith('void contents.loadURL('))
  assert.equal(startup.length, 2, 'actual attach sizing/navigation boundary')
  const startNavigation = new Script('(function () { const contents = this.view.webContents;\n' +
    startup.map(node => node.getText(ast)).join('\n') + '\n})').runInNewContext({})
  const base = {}
  new Script(code).runInNewContext({ exports: base })
  const loads = [], views = []
  const parent = { isDestroyed: () => false, createView() {
    const native = { visible: true, bounds: { width: 0, height: 0 }, viewport: { width: 0, height: 0 } }
    const view = { webContents: { isDestroyed: () => false, setBackgroundThrottling() {},
      loadURL(url) { loads.push({ url, visible: native.visible, viewport: { ...native.viewport } }) } },
      setBounds(bounds) {
        native.bounds = { ...bounds }
        if (native.visible) native.viewport = { width: bounds.width, height: bounds.height }
      },
      setVisible(visible) {
        native.visible = visible
        if (visible) native.viewport = { width: native.bounds.width, height: native.bounds.height }
      } }
    views.push({ view, native })
    return view
  } }
  class LazyEmbed extends base.Embed {
    constructor(platform, _handlers, initialUrl) {
      super()
      Object.assign(this, { platform, initialUrl, visible: true, view: null, bounds: { x: 0, y: 0, width: 0, height: 0 } })
    }
    attach(window) {
      if (this.view) return
      this.view = window.createView()
      startNavigation.call(this)
    }
    liveContents() { return this.view?.webContents ?? null }
    dismissSelectionQuestion() {}
    setPromptInjectionEnabled() {}
    setComputerUseRecognitionEnabled() {}
    setSendBlock() {}
    setBaselinePolicy() {}
    setPromptParts() {}
    setTheme() {}
  }
  const runtimeSource = readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8')
  const runtimeAst = ts.createSourceFile('session-runtime.ts', runtimeSource, ts.ScriptTarget.Latest, true)
  const runtimeClass = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
  const ensure = runtimeClass.members.find(node => node.name?.getText(runtimeAst) === 'ensureEmbed')
  const exports = {}
  new Script(compile('export class Runtime {' + ensure.getText(runtimeAst) + '}')).runInNewContext({ exports,
    ChatGptEmbed: LazyEmbed, computerUseSendBlock: () => null, buildTerminalPromptParts: () => ({ prefix: 'synthetic' }) })
  const bounds = { x: 261, y: 127, width: 1248, height: 785 }
  const runtime = Object.assign(new exports.Runtime(), { embeds: new Map([
    ['chatgpt', { platform: { id: 'chatgpt' }, embed: { retained: true } }],
    ['deepseek', { platform: { id: 'deepseek', homeUrl: 'https://chat.deepseek.com/' } }]
  ]), lastBounds: bounds, window: windowReady ? parent : null, environment: {},
  options: { settings: () => ({ theme: 'light' }) }, runner: { getAutomation: () => ({ mode: 'auto' }) },
  embedHandlers() { return {} }, getComputerUseCapability() { return {} }, toolPrompt() { return '' }, refreshComputerUseStepContext() {} })
  return { runtime, parent, loads, views, bounds }
}

test('ChatGPT to a lazy DeepSeek platform has a nonzero hidden viewport at its first navigation', () => {
  const f = lazyPlatformFixture()
  const chatgpt = f.runtime.embeds.get('chatgpt').embed
  const created = f.runtime.ensureEmbed('deepseek')
  assert.deepEqual(f.loads, [{ url: 'https://chat.deepseek.com/', visible: false, viewport: { width: 1248, height: 785 } }])
  assert.equal(f.views[0].native.visible, false)
  assert.equal(f.runtime.embeds.get('chatgpt').embed, chatgpt, 'retain the original platform')
  assert.equal(f.runtime.ensureEmbed('deepseek'), created)
  assert.equal(f.loads.length, 1, 'switching to an existing platform must not reload or recreate it')
})

test('a platform prepared before its parent exists keeps geometry for its later first attachment', () => {
  const f = lazyPlatformFixture(false)
  const created = f.runtime.ensureEmbed('deepseek')
  assert.equal(f.loads.length, 0)
  created.embed.attach(f.parent)
  assert.deepEqual(f.loads, [{ url: 'https://chat.deepseek.com/', visible: false, viewport: { width: 1248, height: 785 } }])
})
