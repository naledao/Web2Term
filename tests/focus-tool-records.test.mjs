// User-run only: node --test tests/focus-tool-records.test.mjs tests/focus-answer-layout.test.mjs
// Actual reducers/dispatchers with synthetic mail, page receipts and timers. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, Date, AbortController,
    setTimeout, clearTimeout, structuredClone, require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
      return dependencies[name]
    }, ...globals })
  return exports
}
const shared = load('../src/shared/focus-chat.ts')
const prompts = load('../src/shared/tool-prompts.ts', { './types': { fileReadingPlatform: () => ({}) } })
const scheduled = load('../src/shared/scheduled-tasks.ts')
const { FocusChat } = load('../src/main/focus-chat.ts', { 'node:crypto': { randomUUID }, '../shared/focus-chat': shared })
const { ToolPromptReads } = load('../src/main/tool-prompt-reads.ts', { '../shared/tool-prompts': prompts })
const { MailNotifications } = load('../src/main/mail-notifications.ts')
const { ScheduledTaskTools } = load('../src/main/scheduled-task-tools.ts')
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', { ...progressVmModules,
  'node:crypto': { createHash, randomUUID }, '../shared/computer-actions': load('../src/shared/computer-actions.ts') })
const { TaskProgression } = load('../src/main/task-progression.ts', { 'node:crypto': { randomUUID } })
const plain = value => JSON.parse(JSON.stringify(value))
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
const call = (messageId, value = {}) => ({ messageId, rawJson: JSON.stringify(value), conversationId: 'chat-a',
  sourceSubmissionId: 'user-a', pageEpoch: 'epoch-a' })
function fixture() {
  const rows = new Map()
  const store = {
    listFocusTurns(session, platform, conversation) { return [...rows.values()].filter(row => row.conversation === conversation).map(row => plain(row.turn)) },
    saveFocusTurn(session, platform, conversation, turn) { rows.set(turn.id, { conversation, turn: plain(turn) }) }
  }
  const chat = new FocusChat('session-a', store)
  const turnId = chat.begin('chatgpt', 'chat-a', '完成这个任务')
  const observe = tool => request => chat.observeTool('chatgpt', request.conversationId, request.messageId, tool, shared.focusToolInfo(tool, request.rawJson))
  const turn = () => chat.turns('chatgpt', 'chat-a').find(item => item.id === turnId)
  return { chat, store, rows, turnId, observe, turn }
}

function runtimeMethods(names) {
  const source = readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true)
  const runtime = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
  const exports = {}
  new Script(compile('export class Runtime {' + runtime.members.filter(node => names.includes(node.name?.getText(ast))).map(node => node.getText(ast)).join('\n') + '}'))
    .runInNewContext({ exports, ...shared, parseScheduledTaskToolRequest: scheduled.parseScheduledTaskToolRequest,
      sameConversationToolsOwner: () => true, AbortController })
  return new exports.Runtime()
}

function computerFixture(options = {}) {
  const f = fixture(), tasks = new Map(), sends = []
  const runtime = Object.assign(runtimeMethods(['recordFocusComputer', 'recordFocusComputerReceipt']), { focusChat: f.chat })
  let loop
  const coordinator = new TaskCoordinator('session-a', {
    autonomousTaskGeneration: () => tasks.size,
    latestAutonomousTask: (_session, _platform, conversation) => plain([...tasks.values()].filter(task => task.conversationId === conversation).at(-1) ?? null),
    autonomousTaskBySubmission: (_session, _platform, submission) => plain([...tasks.values()].find(task => task.inputs.some(input => input.id === submission)) ?? null),
    saveAutonomousTasks(values) { for (const task of values) tasks.set(task.id, plain(task)) }
  }, state => { runtime.recordFocusComputer(state); loop?.reconcile() })
  const submit = (patch = {}) => coordinator.submit({ platformId: 'chatgpt', conversationId: 'chat-a', turnId: f.turnId,
    submission: { id: 'user-a', kind: 'goal' }, text: '检查桌面状态', attachments: [],
    machine: { id: 'machine-a', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\work' },
    capability: { scopeSupported: true, computerUseEnabled: true, context: { sessionId: 'session-a', platformId: 'chatgpt' } }, ...patch })
  const first = submit()
  const request = messageId => {
    const task = coordinator.current('chatgpt')
    return { sessionId: 'session-a', platformId: 'chatgpt', conversationId: 'chat-a', taskId: task.id, generation: task.generation,
      sourceMessageId: messageId, call: { action: 'observe', parameters: {} } }
  }
  loop = new TaskProgression({ coordinator, isCurrent: () => true, canRun: () => true,
    invoke: options.invoke ?? (async () => ({ type: 'computer_result', version: 1, action: 'observe', ok: true, execution: 'executed', code: 'ok', message: '观察完成' })),
    send: async (...args) => { sends.push(args); return options.send ? options.send(...args) : 'ok' },
    onLateReceipt: (owner, event) => runtime.recordFocusComputerReceipt(owner, event),
    onError: () => assert.fail('Unexpected computer progression failure') })
  return { ...f, coordinator, loop, submit, first, request, sends, tasks }
}

test('all non-shell tools persist in the owning turn and cycle; duplicate observations keep one record', () => {
  const f = fixture()
  const kinds = ['read_tool_prompt', 'scheduled_task', 'send_email', 'computer']
  for (const [index, tool] of kinds.entries()) {
    const request = call('tool-' + index, { type: tool, tools: ['read_files'], action: tool === 'computer' ? 'observe' : 'list', subject: '任务通知' })
    const update = f.observe(tool)(request)
    update({ status: 'done', result: '已完成', delivery: 'sent' })
    f.observe(tool)(request)({ status: 'done' })
    f.chat.rawSent('chatgpt')
  }
  assert.equal(f.turn().toolCalls.length, 4)
  assert.deepEqual(Array.from(f.turn().toolCalls, item => item.cycle), [0, 1, 2, 3])
  assert.deepEqual(Array.from(f.turn().toolCalls, item => item.tool), kinds)
  assert.ok(f.turn().toolCalls.every(item => item.status === 'done' && item.delivery === 'sent'))
  const restored = new FocusChat('session-a', f.store).turns('chatgpt', 'chat-a')[0]
  assert.equal(restored.toolCalls.length, 4)
  assert.ok(restored.toolCalls.every(item => item.delivery === 'sent'))
})

test('a late receipt updates only its original history, never a switched conversation or its cursor', () => {
  const f = fixture(), request = call('mail', { type: 'send_email', subject: '通知' })
  const update = f.observe('send_email')(request)
  const next = f.chat.begin('chatgpt', 'chat-b', '另一个任务')
  const version = f.chat.version('chatgpt', 'chat-b')
  update({ status: 'done', delivery: 'blocked', result: 'SMTP 已接受。' })
  assert.equal(f.chat.version('chatgpt', 'chat-b'), version)
  assert.equal(f.chat.turns('chatgpt', 'chat-b').find(item => item.id === next).toolCalls, undefined)
  assert.equal(f.rows.get(f.turnId).turn.toolCalls[0].result, 'SMTP 已接受。')
  assert.equal(f.rows.get(f.turnId).conversation, 'chat-a')
  assert.equal(f.chat.observeTool('chatgpt', 'chat-a', 'stale', 'computer', { title: '旧请求', request: '' }), undefined)
})

test('a receipt after returning to its conversation refreshes the loaded record and history cursor', () => {
  const f = fixture(), update = f.observe('send_email')(call('mail', { subject: '通知' }))
  f.chat.context('chatgpt', 'chat-b')
  f.chat.context('chatgpt', 'chat-a')
  f.chat.linkUser('chatgpt', f.turnId, 'captured-after-return')
  const version = f.chat.version('chatgpt', 'chat-a')
  update({ status: 'done', delivery: 'blocked', result: 'SMTP 已接受。' })
  assert.ok(f.chat.version('chatgpt', 'chat-a') > version)
  assert.equal(f.turn().toolCalls[0].status, 'done')
  assert.equal(f.turn().userMessageId, 'captured-after-return')
  assert.equal(f.rows.get(f.turnId).turn.userMessageId, 'captured-after-return')
  assert.equal(f.chat.currentTurnId('chatgpt'), undefined, 'a receipt never resumes a restored turn')
})

for (const leaveAgain of [false, true]) test(`late observers preserve an edited branch and each other's updates (leave again: ${leaveAgain})`, () => {
  const f = fixture(), request = call('mail', { subject: '通知' })
  const result = f.observe('send_email')(request), delivery = f.observe('send_email')(request)
  f.chat.context('chatgpt', 'chat-b')
  f.chat.context('chatgpt', 'chat-a')
  const replacement = f.chat.revise('chatgpt', 'chat-a', '改后的任务', [f.turnId], ['old-message'])
  if (leaveAgain) f.chat.context('chatgpt', 'chat-b')
  const version = f.chat.version('chatgpt', leaveAgain ? 'chat-b' : 'chat-a')
  result({ status: 'done', result: 'SMTP 已接受。' })
  delivery({ delivery: 'sent' })
  const saved = f.rows.get(f.turnId).turn
  assert.equal(saved.supersededBy, replacement)
  assert.equal(saved.toolCalls[0].status, 'done')
  assert.equal(saved.toolCalls[0].result, 'SMTP 已接受。')
  assert.equal(saved.toolCalls[0].delivery, 'sent')
  if (leaveAgain) assert.equal(f.chat.version('chatgpt', 'chat-b'), version)
  else assert.ok(f.chat.version('chatgpt', 'chat-a') > version)
  assert.deepEqual(Array.from(f.chat.turns('chatgpt', 'chat-a'), turn => turn.id), [replacement])
  assert.equal(f.chat.turns('chatgpt', 'chat-a')[0].toolCalls, undefined)
  assert.deepEqual(Array.from(new FocusChat('session-a', f.store).turns('chatgpt', 'chat-a'), turn => turn.id), [replacement])
})

test('restore does not claim an interrupted call succeeded or resume its execution', () => {
  const f = fixture()
  f.observe('send_email')(call('mail', { subject: '通知' }))
  const restored = new FocusChat('session-a', f.store)
  const saved = restored.turns('chatgpt', 'chat-a')[0]
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.toolCalls[0].status, 'unknown')
  assert.equal(saved.toolCalls[0].delivery, 'blocked')
  assert.equal(restored.currentTurnId('chatgpt'), undefined)
  assert.equal(shared.validFocusToolCall(saved.toolCalls[0]), true)
})

test('a first-route tool binds a confirmed draft and long summaries remain bounded', () => {
  const f = fixture()
  f.chat.begin('deepseek', null, '新对话')
  const update = f.chat.observeTool('deepseek', 'new-chat', 'request', 'scheduled_task', { title: '创建定时任务', request: '' })
  assert.ok(update)
  update({ status: 'done', result: '结果'.repeat(10000) })
  const tool = f.chat.turns('deepseek', 'new-chat')[0].toolCalls[0]
  assert.ok(tool.result.length <= 4100)
  assert.match(tool.result, /仅保留结果摘要/)
})

test('display summaries exclude email bodies, computer input and binary observations', () => {
  const mail = shared.focusToolInfo('send_email', JSON.stringify({ subject: '任务完成', body: 'private-body' }))
  assert.equal(mail.request, '任务完成')
  assert.doesNotMatch(JSON.stringify(mail), /private-body/)
  const computer = shared.focusToolInfo('computer', JSON.stringify({ action: 'type_text', parameters: { text: 'secret-input' } }))
  assert.equal(computer.request, 'type_text')
  const update = shared.focusComputerToolUpdate({ status: 'result-ready', execution: 'executed', delivery: 'pending', message: '操作已返回',
    resultText: JSON.stringify({ ok: false, execution: 'executed', message: '目标窗口已关闭', data: { image: 'data:image/png;base64,private-image' } }) })
  assert.equal(update.status, 'failed')
  assert.doesNotMatch(JSON.stringify(update), /private-image|secret-input/)
})

test('computer delivery acknowledgements preserve a failed execution outcome after resultText is cleared', () => {
  const f = fixture(), observe = f.observe('computer')(call('desktop', { action: 'click' }))
  observe(shared.focusComputerToolUpdate({ status: 'result-ready', execution: 'executed', delivery: 'pending', message: '失败',
    resultText: JSON.stringify({ ok: false, execution: 'executed', message: '目标窗口已关闭' }) }))
  observe(shared.focusComputerToolUpdate({ status: 'delivered', execution: 'executed', delivery: 'sent', message: '目标窗口已关闭', resultText: null }))
  assert.equal(f.turn().toolCalls[0].status, 'failed')
  assert.equal(f.turn().toolCalls[0].delivery, 'sent')
})

test('old interrupted computer snapshots cannot replace a known receipt or delivery confirmation', () => {
  for (const status of ['done', 'failed', 'blocked']) {
    const f = fixture(), update = f.observe('computer')(call('desktop', { action: 'observe' }))
    update({ status, result: '已保存的真实回执', delivery: 'sent' })
    update(shared.focusComputerToolUpdate({ status: 'interrupted', execution: 'unknown', delivery: 'cancelled', message: null, resultText: null }))
    update(shared.focusComputerToolUpdate({ status: 'executing', execution: 'unknown', delivery: 'pending', message: '旧快照', resultText: null }))
    assert.equal(f.turn().toolCalls[0].status, status)
    assert.equal(f.turn().toolCalls[0].result, '已保存的真实回执')
    assert.equal(f.turn().toolCalls[0].delivery, 'sent')
  }
})

test('new computer steps after a clarification belong to its new focus turn while retaining the original task', async t => {
  const f = computerFixture()
  t.after(() => f.loop.dispose())
  f.coordinator.noteReply('chatgpt', 'question', 'question')
  f.chat.settled('chatgpt', 'question', '请确认要检查哪个窗口。')
  const answer = f.chat.begin('chatgpt', 'chat-a', '检查当前桌面。')
  const clarified = f.submit({ turnId: answer, submission: { id: 'user-answer', kind: 'clarification' }, text: '检查当前桌面。' })
  assert.equal(clarified.id, f.first.id)
  assert.equal(clarified.sourceTurnId, f.turnId, 'task provenance remains the original goal')
  assert.equal(f.loop.enqueue(f.request('after-answer')), 'accepted')
  await f.loop.wake()
  const turns = f.chat.turns('chatgpt', 'chat-a')
  assert.equal(turns.find(turn => turn.id === f.turnId).toolCalls, undefined)
  assert.equal(turns.find(turn => turn.id === f.turnId).status, 'answered')
  const current = turns.find(turn => turn.id === answer)
  assert.equal(current.toolCalls.length, 1)
  assert.equal(current.toolCalls[0].sourceMessageId, 'after-answer')
  assert.equal(current.toolCalls[0].status, 'done')
  assert.equal(current.toolCalls[0].delivery, 'sent')
})

for (const ok of [true, false]) test(`a late computer execution result updates original history only (success: ${ok})`, async t => {
  let resolve
  const f = computerFixture({ invoke: () => new Promise(done => { resolve = done }) })
  t.after(() => f.loop.dispose())
  const request = f.request('old-computer')
  assert.equal(f.loop.enqueue(request), 'accepted')
  f.coordinator.stop('chatgpt')
  f.chat.stop('chatgpt')
  const next = f.chat.begin('chatgpt', 'chat-b', '新任务')
  const version = f.chat.version('chatgpt', 'chat-b')
  resolve({ type: 'computer_result', version: 1, action: 'observe', ok, execution: 'executed', code: ok ? 'ok' : 'executor_error',
    message: ok ? '旧动作已完成' : '旧动作失败', data: { image: 'private-image' } })
  await f.loop.wake()
  const saved = f.rows.get(f.turnId).turn
  assert.equal(saved.status, 'stopped')
  assert.equal(saved.toolCalls[0].status, ok ? 'done' : 'failed')
  assert.equal(saved.toolCalls[0].result, ok ? '旧动作已完成' : '旧动作失败')
  assert.equal(saved.toolCalls[0].delivery, 'blocked')
  assert.doesNotMatch(JSON.stringify(saved), /private-image/)
  assert.equal(f.chat.version('chatgpt', 'chat-b'), version)
  assert.equal(f.chat.turns('chatgpt', 'chat-b').find(turn => turn.id === next).toolCalls, undefined)
  assert.equal(f.coordinator.current('chatgpt'), null)
  assert.equal(f.tasks.get(f.first.id).progress.currentStep.execution, 'unknown', 'display history never reactivates or rewrites task authority')
  assert.equal(f.sends.length, 0)
})

test('a late computer delivery acknowledgement updates its original call without changing a newer goal', async t => {
  let resolve
  const f = computerFixture({ send: () => new Promise(done => { resolve = done }) })
  t.after(() => f.loop.dispose())
  f.loop.enqueue(f.request('old-computer'))
  await settle()
  assert.equal(f.sends.length, 1)
  f.coordinator.stop('chatgpt')
  f.chat.stop('chatgpt')
  const next = f.chat.begin('chatgpt', 'chat-a', '新目标')
  const task = f.submit({ turnId: next, submission: { id: 'user-next', kind: 'goal' }, text: '新目标' })
  resolve('ok')
  await f.loop.wake()
  const old = f.turn()
  assert.equal(old.status, 'stopped')
  assert.equal(old.toolCalls[0].status, 'done')
  assert.equal(old.toolCalls[0].delivery, 'sent')
  assert.equal(f.chat.turns('chatgpt', 'chat-a').find(turn => turn.id === next).toolCalls, undefined)
  assert.equal(f.coordinator.current('chatgpt').id, task.id)
  assert.equal(f.coordinator.current('chatgpt').progress.currentStep, null)
  assert.equal(f.sends.length, 1)
})

test('tool-definition receipts update display status independently of delivery uncertainty', async () => {
  const f = fixture()
  const reader = new ToolPromptReads({ current: () => true, lookup: () => ({ prompt: 'FULL-DEFINITION'.repeat(100) }),
    note() {}, observe: f.observe('read_tool_prompt'), send: async () => 'unknown' })
  reader.receive(call('read', { type: 'read_tool_prompt', tools: ['read_files'] }))
  await settle()
  assert.equal(reader.busy, false)
  assert.equal(f.turn().toolCalls[0].status, 'done')
  assert.equal(f.turn().toolCalls[0].delivery, 'unknown')
  assert.doesNotMatch(f.turn().toolCalls[0].result, /FULL-DEFINITION/)
  reader.cancel()
  assert.equal(f.turn().toolCalls[0].delivery, 'unknown')
})

test('successful SMTP remains successful when its AI receipt is unknown; no automatic second email', async () => {
  const f = fixture()
  let sends = 0
  const notifications = new MailNotifications({ mail: () => ({ async sendNotification() {
    sends++; return { type: 'email_result', ok: true, status: 'sent', message: 'SMTP 已接受。' }
  } }), current: () => true, note() {}, observe: f.observe('send_email'), send: async () => 'unknown' })
  const request = call('mail', { type: 'send_email', subject: '任务完成', body: 'private-body' })
  notifications.receive(request, 'key'); notifications.receive(request, 'key')
  await settle()
  assert.equal(sends, 1)
  assert.equal(f.turn().toolCalls[0].status, 'done')
  assert.equal(f.turn().toolCalls[0].delivery, 'unknown')
  assert.doesNotMatch(JSON.stringify(f.rows.get(f.turnId)), /private-body/)
})

test('cancelled SMTP may later return a known result without sending a receipt into the new conversation', async () => {
  const f = fixture()
  let resolve, receipts = 0
  const notifications = new MailNotifications({ mail: () => ({ sendNotification() { return new Promise(done => { resolve = done }) } }),
    current: () => true, note() {}, observe: f.observe('send_email'), send: async () => { receipts++; return 'ok' } })
  notifications.receive(call('mail', { type: 'send_email', subject: '通知', body: '内容' }), 'key')
  notifications.cancel()
  f.chat.begin('chatgpt', 'chat-b', '新任务')
  resolve({ type: 'email_result', ok: true, status: 'sent', message: 'SMTP 已接受。' })
  await settle()
  assert.equal(receipts, 0)
  assert.equal(f.rows.get(f.turnId).turn.toolCalls[0].status, 'done')
  assert.equal(f.rows.get(f.turnId).turn.toolCalls[0].delivery, 'blocked')
})

test('a late confirmed receipt updates the original record without reopening or modifying a newer turn', async () => {
  const f = fixture()
  let resolve
  const reader = new ToolPromptReads({ current: () => true, lookup: () => ({ prompt: '说明' }), note() {}, observe: f.observe('read_tool_prompt'),
    send: () => new Promise(done => { resolve = done }) })
  reader.receive(call('read', { type: 'read_tool_prompt', tools: ['read_files'] }))
  reader.cancel()
  assert.equal(f.turn().toolCalls[0].delivery, 'unknown')
  const next = f.chat.begin('chatgpt', 'chat-a', '新目标')
  resolve('ok')
  await settle()
  assert.equal(f.turn().toolCalls[0].delivery, 'sent')
  assert.equal(f.chat.turns('chatgpt', 'chat-a').find(item => item.id === next).toolCalls, undefined)
})

test('scheduled-management delivery retries do not execute the management operation again', async () => {
  const f = fixture(), timers = []
  let executions = 0, deliveries = 0
  const tools = new ScheduledTaskTools({ current: () => true, observe: f.observe('scheduled_task'), note() {},
    send: async () => ++deliveries === 1 ? 'busy' : 'ok',
    schedule(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer }, cancel() {} })
  tools.receive(call('delete', { type: 'scheduled_task', action: 'delete', id: 'task', revision: 1 }), () => {
    executions++; return '【定时任务已删除】\n任务编号：task'
  })
  await settle()
  assert.equal(f.turn().toolCalls[0].delivery, 'pending')
  timers.shift().callback()
  await settle()
  assert.equal(executions, 1)
  assert.equal(deliveries, 2)
  assert.equal(f.turn().toolCalls[0].status, 'done')
  assert.equal(f.turn().toolCalls[0].delivery, 'sent')
})

for (const tool of ['read_tool_prompt', 'send_email', 'scheduled_task']) {
  for (const outcome of ['busy', 'no-composer']) test(`${tool} stops waiting after 60 ${outcome} receipts without re-executing`, async t => {
    const f = fixture(), timers = new Set()
    const globals = { setTimeout(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer },
      clearTimeout(timer) { timers.delete(timer) } }
    let deliveries = 0, executions = 0
    const deps = { current: () => true, observe: f.observe(tool), note() {}, send: async () => { deliveries++; return outcome } }
    let subject
    if (tool === 'read_tool_prompt') {
      const { ToolPromptReads: Subject } = load('../src/main/tool-prompt-reads.ts', { '../shared/tool-prompts': prompts }, globals)
      subject = new Subject({ ...deps, lookup: () => { executions++; return { prompt: '工具说明' } } })
      subject.receive(call('retry', { type: tool, tools: ['read_files'] }))
    } else if (tool === 'send_email') {
      const { MailNotifications: Subject } = load('../src/main/mail-notifications.ts', {}, globals)
      subject = new Subject({ ...deps, mail: () => ({ async sendNotification() { executions++; return { ok: true, status: 'sent', message: 'SMTP 已接受。' } } }) })
      subject.receive(call('retry', { type: tool, subject: '通知' }), 'source')
    } else {
      const { ScheduledTaskTools: Subject } = load('../src/main/scheduled-task-tools.ts', {}, globals)
      subject = new Subject(deps)
      subject.receive(call('retry', { type: tool, action: 'delete', id: 'plan' }), () => { executions++; return '【定时任务已删除】\n任务编号：plan' })
    }
    t.after(() => subject.cancel())
    await settle()
    for (let attempt = 1; attempt < 60; attempt++) {
      assert.equal(f.turn().toolCalls[0].delivery, 'pending')
      assert.equal(timers.size, 1)
      const timer = [...timers][0]; timers.delete(timer); timer.callback()
      await settle()
    }
    assert.equal(deliveries, 60)
    assert.equal(executions, 1)
    assert.equal(subject.busy, false)
    assert.equal(timers.size, 0)
    assert.equal(f.turn().toolCalls[0].status, 'done')
    assert.equal(f.turn().toolCalls[0].delivery, 'failed')
    assert.equal(new FocusChat('session-a', f.store).turns('chatgpt', 'chat-a')[0].toolCalls[0].delivery, 'failed')
  })
}

test('runtime records plan creation and matches its later receipt by the original model source key', () => {
  const f = fixture()
  const names = ['observeFocusTool', 'recordFocusScheduledReceipt', 'receiveScheduledTask']
  let task
  const instance = Object.assign(runtimeMethods(names), { id: 'session-a', active: true, disposed: false, activePlatformId: 'chatgpt', taskEnded: false,
    focusChat: f.chat, lastSubmissions: new Map([['chatgpt', 'user-a']]),
    options: { scheduledTasks: { create(owner, target, input, sourceKey) { return task = { id: 'plan', nextRunAt: Date.now() + 60000, owner, sourceKey } } } },
    embed: { getState: () => ({ conversationId: 'chat-a' }), getComputerUsePageEpoch: () => 'epoch-a' },
    runner: { getAutomation: () => ({ paused: false }), refreshTerminal() {} }, toolPreferences: () => ({ scheduledTasksEnabled: true }),
    scheduledTarget: () => ({}), toolsOwner: () => ({ sessionId: 'session-a', platformId: 'chatgpt', conversationId: 'chat-a' }) })
  instance.receiveScheduledTask(call('create', { type: 'scheduled_task', schedule: { kind: 'interval', minutes: 5 }, prompt: '检查状态' }))
  assert.equal(f.turn().toolCalls[0].status, 'done')
  assert.equal(f.turn().toolCalls[0].delivery, 'pending')
  instance.recordFocusScheduledReceipt(task, 'ok')
  assert.equal(f.turn().toolCalls[0].delivery, 'sent')
})
