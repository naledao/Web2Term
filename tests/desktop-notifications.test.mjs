// User-run offline regressions. Electron, protocol registration and windows are mocked.
// Run: node --test tests/desktop-notifications.test.mjs tests/app-identity.test.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const plain = value => JSON.parse(JSON.stringify(value))
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    module, exports: module.exports, URL, console: { warn() {} }, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return module.exports
}
const files = load('../src/shared/file-requests.ts')
const types = load('../src/shared/types.ts', { './file-requests': files })
const platforms = load('../src/shared/platforms.ts', { './types': types })
const targets = load('../src/main/notification-target.ts', {
  '../shared/types': types, '../shared/platforms': platforms
})
const target = { sessionId: '11111111-2222-4333-8444-555555555555', platformId: 'chatgpt',
  conversationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
const other = { ...target, sessionId: '22222222-2222-4333-8444-555555555555' }
const url = (value = target, protocol = 'web2term-dev') => targets.notificationTargetUrl(protocol, value)

function desktop({ platform = 'win32', packaged = false, registered = true, supported = true } = {}) {
  const calls = [], shown = []
  class Notification extends EventEmitter {
    static isSupported() { return supported }
    constructor(options) { super(); this.options = options; shown.push(this) }
    show() { calls.push(['show']) }
  }
  const api = load('../src/main/desktop-notifications.ts', {
    electron: { Notification, app: {
      isPackaged: packaged,
      getAppPath: () => 'C:\\work with spaces\\Web2Term',
      setAppUserModelId(id) { calls.push(['identity', id]) },
      setAsDefaultProtocolClient(...args) { calls.push(['protocol', ...plain(args)]); return registered }
    } },
    './app-identity': { APP_ID: 'com.example.gptweb2codexterminal' },
    './notification-target': targets
  }, { process: { platform, execPath: 'C:\\work with spaces\\Web2Term\\node_modules\\electron\\dist\\electron.exe' } })
  return { api, calls, shown }
}

test('development activation includes the absolute app entry and has a separate identity', () => {
  const f = desktop()
  f.api.registerDesktopNotifications()
  assert.deepEqual(f.calls, [
    ['identity', 'com.example.gptweb2codexterminal.development'],
    ['protocol', 'web2term-dev', 'C:\\work with spaces\\Web2Term\\node_modules\\electron\\dist\\electron.exe',
      ['C:\\work with spaces\\Web2Term']]
  ])
})

test('installed activation preserves the app identity and uses its own executable', () => {
  const f = desktop({ packaged: true })
  f.api.registerDesktopNotifications()
  assert.deepEqual(f.calls, [['identity', 'com.example.gptweb2codexterminal'], ['protocol', 'web2term']])
})

test('Windows notifications launch the captured target through the app protocol', () => {
  const f = desktop()
  f.api.registerDesktopNotifications()
  f.api.showDesktopNotification(target, '有问题', '等待回答', () => assert.fail('Windows must use the URI route'))
  assert.equal(f.shown.length, 1)
  assert.match(f.shown[0].options.toastXml, /activationType="protocol"/)
  assert.equal(f.shown[0].options.silent, true)
  assert.ok(f.shown[0].options.toastXml.includes('<audio silent="true"/>'), 'custom XML must also mute the system sound')
  assert.ok(f.shown[0].options.toastXml.includes(url().replaceAll('&', '&amp;')))
  f.shown[0].emit('click') // Releases the object without invoking a second navigation callback.
})

test('Windows plays the selected sound once after successful delivery, never on a click or a failed toast', () => {
  const f = desktop()
  let sounds = 0
  f.api.registerDesktopNotifications(() => { sounds++ })
  f.api.showDesktopNotification(target, 'Title', 'Body', () => {})
  assert.equal(sounds, 0, 'constructing/showing a toast is not proof of delivery')
  f.shown[0].emit('show')
  f.shown[0].emit('show')
  f.shown[0].emit('click')
  assert.equal(sounds, 1)
  f.api.showDesktopNotification(target, 'Title', 'Body', () => {})
  f.shown[1].emit('failed', {}, 'Unavailable')
  assert.equal(sounds, 1)
})

test('a sound delivery failure leaves notification activation available', () => {
  const f = desktop()
  f.api.registerDesktopNotifications(() => { throw new Error('Renderer unavailable') })
  f.api.showDesktopNotification(target, 'Title', 'Body', () => {})
  assert.doesNotThrow(() => f.shown[0].emit('show'))
  assert.ok(f.shown[0].options.toastXml.includes(url().replaceAll('&', '&amp;')))
})

test('a failed protocol registration never posts a notification with a broken launch target', () => {
  const f = desktop({ registered: false })
  f.api.registerDesktopNotifications()
  f.api.showDesktopNotification(target, 'Title', 'Body', () => {})
  assert.equal(f.shown.length, 0)
})

test('other operating systems retain the native click handler without registering a Windows protocol', () => {
  for (const platform of ['darwin', 'linux']) {
    const f = desktop({ platform })
    let clicks = 0
    f.api.registerDesktopNotifications()
    f.api.showDesktopNotification(target, 'Title', 'Body', () => { clicks++ })
    assert.equal(f.shown[0].options.toastXml, undefined)
    assert.equal(f.calls.some(call => call[0] === 'protocol'), false)
    f.shown[0].emit('click')
    assert.equal(clicks, 1)
  }
})

test('target URIs round-trip UUID, Gemini and not-yet-assigned conversation IDs', () => {
  for (const value of [target, { ...target, platformId: 'gemini', conversationId: '0123456789abcdef' },
    { ...target, conversationId: null }]) {
    assert.deepEqual(plain(targets.parseNotificationTarget(url(value), 'web2term-dev')), value)
  }
  assert.equal(targets.parseNotificationTarget(url(), 'web2term'), null, 'development cannot claim installed notifications')
})

test('external activation accepts only valid notification targets, never a URL or command to execute', () => {
  const valid = url()
  for (const value of ['--inspect', 'https://example.com', valid.replace('/open', '/execute'),
    valid.replace('notification/', 'elsewhere/'), valid.replace('notification/', 'user@notification/'),
    valid.replace('notification/', 'notification:1234/'), valid.replace('chatgpt', 'unknown-platform'),
    valid.replace(target.sessionId, '../../app'), valid.replace(target.conversationId, 'https://example.com'),
    valid + '&session=' + other.sessionId, valid + '&command=calc.exe', valid + '#fragment',
    valid + '&conversation=', 'x'.repeat(2049)]) {
    assert.equal(targets.parseNotificationTarget(value, 'web2term-dev'), null, value)
  }
})

test('notification text is escaped without allowing XML attributes or elements to be injected', () => {
  const xml = targets.notificationToastXml(url(), 'A & "B"', '<text>\u0000\u000b\'内容\'</text>')
  assert.ok(xml.includes('<text>A &amp; &quot;B&quot;</text>'))
  assert.ok(xml.includes('&lt;text&gt;&apos;内容&apos;&lt;/text&gt;'))
  assert.ok(!xml.includes('\u0000') && !xml.includes('\u000b'))
})

test('a notification received during startup opens after session restoration and only once', () => {
  const opened = []
  const router = new targets.NotificationActivationRouter('web2term-dev', value => { opened.push(plain(value)); return true },
    () => assert.fail('target exists'))
  assert.equal(router.handleCommandLine(['electron.exe', 'C:\\app', url()]), true)
  assert.deepEqual(opened, [])
  router.markReady()
  router.markReady()
  assert.deepEqual(opened, [target])
  assert.equal(router.handleCommandLine(['electron.exe', url(other), '--flag']), true)
  assert.deepEqual(opened, [target, other])
})

test('the latest click during startup wins and a deleted session falls back without creating a new one', () => {
  const opened = []
  let fallback = 0
  const router = new targets.NotificationActivationRouter('web2term-dev', value => { opened.push(plain(value)); return false },
    () => { fallback++ })
  assert.equal(router.handleCommandLine(['electron.exe', '--flag']), false)
  assert.equal(router.handleCommandLine([url()]), true)
  assert.equal(router.handleCommandLine([url(other)]), true)
  router.markReady()
  assert.deepEqual(opened, [other])
  assert.equal(fallback, 1)
})

// Exercise actual runtime methods without constructing sessions, pages or terminals.
const runtimeAst = ts.createSourceFile('session-runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.ES2022, true)
const runtimeClass = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const methodNames = ['focusNotification', 'notificationTarget', 'notifyQuestion', 'notifyTaskCompleted']
const methods = methodNames.map(name => runtimeClass.members.find(node => node.name?.getText(runtimeAst) === name).getText(runtimeAst)).join('\n')
function runtime() {
  const notifications = [], calls = []
  const Subject = new Script(compile(`class Subject { ${methods} }\nmodule.exports = Subject`))
  const module = { exports: {} }
  Subject.runInNewContext({ module, exports: module.exports, showDesktopNotification(value, title, body, callback) {
    notifications.push({ value, title, body, callback })
  } })
  const state = { conversationId: target.conversationId }
  const subject = Object.assign(new module.exports(), {
    id: target.sessionId, disposed: false, active: false, taskEnded: false, activePlatformId: target.platformId,
    options: { onTaskCompleted() {} }, window: null,
    embed: { getState: () => state }, completedTaskNotifications: new Set(),
    taskCoordinator: { hasError: () => false, completionNotificationAllowed: () => true, completedTaskId: () => 'task-one' },
    focus() { calls.push(['focus', this.id]); return true },
    switchPlatform(id) { calls.push(['platform', id]); this.activePlatformId = id; return true },
    activePlatform: { conversationUrl: id => `https://chatgpt.com/c/${id}` },
    taskRunning: () => false, navigateEmbed(value) { calls.push(['navigate', value]) }
  })
  return { subject, state, notifications, calls }
}

test('question and completion notifications capture the original conversation before a later switch', () => {
  for (const notify of [subject => subject.notifyQuestion('问题?', 1), subject => subject.notifyTaskCompleted('任务完成')]) {
    const f = runtime()
    notify(f.subject)
    f.state.conversationId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    assert.deepEqual(plain(f.notifications[0].value), target)
    f.notifications[0].callback()
    assert.deepEqual(f.calls, [['focus', target.sessionId], ['navigate', `https://chatgpt.com/c/${target.conversationId}`]])
  }
})

test('focusing the existing target does not reload it and platform switches select the target site', () => {
  const f = runtime()
  assert.equal(f.subject.focusNotification(target), true)
  assert.deepEqual(f.calls, [['focus', target.sessionId]])
  f.calls.length = 0
  f.subject.activePlatformId = 'deepseek'
  assert.equal(f.subject.focusNotification(target), true)
  assert.deepEqual(f.calls, [['focus', target.sessionId], ['platform', 'chatgpt']])
})

test('old notifications cannot replace another running conversation or focus a different session', () => {
  const f = runtime()
  f.state.conversationId = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  f.subject.taskRunning = () => true
  assert.equal(f.subject.focusNotification(target), false)
  assert.deepEqual(f.calls, [['focus', target.sessionId]])
  f.calls.length = 0
  f.subject.activePlatformId = 'deepseek'
  assert.equal(f.subject.focusNotification(target), false)
  assert.deepEqual(f.calls, [['focus', target.sessionId]], 'a stale notification must not interrupt a task by switching sites')
  f.calls.length = 0
  assert.equal(f.subject.focusNotification(other), false)
  assert.deepEqual(f.calls, [])
  f.subject.disposed = true
  assert.equal(f.subject.focusNotification(target), false)
})
