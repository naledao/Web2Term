// User-run only: node --test tests/focus-edit.test.mjs
// Actual page helpers, synthetic DOM and virtual time. No Electron, session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const ast = ts.createSourceFile('page.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function find(name, node = ast) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer
  return ts.forEachChild(node, child => find(name, child))
}
function helper(name, context) {
  const node = find(name)
  assert.ok(node, name)
  return new Script('(' + node.getText(ast) + ')').runInContext(context)
}
function method(name, context) {
  const findMethod = node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name ? node : ts.forEachChild(node, findMethod)
  const node = findMethod(ast)
  assert.ok(node, name)
  return new Script('({' + node.getText(ast) + '}).' + name).runInContext(context)
}
const exports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports, require: () => ({ isConversationId: () => true }) })
const PAGE = exports.CHATGPT_PAGE, rules = PAGE.focus.edit

function fixture() {
  const calls = [], reports = [], editor = { innerText: '', isConnected: false }
  let opened = false, now = 1000, groups, stalled = false, scanCount = 0
  let nativeOriginal = '第二轮', foldNewMessage = false, committedText = '', pendingCommit = null, requestedPayload = ''
  let domOnly = false, omitRequest = false, requestId = 'user-new'
  const edit = { kind: 'edit' }, send = { kind: 'send' }, cancel = { kind: 'cancel', textContent: '取消' }
  const form = { querySelector: selector => selector === rules.submitSelector ? send : null, querySelectorAll: () => [cancel] }
  editor.closest = () => form
  const group = (id, text) => ({
    id, getAttribute: name => name === rules.turnIdAttr ? id : null,
    querySelector(selector) {
      if (selector === rules.userTextSelector) return { innerText: text }
      if (selector === rules.editorSelector) return id === 'user-2' && opened ? editor : null
      if (rules.buttonSelectors.includes(selector)) return edit
      return null
    }
  })
  groups = [group('user-1', '第一轮'), group('user-2', '第二轮'), group('user-3', '第三轮')]
  const replies = groups.map((item, index) => ({ id: 'reply-' + (index + 1), closest: () => item }))
  const state = { enabled: true, promptInjectionEnabled: true, taskPromptInjected: false, prefix: 'SYSTEM\n',
    taskPromptGeneration: 4, programmatic: false, awaitingReplySince: 0, pendingQuestion: null }
  const composer = { innerText: '' }
  const context = createContext({
    PAGE, state, Promise, Date: { now: () => now }, location: { pathname: '/c/one' },
    USER_TEXT_SENTINEL: '\u0000\u0001', SEND_TIMEOUT_MS: 1000, fileSend: null, focusEditing: null,
    focusEditExcludedIds: new Set(), focusReplyBaseline: 'reply-3', focusBaselinePosition: null, focusReplyPosition: 'reply-3',
    draftRejected: false, getComposer: () => composer, findStopButton: () => null,
    collapse: text => String(text || '').replace(/\s+/g, ' ').trim(), normalizeLineEndings: text => text.replace(/\r\n?/g, '\n'),
    attachmentSnapshot: () => ({}), draftAttachmentEvidence: () => false, hasDraftImageAttachment: () => false,
    isVisibleElement: node => !!node && node.isConnected !== false, controlDisabled: node => node.disabled === true,
    readComposer: node => node?.innerText || '', queryAllAssistant: () => replies, messageIdOf: node => node?.id || null,
    queryAll(selectors) { return selectors.includes(rules.turnSelector) ? groups : selectors.includes(rules.editorSelector) && opened ? [editor] : [] },
    insertText(node, text) { node.innerText = text; requestedPayload = text; pendingCommit = text; return true }, composerMatches: (node, text) => node.innerText === text,
    pressButton(button) {
      calls.push(button.kind)
      if (button === edit) { opened = true; editor.isConnected = true; editor.innerText = nativeOriginal; committedText = nativeOriginal }
      if (button === cancel) { opened = false; editor.isConnected = false }
      if (button === send) {
        if (!omitRequest) context.noteEditSubmission(context.focusEditing.token, {
          messageId: requestId, requestBodyReadable: true, requestTextMatches: committedText === requestedPayload,
          requestOriginalMatches: committedText === nativeOriginal, requestCount: 1,
          reason: committedText === requestedPayload ? 'request-matched' : 'request-original'
        })
        if (!stalled) { groups = [groups[0], group('user-new', foldNewMessage ? '提示词预览…显示更多' : committedText)]; opened = false; editor.isConnected = false }
      }
    },
    setTimeout(callback, ms) {
      now += ms
      queueMicrotask(() => { if (!domOnly && pendingCommit !== null) { committedText = pendingCommit; pendingCommit = null }; callback() })
    },
    report: value => reports.push(value), setReplyWaiting: value => { state.awaitingReplySince = value },
    scheduleScrollToBottom() {}, scheduleCheck() { scanCount++ }
  })
  context.userTextOf = helper('userTextOf', context)
  context.noteEditSubmission = method('noteEditSubmission', context)
  return { context, state, composer, calls, reports, editor, groups: () => groups, scanCount: () => scanCount,
    stall() { stalled = true },
    nativeOriginal(value) { nativeOriginal = value },
    domOnly() { domOnly = true },
    omitRequest() { omitRequest = true },
    requestId(value) { requestId = value },
    foldMessages() {
      nativeOriginal = '隐藏的长提示词\n\u0000\u0001第二轮'
      foldNewMessage = true
      const query = groups[1].querySelector.bind(groups[1])
      groups[1].querySelector = selector => selector === rules.userTextSelector ? { innerText: '提示词预览…显示更多' } : query(selector)
    }, edit: helper('editFocusUser', context) }
}
const request = { text: '新的第二轮\n换行', originalText: '第二轮', replyMessageId: 'reply-2', token: 'test-edit' }

test('native form is scoped to the selected reply, submitted once, and acknowledged by a new user id', async () => {
  const f = fixture(), diagnostic = {}
  assert.equal(await f.edit(request, '/c/one', diagnostic), 'ok')
  assert.deepEqual(f.calls, ['edit', 'send'])
  assert.deepEqual(f.groups().map(group => group.id), ['user-1', 'user-new'])
  assert.equal(f.editor.innerText, 'SYSTEM\n\u0000\u0001新的第二轮\n换行')
  assert.equal(f.reports.filter(item => item.event === 'user-message').length, 1)
  assert.equal(f.reports.find(item => item.event === 'user-message').focusEditToken, 'test-edit')
  assert.equal(f.state.taskPromptInjected, true)
  assert.equal(f.context.focusEditing, null)
  assert.equal(f.context.focusReplyPosition, null)
  assert.equal(f.scanCount(), 1, 'even a fast reply gets scanned after edit acknowledgement')
  assert.deepEqual([...f.context.focusEditExcludedIds], ['reply-1', 'reply-2', 'reply-3'])
  assert.ok(diagnostic.settleMs >= 180, 'wait for the native framework instead of clicking its already-enabled old button')
  assert.ok(diagnostic.editorStableReads >= 3)
  assert.equal(diagnostic.draftMatches, true)
  assert.equal(diagnostic.requestTextMatches, true)
})

test('a DOM-only draft with the old native submit state cannot acknowledge or replace local history', async () => {
  const f = fixture(), diagnostic = {}; f.domOnly()
  assert.equal(await f.edit(request, '/c/one', diagnostic), 'stuck')
  assert.deepEqual(f.calls, ['edit', 'send'])
  assert.equal(diagnostic.draftMatches, true)
  assert.equal(diagnostic.requestTextMatches, false)
  assert.equal(diagnostic.requestOriginalMatches, true)
  assert.equal(diagnostic.reason, 'request-original')
  assert.equal(f.reports.some(item => item.event === 'user-message'), false)
  assert.equal(f.state.taskPromptInjected, false)
})

test('a new DOM id without matching observed request identity is never sufficient', async () => {
  for (const kind of ['missing', 'different-id']) {
    const f = fixture(), diagnostic = {}
    if (kind === 'missing') f.omitRequest()
    else f.requestId('another-user')
    assert.equal(await f.edit(request, '/c/one', diagnostic), 'stuck', kind)
    assert.deepEqual(f.calls, ['edit', 'send'])
    assert.equal(diagnostic.reason, kind === 'missing' ? 'request-not-observed' : 'submit-unconfirmed')
    assert.equal(f.reports.some(item => item.event === 'user-message'), false)
  }
})

test('submission metadata can only attach to the current edit after its submit', () => {
  const f = fixture(), receipt = { messageId: 'user-new', requestBodyReadable: true, requestTextMatches: true }
  assert.equal(f.context.noteEditSubmission('old-token', receipt), false)
  f.context.focusEditing = { token: 'new-token', submitted: false }
  assert.equal(f.context.noteEditSubmission('new-token', receipt), false)
  f.context.focusEditing.submitted = true
  assert.equal(f.context.noteEditSubmission('old-token', receipt), false)
  assert.equal(f.context.noteEditSubmission('new-token', receipt), true)
  assert.equal(f.context.focusEditing.submission, receipt)
})

const requestExports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/main/focus-edit-request.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: requestExports, Buffer, URL })
const expectedRequest = {
  origin: 'https://chatgpt.com', submissionPath: rules.submissionPath, conversationId: 'one',
  text: '当前cpu信息', originalText: '当前电脑信息', prefix: 'SYSTEM\n'
}
function networkRequest(text, changes = {}) {
  return {
    method: 'POST', url: expectedRequest.origin + rules.submissionPath,
    uploadData: [{ bytes: Buffer.from(JSON.stringify({ conversation_id: 'one', action: 'next', messages: [
      { id: 'user-new', author: { role: 'user' }, content: { content_type: 'text', parts: [text] } }
    ] })) }], ...changes
  }
}

test('actual native request body distinguishes the edit from the original without logging text', () => {
  const summarize = requestExports.summarizeFocusEditRequest
  for (const prefix of ['', 'SYSTEM\n', 'SYSTEM\n\u0000\u0001']) {
    const next = summarize(networkRequest(prefix + expectedRequest.text), expectedRequest)
    assert.equal(next.requestTextMatches, true)
    assert.equal(next.requestOriginalMatches, false)
    assert.equal(next.messageId, 'user-new')
    const old = summarize(networkRequest(prefix + expectedRequest.originalText), expectedRequest)
    assert.equal(old.requestTextMatches, false)
    assert.equal(old.requestOriginalMatches, true)
    assert.equal(old.reason, 'request-original')
    assert.equal(JSON.stringify(old).includes(expectedRequest.originalText), false)
    assert.equal(JSON.stringify(next).includes(expectedRequest.text), false)
  }
  const mismatch = summarize(networkRequest('意外的另一条内容'), expectedRequest)
  assert.equal(mismatch.reason, 'request-mismatch')
  const suffix = { ...expectedRequest, text: '电脑信息' }
  assert.equal(summarize(networkRequest(expectedRequest.originalText), suffix).requestTextMatches, false, 'a suffix of old text is not the requested edit')
})

test('native request observer ignores other endpoints and conversations and never reads files', () => {
  const summarize = requestExports.summarizeFocusEditRequest
  assert.equal(summarize(networkRequest('x', { url: 'https://chatgpt.com/backend-api/other' }), expectedRequest), null)
  assert.equal(summarize(networkRequest('x', { method: 'GET' }), expectedRequest), null)
  const other = networkRequest('x')
  const body = JSON.parse(other.uploadData[0].bytes.toString())
  body.conversation_id = 'another'
  other.uploadData[0].bytes = Buffer.from(JSON.stringify(body))
  assert.equal(summarize(other, expectedRequest), null)
  for (const uploadData of [[], [{ file: 'C:/private.txt' }], [{ bytes: Buffer.from('{') }], [{ bytes: Buffer.alloc(512 * 1024 + 1) }]]) {
    const summary = summarize(networkRequest('x', { uploadData }), expectedRequest)
    assert.equal(summary.reason, 'request-body-unavailable')
    assert.equal(summary.requestBodyReadable, false)
    assert.equal(JSON.stringify(summary).includes('private.txt'), false)
  }
})

test('one passive request listener is registered per partition and released edits stop observing', () => {
  let installed = 0, listener, continued = 0
  const session = { webRequest: { onBeforeRequest(_filter, receive) { installed++; listener = receive } } }
  const frame = {}, contents = { id: 41, session, mainFrame: frame, isDestroyed: () => false, getURL: () => 'https://chatgpt.com/c/one' }
  const first = [], second = []
  const releaseFirst = requestExports.observeFocusEditRequest(contents, expectedRequest, value => first.push(value))
  const releaseSecond = requestExports.observeFocusEditRequest(contents, expectedRequest, value => second.push(value))
  const receive = (changes = {}) => listener({ ...networkRequest(expectedRequest.text), webContentsId: 41, frame, ...changes }, () => { continued++ })
  assert.equal(installed, 1)
  releaseFirst()
  receive({ webContentsId: 42 })
  receive({ frame: {} })
  assert.equal(second.length, 0)
  receive()
  assert.equal(first.length, 0)
  assert.equal(second.length, 1)
  assert.equal(second[0].requestCount, 1)
  releaseSecond()
  receive()
  assert.equal(second.length, 1)
  assert.equal(continued, 4, 'all requests continue without changing headers, body or destination')
})

test('folded prompt previews never substitute for full original verification or new-id acknowledgement', async () => {
  const f = fixture(), diagnostic = {}
  f.foldMessages()
  assert.equal(await f.edit(request, '/c/one', diagnostic), 'ok')
  assert.deepEqual(f.calls, ['edit', 'send'])
  assert.equal(diagnostic.anchored, true)
  assert.equal(diagnostic.originalMatches, true)
  assert.equal(diagnostic.reason, 'new-user-confirmed')
  assert.equal(diagnostic.stage, 'confirm')
  assert.ok(diagnostic.editorTextLength > diagnostic.originalLength)
  assert.equal(f.groups()[1].querySelector(rules.userTextSelector).innerText, '提示词预览…显示更多')
  assert.equal(f.reports.find(item => item.event === 'user-message').text, request.text)
  assert.equal(JSON.stringify(diagnostic).includes('隐藏的长提示词'), false)
  assert.equal(JSON.stringify(diagnostic).includes('第二轮'), false)
})

test('a stale full original is refused before insertion and the native form is cancelled', async () => {
  const f = fixture(), diagnostic = {}
  f.nativeOriginal('另一条实际消息')
  f.context.insertText = () => { assert.fail('must verify the complete native original first') }
  assert.equal(await f.edit(request, '/c/one', diagnostic), 'unavailable')
  assert.deepEqual(f.calls, ['edit', 'cancel'])
  assert.equal(diagnostic.stage, 'verify')
  assert.equal(diagnostic.reason, 'original-text-mismatch')
  assert.equal(diagnostic.submitted, false)
  assert.equal(f.reports.some(item => item.event === 'user-message'), false)
})

test('drafts, pending tasks, another conversation and ambiguous identical messages never submit', async () => {
  for (const kind of ['draft', 'question', 'waiting', 'file', 'generating', 'history-edit', 'path']) {
    const f = fixture()
    if (kind === 'draft') f.composer.innerText = '原网页草稿'
    if (kind === 'question') f.state.pendingQuestion = {}
    if (kind === 'waiting') f.state.awaitingReplySince = 1
    if (kind === 'file') f.context.fileSend = {}
    if (kind === 'generating') f.context.findStopButton = () => ({})
    if (kind === 'history-edit') f.context.queryAll = () => [{ isConnected: true }]
    const outcome = await f.edit(request, kind === 'path' ? '/c/other' : '/c/one')
    assert.equal(outcome, kind === 'path' ? 'unavailable' : 'busy', kind)
    assert.deepEqual(f.calls, [], kind)
  }
  const f = fixture()
  f.groups()[2].querySelector = selector => selector === rules.userTextSelector ? { innerText: '第二轮' } : null
  assert.equal(await f.edit({ ...request, replyMessageId: null }, '/c/one'), 'unavailable')
  assert.deepEqual(f.calls, [])
})

test('an unconfirmed submit is never retried and cannot create a local revision', async () => {
  const f = fixture(), diagnostic = {}; f.stall()
  assert.equal(await f.edit(request, '/c/one', diagnostic), 'stuck')
  assert.deepEqual(f.calls, ['edit', 'send'])
  assert.equal(f.reports.some(item => item.event === 'user-message'), false)
  assert.equal(f.state.awaitingReplySince, 0)
  assert.equal(f.state.programmatic, false)
  assert.equal(diagnostic.stage, 'confirm')
  assert.equal(diagnostic.reason, 'submit-unconfirmed')
})

test('failed insertion cancels only its own native form; a changed generation never sends', async () => {
  const f = fixture(); f.context.insertText = () => false
  assert.equal(await f.edit(request, '/c/one'), 'insert-failed')
  assert.deepEqual(f.calls, ['edit', 'cancel'])
  const changed = fixture()
  changed.context.insertText = () => { changed.state.taskPromptGeneration++; return true }
  changed.context.composerMatches = () => true
  assert.equal(await changed.edit(request, '/c/one'), 'cancelled')
  assert.deepEqual(changed.calls, ['edit'])
  assert.equal(changed.reports.some(item => item.event === 'user-message'), false)
})

test('main-composer selection excludes a focused history editor with the identical attributes', () => {
  const editGroup = {}
  const main = { closest: selector => PAGE.composerSelectors.includes(selector) ? main : null }
  const history = { closest: selector => selector === rules.turnSelector ? editGroup : PAGE.composerSelectors.includes(selector) ? history : null }
  const context = createContext({ PAGE, document: { activeElement: history, querySelectorAll: () => [history, main] }, isVisibleElement: node => !!node })
  const composer = helper('getComposer', context)
  assert.equal(composer(history), main)
  assert.equal(composer(), main)
})

test('the reply fence excludes every old reply when editing exposes an earlier answer', () => {
  const context = createContext({ PAGE, focusEditExcludedIds: new Set(['old-1', 'old-2']), isVisibleElement: () => true, messageIdOf: node => node.id })
  const candidates = helper('replyCandidatesOf', context)
  assert.deepEqual(Array.from(candidates([{ id: 'old-1' }, { id: 'old-2' }])), [])
  assert.deepEqual(Array.from(candidates([{ id: 'old-1' }, { id: 'new' }]), node => node.id), ['new'])
})

const runtimeSource = readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8')
const runtimeAst = ts.createSourceFile('runtime.ts', runtimeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const runtimeClass = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const runtimeMethod = runtimeClass.members.find(node => node.name?.getText(runtimeAst) === 'editFocusMessage')
const runtimeModule = ts.transpileModule('class Runtime {' + runtimeMethod.getText(runtimeAst) + '} exports.Runtime = Runtime', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function runtimeFixture() {
  const moduleExports = {}, calls = []
  new Script(runtimeModule).runInNewContext({ exports: moduleExports, randomUUID: () => 'test-token', writeFocusDiagnostic() {} })
  const runtime = new moduleExports.Runtime()
  runtime.focusSending = false
  runtime.focusRevision = null
  runtime.ownsFocus = () => true
  runtime.taskRunning = () => runtime.focusSending
  const messages = [
    { id: 'u1', role: 'user', content: '第一轮', createdAt: 1, attachments: [] },
    { id: 'a1', role: 'assistant', content: '回复一', sourceMessageId: 'native-1', createdAt: 2, attachments: [] },
    { id: 'u2', role: 'user', content: '第二轮', createdAt: 3, attachments: [] },
    { id: 'a2', role: 'assistant', content: '回复二', sourceMessageId: 'native-2', createdAt: 4, attachments: [] },
    { id: 'u3', role: 'user', content: '第三轮', createdAt: 5, attachments: [] }
  ]
  runtime.options = { store: { listConversationMessages: () => messages } }
  runtime.focusChat = { hiddenMessageIds: () => [], turns: () => [
    { id: 'turn-1', userMessageId: 'u1', userText: '第一轮', createdAt: 1, segments: [], executionIds: [] },
    { id: 'turn-2', userMessageId: 'u2', userText: '第二轮', createdAt: 3, segments: [{ sourceMessageId: 'native-2' }], executionIds: [] },
    { id: 'turn-3', userMessageId: 'u3', userText: '第三轮', createdAt: 5, segments: [], executionIds: [] }
  ] }
  runtime.embed = { async editFocusUser(request) { calls.push(request); runtime.focusRevision.acknowledged = true; return 'ok' } }
  return { runtime, calls, messages }
}
const runtimeRequest = { sessionId: 'workspace', platformId: 'chatgpt', conversationId: 'one', messageId: 'u2', text: '修改第二轮' }

test('runtime resolves local ownership and computes the replaced branch before invoking the page', async () => {
  const f = runtimeFixture()
  f.runtime.embed.editFocusUser = async request => {
    f.calls.push(request)
    assert.deepEqual(Array.from(f.runtime.focusRevision.turnIds), ['turn-2', 'turn-3'])
    assert.deepEqual(Array.from(f.runtime.focusRevision.messageIds), ['u2', 'a2', 'u3'])
    f.runtime.focusRevision.acknowledged = true
    return 'ok'
  }
  assert.equal(await f.runtime.editFocusMessage(runtimeRequest), 'ok')
  assert.equal(f.calls[0].replyMessageId, 'native-2')
  assert.equal(f.calls[0].originalText, '第二轮')
  assert.equal(f.runtime.focusRevision, null)
  assert.equal(f.runtime.focusSending, false)
})

test('runtime rejects stale owners, non-user rows, attachments and hidden branches without page calls', async () => {
  for (const kind of ['owner', 'platform', 'assistant', 'missing', 'attachment', 'hidden', 'busy']) {
    const f = runtimeFixture(), request = { ...runtimeRequest }
    if (kind === 'owner') f.runtime.ownsFocus = () => false
    if (kind === 'platform') request.platformId = 'deepseek'
    if (kind === 'assistant') request.messageId = 'a2'
    if (kind === 'missing') request.messageId = 'missing'
    if (kind === 'attachment') f.messages[2].attachments = [{}]
    if (kind === 'hidden') f.runtime.focusChat.hiddenMessageIds = () => ['u2']
    if (kind === 'busy') f.runtime.taskRunning = () => true
    assert.notEqual(await f.runtime.editFocusMessage(request), 'ok', kind)
    assert.equal(f.calls.length, 0, kind)
  }
})

test('one outstanding runtime edit excludes a second; missing acknowledgement cannot claim success', async () => {
  const f = runtimeFixture()
  let finish
  f.runtime.embed.editFocusUser = () => new Promise(resolve => { finish = resolve })
  const first = f.runtime.editFocusMessage(runtimeRequest)
  assert.equal(await f.runtime.editFocusMessage(runtimeRequest), 'busy')
  finish('ok')
  assert.equal(await first, 'stuck', 'a page result without the matching user-message token is uncertain')
  assert.equal(f.runtime.focusSending, false)
  assert.equal(f.runtime.focusRevision, null)
})
