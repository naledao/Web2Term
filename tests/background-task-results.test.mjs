// User-run offline regressions: node --test tests/background-task-results.test.mjs
// Fake timers, send callbacks and page state only; no Electron, browser or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

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
  const timers = new Set(), sends = [], statuses = [], outcomes = []
  let canSend = true
  const exports = {}
  new Script(compile(resultSource)).runInNewContext({ exports,
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer) }
  })
  const queue = new exports.BackgroundTaskResults({
    canSend: route => typeof canSend === 'function' ? canSend(route) : canSend,
    async send(text, route) { sends.push({ text, ...route }); const value = outcomes.shift(); return typeof value === 'function' ? value() : value ?? 'ok' },
    onStatus: (id, status, message, kind) => statuses.push({ id, status, message, kind })
  })
  t.after(() => queue.dispose())
  return { queue, sends, statuses, outcomes, timers, build: exports.buildBackgroundTaskResult,
    setCanSend(value) { canSend = value },
    async tick() { const pending = [...timers]; timers.clear(); for (const timer of pending) timer.callback(); await settle() }
  }
}

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
  assert.equal(f.statuses.at(-1).status, 'pending')
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
  const protocol = load('../src/shared/background-tasks.ts')
  const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': protocol })
  for (const kind of ['windows', 'posix']) {
    const parts = types.buildTerminalPromptParts({ ...types.FALLBACK_ENVIRONMENT, kind }, types.toolPromptForPlatform('deepseek'))
    assert.ok(parts.basePrompt.includes('【执行方式】'))
    assert.ok(parts.basePrompt.includes('预计超过 2 分钟'))
    assert.ok(parts.basePrompt.includes('使用 background_task 工具创建后台任务'))
    assert.ok(parts.basePrompt.includes('不要自行发送命令轮询'))
    assert.ok(!parts.basePrompt.includes('【工具：background_task】'))
    assert.ok(!parts.basePrompt.includes('__W2T_BACKGROUND_TASK__'))
    assert.ok(!parts.basePrompt.includes('exit_code_path'))
    assert.ok(parts.toolPrompt.includes('【工具：background_task】'))
    assert.ok(parts.toolPrompt.includes('【工具：read_files】'))
    assert.ok(parts.toolPrompt.includes('收到创建通知只简短确认并等待'))
    assert.ok(parts.toolPrompt.includes('【后台任务已创建】'))
    assert.ok(!parts.toolPrompt.includes('按 10–30 秒'))
    assert.ok(parts.toolPrompt.includes('```json\n{\n  "pid"'))
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
