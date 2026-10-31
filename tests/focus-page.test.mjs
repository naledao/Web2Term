// User-run only: node --test tests/focus-page.test.mjs
// The actual injected public methods run against synthetic page collaborators.
// No Electron, real browser session, screenshots, files written or network calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script, createContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
// The page reads come from the platform's measured focus rules, as in the app.
const platformExports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: platformExports, require: () => ({ isConversationId: () => true }) })
const { CHATGPT_PAGE, DEEPSEEK_PAGE } = platformExports
const file = ts.createSourceFile('send-interceptor.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function find(predicate, node = file) {
  if (predicate(node)) return node
  return ts.forEachChild(node, child => find(predicate, child))
}
function method(name, context) {
  const node = find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === name)
  assert.ok(node, 'Missing actual injected method: ' + name)
  return new Script('(function ' + node.getText(file) + ')').runInContext(context)
}
function arrow(name, context) {
  const node = find(node => ts.isVariableDeclaration(node) && node.name.getText(file) === name)
  assert.ok(node?.initializer)
  return new Script('(' + node.initializer.getText(file) + ')').runInContext(context)
}
const USER_TEXT_SENTINEL = arrow('USER_TEXT_SENTINEL', createContext({}))
function fixture() {
  const composer = { draft: '' }, calls = [], reports = []
  const context = createContext({
    Date, URL, Promise, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    location: { pathname: '/a/chat/s/one', href: 'https://chat.deepseek.com/a/chat/s/one' },
    state: { enabled: true, promptInjectionEnabled: true, prefix: 'SYSTEM\n\n', taskPromptInjected: false,
      replyProtocolPrefix: 'SHORT\n\n', replyProtocolVersion: 1, prefixIncludesReplyProtocol: true, replyProtocolFullLength: 6,
      injectedCount: 0, taskPromptGeneration: 1, programmatic: false, awaitingReplySince: 0, pendingQuestion: null },
    USER_TEXT_SENTINEL, SEND_TIMEOUT_MS: 6000, SEND_BUTTON_GRACE_MS: 500,
    fileSend: null, computerResultToken: null, scopedUserSend: null, userTurns: () => [], focusEditing: null, focusEditExcludedIds: new Set(), focusReplyBaseline: null, focusBaselinePosition: null, focusReplyPosition: null,
    getComposer: () => composer, collapse: text => String(text).replace(/\s+/g, ' ').trim(),
    readComposer: node => node.draft, findStopButton: () => null,
    attachmentSnapshot: () => ({}), draftAttachmentEvidence: () => false, hasDraftImageAttachment: () => false,
    normalizeLineEndings: text => text.replace(/\r\n?/g, '\n'),
    insertText(node, text) { node.draft = text; return true },
    composerMatches: (node, text) => node.draft === text,
    submitWithRetry(...args) { calls.push(args) }, report: item => reports.push(item),
    composerToolbarControls: () => [], queryAllAssistant: () => [], isAssistantTurn: () => true,
    latestReplyNode: nodes => nodes.at(-1), turnKeyOf: node => node.id,
    readReplyText: node => node.body || '', readReplyMarkdown: node => node.markdown || '', smartUiCardsOf: () => [], smartUiLayoutsOf: () => [], focusComposerModesOf: () => [],
    focusModelSettingsOf: () => ({ model: null, effort: null, models: [], efforts: [] }),
    focusModelPickerParts: () => null,
    extractCommand: () => null, PAGE: DEEPSEEK_PAGE,
    queryAll: () => [], isVisibleElement: () => true, focusSendFailureOf: () => null
  })
  for (const name of ['looksLikeReadFilesReply', 'looksLikeQuestionReply', 'looksLikeCommandReply', 'focusRowPosition', 'focusReplyAnchor', 'conversationPromptInHistory', 'userPromptInjection', 'reportUserInjection']) context[name] = arrow(name, context)
  return { context, composer, calls, reports, send: method('sendUser', context), snapshot: method('focusSnapshot', context) }
}

test('cancelling a dialog send stops actual retries and clears only its own draft', async () => {
  for (const attempted of [false, true]) {
    for (const edited of [false, true]) {
      const f = fixture()
      const controller = { sendUser: f.send, sendScopedUser: method('sendScopedUser', f.context), cancelScopedUser: method('cancelScopedUser', f.context) }
      const pending = controller.sendScopedUser('install on the approved remote', '/a/chat/s/one', 'approval-a')
      const call = f.calls[0], context = call.at(-1)
      context.scope.attempted = attempted
      if (edited) f.composer.draft = '用户自己的新草稿'
      controller.cancelScopedUser('unrelated-approval')
      assert.equal(context.scope.cancelled, false)
      controller.cancelScopedUser('approval-a')
      assert.equal(f.composer.draft, edited ? '用户自己的新草稿' : '')
      Object.assign(f.context, {
        lastAssistantId: () => null, computerBaselineOf: () => ({}), discardUserImageCapture() {},
        findSendButton() { assert.fail('cancelled approval must never reach another click') }
      })
      // A later send may now own the page; an old callback must leave it alone.
      f.context.state.programmatic = true
      let outcome
      arrow('submitWithRetry', f.context)(call[0], 0, false, value => { outcome = value }, 0, 0, 0, null, context)
      assert.equal(outcome, attempted ? 'stuck' : 'cancelled')
      assert.equal(f.context.state.programmatic, true)
      assert.equal(f.reports.some(report => report.event === 'user-message'), false)
      call[3](outcome)
      assert.equal(await pending, outcome)
    }
  }
})

test('a scoped first send allows its new chat id, while an existing chat stays pinned', async () => {
  for (const allowNewConversation of [false, true]) {
    const f = fixture()
    const controller = { sendUser: f.send, sendScopedUser: method('sendScopedUser', f.context) }
    const pending = controller.sendScopedUser('install rg', '/a/chat/s/one', 'approval-a', allowNewConversation)
    const call = f.calls[0]
    assert.equal(call.at(-1).path, allowNewConversation ? undefined : '/a/chat/s/one')
    call[3]('ok')
    assert.equal(await pending, 'ok')
    assert.equal(f.context.scopedUserSend, null)
  }
})

test('the read-only focus snapshot exposes a later native send rejection and clears it when recovered', () => {
  const f = fixture()
  const failure = { id: 'failed-user', message: '消息发送过于频繁，请稍后重试', retryable: true }
  f.context.focusSendFailureOf = () => ({ data: failure })
  assert.equal(f.snapshot().sendFailure, failure)
  f.context.focusSendFailureOf = () => null
  assert.equal(f.snapshot().sendFailure, null)
  assert.equal(f.calls.length, 0)
})

test('a new ChatGPT composer can be ready before its model trigger without requesting any native input', () => {
  const f = fixture()
  f.context.PAGE = CHATGPT_PAGE
  let mounted = false, disabled = false
  f.context.focusModelPickerParts = () => mounted ? { trigger: {} } : null
  f.context.controlDisabled = () => disabled
  assert.equal(f.snapshot().ready, true)
  assert.equal(f.snapshot().modelSettingsReady, false)
  mounted = true
  assert.equal(f.snapshot().modelSettingsReady, true)
  disabled = true
  assert.equal(f.snapshot().modelSettingsReady, false, 'a still-loading trigger must not start the automatic menu read')
  assert.equal(f.calls.length, 0)
  assert.equal(f.reports.length, 0)
})

test('the user-text boundary uses invisible separators and still reads legacy messages without changing user wording', () => {
  const f = fixture(), read = arrow('userTextOf', f.context)
  const text = '把【已完成】加到文档里\n  保留缩进和第二行'
  assert.equal(USER_TEXT_SENTINEL, '\u2063\u2063')
  for (const marker of [USER_TEXT_SENTINEL, '\u0000\u0001']) {
    assert.equal(read('【角色】提示词\n【工具】说明\n' + marker + text), text)
  }
  assert.equal(read(text), text)
})

test('app composer preserves multiline input and waits for confirmed user-send outcome', async () => {
  const f = fixture()
  let resolved = false
  const pending = f.send('第一行\r\n第二行', '/a/chat/s/one').then(value => { resolved = true; return value })
  assert.equal(resolved, false)
  assert.equal(f.composer.draft, 'SYSTEM\n\n' + USER_TEXT_SENTINEL + '第一行\n第二行')
  assert.doesNotMatch(f.composer.draft, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][2], false, 'must use the human-send path, not sendRaw')
  assert.equal(f.reports[0].event, 'injected')
  f.calls[0][3]('ok')
  assert.equal(await pending, 'ok')
  f.context.state.programmatic = false
  f.context.state.taskPromptInjected = true
  f.composer.draft = ''
  const next = f.send('继续', '/a/chat/s/one')
  assert.equal(f.calls[1][0], 'SHORT\n\n' + USER_TEXT_SENTINEL + '继续')
  assert.equal(f.calls[1].at(-1).promptInjected, false, 'the short reminder must not commit another environment plan')
  assert.equal(f.calls[1].at(-1).replyProtocolKind, 'short')
  assert.equal(f.context.state.taskPromptGeneration, 1, 'reminding does not create a new task boundary')
  f.calls[1][3]('stuck')
  assert.equal(await next, 'stuck')
})

test('a scheduled send includes system and tool prompts when the conversation has no prior injection', async () => {
  const f = fixture()
  f.context.state.prefix = 'SYSTEM\n\nTOOLS\n\n'
  const send = method('sendScheduledUser', f.context)
  const pending = send.call({ sendUser: f.send }, '检查 GPU 温度', '/a/chat/s/one', 'run-first', false)
  assert.equal(f.calls[0][0], 'SYSTEM\n\nTOOLS\n\n' + USER_TEXT_SENTINEL + '检查 GPU 温度')
  assert.equal(f.calls[0].at(-1).promptInjected, true)
  assert.equal(f.context.state.taskPromptInjected, false, 'preparing a send is not a confirmed injection')
  f.calls[0][3]('stuck')
  assert.equal(await pending, 'stuck')
  assert.equal(f.context.state.taskPromptInjected, false)
  assert.equal(f.context.computerResultToken, null)
})

test('scheduled sends reuse conversation prompts after a task reset or page reload, including older rendered history', async () => {
  for (const evidence of ['persisted', 'current-task', 'history', 'current-history']) {
    const f = fixture()
    if (evidence === 'current-task') f.context.state.taskPromptInjected = true
    if (evidence === 'history') f.context.userTurns = () => [{ textContent: '【角色】你是 PowerShell 终端助手。\n【工作协议】\n【执行环境】\n【工具：scheduled_task】' }]
    if (evidence === 'current-history') f.context.userTurns = () => [{ textContent: '【角色】协助用户完成当前目标。\n【任务完成】\n【工作协议】\n【执行环境】\n【工具目录】' }]
    const send = method('sendScheduledUser', f.context)
    const pending = send.call({ sendUser: f.send }, '检查 GPU 温度', '/a/chat/s/one', 'run-next', evidence === 'persisted')
    assert.equal(f.calls[0][0], 'SHORT\n\n' + USER_TEXT_SENTINEL + '检查 GPU 温度', evidence)
    assert.equal(f.calls[0].at(-1).promptInjected, false, evidence)
    assert.equal(f.calls[0].at(-1).conversationPromptInjected, true, evidence)
    assert.equal(f.reports.length, 1)
    assert.equal(f.reports[0].promptInjected, false, 'only the per-user contract was injected')
    assert.equal(f.reports[0].replyProtocolKind, 'short')
    f.calls[0][3]('ok'); assert.equal(await pending, 'ok')
    assert.equal(f.context.computerResultToken, null)
  }
})

test('a tool mention or a system-only history message does not suppress the first complete scheduled prompt', async () => {
  const f = fixture()
  f.context.userTurns = () => [{ textContent: '说明【工具：scheduled_task】的用法' },
    { textContent: '【角色】你是 PowerShell 终端助手。\n【工作协议】\n【执行环境】' }]
  const pending = method('sendScheduledUser', f.context).call({ sendUser: f.send }, '新任务', '/a/chat/s/one', 'run-a')
  assert.equal(f.calls[0].at(-1).promptInjected, true)
  f.calls[0][3]('ok'); assert.equal(await pending, 'ok')
})

test('the injection switch disables both full and short contracts without changing user wording', async () => {
  for (const taskPromptInjected of [false, true]) {
    const f = fixture()
    Object.assign(f.context.state, { promptInjectionEnabled: false, taskPromptInjected })
    const pending = f.send('把【任务完成】写进文档\n  第二行', '/a/chat/s/one')
    assert.equal(f.calls[0][0], '把【任务完成】写进文档\n  第二行')
    assert.equal(f.calls[0].at(-1).promptInjected, false)
    assert.equal(f.calls[0].at(-1).replyProtocolKind, undefined)
    assert.equal(f.reports.length, 0)
    f.calls[0][3]('ok'); assert.equal(await pending, 'ok')
  }
})

test('a clarification keeps its original pending question and receives only the per-user reminder', () => {
  const f = fixture()
  Object.assign(f.context.state, { taskPromptInjected: true, pendingQuestion: { messageId: 'question-a' } })
  const injection = f.context.userPromptInjection()
  assert.equal(injection.prefix, 'SHORT\n\n')
  assert.equal(injection.metadata.promptInjected, false)
  assert.equal(f.context.state.pendingQuestion.messageId, 'question-a')
  assert.equal(f.context.state.taskPromptGeneration, 1)
})

test('preserves native drafts, pending questions and uploads without attempting a send', async () => {
  for (const condition of ['draft', 'question', 'upload', 'path', 'generating']) {
    const f = fixture()
    if (condition === 'draft') f.composer.draft = '原网页草稿'
    if (condition === 'question') f.context.state.pendingQuestion = { messageId: 'question' }
    if (condition === 'upload') f.context.fileSend = { token: 'upload' }
    if (condition === 'path') f.context.location.pathname = '/a/chat/s/other'
    if (condition === 'generating') f.context.state.awaitingReplySince = Date.now()
    assert.equal(await f.send('新消息', '/a/chat/s/one'), 'busy', condition)
    assert.equal(f.calls.length, 0, condition)
    if (condition === 'draft') assert.equal(f.composer.draft, '原网页草稿')
  }
})

test('failed insertion, missing prompt and invalid input do not submit', async () => {
  const f = fixture()
  f.context.insertText = () => false
  assert.equal(await f.send('问题', '/a/chat/s/one'), 'insert-failed')
  assert.equal(f.context.state.programmatic, false)
  f.context.state.prefix = ''
  assert.equal(await f.send('问题', '/a/chat/s/one'), 'unavailable')
  assert.equal(await f.send(' ', '/a/chat/s/one'), 'invalid')
  assert.equal(await f.send('a'.repeat(20001), '/a/chat/s/one'), 'invalid')
  assert.equal(f.calls.length, 0)
})

function node(order, text, url) {
  return { order, innerText: text, markdown: text, contains: () => false,
    getAttribute: name => name === 'href' ? url : null,
    compareDocumentPosition(other) { return this.order < other.order ? 4 : 2 } }
}
function reply(id, position, body = '正文', thoughts = [], links = []) {
  const answer = { contains: () => false }
  return { id, body, markdown: '**' + body + '**', getAttribute: () => String(position),
    querySelector: selector => selector === '.ds-assistant-message-main-content' ? answer : null,
    querySelectorAll: selector => selector === '.ds-think-content' ? thoughts : selector === 'a[href]' ? links : [] }
}

test('ChatGPT rich refresh excludes transport code blocks instead of overwriting readable questions', () => {
  const f = fixture()
  f.context.PAGE = CHATGPT_PAGE
  const turn = (id, body, markdown) => ({ id, body, markdown,
    matches: selector => selector === CHATGPT_PAGE.focus.smartUi.rootSelector,
    getAttribute: name => name === CHATGPT_PAGE.messageIdAttr ? id : null,
    querySelector: selector => selector === CHATGPT_PAGE.assistantReplySelectors[0] ? { contains: () => false } : null,
    querySelectorAll: () => [], closest: () => null })
  const questions = '{"type":"questions","questions":[{"question":"监控多久？"}]}'
  const rich = '选择监控方式\n<!--focus-ui {"type":"choice"}-->\n> 监控三分钟'
  f.context.queryAllAssistant = () => [
    turn('batch-question', questions, 'JSON\n\n```json\n' + questions + '\n```'),
    turn('single-question', '{"type":"question","question":"间隔多久？"}', '不应覆盖问题'),
    turn('command', '{"command":"Get-Date"}', '不应显示执行指令'),
    turn('files', '{"type":"read_files","files":[]}', '不应显示读取协议'),
    turn('markdown-only-question', '读取到普通占位文本', '```json\n' + questions + '\n```'),
    turn('real-card', '选择监控方式', rich)
  ]
  const snapshot = f.snapshot()
  assert.deepEqual(Array.from(snapshot.smartReplies, item => [item.sourceMessageId, item.answer]), [['real-card', rich]])
  assert.equal(f.calls.length, 0, 'filtering a read-only refresh must not send anything')
})

test('all three reasoning blocks and interleaved search sources keep document order', () => {
  const f = fixture()
  const thoughts = [node(1, '思考一'), node(3, '思考二'), node(5, '思考三')]
  const links = [node(2, '资料一', 'https://example.com/1'), node(4, '资料二', 'https://example.com/2')]
  f.context.queryAllAssistant = () => [reply('current', 6, '最终回答', thoughts, links)]
  const result = f.snapshot()
  assert.deepEqual(Array.from(result.reply.parts, part => part.text), ['思考一', '资料一', '思考二', '资料二', '思考三'])
  assert.equal(result.reply.answer, '**最终回答**')
  assert.equal('prefix' in result, false)
  assert.equal('userMessages' in result, false)
})

test('complete and partial command, question and read-files protocol never become body text', () => {
  for (const text of ['{"command":"pwd"}', '{"type":"read_files","files":[]}', '{"type":"questions","questions":[]}', '{"com']) {
    const f = fixture()
    f.context.state.awaitingReplySince = Date.now()
    f.context.queryAllAssistant = () => [reply('protocol', 2, text)]
    assert.equal(f.snapshot().reply.answer, '', text)
  }
})

test('rich-content snapshots exclude command protocol while preserving ordinary JSON and shell examples', () => {
  const f = fixture()
  f.context.PAGE = CHATGPT_PAGE
  f.context.messageIdOf = node => node.id
  f.context.state.awaitingReplySince = 1
  const texts = [
    '{"command":"ls -lh /root/website-source-2.zip","description":"检查文件","timeout_seconds":30}',
    '{"command":"unzip -n -q /root/website-source-2.zip","description":"解压项目","timeout_seconds":30}',
    '{"type":"read_files","files":[{"path":"/root/package.json"}]}',
    '{"type":"questions","questions":[]}',
    '{"com',
    '配置示例：\n```json\n{"name":"example"}\n```',
    '运行示例：\n```sh\nnpm run dev\n```',
    '已成功解压至 `/root/website-source-2/`。'
  ]
  f.context.queryAllAssistant = () => texts.map((body, index) => ({
    id: 'message-' + index, body, markdown: body,
    getAttribute: name => name === 'data-chatgpt-selection-message-id' ? 'message-' + index : null,
    querySelector: selector => [CHATGPT_PAGE.focus.smartUi.rootSelector, CHATGPT_PAGE.assistantReplySelectors[0]].includes(selector) ? {} : null,
    querySelectorAll: () => [], closest: () => null
  }))
  const snapshot = f.snapshot()
  assert.deepEqual(Array.from(snapshot.smartReplies, reply => reply.answer), texts.slice(5))
  assert.equal(snapshot.reply.answer, texts.at(-1))
})

test('virtualized history cannot replace the current streaming row', () => {
  const f = fixture()
  f.context.focusReplyBaseline = 'previous'
  f.context.focusBaselinePosition = '4'
  f.context.queryAllAssistant = () => [reply('history', 2)]
  assert.equal(f.snapshot().reply, null)
  f.context.queryAllAssistant = () => [reply('previous', 4)]
  assert.equal(f.snapshot().reply, null)
  f.context.queryAllAssistant = () => [reply('stream-hash-a', 6)]
  assert.equal(f.snapshot().reply.sourceMessageId, 'stream-hash-a')
  f.context.queryAllAssistant = () => [reply('older', 2), reply('stream-hash-b', 6)]
  assert.equal(f.snapshot().reply.sourceMessageId, 'stream-hash-b')
  f.context.queryAllAssistant = () => [reply('older', 2)]
  assert.equal(f.snapshot().reply, null)
})

test('ChatGPT pins the reply by its message id and reads generation from the measured stop button', () => {
  const f = fixture()
  f.context.PAGE = CHATGPT_PAGE
  const turn = (id, body = '回答') => ({ id, body, markdown: body,
    getAttribute: name => name === 'data-chatgpt-selection-message-id' ? id : null,
    querySelector: selector => selector === '[data-markdown-text-style="assistant-message"]' ? {} : null,
    querySelectorAll: () => [], closest: () => null })
  f.context.focusReplyBaseline = 'msg-old'
  f.context.queryAllAssistant = () => [turn('msg-old')]
  assert.equal(f.snapshot().reply, null, 'the reply before this send is not the answer')
  f.context.findStopButton = () => ({})
  f.context.queryAllAssistant = () => [turn('msg-old'), turn('msg-new', '流式中')]
  const streaming = f.snapshot()
  assert.equal(streaming.generating, 'active')
  assert.equal(streaming.reply.sourceMessageId, 'msg-new')
  // A later, unrelated row cannot take over the pinned reply.
  f.context.findStopButton = () => null
  f.context.queryAllAssistant = () => [turn('msg-old'), turn('msg-new', '完成'), turn('msg-other')]
  const done = f.snapshot()
  assert.equal(done.generating, 'idle')
  assert.equal(done.reply.sourceMessageId, 'msg-new')
  assert.equal(done.reply.answer, '完成')
  // A turn rendered before ChatGPT assigns its id is not pinned by a content hash.
  const g = fixture()
  g.context.PAGE = CHATGPT_PAGE
  g.context.queryAllAssistant = () => [{ ...turn('hash'), getAttribute: () => null }]
  assert.equal(g.snapshot().reply, null)
})

test('ChatGPT activity steps beside the turn become reasoning, while its answer stays the answer', () => {
  const f = fixture()
  f.context.PAGE = CHATGPT_PAGE
  const [scope] = [CHATGPT_PAGE.focus.reasoningScopeSelector]
  const [stepSelector] = CHATGPT_PAGE.focus.reasoningSelectors
  const answer = { contains: () => false }
  const steps = [node(1, '编写监控程序'), node(2, '正在搜索 8 个网站')]
  const group = { querySelectorAll: selector => selector === stepSelector ? steps : [] }
  const reply = { id: 'msg-new', body: '最终回答', markdown: '最终回答',
    getAttribute: name => name === 'data-chatgpt-selection-message-id' ? 'msg-new' : null,
    querySelector: selector => selector === '[data-markdown-text-style="assistant-message"]' ? answer : null,
    // The id-bearing turn holds only its answer; the activity block is in the turn group.
    querySelectorAll: () => [], closest: selector => selector === scope ? group : null }
  f.context.queryAllAssistant = () => [reply]
  const result = f.snapshot()
  assert.deepEqual(Array.from(result.reply.parts, part => [part.kind, part.text]), [['reasoning', '编写监控程序'], ['reasoning', '正在搜索 8 个网站']])
  assert.equal(result.reply.answer, '最终回答')
  // The answer itself, matched by a too-broad rule, is never shown twice as reasoning.
  steps.push(answer)
  answer.order = 3
  answer.compareDocumentPosition = node(3).compareDocumentPosition
  assert.equal(f.snapshot().reply.parts.length, 2)
})

test('ChatGPT activity is shown while the reply is still working, before its id element exists', () => {
  const f = fixture()
  f.context.PAGE = CHATGPT_PAGE
  const [stepSelector] = CHATGPT_PAGE.focus.reasoningSelectors
  const previous = { id: 'msg-old', body: '旧回答', markdown: '旧回答',
    getAttribute: name => name === 'data-chatgpt-selection-message-id' ? 'msg-old' : null,
    querySelector: () => ({}), querySelectorAll: () => [], closest: () => null }
  const steps = [node(1, '完善并明确监控方案设置'), node(2, '准备启动任务')]
  const working = { querySelector: () => null, querySelectorAll: selector => selector === stepSelector ? steps : [] }
  const finished = { querySelector: selector => selector === '[data-chatgpt-selection-message-id]' ? previous : null, querySelectorAll: () => [] }
  f.context.focusReplyBaseline = 'msg-old'
  f.context.queryAllAssistant = () => [previous]
  f.context.queryAll = () => [finished, working]
  const result = f.snapshot()
  assert.deepEqual(Array.from(result.reply.parts, part => part.text), ['完善并明确监控方案设置', '准备启动任务'])
  assert.equal(result.reply.answer, '')
  assert.equal(result.reply.sourceMessageId, '', 'no identity is pinned before the id exists')
  assert.equal(f.context.focusReplyPosition, null)
  // Until the user's own turn appears, the newest group is the finished one: nothing is shown.
  f.context.queryAll = () => [finished]
  assert.equal(f.snapshot().reply, null)
})

test('measured send and stop icons identify generation; an unknown spinner stays unknown', () => {
  const f = fixture()
  const inspect = shape => {
    f.context.composerToolbarControls = () => [{ matches: () => true, querySelector: () => ({ getAttribute: () => shape }) }]
    return f.snapshot().generating
  }
  assert.equal(inspect('M2 4.88C2 3.68009...'), 'active')
  assert.equal(inspect('M8.3125 0.980206...'), 'idle')
  assert.equal(inspect('spinner'), 'unknown')
})

test('a page without focus rules reads nothing rather than borrowing another site\'s selectors', () => {
  const f = fixture()
  f.context.PAGE = { ...DEEPSEEK_PAGE, focus: undefined }
  f.context.composerToolbarControls = () => [{ matches: () => true, querySelector: () => ({ getAttribute: () => 'M2 4.88C2 3.68009' }) }]
  f.context.queryAllAssistant = () => [{ id: 'reply', getAttribute: () => '7', querySelector: () => null, querySelectorAll: () => [] }]
  const result = f.snapshot()
  assert.equal(result.generating, 'unknown')
  assert.equal(result.reply, null, 'no row position rule, so no reply can be attributed to this send')
})

function uploadFixture(text = '阅读附件') {
  const f = fixture()
  f.context.fileSendStatus = () => ({ status: 'ready' })
  f.api = {
    beginFileSend(token, files) {
      f.context.fileSend = { token, files, submitted: false }
      return 'ok'
    },
    begin: method('beginFocusFileSend', f.context),
    prepare: method('prepareFocusFileSendCaption', f.context)
  }
  f.files = [{ fileName: 'image.png', mimeType: 'image/png', sizeBytes: 3 }]
  assert.equal(f.api.begin('owned-file', f.files, text, '/a/chat/s/one'), 'ok')
  return f
}

test('file message prepares a user prompt once, including attachment-only messages', () => {
  for (const text of ['两行问题\n第二行', '']) {
    const f = uploadFixture(text)
    assert.equal(f.api.prepare('owned-file'), true)
    assert.equal(f.composer.draft, 'SYSTEM\n\n' + USER_TEXT_SENTINEL + text)
    assert.equal(f.api.prepare('owned-file'), false)
    assert.equal(f.context.state.injectedCount, 1)
    assert.equal(f.reports.some(report => report.event === 'user-message'), false, 'not reported before confirmation')
  }
  const plain = uploadFixture('')
  plain.context.state.enabled = false
  assert.equal(plain.api.prepare('owned-file'), true)
  assert.equal(plain.composer.draft, '')
})

test('an attachment in an open task carries the short contract before its user-text boundary', () => {
  const f = uploadFixture('附件问题\n  保留缩进')
  f.context.state.taskPromptInjected = true
  assert.equal(f.api.prepare('owned-file'), true)
  assert.equal(f.composer.draft, 'SHORT\n\n' + USER_TEXT_SENTINEL + '附件问题\n  保留缩进')
  assert.equal(f.context.fileSend.focus.promptInjected, false)
  assert.equal(f.context.fileSend.focus.injection.metadata.replyProtocolKind, 'short')
})

test('upload cannot borrow another draft, task generation or route', () => {
  const f = uploadFixture()
  f.composer.draft = '用户后来修改的内容'
  assert.equal(f.api.prepare('owned-file'), false)
  f.composer.draft = ''
  f.context.state.taskPromptGeneration++
  assert.equal(f.api.prepare('owned-file'), false)
  assert.equal(f.api.begin('other', f.files, '问题', '/a/chat/s/other'), 'busy')
  f.context.state.pendingQuestion = { messageId: 'waiting' }
  assert.equal(f.api.begin('other', f.files, '问题', '/a/chat/s/one'), 'busy')
})

test('confirmed attachment upload reports one human message and never sent-raw', () => {
  const f = uploadFixture('阅读附件')
  const turn = {}
  Object.assign(f.context, {
    confirmedFileSends: new Set(), lastDraftImageCapturedAt: 0, lastDraftImagePromise: Promise.resolve([]),
    fileUserTurns: () => [turn], isNewFileUserTurn: () => true, turnShowsFiles: () => true,
    fileTurnText: () => 'SYSTEM\n\n阅读附件', scheduleCheck: () => {}, scheduleScrollToBottom: () => {},
    draftRejected: true
  })
  Object.assign(f.context.fileSend, { submitted: true, baselineUser: {}, caption: 'SYSTEM\u0000\u0001阅读附件' })
  Object.assign(f.context.fileSend.focus, { promptInjected: true, attachmentToken: 'img:owned', injection: f.context.userPromptInjection() })
  f.context.state.awaitingReplySince = 1
  const status = arrow('fileSendStatus', f.context)
  assert.equal(status('owned-file').status, 'sent')
  assert.equal(status('owned-file').status, 'sent')
  assert.deepEqual(f.reports.map(report => report.event), ['user-message', 'sent'])
  assert.equal(f.reports[0].text, '阅读附件')
  assert.equal(f.reports[0].attachmentToken, 'img:owned')
  assert.equal(f.reports[0].focusFiles[0].fileName, 'image.png')
  assert.equal(f.reports[0].focusSendToken, 'owned-file')
  assert.equal(f.context.state.taskPromptInjected, true)
})
