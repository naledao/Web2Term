// User-run only: node --test tests/focus-tool-records.test.mjs tests/focus-answer-layout.test.mjs
// Actual reducers/dispatchers with synthetic mail, page receipts and timers. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, Date, AbortController,
    setTimeout, clearTimeout, structuredClone, require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
      return dependencies[name]
    } })
  return exports
}
const shared = load('../src/shared/focus-chat.ts')
const prompts = load('../src/shared/tool-prompts.ts', { './types': { fileReadingPlatform: () => ({}) } })
const scheduled = load('../src/shared/scheduled-tasks.ts')
const { FocusChat } = load('../src/main/focus-chat.ts', { 'node:crypto': { randomUUID }, '../shared/focus-chat': shared })
const { ToolPromptReads } = load('../src/main/tool-prompt-reads.ts', { '../shared/tool-prompts': prompts })
const { MailNotifications } = load('../src/main/mail-notifications.ts')
const { ScheduledTaskTools } = load('../src/main/scheduled-task-tools.ts')
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

test('runtime records plan creation and matches its later receipt by the original model source key', () => {
  const f = fixture(), source = readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('runtime.ts', source, ts.ScriptTarget.Latest, true)
  const runtime = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
  const names = ['observeFocusTool', 'recordFocusScheduledReceipt', 'receiveScheduledTask']
  const exports = {}
  new Script(compile('export class Runtime {' + runtime.members.filter(node => names.includes(node.name?.getText(ast))).map(node => node.getText(ast)).join('\n') + '}'))
    .runInNewContext({ exports, ...shared, parseScheduledTaskToolRequest: scheduled.parseScheduledTaskToolRequest,
      sameConversationToolsOwner: () => true, AbortController })
  let task
  const instance = Object.assign(new exports.Runtime(), { id: 'session-a', active: true, disposed: false, activePlatformId: 'chatgpt', taskEnded: false,
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
