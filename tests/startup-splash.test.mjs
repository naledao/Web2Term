// User-run offline regressions. These mocks never launch Electron or load a website.
// Run: node --test tests/startup-splash.test.mjs tests/startup-theme.test.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true)
const names = [
  'createSplashWindow', 'armSplashFallback', 'closeSplashWindow', 'destroySplashWindow',
  'showManagerWhenReady', 'startApplication', 'handleStartupFailure', 'handleSecondInstance', 'applyAppTheme'
]
const code = names.map(name => {
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(declaration, `${name} exists`)
  return declaration.getText(ast)
}).join('\n')
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fixture({ packaged = false, dark = false, savedTheme = 'light' } = {}) {
  const events = []
  const themeReads = []
  const windows = []
  const timers = new Map()
  let timerId = 0
  let now = 0
  const schedule = (callback, delay, interval = false) => {
    const id = ++timerId
    timers.set(id, { callback, at: now + delay, delay, interval })
    return id
  }
  class Window extends EventEmitter {
    destroyed = false
    webContents = new EventEmitter()
    constructor(options) {
      super()
      this.options = options
      this.opacity = options.opacity ?? 1
      this.backgroundColor = options.backgroundColor
      windows.push(this)
      events.push('splash-created')
    }
    isDestroyed() { return this.destroyed }
    setBounds() {}
    setResizable() {}
    setMaximizable() {}
    setBackgroundColor(value) { this.backgroundColor = value }
    showInactive() { events.push('splash-shown') }
    getOpacity() { return this.opacity }
    setOpacity(value) { this.opacity = value; events.push(['splash-opacity', value]) }
    loadFile(path, options) {
      this.path = path
      this.loadOptions = options
      return new Promise((resolve, reject) => { this.loaded = resolve; this.failed = reject })
    }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      events.push('splash-destroyed')
      this.emit('closed')
    }
  }
  const context = {
    Error, BrowserWindow: Window, join, __dirname: '/app/out/main', isDev: !packaged,
    process: { platform: 'win32' }, runtimes: new Map(), nacosViews: new Map(),
    nativeTheme: { themeSource: dark ? 'dark' : 'light', get shouldUseDarkColors() { return this.themeSource === 'dark' } },
    settings: { theme: 'light' },
    readStartupTheme: path => { themeReads.push(path); return savedTheme },
    app: { getAppPath: () => '/app', getPath: name => {
      assert.equal(name, 'userData')
      return '/profile'
    }, quit: () => events.push('quit') },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    console: { info() {}, warn: (...args) => events.push(['warning', ...args]), error: (...args) => events.push(['error', ...args]) },
    dialog: { showErrorBox: (...args) => events.push(['dialog', ...args]) },
    Date: { now: () => now }, APP_NAME: 'Web2Term',
    SPLASH_WIDTH: 380, SPLASH_HEIGHT: 264, SPLASH_FIRST_PAINT_MAX_MS: 3000,
    SPLASH_MIN_VISIBLE_MS: 3000, SPLASH_MAX_MS: 20000,
    splashWindow: null, splashClosing: false, splashReady: false, splashShownAt: null,
    splashCloseRequested: false, splashFallbackTimer: null, splashCloseTimer: null, splashFirstPaint: null,
    quitting: false, applicationReady: false, managerReadyToShow: false, managerWindow: null,
    currentSessionId: null, markSessionViewed() {},
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearInterval: id => timers.delete(id),
    initializeApplication: async () => events.push('initialize'),
    createManagerWindow: () => events.push('manager-requested'),
    notificationActivations: { handleCommandLine: () => false }
  }
  const actions = new Script(`${compiled}\n({ ${names.join(', ')} })`).runInNewContext(context)
  function advance(milliseconds) {
    const until = now + milliseconds
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [id, timer] = next
      now = timer.at
      if (timer.interval) timer.at += timer.delay
      else timers.delete(id)
      timer.callback()
    }
    now = until
  }
  function prepareManager() {
    context.managerWindow = {
      isDestroyed: () => false, isMinimized: () => false,
      maximize() {}, show: () => events.push('manager-shown'), focus() {}
    }
    context.managerReadyToShow = true
  }
  return { actions, context, events, windows, timers, advance, prepareManager, themeReads }
}

test('saved application theme is applied before the native window and HTML are loaded, even when the system differs', async () => {
  for (const savedTheme of ['dark', 'light']) {
    const app = fixture({ dark: savedTheme === 'light', savedTheme })
    const starting = app.actions.startApplication(), window = app.windows[0]
    assert.deepEqual(app.themeReads, [join('/profile', 'conversations.db')])
    assert.equal(app.context.settings.theme, savedTheme)
    assert.equal(app.context.nativeTheme.themeSource, savedTheme)
    assert.equal(window.options.backgroundColor, savedTheme === 'dark' ? '#0b0e14' : '#ffffff')
    assert.equal(window.loadOptions.query.theme, savedTheme)
    assert.equal(app.events.includes('initialize'), false)
    window.emit('ready-to-show')
    await starting
    assert.equal(window.backgroundColor, window.options.backgroundColor, 'workspace initialization does not need to correct the first palette')
  }
})

for (const documentFirst of [false, true]) {
  test(`startup waits for the first rendered frame before initialization (document first: ${documentFirst})`, async () => {
    const app = fixture()
    const starting = app.actions.startApplication()
    const window = app.windows[0]
    assert.equal(window.path, join('/app', 'src/renderer/splash.html'))
    assert.equal(window.options.show, false)
    assert.equal(window.options.transparent, false)
    assert.equal(Object.hasOwn(window.options, 'opacity'), false, 'an explicit opacity would enable Windows layered-window mode')
    assert.deepEqual(app.events, ['splash-created'])
    if (documentFirst) {
      window.webContents.emit('did-finish-load')
      await Promise.resolve()
      assert.deepEqual(app.events, ['splash-created'], 'document load alone cannot reveal the window or start heavy initialization')
      assert.equal(app.context.splashReady, false)
      assert.equal(app.context.splashShownAt, null)
    }
    window.emit('ready-to-show')
    await starting
    assert.deepEqual(app.events, ['splash-created', 'splash-shown', 'initialize'])
    window.emit('ready-to-show')
    window.webContents.emit('did-finish-load')
    assert.equal(app.events.filter(event => event === 'splash-shown').length, 1)
    assert.equal(app.timers.size, 0)
  })
}

test('the native splash has an opaque backing in both themes and follows a saved theme change', async () => {
  for (const dark of [false, true]) {
    const app = fixture({ dark })
    const painted = app.actions.createSplashWindow(), window = app.windows[0]
    assert.equal(window.options.backgroundColor, dark ? '#0b0e14' : '#ffffff')
    assert.equal(window.options.backgroundMaterial, 'none')
    assert.equal(window.options.roundedCorners, true)
    app.actions.applyAppTheme(dark ? 'light' : 'dark')
    assert.equal(window.backgroundColor, dark ? '#ffffff' : '#0b0e14')
    window.emit('ready-to-show')
    await painted
  }
})

test('packaged startup loads the built local splash without waiting for the workspace renderer', async () => {
  const app = fixture({ packaged: true })
  const painted = app.actions.createSplashWindow()
  assert.equal(app.windows[0].path, join('/app/out/main', '../renderer/splash.html'))
  assert.equal(app.actions.createSplashWindow(), painted)
  assert.equal(app.windows.length, 1)
  app.windows[0].emit('ready-to-show')
  await painted
})

test('a missing splash or first-frame timeout cannot strand initialization', async () => {
  for (const failure of ['load', 'timeout']) {
    const app = fixture()
    const starting = app.actions.startApplication()
    if (failure === 'load') app.windows[0].failed(new Error('missing splash'))
    else {
      app.windows[0].webContents.emit('did-finish-load')
      app.advance(2999)
      assert.equal(app.events.includes('splash-shown'), false)
      assert.equal(app.events.includes('initialize'), false)
      app.advance(1)
    }
    await starting
    assert.equal(app.events.includes('initialize'), true)
    assert.equal(app.context.splashWindow, null)
    assert.equal(app.events.includes('splash-shown'), false, 'an unpainted page is discarded without showing it')
    app.advance(240)
    assert.equal(app.windows[0].isDestroyed(), true)
    assert.equal(app.timers.size, 0)
  }
})

test('quitting before the splash paints releases the wait without starting services', async () => {
  const app = fixture()
  const starting = app.actions.startApplication()
  app.context.quitting = true
  app.actions.destroySplashWindow()
  await starting
  assert.equal(app.events.includes('initialize'), false)
  assert.equal(app.timers.size, 0)
})

test('the chat-load timeout starts when armed after workspace creation', async () => {
  const app = fixture()
  const starting = app.actions.startApplication()
  app.windows[0].emit('ready-to-show')
  await starting
  app.advance(25000)
  assert.equal(app.windows[0].isDestroyed(), false)
  app.prepareManager()
  app.actions.armSplashFallback()
  app.actions.armSplashFallback()
  assert.equal(app.timers.size, 1)
  app.advance(19999)
  assert.equal(app.context.splashClosing, false)
  app.advance(241)
  assert.equal(app.windows[0].isDestroyed(), true)
  assert.equal(app.events.includes('manager-shown'), true)
  assert.equal(app.timers.size, 0)
})

test('normal startup stays opaque for the minimum animation time, then closes before showing the manager', async () => {
  const app = fixture()
  const starting = app.actions.startApplication()
  app.windows[0].emit('ready-to-show')
  await starting
  app.prepareManager()
  app.actions.armSplashFallback()
  app.actions.showManagerWhenReady()
  app.actions.closeSplashWindow()
  app.advance(2999)
  assert.equal(app.events.includes('manager-shown'), false)
  assert.equal(app.windows[0].isDestroyed(), false)
  assert.equal(app.windows[0].getOpacity(), 1)
  app.advance(1)
  assert.equal(app.windows[0].isDestroyed(), true)
  assert.equal(app.events.includes('manager-shown'), true)
  assert.ok(app.events.indexOf('splash-destroyed') < app.events.indexOf('manager-shown'))
  assert.equal(app.events.some(event => Array.isArray(event) && event[0] === 'splash-opacity' && event[1] < 1), false)
  assert.equal(app.context.splashClosing, false)
  assert.equal(app.timers.size, 0)
})

test('a forced splash close never leaves a translucent window or delays the ready workspace', async () => {
  const app = fixture()
  const starting = app.actions.startApplication()
  app.windows[0].emit('ready-to-show')
  await starting
  app.prepareManager()
  app.actions.armSplashFallback()
  app.actions.closeSplashWindow(true)
  assert.equal(app.windows[0].isDestroyed(), true)
  assert.equal(app.windows[0].getOpacity(), 1)
  assert.equal(app.events.some(event => Array.isArray(event) && event[0] === 'splash-opacity' && event[1] < 1), false)
  assert.ok(app.events.indexOf('splash-destroyed') < app.events.indexOf('manager-shown'))
  assert.equal(app.context.splashClosing, false)
  assert.equal(app.timers.size, 0)
  app.actions.closeSplashWindow(true)
  assert.equal(app.events.filter(event => event === 'splash-destroyed').length, 1)
  assert.equal(app.events.filter(event => event === 'manager-shown').length, 1)
})

test('a second launch waits for initialization while notification arguments still reach the router', () => {
  const app = fixture()
  const received = []
  app.context.notificationActivations.handleCommandLine = argv => {
    received.push(argv)
    return argv.includes('notification')
  }
  app.actions.handleSecondInstance(['ordinary'])
  assert.equal(app.events.includes('manager-requested'), false)
  app.context.applicationReady = true
  app.actions.handleSecondInstance(['ordinary'])
  app.actions.handleSecondInstance(['notification'])
  assert.equal(app.events.filter(event => event === 'manager-requested').length, 1)
  assert.deepEqual(received, [['ordinary'], ['ordinary'], ['notification']])
})

test('startup failure removes the splash, suppresses manager reveal and reports the error once', async () => {
  const app = fixture()
  const starting = app.actions.startApplication()
  app.context.initializeApplication = async () => { throw new Error('database unavailable') }
  app.windows[0].emit('ready-to-show')
  app.prepareManager()
  await starting.catch(app.actions.handleStartupFailure)
  assert.equal(app.context.quitting, true)
  assert.equal(app.windows[0].isDestroyed(), true)
  assert.equal(app.events.includes('manager-shown'), false)
  assert.equal(app.events.includes('quit'), true)
  assert.deepEqual(app.events.filter(event => Array.isArray(event) && event[0] === 'dialog'), [
    ['dialog', 'Web2Term 启动失败', 'database unavailable']
  ])
  app.actions.handleStartupFailure(new Error('already quitting'))
  assert.equal(app.events.filter(event => event === 'quit').length, 1)
  assert.equal(app.timers.size, 0)
})

test('the first splash palette uses the native theme and follows the saved application theme', () => {
  const html = readFileSync(new URL('../src/renderer/splash.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  assert.ok(script)
  for (const initiallyDark of [false, true]) {
    const themes = []
    let changed
    new Script(script).runInNewContext({
      window: {
        location: { search: '' },
        matchMedia: () => ({ matches: initiallyDark, addEventListener: (event, callback) => {
          assert.equal(event, 'change')
          changed = callback
        } })
      },
      document: { documentElement: { setAttribute: (name, value) => {
        assert.equal(name, 'data-theme')
        themes.push(value)
      } } }
    })
    assert.deepEqual(themes, [initiallyDark ? 'dark' : 'light'])
    changed({ matches: !initiallyDark })
    assert.deepEqual(themes, initiallyDark ? ['dark', 'light'] : ['light', 'dark'])
  }
})

test('the HTML uses the explicit saved palette before styles, regardless of the preview system preference', () => {
  const html = readFileSync(new URL('../src/renderer/splash.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  assert.ok(script)
  assert.ok(html.indexOf('<script>') < html.indexOf('<style>'))
  for (const theme of ['dark', 'light']) {
    const themes = []
    new Script(script).runInNewContext({
      window: { location: { search: '?theme=' + theme },
        matchMedia: () => ({ matches: theme === 'light', addEventListener() {} }) },
      document: { documentElement: { setAttribute: (_name, value) => themes.push(value) } }
    })
    assert.deepEqual(themes, [theme])
  }
})
