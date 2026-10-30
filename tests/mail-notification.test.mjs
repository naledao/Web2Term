// User-run only. Synthetic page, SMTP connection, storage and timers; no Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  new Function('exports', 'require', ...Object.keys(globals), compile(readFileSync(new URL(path, import.meta.url), 'utf8')))(
    exports, name => dependencies[name] ?? nodeRequire(name), ...Object.values(globals))
  return exports
}
function methods(path, name, names, globals = {}) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name)
  const body = names.map(name => declaration.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
  return new Function(...Object.keys(globals), compile(`class Subject { ${body} }`) + '\nreturn Subject')(...Object.values(globals))
}
const pageAst = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function pageFunction(name, globals = {}) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(pageAst) === name) return node.initializer
    return ts.forEachChild(node, find)
  }
  return new Function(...Object.keys(globals), 'return ' + find(pageAst).getText(pageAst))(...Object.values(globals))
}
const protocol = load('../src/shared/mail-notification.ts')
const { QqMailService } = load('../src/main/qq-mail.ts', { '../shared/mail-notification': protocol })
const { MailNotifications } = load('../src/main/mail-notifications.ts')
const request = { type: 'send_email', subject: '任务完成', body: '结果已生成。\n请查看报告。' }
const call = { messageId: 'reply-a', rawJson: JSON.stringify(request), conversationId: 'chat-a', pageEpoch: 'epoch-a', sourceSubmissionId: 'user:first' }
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const result = { type: 'email_result', ok: true, status: 'sent', message: '服务器已接受。' }

function page(report, overrides = {}) {
  const state = { enabled: true, awaitingReplySince: 1, taskPromptGeneration: 3, ...overrides }
  const check = pageFunction('checkMailNotification', {
    state, mailSourceSubmissionId: 'user:first', computerPageEpoch: 'epoch-a',
    location: { pathname: '/chat-a' }, report,
    looksLikeMailReply: pageFunction('looksLikeMailReply'), balancedObjects: pageFunction('balancedObjects'),
    setReplyWaiting: value => { state.awaitingReplySince = value }
  })
  return { state, check }
}

test('page recognition preserves Markdown inside the email and never acts on history or disabled terminal mode', () => {
  const events = [], f = page(event => events.push(event))
  const content = { ...request, body: 'Example:\n```javascript\nconst x = { value: 1 }\n```\n结束' }
  assert.equal(f.check('reply-a', '```json\n' + JSON.stringify(content) + '\n```'), true)
  assert.deepEqual(JSON.parse(events[0].rawJson), content)
  assert.equal(events[0].sourceSubmissionId, 'user:first')
  assert.equal(events[0].taskPromptGeneration, 3)
  assert.equal(f.state.awaitingReplySince, 0)
  for (const overrides of [{ enabled: false }, { awaitingReplySince: 0 }]) {
    const f = page(() => assert.fail('history must not send'), overrides)
    assert.equal(f.check('old-reply', JSON.stringify(request)), true)
  }
})

test('mixed or malformed tool replies remain failures rather than sending a partial email or running a command', () => {
  const events = [], f = page(event => events.push(event))
  f.check('mixed', JSON.stringify(request) + '\n{"command":"anything"}')
  assert.throws(() => JSON.parse(events[0].rawJson))
  assert.equal(f.state.replyActionDetected, true)
  const malformed = page(event => events.push(event))
  malformed.check('broken', '{"type":"send_email","subject":')
  assert.throws(() => JSON.parse(events[1].rawJson))
  const explanation = page(event => events.push(event))
  explanation.check('example', '下面是调用格式示例：\n```json\n' + JSON.stringify(request) + '\n```')
  assert.equal(protocol.parseMailNotificationRequest(JSON.parse(events[2].rawJson)), null)
})

const Embed = methods('../src/main/embed.ts', 'ChatGptEmbed', ['handlePageReport'], {
  INTERCEPTOR_LOG_TAG: 'test:', writeReplyDiagnostic: () => null, writePromptDiagnostic() {},
  conversationIdOf: (_platform, url) => new URL(url).pathname.slice(1)
})
function embed(handler) {
  return Object.assign(new Embed(), {
    platform: { id: 'claude', homeUrl: 'https://example.test/', page: { computerUseRequests: false },
      conversationIdFromPath: path => path === '/chat-a' ? 'chat-a' : null },
    computerUseRecognitionEnabled: false, computerPageEpoch: 'epoch-a', taskPromptGeneration: 3,
    userSubmissions: new Set(['user:first']), interceptor: { pendingQuestion: null },
    liveContents: () => ({ id: 1, getURL: () => 'https://example.test/chat-a' }), getInterceptorStatus: () => ({}),
    handlers: { onMailNotification: handler, onInterceptor() {} }
  })
}

test('the bridge works with computer use disabled and rejects stale epoch, generation, source and path', () => {
  const received = [], subject = embed(value => received.push(value))
  const payload = { event: 'mail-notification', ...call, live: true, computerPageEpoch: call.pageEpoch,
    pagePath: '/chat-a', taskPromptGeneration: 3 }
  subject.handlePageReport('test:' + JSON.stringify(payload))
  assert.deepEqual(received, [call])
  for (const patch of [{ computerPageEpoch: 'old' }, { taskPromptGeneration: 2 }, { sourceSubmissionId: 'unknown' },
    { pagePath: '/other' }, { live: false }]) subject.handlePageReport('test:' + JSON.stringify({ ...payload, ...patch }))
  assert.equal(received.length, 1)
})

const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', ['mailNotificationCurrent', 'canRunConversationInBackground'], {
  taskPausedByInput: task => !!task?.paused
})
function runtime() {
  return Object.assign(new Runtime(), { active: true, disposed: false, taskEnded: false, stoppingTask: null,
    activePlatformId: 'claude', options: {}, lastSubmissions: new Map([['claude', 'user:first']]),
    getComputerUseCapability: () => ({ scopeSupported: false }),
    runner: { getAutomation: () => ({ paused: false }) }, toolPreferences: () => ({ mailNotificationsEnabled: true }),
    taskCoordinator: { waitingForUser: () => false, latest: () => null },
    embed: { getComputerUsePageEpoch: () => 'epoch-a', getState: () => ({ conversationId: 'chat-a' }),
      getInterceptorStatus: () => ({ enabled: true, pendingQuestion: null }) }
  })
}

test('runtime admission rejects disabled, paused, stopped and stale conversation calls', () => {
  const subject = runtime()
  assert.equal(subject.mailNotificationCurrent(call), true)
  for (const [key, value] of [['disposed', true], ['taskEnded', true], ['stoppingTask', {}]]) {
    const original = subject[key]; subject[key] = value
    assert.equal(subject.mailNotificationCurrent(call), false); subject[key] = original
  }
  assert.equal(subject.mailNotificationCurrent({ ...call, pageEpoch: 'old' }), false)
  assert.equal(subject.mailNotificationCurrent({ ...call, sourceSubmissionId: 'old' }), false)
  assert.equal(subject.mailNotificationCurrent({ ...call, conversationId: 'other' }), false)
  subject.toolPreferences = () => ({ mailNotificationsEnabled: false })
  assert.equal(subject.mailNotificationCurrent(call), false)
  subject.toolPreferences = () => ({ mailNotificationsEnabled: true })
  subject.options.automationBlocked = () => true
  assert.equal(subject.mailNotificationCurrent(call), false)
  delete subject.options.automationBlocked
  subject.runner.getAutomation = () => ({ paused: true })
  assert.equal(subject.mailNotificationCurrent(call), false)
})

test('a complete page-to-service call sends exactly once and returns the server result to the same AI conversation', async t => {
  const values = new Map(), sent = [], receipts = [], notes = [], subject = runtime()
  const service = new QqMailService({ getSetting: key => values.get(key) ?? null, setSetting: (key, value) => values.set(key, value) }, {
    encryptionAvailable: () => true, encrypt: value => 'sealed:' + value, decrypt: value => value.slice(7),
    verify: async () => assert.fail('no extra probe'), send: async message => { sent.push(message) }
  })
  service.save({ senderEmail: '123456789@qq.com', authorizationCode: 'abcdefghijklmnop' })
  service.saveRecipient('987654321@qq.com')
  const notifications = new MailNotifications({ mail: () => service, current: value => subject.mailNotificationCurrent(value),
    send: async (text, value) => { receipts.push({ text, call: value }); return 'ok' }, note: text => notes.push(text) })
  t.after(() => notifications.cancel())
  const bridge = embed(value => notifications.receive(value, JSON.stringify(['session-a', 'claude', value.conversationId, value.sourceSubmissionId, value.messageId])))
  page(event => bridge.handlePageReport('test:' + JSON.stringify(event))).check('reply-a', '```json\n' + JSON.stringify(request) + '\n```')
  await settle()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].recipientEmail, '987654321@qq.com')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].call.conversationId, 'chat-a')
  assert.match(receipts[0].text, /"status":"sent"/)
  assert.match(notes[0], /邮件通知/)
  assert.equal(notifications.busy, false)
})

test('only busy AI receipts retry; SMTP executes once, uncertain AI submissions never retry', async t => {
  const timers = new Set(), { MailNotifications: Subject } = load('../src/main/mail-notifications.ts', {}, {
    setTimeout(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer) }
  })
  let smtp = 0, deliveries = 0, outcome = 'busy'
  const subject = new Subject({ mail: () => ({ async sendNotification() { smtp++; return result } }), current: () => true,
    send: async () => { deliveries++; return outcome }, note() {} })
  t.after(() => subject.cancel())
  subject.receive(call, 'a'); subject.receive(call, 'a'); await settle()
  assert.equal(smtp, 1); assert.equal(deliveries, 1); assert.equal(timers.size, 1)
  outcome = 'unknown'
  const timer = [...timers][0]; timers.delete(timer); timer.callback(); await settle()
  assert.equal(smtp, 1); assert.equal(deliveries, 2); assert.equal(timers.size, 0)
  assert.equal(subject.busy, false)
})

test('a scope change cancels in-flight SMTP and never sends its receipt into a new conversation', async t => {
  let resolve, signal, active = true, deliveries = 0
  const subject = new MailNotifications({ mail: () => ({ sendNotification(_request, _key, value) {
    signal = value; return new Promise(done => { resolve = done })
  } }), current: () => active, send: async () => { deliveries++; return 'ok' }, note() {} })
  t.after(() => subject.cancel())
  subject.receive(call, 'a')
  active = false; subject.reconcile()
  assert.equal(signal.aborted, true)
  resolve(result); await settle()
  assert.equal(deliveries, 0); assert.equal(subject.busy, false)
})

function transport(options = {}) {
  const connections = [], composed = []
  class Connection extends EventEmitter {
    constructor(config) { super(); this.config = config; this.closed = false; this.transactions = []; connections.push(this) }
    connect(callback) { callback(null) }
    login(auth, callback) { this.auth = auth; options.login ? options.login(callback) : callback(null) }
    send(envelope, mime, callback) {
      this.transactions.push({ envelope, mime })
      if (options.send) options.send(callback)
      else callback(null, { accepted: envelope.to })
    }
    close() { this.closed = true }
  }
  class Composer {
    constructor(options) { composed.push(options) }
    compile() { return { build: async () => Buffer.from('synthetic MIME') } }
  }
  const api = load('../src/main/qq-mail-transport.ts', {
    'nodemailer/lib/smtp-connection': Connection, 'nodemailer/lib/mail-composer': Composer,
    '../shared/qq-mail': { QQ_MAIL_SMTP: { host: 'smtp.qq.com', port: 465 } }
  })
  return { ...api, connections, composed }
}
const message = { auth: { user: '123@qq.com', pass: 'abcdefghijklmnop' }, recipientEmail: '456@qq.com', subject: '完成', body: '结果' }

test('SMTP sends one plain text MIME message with certificate verification and no attachment or URL access', async () => {
  const f = transport()
  await f.sendQqMailNotification(message, new AbortController().signal, () => true)
  assert.equal(f.connections.length, 1)
  const connection = f.connections[0]
  assert.equal(connection.config.secure, true)
  assert.equal(connection.config.tls.rejectUnauthorized, true)
  assert.equal(connection.transactions.length, 1)
  assert.deepEqual(connection.transactions[0].envelope, { from: message.auth.user, to: [message.recipientEmail] })
  assert.equal(f.composed[0].text, message.body)
  assert.equal(f.composed[0].disableFileAccess, true)
  assert.equal(f.composed[0].disableUrlAccess, true)
  assert.equal(connection.closed, true)
})

test('SMTP rechecks the live owner after login and cannot send after a pause or settings change', async () => {
  let finishLogin, active = true
  const f = transport({ login: callback => { finishLogin = callback } })
  const pending = f.sendQqMailNotification(message, new AbortController().signal, () => active)
  await settle(); active = false; finishLogin(null)
  await assert.rejects(pending, error => error.code === 'ECANCELLED')
  assert.equal(f.connections[0].transactions.length, 0)
  assert.equal(f.connections[0].closed, true)
})

test('losing an SMTP acceptance or aborting during submission is unknown, while explicit rejection is failed', async () => {
  for (const code of ['disconnect', 'reject', 'abort']) {
    const controller = new AbortController()
    const f = transport({ send: callback => {
      if (code === 'abort') controller.abort()
      else callback(code === 'reject' ? Object.assign(new Error('rejected'), { responseCode: 550, code: 'EENVELOPE' }) : new Error('socket lost'))
    } })
    await assert.rejects(f.sendQqMailNotification(message, controller.signal, () => true),
      error => error.code === (code === 'reject' ? 'EENVELOPE' : 'EUNCERTAIN'))
    assert.equal(f.connections[0].transactions.length, 1)
    assert.equal(f.connections[0].closed, true)
  }
})
