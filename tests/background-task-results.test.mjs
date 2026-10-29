// User-run offline regressions: node --test tests/background-task-results.test.mjs
// Fake timers, send callbacks and page state only; no Electron, browser or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const require = createRequire(import.meta.url)
const compile = code => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, ...globals, require(name) {
      if (name.startsWith('node:')) return require(name)
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return exports
}
const resultSource = readFileSync(new URL('../src/main/background-task-results.ts', import.meta.url), 'utf8')
const owner = { platformId: 'deepseek', conversationId: 'chat-a' }
const task = (patch = {}) => ({
  id: 'task-a', name: '构建', pid: 12345, transport: 'local', targetLabel: '本机', conversationId: 'chat-a',
  command: 'start-build', logPath: '/tmp/build.log', stderrPath: '/tmp/build.err', exitCodePath: '/tmp/build.exit',
  status: 'completed', exitCode: 0, createdAt: 1, checkedAt: 2, message: '', output: 'build finished',
  errorOutput: '', outputTruncated: false, errorOutputTruncated: false, ...patch
})
const settle = () => new Promise(setImmediate)
function fixture(t) {
  const timers = new Set(), sends = [], statuses = [], outcomes = [], signals = [], delivered = []
  const latest = new Map()
  let canSend = true
  let current = true, idleCount = 0
  const exports = {}
  new Script(compile(resultSource)).runInNewContext({ exports, AbortController,
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer) }
  })
  const queue = new exports.BackgroundTaskResults({
    canSend: route => typeof canSend === 'function' ? canSend(route) : canSend,
    current: () => current,
    async send(text, route, task, signal) { signals.push(signal); sends.push({ text, ...route }); const value = outcomes.shift(); return typeof value === 'function' ? value() : value ?? 'ok' },
    onOutcome: (task, outcome) => delivered.push({ id: task.id, outcome }),
    onIdle: () => { idleCount++ },
    onStatus: (id, status, message, kind) => statuses.push({ id, status, message, kind }),
    latest: id => latest.get(id)
  })
  t.after(() => queue.dispose())
  return { queue, sends, statuses, outcomes, signals, delivered, timers, latest, build: exports.buildBackgroundTaskResult,
    setCurrent(value) { current = value }, idleCount: () => idleCount,
    setCanSend(value) { canSend = value },
    async tick() { const pending = [...timers]; timers.clear(); for (const timer of pending) timer.callback(); await settle() }
  }
}

const readyService = (patch = {}) => task({ status: 'running', exitCode: null, backgroundOptions: { kind: 'service' },
  startup: { state: 'ready', readyAt: 1, deadlineAt: 120000, url: 'https://localhost:44301', evidence: 'Application started; 本任务正在监听',
    stdoutOffset: 0, stderrOffset: 0, stdoutCarry: '', stderrCarry: '' }, ...patch })

test('fast services merge creation into one ready result and allow the model to continue', async t => {
  const f = fixture(t)
  f.queue.capture(owner, () => true, 'created')(readyService({ startup: undefined }))
  const ready = f.queue.capture(owner, () => true, 'ready')
  ready(readyService())
  await f.tick()
  ready(readyService())
  await f.tick()
  assert.equal(f.sends.length, 1)
  assert.match(f.sends[0].text, /【后台服务已就绪】/)
  assert.match(f.sends[0].text, /继续原任务/)
  assert.match(f.sends[0].text, /无需等待服务退出/)
  assert.doesNotMatch(f.sends[0].text, /等待软件自动发送【后台任务执行结果】/)
  assert.ok(f.statuses.some(item => item.kind === 'created' && item.status === 'superseded'))
})

test('a busy creation attempt cannot be retried with stale waiting instructions after readiness arrives', async t => {
  const f = fixture(t)
  let release
  f.outcomes.push(() => new Promise(resolve => { release = resolve }))
  f.queue.capture(owner, () => true, 'created')(readyService({ startup: undefined }))
  await f.tick()
  const current = readyService()
  f.latest.set(current.id, current)
  f.queue.capture(owner, () => true, 'ready')(current)
  release('busy')
  await settle()
  await f.tick()
  assert.equal(f.sends.length, 2, 'one busy attempt followed by one ready notification')
  assert.match(f.sends[1].text, /【后台服务已就绪】/)
  assert.deepEqual(f.statuses.filter(item => item.status === 'sent').map(item => item.kind), ['ready'])
})

test('restored cancelled or already confirmed ready notifications are never submitted again', async t => {
  const f = fixture(t)
  for (const readinessDeliveryStatus of ['sent', 'cancelled', 'needs-attention', 'superseded']) {
    f.queue.capture(owner, () => true, 'ready')(readyService({ id: readinessDeliveryStatus, readinessDeliveryStatus }))
  }
  await f.tick()
  assert.equal(f.sends.length, 0)
})

test('a service that exits before delivery cannot send an obsolete ready notification', async t => {
  const f = fixture(t), current = readyService()
  f.latest.set(current.id, current)
  f.queue.capture(owner, () => true, 'ready')(current)
  f.latest.set(current.id, readyService({ status: 'failed', exitCode: 1, startup: { ...current.startup, state: 'failed' } }))
  await f.tick()
  assert.equal(f.sends.length, 0)
  assert.equal(f.statuses.at(-1).status, 'superseded')
  f.queue.capture(owner)(f.latest.get(current.id))
  await f.tick()
  assert.match(f.sends[0].text, /服务已退出/)
})

test('manual stop in progress pauses ready delivery and an accepted stop suppresses it', async t => {
  const f = fixture(t), current = readyService()
  f.queue.capture(owner, () => true, 'ready')(current)
  f.latest.set(current.id, { ...current, stopInProgress: true })
  await f.tick()
  assert.equal(f.sends.length, 0)
  f.latest.set(current.id, { ...current, stopInProgress: false, stopRequestedAt: 100 })
  await f.tick()
  assert.equal(f.sends.length, 0)
  assert.equal(f.statuses.at(-1).status, 'superseded')
})

test('timeout is an observation result rather than an instruction to kill or restart the service', async t => {
  const f = fixture(t), current = readyService()
  f.queue.capture(owner, () => true, 'startup-timeout')({ ...current, startup: { ...current.startup, state: 'timeout', readyAt: undefined } })
  await f.tick()
  assert.match(f.sends[0].text, /进程仍在运行/)
  assert.match(f.sends[0].text, /不要直接重复启动/)
  f.queue.capture(owner, () => true, 'ready')(current)
  await f.tick()
  assert.equal(f.sends.length, 2)
})

test('an exception after starting submission is treated as uncertain instead of retried', async t => {
  const f = fixture(t)
  f.outcomes.push(() => { throw new Error('acknowledgement lost') })
  f.queue.capture(owner, () => true, 'ready')(readyService())
  await f.tick()
  await f.tick()
  assert.equal(f.sends.length, 1)
  assert.equal(f.statuses.at(-1).status, 'needs-attention')
  assert.ok(f.statuses.some(item => item.status === 'sending'))
})

test('manual stop notifications tell the model to wait for the user instead of restarting the task', t => {
  const f = fixture(t)
  const text = f.build(task({ status: 'stopped', exitCode: null, stopRequestedAt: 10, output: 'shutdown complete' }))
  assert.match(text, /用户已手动停止/)
  assert.match(text, /不要自动重启、重试或修复/)
  assert.match(text, /shutdown complete/)
  assert.doesNotMatch(text, /继续必要的验证、修复/)
})

test('final results are queued and sent once to the captured conversation, including final logs and exit status', async t => {
  const f = fixture(t), route = { ...owner }, complete = f.queue.capture(route)
  route.conversationId = 'wrong-chat'
  complete(task())
  assert.equal(f.sends.length, 0)
  assert.equal(f.statuses[0].status, 'pending')
  await f.tick()
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].conversationId, 'chat-a')
  assert.equal(f.sends[0].platformId, 'deepseek')
  assert.match(f.sends[0].text, /【后台任务执行结果】/)
  assert.match(f.sends[0].text, /退出码: 0/)
  assert.match(f.sends[0].text, /build finished/)
  assert.equal(f.statuses.at(-1).status, 'sent')
  complete(task())
  await f.tick()
  assert.equal(f.sends.length, 1)
  assert.equal(f.timers.size, 0)
})

test('creation notifications include startup stdout and stderr without treating stderr as completion', async t => {
  const f = fixture(t)
  f.queue.capture(owner, () => true, 'created')(task({ status: 'running', exitCode: null,
    output: 'startup ready', errorOutput: 'First copy your one-time code: TEST-CODE\nhttps://github.com/login/device' }))
  await f.tick()
  assert.equal(f.sends.length, 1)
  assert.match(f.sends[0].text, /【后台任务已创建】/)
  assert.match(f.sends[0].text, /startup ready/)
  assert.match(f.sends[0].text, /TEST-CODE/)
  assert.doesNotMatch(f.sends[0].text, /^结果: 成功|^【后台任务执行结果】/m)
})

test('creation confirmation and final result are separate, ordered, and each sent once', async t => {
  const f = fixture(t)
  const created = f.queue.capture(owner, () => true, 'created')
  const finished = f.queue.capture(owner)
  created(task({ status: 'checking', exitCode: null, output: '' }))
  finished(task())
  await f.tick()
  assert.equal(f.sends.length, 1)
  assert.ok(f.sends[0].text.startsWith('【后台任务已创建】'))
  assert.match(f.sends[0].text, /不代表任务已完成/)
  assert.match(f.sends[0].text, /请简短确认后等待/)
  assert.match(f.sends[0].text, /不要发命令轮询/)
  assert.equal(f.statuses.filter(item => item.status === 'sent')[0].kind, 'created')
  f.setCanSend(false)
  await f.tick()
  assert.equal(f.sends.length, 1, 'the final result waits while the model acknowledges creation')
  f.setCanSend(true)
  await f.tick()
  assert.equal(f.sends.length, 2)
  assert.ok(f.sends[1].text.startsWith('【后台任务执行结果】'))
  assert.equal(f.statuses.filter(item => item.status === 'sent')[1].kind, 'finished')
  created(task())
  finished(task())
  await f.tick()
  assert.equal(f.sends.length, 2)
})

test('busy creation notifications retry without duplicating or blocking the later final result', async t => {
  const f = fixture(t)
  f.outcomes.push('busy', 'ok', 'ok')
  f.queue.capture(owner, () => true, 'created')(task({ status: 'checking', exitCode: null }))
  f.queue.capture(owner)(task())
  await f.tick()
  assert.equal(f.statuses.filter(item => item.status === 'sent').length, 0)
  await f.tick()
  await f.tick()
  assert.deepEqual(f.statuses.filter(item => item.status === 'sent').map(item => item.kind), ['created', 'finished'])
})

test('pause, mode, busy drafts, missing composers and disconnected targets wait without losing the result', async t => {
  const f = fixture(t)
  let targetReady = false
  f.queue.capture(owner, () => targetReady)(task())
  await f.tick()
  assert.equal(f.sends.length, 0)
  targetReady = true
  f.setCanSend(false)
  await f.tick()
  assert.equal(f.sends.length, 0)
  f.setCanSend(true)
  f.outcomes.push('busy', 'no-composer', 'ok')
  await f.tick()
  await f.tick()
  assert.equal(f.statuses.at(-1).status, 'pending')
  await f.tick()
  assert.equal(f.sends.length, 3)
  assert.equal(f.statuses.at(-1).status, 'sent')
  assert.ok(f.sends.every(send => send.text === f.sends[0].text))
})

test('other conversations cannot receive the result; eligible tasks are not blocked by a different route', async t => {
  const f = fixture(t)
  f.setCanSend(route => route.conversationId === 'chat-b')
  f.queue.capture(owner)(task())
  f.queue.capture({ ...owner, conversationId: 'chat-b' })(task({ id: 'task-b', conversationId: 'chat-b' }))
  await f.tick()
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0].conversationId, 'chat-b')
  f.setCanSend(route => route.conversationId === 'chat-a')
  await f.tick()
  assert.equal(f.sends.length, 2)
  assert.equal(f.sends[1].conversationId, 'chat-a')
})

test('ending the task cancels both queued and future completion messages from that task generation', async t => {
  const f = fixture(t), later = f.queue.capture(owner)
  f.queue.capture(owner)(task())
  f.queue.cancel(owner)
  later(task({ id: 'late' }))
  await f.tick()
  assert.equal(f.sends.length, 0)
  assert.equal(f.statuses.at(-1).status, 'cancelled')
  f.queue.capture(owner)(task({ id: 'new-goal' }))
  await f.tick()
  assert.equal(f.sends.length, 1)
})

test('manual end cancels creation and final notifications independently', async t => {
  const f = fixture(t)
  const created = f.queue.capture(owner, () => true, 'created')
  const finished = f.queue.capture(owner)
  created(task({ status: 'checking' }))
  f.queue.cancel(owner)
  finished(task())
  await f.tick()
  assert.equal(f.sends.length, 0)
  assert.deepEqual(f.statuses.filter(item => item.status === 'cancelled').map(item => item.kind), ['created', 'finished'])
})

test('uncertain submissions require attention instead of automatically duplicating a send', async t => {
  for (const outcome of ['stuck', 'insert-failed']) {
    const f = fixture(t)
    f.outcomes.push(outcome)
    f.queue.capture(owner)(task())
    await f.tick()
    await f.tick()
    assert.equal(f.sends.length, 1)
    assert.equal(f.statuses.at(-1).status, 'needs-attention')
    assert.equal(f.timers.size, 0)
  }
})

test('disposal stops retries and ignores a late page acknowledgement', async t => {
  const f = fixture(t)
  let finish
  f.outcomes.push(() => new Promise(resolve => { finish = resolve }))
  f.queue.capture(owner)(task())
  await f.tick()
  assert.equal(f.sends.length, 1)
  f.queue.dispose()
  finish('ok')
  await settle()
  assert.equal(f.statuses.at(-1).status, 'sending')
  assert.equal(f.timers.size, 0)
})

test('failure, unknown exit codes and large logs have accurate bounded final messages', t => {
  const f = fixture(t)
  assert.match(f.build(task({ status: 'failed', exitCode: 7, errorOutput: 'compile error' })), /结果: 失败\n退出码: 7/)
  const unknown = f.build(task({ status: 'exited', exitCode: null }))
  assert.match(unknown, /退出码未知/)
  assert.doesNotMatch(unknown, /结果: 成功/)
  const large = f.build(task({ output: 'A'.repeat(65000), errorOutput: 'B'.repeat(65000), outputTruncated: true }))
  assert.ok(large.length < 14000)
  assert.match(large, /已截断/)
  assert.match(large, /完整内容见日志文件/)
})

test('background task protocol lives in tool prompts, including web2term without file reading', () => {
  const files = load('../src/shared/file-requests.ts')
  const protocol = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
  const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': protocol })
  for (const kind of ['windows', 'posix']) {
    const parts = types.buildTerminalPromptParts({ ...types.FALLBACK_ENVIRONMENT, kind }, types.toolPromptForPlatform('deepseek'))
    assert.ok(parts.basePrompt.includes('【执行方式】'))
    assert.ok(parts.basePrompt.includes('长时任务、常驻服务或需脱离终端运行时，优先使用当前可用的 background_task'))
    assert.ok(parts.basePrompt.includes('必须后台运行但工具不可用时，先询问用户'))
    assert.ok(parts.basePrompt.includes('不自行轮询或重复启动'))
    assert.ok(!parts.basePrompt.includes('【工具：background_task】'))
    assert.ok(!parts.basePrompt.includes('__W2T_BACKGROUND_TASK__'))
    assert.ok(!parts.basePrompt.includes('exit_code_path'))
    assert.ok(parts.toolPrompt.includes('【工具：background_task】'))
    assert.ok(parts.toolPrompt.includes('【工具：read_files】'))
    assert.ok(parts.toolPrompt.includes('【后台服务已就绪】'))
    assert.ok(parts.toolPrompt.includes('继续原任务'))
    assert.ok(parts.toolPrompt.includes('任务运行不限时'))
    assert.ok(parts.toolPrompt.includes('创建不代表完成'))
    assert.ok(!parts.toolPrompt.includes('按 10–30 秒'))
    assert.ok(parts.toolPrompt.includes('"background":true'))
    assert.ok(parts.toolPrompt.includes('软件负责启动、登记、日志和监控'))
    assert.ok(!parts.toolPrompt.includes('"pid": 12345'), 'the model no longer owns PID generation')
    const backgroundPrompt = parts.toolPrompt.slice(parts.toolPrompt.indexOf('【工具：background_task】'))
    assert.ok(backgroundPrompt.length <= 650, 'keep the background tool instructions compact')
    assert.ok(!backgroundPrompt.includes(protocol.BACKGROUND_TASK_MARKER), 'legacy registration stays in code, not model instructions')
    const examples = [...backgroundPrompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
    assert.equal(examples.length, 1)
    const example = JSON.parse(examples[0][1])
    assert.equal(example.background, true)
    assert.equal(example.background_kind, 'service')
    assert.ok(protocol.parseBackgroundOptions({ kind: example.background_kind, readiness: example.readiness }), 'the example must match the executable protocol')
    assert.match(backgroundPrompt, /一次性任务用 "job"，常驻服务用 "service"/)
    assert.match(backgroundPrompt, /无 stdin\/TTY/)
    assert.match(backgroundPrompt, /外层 timeout_seconds 只限启动，最多 30 秒/)
    assert.match(backgroundPrompt, /超时保留进程/)
    assert.match(backgroundPrompt, /不轮询等待或重复启动/)
    assert.match(backgroundPrompt, /目标机回环地址.*勿臆造/)
    assert.match(backgroundPrompt, /job 等【后台任务执行结果】；service 等【后台服务已就绪】后继续原任务/)
    assert.ok(parts.prefix.includes(parts.toolPrompt))
  }
  const remote = types.toolPromptForPlatform('deepseek', false)
  assert.ok(remote.includes('【工具：background_task】'))
  assert.ok(!remote.includes('【工具：read_files】'))
  assert.equal(types.toolPromptForPlatform('unsupported'), '')
})

// Exercise the actual page-side guards without constructing a DOM or browser.
const page = ts.createSourceFile('send-interceptor.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
let rawMethod
function findRaw(node) { if (ts.isMethodDeclaration(node) && node.name.getText(page) === 'sendRaw') rawMethod = node; ts.forEachChild(node, findRaw) }
findRaw(page)
assert.ok(rawMethod)
function pageFixture(patch = {}) {
  const state = { programmatic: false, awaitingReplySince: 1, replyActionDetected: false, pendingQuestion: null, taskPromptGeneration: 1, ...patch }
  const calls = [], composer = { value: '' }
  const action = new Script(`(function(${rawMethod.parameters.map(node => node.getText(page)).join(',')})${rawMethod.body.getText(page)})`).runInNewContext({
    state, location: { pathname: '/c/original' }, getComposer: () => composer,
    readComposer: element => element.value, collapse: text => text.trim(), report() {},
    findStopButton: () => null, hasDraftImageAttachment: () => false, attachmentSnapshot: () => ({}), draftAttachmentEvidence: () => false,
    normalizeLineEndings: text => text, composerMatches: (element, text) => element.value === text,
    insertText(element, text) { element.value = text; return true },
    setTimeout: () => 1, clearTimeout() {}, SEND_TIMEOUT_MS: 10000, SEND_BUTTON_GRACE_MS: 700,
    submitWithRetry(...args) { calls.push(args); args[3]('ok') }
  })
  return { state, calls, composer, action }
}
test('automatic page sends wait for replies and questions, but a settled startup command can receive its final result', async () => {
  const app = pageFixture()
  const options = { path: '/c/original', requireIdle: true }
  assert.equal(await app.action('final result', null, options), 'busy')
  app.state.replyActionDetected = true
  assert.equal(await app.action('final result', null, options), 'ok')
  assert.equal(app.calls.length, 1)
  assert.equal(app.calls[0].at(-1).path, '/c/original')
  const question = pageFixture({ pendingQuestion: { messageId: 'question' }, replyActionDetected: true })
  assert.equal(await question.action('final result', null, options), 'busy')
})
test('page guards preserve drafts and reject a changed route before inserting any result', async () => {
  const app = pageFixture({ awaitingReplySince: 0 })
  assert.equal(await app.action('final result', null, { path: '/c/wrong', requireIdle: true }), 'busy')
  assert.equal(app.composer.value, '')
  app.composer.value = 'user draft'
  assert.equal(await app.action('final result', null, { path: '/c/original', requireIdle: true }), 'busy')
  assert.equal(app.composer.value, 'user draft')
  assert.equal(app.calls.length, 0)
})

test('revoked task notifications are cancelled before sending and cannot feed a new goal', async t => {
  const f = fixture(t)
  f.queue.capture(owner)(task())
  f.setCurrent(false)
  f.queue.reconcile()
  await f.tick()
  assert.equal(f.sends.length, 0)
  assert.ok(f.statuses.some(s => s.status === 'cancelled'))
})

test('revocation aborts an in-flight send and still releases the session scheduling lock', async t => {
  const f = fixture(t)
  let resolve
  f.outcomes.push(() => new Promise(done => { resolve = done }))
  f.queue.capture(owner)(task())
  await f.tick()
  assert.equal(f.queue.isSending, true); assert.equal(f.signals[0].aborted, false)
  f.setCurrent(false); f.queue.reconcile()
  assert.equal(f.signals[0].aborted, true)
  resolve('ok'); await settle()
  assert.equal(f.queue.isSending, false); assert.equal(f.idleCount(), 1)
  assert.equal(f.delivered.length, 0)
  assert.equal(f.statuses.some(s => s.status === 'sent'), false)
})


test('global cancellation covers queued and not-yet-produced callbacks across every conversation', async t => {
  const f = fixture(t), lateA = f.queue.capture(owner), lateB = f.queue.capture({ platformId: 'deepseek', conversationId: 'chat-b' })
  f.queue.capture(owner)(task())
  f.queue.cancelAll()
  lateA(task({ id: 'late-a' })); lateB(task({ id: 'late-b', conversationId: 'chat-b' }))
  await f.tick()
  assert.equal(f.sends.length, 0)
  assert.ok(f.statuses.every(s => s.status === 'pending' || s.status === 'cancelled'))
  f.queue.capture(owner)(task({ id: 'new-user-task' }))
  await f.tick()
  assert.equal(f.sends.length, 1)
})

test('cancelling a submission preserves uncertainty, while a late positive acknowledgement only updates its original history', async t => {
  const f = fixture(t)
  let ack
  f.outcomes.push(() => new Promise(resolve => { ack = resolve }))
  f.queue.capture(owner)(task())
  await f.tick()
  f.queue.cancelAll()
  assert.equal(f.signals[0].aborted, true)
  assert.equal(f.statuses.at(-1).status, 'needs-attention')
  ack('ok'); await settle()
  assert.equal(f.statuses.at(-1).status, 'sent')
  assert.equal(f.delivered.length, 0, 'late history receipt never advances a new task')
  await f.tick()
  assert.equal(f.sends.length, 1)
})


test('a failing status journal cannot retain cancelled outbox entries or revive old callbacks', async t => {
  const f = fixture(t)
  f.setCanSend(false)
  const late = f.queue.capture(owner)
  f.queue.capture(owner)(task()); f.queue.capture({ ...owner, conversationId: 'chat-b' })(task({ id: 'second', conversationId: 'chat-b' }))
  const report = f.queue.report.bind(f.queue)
  f.queue.report = () => { throw new Error('journal unavailable') }
  assert.throws(() => f.queue.cancelAll(), /journal unavailable/)
  f.queue.report = report
  late(task({ id: 'late' }))
  f.setCanSend(true); await f.tick()
  assert.equal(f.sends.length, 0)
})
