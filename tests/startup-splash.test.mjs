// User-run offline regressions. These mocks never launch Electron or load a website.
// Run: node --test tests/startup-splash.test.mjs
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
  'showManagerWhenReady', 'startApplication', 'handleStartupFailure', 'handleSecondInstance'
]
const code = names.map(name => {
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(declaration, `${name} exists`)
  return declaration.getText(ast)
}).join('\n')
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fixture({ packaged = false } = {}) {
  const events = []
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
      windows.push(this)
      events.push('splash-created')
    }
    isDestroyed() { return this.destroyed }
    setBounds() {}
    setResizable() {}
    setMaximizable() {}
    showInactive() { events.push('splash-shown') }
    getOpacity() { return 1 }
    setOpacity() {}
    loadFile(path) {
      this.path = path
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
    app: { getAppPath: () => '/app', quit: () => events.push('quit') },
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
  return { actions, context, events, windows, timers, advance, prepareManager }
}

for (const signal of ['ready-to-show', 'did-finish-load']) {
  test(`startup shows the standalone splash before initialization via ${signal}`, async () => {
    const app = fixture()
    const starting = app.actions.startApplication()
    const window = app.windows[0]
    assert.equal(window.path, join('/app', 'src/renderer/splash.html'))
    assert.equal(window.options.show, false)
    assert.deepEqual(app.events, ['splash-created'])
    if (signal === 'ready-to-show') window.emit(signal)
    else window.webContents.emit(signal)
    await starting
    assert.deepEqual(app.events, ['splash-created', 'splash-shown', 'initialize'])
    window.emit('ready-to-show')
    window.webContents.emit('did-finish-load')
    assert.equal(app.events.filter(event => event === 'splash-shown').length, 1)
    assert.equal(app.timers.size, 0)
  })
}

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
    else app.advance(3000)
    await starting
    assert.equal(app.events.includes('initialize'), true)
    assert.equal(app.context.splashWindow, null)
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

test('normal startup preserves the minimum animation time and releases the ready manager', async () => {
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
  app.advance(241)
  assert.equal(app.windows[0].isDestroyed(), true)
  assert.equal(app.events.includes('manager-shown'), true)
  assert.equal(app.timers.size, 0)
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
