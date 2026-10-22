// User-run only: node --test tests/focus-page.test.mjs
// The actual injected public methods run against synthetic page collaborators.
// No Electron, real browser session, screenshots, files written or network calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script, createContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
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
function fixture() {
  const composer = { draft: '' }, calls = [], reports = []
  const context = createContext({
    Date, URL, Promise, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    location: { pathname: '/a/chat/s/one', href: 'https://chat.deepseek.com/a/chat/s/one' },
    state: { enabled: true, promptInjectionEnabled: true, prefix: 'SYSTEM\n\n', taskPromptInjected: false,
      injectedCount: 0, taskPromptGeneration: 1, programmatic: false, awaitingReplySince: 0, pendingQuestion: null },
    USER_TEXT_SENTINEL: '\u0000\u0001', SEND_TIMEOUT_MS: 6000, SEND_BUTTON_GRACE_MS: 500,
    fileSend: null, focusReplyBaseline: null, focusBaselinePosition: null, focusReplyPosition: null,
    getComposer: () => composer, collapse: text => String(text).replace(/\s+/g, ' ').trim(),
    readComposer: node => node.draft, findStopButton: () => null,
    attachmentSnapshot: () => ({}), draftAttachmentEvidence: () => false, hasDraftImageAttachment: () => false,
    normalizeLineEndings: text => text.replace(/\r\n?/g, '\n'),
    insertText(node, text) { node.draft = text; return true },
    composerMatches: (node, text) => node.draft === text,
    submitWithRetry(...args) { calls.push(args) }, report: item => reports.push(item),
    composerToolbarControls: () => [], queryAllAssistant: () => [], isAssistantTurn: () => true,
    latestReplyNode: nodes => nodes.at(-1), turnKeyOf: node => node.id,
    readReplyText: node => node.body || '', readReplyMarkdown: node => node.markdown || '',
    extractCommand: () => null
  })
  for (const name of ['looksLikeReadFilesReply', 'looksLikeQuestionReply', 'looksLikeCommandReply']) context[name] = arrow(name, context)
  return { context, composer, calls, reports, send: method('sendUser', context), snapshot: method('focusSnapshot', context) }
}

test('app composer preserves multiline input and waits for confirmed user-send outcome', async () => {
  const f = fixture()
  let resolved = false
  const pending = f.send('第一行\r\n第二行', '/a/chat/s/one').then(value => { resolved = true; return value })
  assert.equal(resolved, false)
  assert.equal(f.composer.draft, 'SYSTEM\n\n\u0000\u0001第一行\n第二行')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][2], false, 'must use the human-send path, not sendRaw')
  assert.equal(f.reports[0].event, 'injected')
  f.calls[0][3]('ok')
  assert.equal(await pending, 'ok')
  f.context.state.programmatic = false
  f.context.state.taskPromptInjected = true
  f.composer.draft = ''
  const next = f.send('继续', '/a/chat/s/one')
  assert.equal(f.calls[1][0], '继续')
  f.calls[1][3]('stuck')
  assert.equal(await next, 'stuck')
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
    assert.equal(f.composer.draft, 'SYSTEM\n\n\u0000\u0001' + text)
    assert.equal(f.api.prepare('owned-file'), false)
    assert.equal(f.context.state.injectedCount, 1)
    assert.equal(f.reports.some(report => report.event === 'user-message'), false, 'not reported before confirmation')
  }
  const plain = uploadFixture('')
  plain.context.state.enabled = false
  assert.equal(plain.api.prepare('owned-file'), true)
  assert.equal(plain.composer.draft, '')
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
  Object.assign(f.context.fileSend.focus, { promptInjected: true, attachmentToken: 'img:owned' })
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
