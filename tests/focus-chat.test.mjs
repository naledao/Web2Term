// User-run only: node --test tests/focus-chat.test.mjs
// Exercises the actual turn reducer with an in-memory store. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  new Script(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, Date, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/focus-chat.ts')
const { FocusChat } = load('../src/main/focus-chat.ts', {
  'node:crypto': { randomUUID }, '../shared/focus-chat': shared
})
const clone = value => JSON.parse(JSON.stringify(value))
function fixture(sessionId = 'workspace-1') {
  const rows = new Map()
  const store = {
    blocked: false,
    listFocusTurns(session, platform, conversation) {
      return [...rows.values()].filter(row => row.owner === JSON.stringify([session, platform, conversation])).map(row => clone(row.turn))
    },
    saveFocusTurn(session, platform, conversation, turn) {
      if (this.blocked) throw new Error('conversation not inserted yet')
      rows.set(turn.id, { owner: JSON.stringify([session, platform, conversation]), turn: clone(turn) })
    }
  }
  return { chat: new FocusChat(sessionId, store), store, rows }
}
const page = (id, answer, parts = []) => ({ path: '/a/chat/s/chat-1', ready: true, nativeDraft: false,
  waiting: true, generating: 'active', reply: { sourceMessageId: id, answer, parts } })
const onlyTurn = chat => chat.turns('deepseek', 'chat-1')[0]

test('unexecuted malformed requests are persisted outside the shell queue with actionable recovery state', () => {
  const { chat, store } = fixture()
  chat.begin('deepseek', 'chat-1', '登录 GitHub')
  const failure = { messageId: 'bad-1', text: '{"command":"gh auth login","background":"true"}', parseErrorCode: 'invalid-background' }
  chat.parseFailed('deepseek', failure)
  chat.parseFailed('deepseek', failure)
  assert.equal(onlyTurn(chat).status, 'blocked')
  assert.equal(onlyTurn(chat).executionIds.length, 0)
  assert.equal(onlyTurn(chat).parseFailures.length, 1)
  const recovery = { messageId: 'bad-1', token: 1, generation: 0, status: 'sent', message: 'Waiting for corrected request' }
  chat.commandRecovery('deepseek', recovery)
  assert.equal(onlyTurn(chat).status, 'working')
  assert.equal(onlyTurn(chat).commandRecovery.status, 'sent')
  const restored = new FocusChat('workspace-1', store)
  const turn = onlyTurn(restored)
  assert.equal(turn.parseFailures[0].text, failure.text)
  assert.equal(turn.commandRecovery.status, 'blocked')
  assert.equal(turn.executionIds.length, 0)
})

test('valid corrected commands clear recovery notices while retaining the unexecuted request history', () => {
  const { chat } = fixture()
  chat.begin('deepseek', 'chat-1', '登录 GitHub')
  chat.parseFailed('deepseek', { messageId: 'bad-1', text: 'bad request', parseErrorCode: 'invalid-json' })
  chat.commandRecovery('deepseek', { messageId: 'bad-1', token: 1, generation: 0, status: 'failed', message: 'Correction failed' })
  assert.equal(onlyTurn(chat).status, 'blocked')
  chat.command('deepseek', 'correct-1', true)
  assert.equal(onlyTurn(chat).notice, undefined)
  assert.equal(onlyTurn(chat).commandRecovery, undefined)
  assert.equal(onlyTurn(chat).parseFailures.length, 1)
  assert.deepEqual([...onlyTurn(chat).executionIds], ['correct-1'])
})

test('hides only an explicit injected prefix and preserves genuine user wording', () => {
  assert.equal(shared.cleanFocusUserText('SYSTEM\u0000\u0001真正的问题\n第二行'), '真正的问题\n第二行')
  assert.equal(shared.cleanFocusUserText('上一条命令执行结果是什么意思？'), '上一条命令执行结果是什么意思？')
  assert.equal(shared.cleanFocusAnswer('【任务完成】\n**完成**'), '**完成**')
  assert.equal(shared.cleanFocusAnswer('文中引用【任务完成】'), '文中引用【任务完成】')
})

test('multiple commands, internal deliveries and final prose belong to one human turn', () => {
  const { chat, rows } = fixture()
  const id = chat.begin('deepseek', 'chat-1', '修改聊天视图')
  chat.linkUser('deepseek', id, 'human-row')
  chat.snapshot('deepseek', chat.token('deepseek'), page('command-1', '', [{ kind: 'reasoning', text: '检查结构' }]))
  chat.command('deepseek', 'command-1', true)
  chat.delivery('deepseek', 'chat-1', 'command-1', 'sent')
  chat.rawSent('deepseek')
  chat.command('deepseek', 'command-2', true)
  chat.delivery('deepseek', 'chat-1', 'command-2', 'blocked')
  chat.delivery('deepseek', 'chat-1', 'command-2', 'sent')
  chat.rawSent('deepseek')
  chat.settled('deepseek', 'final', '【任务完成】\n新的视图已完成。')
  const turn = onlyTurn(chat)
  assert.equal(chat.turns('deepseek', 'chat-1').length, 1)
  assert.equal(turn.userMessageId, 'human-row')
  assert.deepEqual(Array.from(turn.executionIds), ['command-1', 'command-2'])
  assert.deepEqual(clone(turn.executionCycles), { 'command-1': 0, 'command-2': 1 })
  assert.equal(turn.segments.at(-1).answer, '新的视图已完成。')
  assert.equal(turn.status, 'answered')
  assert.equal(rows.get(id).owner, JSON.stringify(['workspace-1', 'deepseek', 'chat-1']))
  assert.equal(rows.get(id).turn.deliveries['command-2'], 'sent')
})

test('settled Markdown wins over a late stream while final reasoning can finish', () => {
  const { chat } = fixture()
  chat.begin('deepseek', 'chat-1', '说明结果')
  const token = chat.token('deepseek')
  chat.settled('deepseek', 'answer', '**最终正文**')
  chat.snapshot('deepseek', token, page('answer', '旧的片段', [{ kind: 'reasoning', text: '最后的思考' }]))
  assert.equal(onlyTurn(chat).segments[0].answer, '**最终正文**')
  assert.equal(onlyTurn(chat).segments[0].parts[0].text, '最后的思考')
  chat.snapshot('deepseek', token, page('older-history', '错误正文', [{ kind: 'reasoning', text: '错误的思考' }]))
  assert.equal(onlyTurn(chat).segments[0].parts[0].text, '最后的思考')
})

test('stale poll tokens and history commands cannot attach to another cycle or chat', () => {
  const { chat } = fixture()
  chat.begin('deepseek', 'chat-1', '第一轮')
  const token = chat.token('deepseek')
  chat.command('deepseek', 'old-history', false)
  assert.equal(onlyTurn(chat).executionIds.length, 0)
  chat.rawSent('deepseek')
  chat.snapshot('deepseek', token, page('stale', '不应出现'))
  assert.equal(onlyTurn(chat).segments.length, 0)
  chat.context('deepseek', 'chat-2')
  chat.snapshot('deepseek', token, page('stale', '不应串会话'))
  assert.equal(chat.turns('deepseek', 'chat-2').length, 0)
  chat.delivery('deepseek', 'chat-1', 'old-history', 'sent')
  assert.equal(chat.begin('chatgpt', 'chat-1', '另一平台'), undefined)
})

test('home-to-conversation binding survives the conversation insert race', () => {
  const { chat, store, rows } = fixture()
  store.blocked = true
  const id = chat.begin('deepseek', null, '从首页开始')
  chat.linkUser('deepseek', id, 'human')
  chat.context('deepseek', 'chat-1')
  chat.flush()
  assert.equal(rows.size, 0)
  store.blocked = false
  chat.flush()
  assert.equal(rows.get(id).turn.userMessageId, 'human')
  assert.equal(rows.get(id).turn.userText, '从首页开始')
  assert.equal(chat.ownsTurn('deepseek', id), true)
  chat.context('deepseek', 'chat-2')
  assert.equal(chat.ownsTurn('deepseek', id), false)
})

test('end-task and restored history cannot be resurrected by late events', () => {
  const { chat, store } = fixture()
  chat.begin('deepseek', 'chat-1', '进行中的任务')
  chat.parseFailed('deepseek')
  assert.equal(onlyTurn(chat).notice, 'parse-failed')
  const token = chat.token('deepseek')
  chat.stop('deepseek')
  chat.rawSent('deepseek')
  chat.command('deepseek', 'late-command', true)
  chat.settled('deepseek', 'late-answer', '已结束后到达')
  chat.snapshot('deepseek', token, page('late', '旧片段'))
  assert.equal(onlyTurn(chat).status, 'stopped')
  assert.equal(onlyTurn(chat).segments.length, 0)
  chat.begin('deepseek', 'chat-1', '另一个任务')
  const restored = new FocusChat('workspace-1', store)
  assert.equal(restored.turns('deepseek', 'chat-1').at(-1).status, 'stopped')
  const anotherWorkspace = new FocusChat('workspace-2', store)
  assert.equal(anotherWorkspace.turns('deepseek', 'chat-1').length, 0)
})

test('one platform switch decides where the focus view exists: DeepSeek and ChatGPT', () => {
  for (const id of ['deepseek', 'chatgpt']) assert.equal(shared.supportsFocusView(id), true, id)
  for (const id of ['claude', 'gemini', 'toString', '']) assert.equal(shared.supportsFocusView(id), false, id)
  assert.equal(shared.focusPlatformLabel('chatgpt'), 'ChatGPT')
  assert.equal(shared.focusPlatformLabels(), 'DeepSeek、ChatGPT')
  const { chat } = fixture()
  assert.equal(chat.begin('claude', 'chat-1', '不应建立专注轮次'), undefined)
  assert.equal(chat.turns('claude', 'chat-1').length, 0)
  assert.equal(typeof chat.begin('chatgpt', 'chat-1', 'ChatGPT 专注轮次'), 'string')
})

test('after a restart the interrupted turn resumes once the task shows it is still running', () => {
  const { chat, store } = fixture()
  chat.begin('deepseek', 'chat-1', '进行中的任务')
  chat.command('deepseek', 'cmd-1', true)
  const restarted = new FocusChat('workspace-1', store)
  assert.equal(restarted.turns('deepseek', 'chat-1').at(-1).status, 'stopped', 'restored work is history until proven live')
  // A restored, non-live command is history and does not resume anything.
  restarted.command('deepseek', 'old-command', false)
  assert.equal(restarted.turns('deepseek', 'chat-1').at(-1).status, 'stopped')
  restarted.rawSent('deepseek')
  restarted.command('deepseek', 'cmd-2', true)
  const turn = restarted.turns('deepseek', 'chat-1').at(-1)
  assert.equal(turn.status, 'working')
  assert.deepEqual(turn.executionIds, ['cmd-1', 'cmd-2'])
  assert.ok(turn.executionCycles['cmd-2'] > turn.executionCycles['cmd-1'], 'resumed steps never share the old cycle')
  restarted.settled('deepseek', 'answer-1', '任务完成')
  assert.equal(restarted.turns('deepseek', 'chat-1').at(-1).status, 'answered')
})

test('a turn the user ended stays stopped across a restart, whatever the page does', () => {
  const { chat, store } = fixture()
  chat.begin('deepseek', 'chat-1', '进行中的任务')
  chat.stop('deepseek')
  const restarted = new FocusChat('workspace-1', store)
  restarted.turns('deepseek', 'chat-1')
  restarted.rawSent('deepseek')
  restarted.command('deepseek', 'cmd-1', true)
  assert.equal(restarted.turns('deepseek', 'chat-1').at(-1).status, 'stopped')
  assert.deepEqual(restarted.turns('deepseek', 'chat-1').at(-1).executionIds, [])
})

test('a re-rendered history answer replaces only the saved prose of that same answer', () => {
  const { chat, store } = fixture()
  chat.begin('chatgpt', 'chat-1', '画一张图')
  chat.settled('chatgpt', 'msg-chart', 'CPU内存0%25%50%1234')
  chat.begin('chatgpt', 'chat-1', '执行命令')
  chat.command('chatgpt', 'msg-command', true)
  const restarted = new FocusChat('workspace-1', store)
  restarted.refreshAnswer('chatgpt', 'chat-1', 'msg-chart', '> 📊 **图表**\n> - 1: 20%')
  restarted.refreshAnswer('chatgpt', 'chat-1', 'msg-command', '不应写入命令段')
  restarted.refreshAnswer('chatgpt', 'chat-1', 'msg-unknown', '无关回答')
  const turns = new FocusChat('workspace-1', store).turns('chatgpt', 'chat-1')
  assert.equal(turns[0].segments[0].answer, '> 📊 **图表**\n> - 1: 20%', 'saved, so it survives another restart')
  assert.equal(turns[1].segments[0].answer, '', 'a command segment stays a command')
  assert.equal(turns.length, 2)
})

test('persisted file-upload status takes precedence over shell delivery state', () => {
  assert.equal(shared.focusDelivery({ kind: 'read_files', deliveryStatus: 'sent' }, 'pending'), 'sent')
  assert.equal(shared.focusDelivery({ kind: 'read_files', deliveryStatus: 'unknown' }, 'pending'), 'failed')
  assert.equal(shared.focusDelivery({ kind: 'read_files', deliveryStatus: 'cancelled' }, 'pending'), undefined)
  assert.equal(shared.focusDelivery({ kind: 'command' }, 'blocked'), 'blocked')
})

test('attachment payloads are bounded and cannot request arbitrary local file paths', () => {
  const file = { fileName: '截图.png', mimeType: 'image/png', sizeBytes: 3, dataBase64: 'YWJj' }
  assert.equal(shared.validFocusFiles([file]), true)
  assert.equal(shared.validFocusFiles([]), true)
  for (const fileName of ['../secret.txt', 'C:\\secret.txt', 'nested/file.txt', '\u0000image.png']) {
    assert.equal(shared.validFocusFiles([{ ...file, fileName }]), false)
  }
  assert.equal(shared.validFocusFiles(Array(4).fill(file)), false)
  assert.equal(shared.validFocusFiles([{ ...file, sizeBytes: shared.FOCUS_MAX_FILE_BYTES + 1 }]), false)
  assert.equal(shared.validFocusFiles([{ ...file, dataBase64: 'not base64' }]), false)
  assert.equal(shared.validFocusFiles([{ ...file, sizeBytes: 0, dataBase64: '' }]), false)
})

test('a file-only human turn persists attachment metadata without an internal result bubble', () => {
  const { chat, rows } = fixture()
  const files = [{ fileName: '资料.pdf', mimeType: 'application/pdf', sizeBytes: 1234 }]
  const id = chat.begin('deepseek', 'chat-1', '', files)
  chat.settled('deepseek', 'answer', '已阅读附件。')
  assert.equal(onlyTurn(chat).userText, '')
  assert.deepEqual(clone(onlyTurn(chat).userAttachments), files)
  assert.deepEqual(rows.get(id).turn.userAttachments, files)
  assert.equal(chat.turns('deepseek', 'chat-1').length, 1)
})
