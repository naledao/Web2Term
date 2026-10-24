// User-run only: node --test tests/focus-smart-ui.test.mjs
// Actual helpers with synthetic DOM, request bodies and virtual time; no Electron/network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function moduleAt(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, Buffer, URL, require: name => dependencies[name] ?? ({ isConversationId: () => true }) })
  return exports
}
const { CHATGPT_PAGE: PAGE, DEEPSEEK_PAGE } = moduleAt('../src/shared/platforms.ts')
const rules = PAGE.focus.smartUi
const { parseFocusUi, validFocusUiAction } = moduleAt('../src/shared/focus-smart-ui.ts')
const { smartUiSubmission } = moduleAt('../src/main/focus-ui-request.ts')
const { dispatchFocusUiClick } = moduleAt('../src/main/focus-ui-click.ts')
const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const ast = ts.createSourceFile('page.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function find(predicate, node = ast) { return predicate(node) ? node : ts.forEachChild(node, child => find(predicate, child)) }
function helper(name, context) {
  const node = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
  return new Script('(' + node.initializer.getText(ast) + ')').runInContext(context)
}
function method(name, context) {
  const node = find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name)
  return new Script('({' + node.getText(ast) + '}).' + name).runInContext(context)
}
const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
const choice = (value, selected = false) => ({ value, label: value + ' 说明', title: value, description: '说明', selected, disabled: false })
const widget = () => ({ version: 1, sourceMessageId: 'answer-1', index: 0, signature: '12345678', title: '开发方向', description: '选择一项继续',
  label: '产品选择', disabled: false, options: [choice('工具箱'), choice('业务流'), choice('两者结合', true)], buttons: [{ label: '按这个方向深入设计', disabled: false }] })

test('widget parser bounds untrusted data and rejects ambiguous or malformed controls', () => {
  assert.ok(parseFocusUi(JSON.stringify(widget())))
  for (const mutate of [item => { item.version = 2 }, item => { item.options[1].value = item.options[0].value },
    item => { item.options[0].selected = true }, item => { item.options[0].label = '' },
    item => { item.options = Array(33).fill(choice('x')) }, item => { item.signature = '<script>' }, item => { item.buttons = [] }]) {
    const item = widget(); mutate(item)
    assert.equal(parseFocusUi(JSON.stringify(item)), null)
  }
  assert.equal(validFocusUiAction({ ...widget(), kind: 'submit', selectedValue: '两者结合', buttonIndex: -1 }), false)
  assert.equal(validFocusUiAction({ ...widget(), kind: 'choose', selectedValue: '两者结合', optionValue: '业务流' }), true)
})

function extractionFixture() {
  const data = widget(), controls = data.options.map(option => ({
    id: 'radio-' + option.value, getAttribute: name => name === 'value' ? option.value : name === 'aria-checked' ? String(option.selected) : null,
    closest: () => ({ textContent: option.label, querySelector: () => ({ textContent: option.title }) })
  }))
  const button = { textContent: data.buttons[0].label }
  const group = { getAttribute: () => data.label, querySelectorAll: () => controls, closest: () => card }
  const card = { nodeType: 1, tagName: 'DIV', closest: () => dil,
    querySelectorAll: selector => selector === rules.groupSelector ? [group] : selector === rules.actionSelector ? [button] : [],
    querySelector: selector => ({ textContent: selector.startsWith('h1') ? data.title : data.description }) }
  const dil = { nodeType: 1, tagName: 'DIV', childNodes: [card], getAttribute: name => name === rules.sourceIdAttr ? data.sourceMessageId : null,
    querySelectorAll: selector => selector === rules.groupSelector ? [group] : [], contains: node => node === card,
    matches: () => false }
  const answer = { nodeType: 1, tagName: 'DIV', childNodes: [{ nodeType: 3, nodeValue: '之前的段落' }, dil, { nodeType: 3, nodeValue: '之后的段落' }],
    matches: () => false, querySelectorAll: () => [dil], getAttribute: () => null }
  dil.getAttribute = name => name === rules.sourceIdAttr ? data.sourceMessageId : null
  const context = createContext({ PAGE: { ...PAGE, answerCharts: null }, collapse, replyRootOf: () => answer,
    messageIdOf: () => data.sourceMessageId, controlDisabled: node => node.disabled === true,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 } })
  context.smartUiCardsOf = helper('smartUiCardsOf', context)
  context.smartUiLayoutsOf = () => []
  context.smartUiMarkdown = helper('smartUiMarkdown', context)
  return { data, context, controls, card, extract: context.smartUiCardsOf, markdown: helper('readReplyMarkdown', context) }
}

test('measured native card extraction retains labels, values and surrounding prose without flattening controls', () => {
  const f = extractionFixture(), cards = f.extract({})
  assert.equal(cards.length, 1)
  assert.deepEqual(Array.from(cards[0].data.options, item => item.value), ['工具箱', '业务流', '两者结合'])
  assert.equal(cards[0].data.options[2].selected, true)
  assert.ok(parseFocusUi(JSON.stringify(cards[0].data)))
  const markdown = f.markdown({})
  assert.match(markdown, /之前的段落[\s\S]*<!--focus-ui /)
  assert.match(markdown, /> \[x\] 两者结合 说明[\s\S]*之后的段落/)
  f.data.title = '标题 --> <script>'
  const serialized = f.context.smartUiMarkdown(f.data)
  assert.equal(serialized.includes('<!--focus-ui {"version":1'), true)
  assert.equal(serialized.split(' -->')[0].includes('<script>'), false, 'untrusted text cannot terminate a machine marker')
  const signature = cards[0].data.signature
  f.data.options[2].selected = false; f.data.options[1].selected = true
  assert.equal(f.extract({})[0].data.signature, signature, 'selection changes do not invalidate the component identity')
})

function requestBody(value = '两者结合') {
  return { conversation_id: 'one', parent_message_id: 'answer-1', action: 'next', messages: [{ id: 'new-user', author: { role: 'user' },
    content: { content_type: 'text', parts: ['原生按钮生成的实际消息，不是按钮标题'] } }], genui_state_snapshots: [{ message_id: 'answer-1', root: { choice: value } }] }
}
const expected = { origin: 'https://chatgpt.com', path: rules.submissionPath, conversationId: 'one', sourceMessageId: 'answer-1', selectedValue: '两者结合' }
const request = body => ({ method: 'POST', url: expected.origin + rules.submissionPath, uploadData: [{ bytes: Buffer.from(JSON.stringify(body)) }] })
test('native submission owns the real user message independently of optional component state', () => {
  const result = smartUiSubmission(request(requestBody()), expected)
  assert.equal(result.matched, true)
  assert.equal(result.messageId, 'new-user')
  assert.equal(result.text, '原生按钮生成的实际消息，不是按钮标题')
  assert.equal(result.requestStateMatches, true)
  const different = smartUiSubmission(request(requestBody('工具箱')), expected)
  assert.equal(different.matched, true)
  assert.equal(different.requestStateMatches, false)
  assert.equal(different.reason, 'request-state-mismatch')
  assert.equal(different.text, result.text)
  const unrelated = requestBody(); unrelated.parent_message_id = 'another-answer'
  assert.equal(smartUiSubmission(request(unrelated), expected), null)
  const absent = requestBody(); absent.genui_state_snapshots = []
  const withoutState = smartUiSubmission(request(absent), expected)
  assert.equal(withoutState.matched, true)
  assert.equal(withoutState.requestStatePresent, false)
  assert.equal(withoutState.reason, 'request-state-absent')
  assert.equal(withoutState.text, result.text)
  const wrongConversation = requestBody(); wrongConversation.conversation_id = 'another'
  assert.equal(smartUiSubmission(request(wrongConversation), expected), null)
  assert.equal(smartUiSubmission({ ...request({}), uploadData: [{ file: 'C:/private.txt' }] }, expected).reason, 'request-body-unavailable')
})

function actionFixture() {
  const data = widget(), calls = [], reports = [], listeners = new Map()
  let now = 100, observed = true, matched = true, newId = 'new-user', cancel = false, receipt
  let hit, deliverInput = true, trusted = true, covered = false, wrongTarget = false
  const control = details => ({ ...details, isConnected: true, contains(node) { return node === this },
    scrollIntoView() { hit = this }, getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }) })
  const controls = data.options.map((_, index) => control({ kind: 'radio', index })), button = control({ kind: 'submit' })
  const state = { taskPromptGeneration: 4, programmatic: false, awaitingReplySince: 0, pendingQuestion: null }
  const composer = { draft: '' }
  const sourceNode = { id: data.sourceMessageId }
  const card = () => ({ element: {}, data, controls, buttons: [button] })
  const context = createContext({ PAGE, state, fileSend: null, focusEditing: null, focusEditExcludedIds: new Set(),
    focusReplyBaseline: null, focusBaselinePosition: null, focusReplyPosition: null, draftRejected: false,
    Date: { now: () => now }, Promise, queueMicrotask, SEND_TIMEOUT_MS: 600, location: { pathname: '/c/one' }, collapse,
    getComposer: () => composer, readComposer: node => node.draft, findStopButton: () => null,
    attachmentSnapshot: () => ({}), draftAttachmentEvidence: () => false, hasDraftImageAttachment: () => false,
    queryAllAssistant: () => [sourceNode], messageIdOf: node => node.id, isVisibleElement: () => true,
    smartUiCardsOf: () => [card()], queryAll: selectors => selectors.includes(PAGE.focus.edit.turnSelector) ? [{ getAttribute: () => newId }] : [],
    controlDisabled: () => false,
    document: { elementFromPoint: () => covered ? {} : hit,
      addEventListener(type, callback) { listeners.set(type, callback) }, removeEventListener(type) { listeners.delete(type) } },
    pressButton() { assert.fail('smart UI must use native input without a synthetic click fallback') },
    report(value) {
      if (value.event !== 'focus-ui-click') { reports.push(value); return }
      if (!deliverInput) return
      const point = context.prepareSmartUiClick(value.focusEditToken)
      if (!point?.ok) return
      const target = wrongTarget ? {} : hit
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const event = { type, target, isTrusted: trusted, defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() {} }
        listeners.get(type)?.(event)
        if (type !== 'click' || event.defaultPrevented || !trusted) continue
        calls.push(hit.kind)
        if (hit.kind === 'radio') data.options.forEach((option, index) => { option.selected = index === hit.index })
        else if (observed) context.noteSmartUiSubmission('token', receipt ?? { matched, messageId: 'new-user', text: matched ? '实际原生新消息' : '' })
      }
    },
    setTimeout(callback, ms) { now += ms; queueMicrotask(() => { if (cancel) { state.taskPromptGeneration++; cancel = false }; callback() }) },
    setReplyWaiting: value => { state.awaitingReplySince = value }, scheduleScrollToBottom() {}, scheduleCheck() {}
  })
  context.noteSmartUiSubmission = method('noteSmartUiSubmission', context)
  context.prepareSmartUiClick = method('prepareSmartUiClick', context)
  context.failSmartUiClick = method('failSmartUiClick', context)
  const act = helper('actOnSmartUi', context)
  const action = { sourceMessageId: data.sourceMessageId, index: 0, signature: data.signature, kind: 'submit', buttonIndex: 0, selectedValue: '两者结合', token: 'token' }
  return { context, data, composer, state, calls, reports, listeners, act, action,
    submission(value) { receipt = value },
    noInput() { deliverInput = false }, untrusted() { trusted = false }, covered() { covered = true }, wrongTarget() { wrongTarget = true },
    omit() { observed = false }, mismatch() { matched = false }, wrongId() { newId = 'unrelated-user' }, cancel() { cancel = true } }
}
test('choice forwards once, confirms native aria state and never starts a user turn', async () => {
  const f = actionFixture()
  assert.equal(await f.act({ ...f.action, kind: 'choose', optionValue: '业务流' }, '/c/one'), 'ok')
  assert.deepEqual(f.calls, ['radio'])
  assert.equal(f.data.options[1].selected, true)
  assert.equal(f.reports.length, 0)
  assert.equal(f.context.focusEditing, null)
  assert.equal(f.state.programmatic, false)
})
test('submit forwards once and acknowledges only the observed request identity and text', async () => {
  const f = actionFixture(), diagnostic = {}
  assert.equal(await f.act(f.action, '/c/one', diagnostic), 'ok')
  assert.deepEqual(f.calls, ['submit'])
  assert.equal(f.reports.find(item => item.event === 'user-message').text, '实际原生新消息')
  assert.equal(f.reports.find(item => item.event === 'user-message').focusEditToken, 'token')
  assert.ok(f.state.awaitingReplySince)
  assert.deepEqual([...f.context.focusEditExcludedIds], ['answer-1'])
  assert.equal(diagnostic.nativeClickReceived, true)
  assert.equal(diagnostic.clickTrusted, true)
  assert.equal(f.listeners.size, 0)
})

test('a sent request with missing or different state still starts its actual focus turn and reply wait', async () => {
  for (const variant of ['missing', 'different']) {
    const f = actionFixture(), body = requestBody('工具箱')
    if (variant === 'missing') delete body.genui_state_snapshots
    const receipt = smartUiSubmission(request(body), expected)
    f.submission(receipt)
    assert.equal(await f.act(f.action, '/c/one'), 'ok', variant)
    assert.equal(f.reports.find(item => item.event === 'user-message').text, body.messages[0].content.parts[0])
    assert.ok(f.state.awaitingReplySince)
    assert.equal(f.state.taskActive, true)
    assert.deepEqual(f.calls, ['submit'])
  }
})

test('native click has one ticket, rejects covers and changed targets, and distinguishes missing input from a missing request', async () => {
  for (const [setup, reason] of [['noInput', 'native-click-not-received'], ['untrusted', 'native-click-not-received'],
    ['covered', 'native-click-unreachable'], ['wrongTarget', 'native-click-target-changed'], ['omit', 'request-not-observed']]) {
    const f = actionFixture(), diagnostic = {}
    f[setup]()
    assert.equal(await f.act(f.action, '/c/one', diagnostic), 'stuck', setup)
    assert.equal(diagnostic.reason, reason)
    assert.equal(f.calls.length, setup === 'omit' ? 1 : 0)
    assert.equal(f.reports.length, 0)
    assert.equal(f.listeners.size, 0, 'temporary input guards are always removed')
  }
  const f = actionFixture()
  f.noInput()
  const pending = f.act(f.action, '/c/one')
  assert.equal(f.context.prepareSmartUiClick('wrong-token'), null)
  assert.equal(f.context.prepareSmartUiClick('token').ok, true)
  assert.equal(f.context.prepareSmartUiClick('token'), null, 'the same ticket cannot dispatch twice')
  await pending
})

test('main native dispatcher applies zoom and sends exactly one input sequence, with no DOM click', async () => {
  const events = [], diagnostics = [], scripts = []
  const contents = { getZoomFactor: () => 1.5, sendInputEvent: event => events.push(event),
    async executeJavaScript(script) { scripts.push(script); return { ok: true, x: 12, y: 20 } } }
  await dispatchFocusUiClick(contents, 'token', () => true, () => true, details => diagnostics.push(details))
  assert.deepEqual(events.map(event => event.type), ['mouseMove', 'mouseDown', 'mouseUp'])
  assert.ok(events.every(event => event.x === 18 && event.y === 30))
  assert.equal(scripts.length, 1)
  assert.match(scripts[0], /prepareSmartUiClick/)
  assert.equal(diagnostics.at(-1).reason, 'native-click-dispatched')
})

test('main native dispatcher stops on focus loss, changed context and invalid coordinates', async () => {
  for (const scenario of ['unfocused', 'changed', 'invalid']) {
    const events = [], diagnostics = [], scripts = []
    let current = true
    const contents = { getZoomFactor: () => 1, sendInputEvent: event => events.push(event),
      async executeJavaScript(script) {
        scripts.push(script)
        if (scenario === 'changed') current = false
        return { ok: true, x: scenario === 'invalid' ? NaN : 12, y: 20 }
      } }
    await dispatchFocusUiClick(contents, 'token', () => current, () => scenario !== 'unfocused', details => diagnostics.push(details))
    assert.equal(events.length, 0, scenario)
    if (scenario !== 'changed') assert.ok(scripts.some(script => script.includes('failSmartUiClick')))
    if (scenario === 'unfocused') assert.equal(diagnostics.at(-1).reason, 'native-click-window-unfocused')
  }
})
test('unobserved, mismatched and unrelated native submissions never acknowledge and are never retried', async () => {
  for (const setup of ['omit', 'mismatch', 'wrongId']) {
    const f = actionFixture(); f[setup]()
    assert.equal(await f.act(f.action, '/c/one'), 'stuck')
    assert.deepEqual(f.calls, ['submit'])
    assert.equal(f.reports.length, 0)
  }
})
test('drafts, running replies, changed identity and other platforms cannot trigger a component', async () => {
  for (const setup of ['draft', 'busy', 'signature', 'value', 'platform']) {
    const f = actionFixture()
    if (setup === 'draft') f.composer.draft = '保留草稿'
    if (setup === 'busy') f.state.awaitingReplySince = 1
    if (setup === 'signature') f.action.signature = '87654321'
    if (setup === 'value') f.action.selectedValue = '工具箱'
    if (setup === 'platform') f.context.PAGE = DEEPSEEK_PAGE
    assert.notEqual(await f.act(f.action, '/c/one'), 'ok')
    assert.deepEqual(f.calls, [])
  }
  const cancelled = actionFixture(); cancelled.cancel()
  assert.equal(await cancelled.act({ ...cancelled.action, kind: 'choose', optionValue: '业务流' }, '/c/one'), 'cancelled')
})

test('each page busy guard names its cause without clicking or changing a draft', async () => {
  const cases = [
    ['edit-in-progress', f => { f.context.focusEditing = {} }],
    ['programmatic-send', f => { f.state.programmatic = true }],
    ['file-send', f => { f.context.fileSend = {} }],
    ['awaiting-reply', f => { f.state.awaitingReplySince = 1 }],
    ['question-pending', f => { f.state.pendingQuestion = {} }],
    ['model-generating', f => { f.context.findStopButton = () => ({}) }],
    ['text-draft', f => { f.composer.draft = '保留草稿' }],
    ['attachment-draft', f => { f.context.draftAttachmentEvidence = () => true }],
    ['image-draft', f => { f.context.hasDraftImageAttachment = () => true }],
    ['history-edit-draft', f => { f.context.queryAll = () => [{}] }]
  ]
  for (const [reason, setup] of cases) {
    const f = actionFixture(), diagnostic = {}
    setup(f)
    const draft = f.composer.draft
    assert.equal(await f.act(f.action, '/c/one', diagnostic), 'busy', reason)
    assert.equal(diagnostic.reason, reason)
    assert.equal(diagnostic.submitted, false)
    assert.deepEqual(f.calls, [])
    assert.equal(f.composer.draft, draft)
  }
})

test('public page action returns the diagnostic alongside the result', async () => {
  const f = actionFixture()
  f.context.actOnSmartUi = f.act
  f.state.awaitingReplySince = 1
  const result = await method('smartUiAction', f.context)(f.action, '/c/one')
  assert.equal(result.outcome, 'busy')
  assert.equal(result.diagnostic.reason, 'awaiting-reply')
})

const runtimeSource = readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8')
const runtimeAst = ts.createSourceFile('runtime.ts', runtimeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const runtimeClass = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const runtimeMethod = runtimeClass.members.find(node => node.name?.getText(runtimeAst) === 'actOnFocusUi')
function runtimeFixture() {
  const exports = {}, calls = [], diagnostics = []
  new Script(ts.transpileModule('class Runtime {' + runtimeMethod.getText(runtimeAst) + '} exports.Runtime = Runtime', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, validFocusUiAction, randomUUID: () => 'token',
    writeFocusDiagnostic(owner, details) { diagnostics.push(details) } })
  const runtime = new exports.Runtime()
  runtime.focusSending = false; runtime.focusRevision = null
  runtime.ownsFocus = () => true
  runtime.taskRunning = () => runtime.focusSending
  runtime.runner = { hasInFlightWork: () => false }
  runtime.options = { store: { listConversationMessages: () => [
    { id: 'u1', role: 'user', createdAt: 1 }, { id: 'a1', role: 'assistant', sourceMessageId: 'answer-1', createdAt: 2 },
    { id: 'u2', role: 'user', createdAt: 3 }, { id: 'a2', role: 'assistant', sourceMessageId: 'answer-2', createdAt: 4 }
  ] } }
  runtime.focusChat = { hiddenMessageIds: () => [], turns: () => [
    { id: 'turn-1', createdAt: 1, segments: [{ sourceMessageId: 'answer-1' }] },
    { id: 'turn-2', createdAt: 3, segments: [{ sourceMessageId: 'answer-2' }] }
  ] }
  runtime.embed = { getInterceptorStatus: () => ({ taskStartedAt: 1, taskFinishedAt: null, pendingQuestion: null }),
    async actOnFocusUi(request) { calls.push(request); if (request.kind === 'submit') runtime.focusRevision.acknowledged = true; return 'ok' } }
  const request = { sessionId: 'session', platformId: 'chatgpt', conversationId: 'one', sourceMessageId: 'answer-1', index: 0,
    signature: '12345678', selectedValue: '两者结合', kind: 'submit', buttonIndex: 0 }
  return { runtime, calls, request, diagnostics }
}

test('a settled answer in an unfinished task permits both card selection and submission', async () => {
  const f = runtimeFixture()
  // Regression from the user log: completed=false keeps taskRunning true after waiting=false.
  f.runtime.taskRunning = () => true
  assert.equal(await f.runtime.actOnFocusUi({ ...f.request, kind: 'choose', optionValue: '业务流' }), 'ok')
  assert.equal(await f.runtime.actOnFocusUi(f.request), 'ok')
  assert.equal(f.calls.length, 2)
  const requests = f.diagnostics.filter(item => item.event === 'smart-ui-request')
  assert.equal(requests.length, 2)
  assert.ok(requests.every(item => item.taskOpen === true))
})

test('actual runtime work or a pending question blocks the card and records the reason', async () => {
  for (const reason of ['send-in-progress', 'edit-in-progress', 'command-in-flight', 'question-pending']) {
    const f = runtimeFixture()
    if (reason === 'send-in-progress') f.runtime.focusSending = true
    if (reason === 'edit-in-progress') f.runtime.focusRevision = {}
    if (reason === 'command-in-flight') f.runtime.runner.hasInFlightWork = () => true
    if (reason === 'question-pending') f.runtime.embed.getInterceptorStatus = () => ({ pendingQuestion: {} })
    assert.equal(await f.runtime.actOnFocusUi(f.request), 'busy', reason)
    assert.equal(f.calls.length, 0)
    assert.equal(f.diagnostics[0].event, 'smart-ui-request')
    assert.equal(f.diagnostics.at(-1).reason, reason)
  }
})

const commandsSource = readFileSync(new URL('../src/main/commands.ts', import.meta.url), 'utf8')
const commandsAst = ts.createSourceFile('commands.ts', commandsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const commandsClass = commandsAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'CommandRunner')
test('execution and result delivery remain busy independently of pause and terminal mode policy', () => {
  const exports = {}
  const methods = commandsClass.members.filter(node => ['hasInFlightWork', 'canSendAutomaticResult'].includes(node.name?.getText(commandsAst)))
  new Script(ts.transpileModule('class Runner {' + methods.map(node => node.getText(commandsAst)).join('\n') + '} exports.Runner = Runner', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports })
  const runner = new exports.Runner()
  let remote = null
  Object.assign(runner, { disposed: false, inFlight: new Set(), activeShell: null, fileAbort: null, localShell: null,
    deps: { remoteShell: () => remote }, automation: { paused: false }, terminalModeOn: () => true })
  assert.equal(runner.hasInFlightWork(), false)
  assert.equal(runner.canSendAutomaticResult(), true)
  for (const key of ['inFlight', 'activeShell', 'fileAbort', 'localShell', 'remoteShell']) {
    if (key === 'inFlight') runner.inFlight.add('executing-or-delivering')
    else if (key === 'remoteShell') remote = { running: true }
    else runner[key] = { running: true }
    assert.equal(runner.hasInFlightWork(), true, key)
    assert.equal(runner.canSendAutomaticResult(), false, key)
    if (key === 'inFlight') runner.inFlight.clear()
    else if (key === 'remoteShell') remote = null
    else runner[key] = null
  }
  runner.automation.paused = true
  runner.terminalModeOn = () => false
  assert.equal(runner.hasInFlightWork(), false, 'an explicit card action can continue while automation is paused or off')
  assert.equal(runner.canSendAutomaticResult(), false, 'automatic delivery still obeys the original policy')
})
test('submitting an older card retains its parent and stages only later local history for replacement', async () => {
  const f = runtimeFixture()
  f.runtime.embed.actOnFocusUi = async request => {
    f.calls.push(request)
    assert.deepEqual(Array.from(f.runtime.focusRevision.turnIds), ['turn-2'])
    assert.deepEqual(Array.from(f.runtime.focusRevision.messageIds), ['u2', 'a2'])
    f.runtime.focusRevision.acknowledged = true
    return 'ok'
  }
  assert.equal(await f.runtime.actOnFocusUi(f.request), 'ok')
  assert.equal(f.runtime.focusRevision, null)
  assert.equal(f.runtime.focusSending, false)
})
test('choice cannot replace history; stale owners and unconfirmed submits cannot claim success', async () => {
  const f = runtimeFixture()
  assert.equal(await f.runtime.actOnFocusUi({ ...f.request, kind: 'choose', optionValue: '业务流' }), 'ok')
  assert.equal(f.runtime.focusRevision, null)
  f.runtime.embed.actOnFocusUi = async () => 'ok'
  assert.equal(await f.runtime.actOnFocusUi(f.request), 'stuck')
  f.runtime.ownsFocus = () => false
  assert.equal(await f.runtime.actOnFocusUi(f.request), 'unavailable')
  assert.equal(f.calls.length, 1)
})

function recoveryPageFixture() {
  const state = { programmatic: false, awaitingReplySince: 0, pendingQuestion: null }, user = { innerText: '按这个方向深入设计：综合工具箱型工作台', querySelector: () => null }
  const parentNode = { id: 'answer-1' }, other = { id: 'answer-2' }
  const group = id => ({ querySelector: () => user, getAttribute: () => id, contains: node => node === parentNode })
  const groups = [group('old-user'), group('native-user')]
  const context = createContext({ PAGE, state, location: { pathname: '/c/one' }, focusEditing: null, fileSend: null,
    queryAll: () => groups, isVisibleElement: () => true, queryAllAssistant: () => [parentNode, other], messageIdOf: node => node.id,
    smartUiCardsOf: node => node === parentNode ? [{}] : [], userTextOf: value => value, normalizeLineEndings: value => value,
    focusReplyBaseline: 'old-baseline', focusBaselinePosition: 'old-position', focusReplyPosition: 'old-reply' })
  const api = { readSmartUiRecovery: method('readSmartUiRecovery', context), adoptSmartUiRecovery: method('adoptSmartUiRecovery', context) }
  return { context, api, state, user, groups }
}

test('history recovery reads only the adjacent native user after a known card and never arms commands', () => {
  const f = recoveryPageFixture(), value = f.api.readSmartUiRecovery(['answer-1'], '/c/one')
  assert.equal(value.userMessageId, 'native-user')
  assert.equal(value.userText, f.user.innerText)
  assert.equal(f.api.adoptSmartUiRecovery(value, '/c/one'), true)
  assert.equal(f.context.focusReplyBaseline, 'answer-1')
  assert.equal(f.context.focusReplyPosition, null)
  assert.equal(f.state.awaitingReplySince, 0)
  assert.equal(f.state.programmatic, false)
  f.user.innerText = '另一条消息'
  assert.equal(f.api.adoptSmartUiRecovery(value, '/c/one'), false, 'a changed native row cannot be adopted')
})

test('history recovery rejects unknown parents, uploads, active sends and changed conversations', () => {
  const f = recoveryPageFixture()
  assert.equal(f.api.readSmartUiRecovery(['unknown'], '/c/one'), null)
  assert.equal(f.api.readSmartUiRecovery(['answer-1'], '/c/other'), null)
  f.user.querySelector = () => ({})
  assert.equal(f.api.readSmartUiRecovery(['answer-1'], '/c/one'), null)
  f.user.querySelector = () => null
  f.state.awaitingReplySince = 1
  assert.equal(f.api.readSmartUiRecovery(['answer-1'], '/c/one'), null)
  f.state.awaitingReplySince = 0
  f.groups.splice(0, 1)
  assert.equal(f.api.readSmartUiRecovery(['answer-1'], '/c/one'), null, 'no adjacency proof means no recovery')
})

const focusShared = moduleAt('../src/shared/focus-chat.ts')
let recoverySerial = 0
const { FocusChat } = moduleAt('../src/main/focus-chat.ts', {
  'node:crypto': { randomUUID: () => 'recovered-' + (++recoverySerial) }, '../shared/focus-chat': focusShared
})
function recoveryRuntimeFixture() {
  const exports = {}, diagnostics = [], captured = [], calls = []
  const methods = runtimeClass.members.filter(node => ['recoverFocusUi', 'getFocusChat'].includes(node.name?.getText(runtimeAst)))
  new Script(ts.transpileModule('class Runtime {' + methods.map(node => node.getText(runtimeAst)).join('\n') + '} exports.Runtime = Runtime', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, cleanFocusUserText: focusShared.cleanFocusUserText,
    writeFocusDiagnostic(owner, details) { diagnostics.push(details) } })
  const saved = new Map(), messages = [
    { id: 'u1', role: 'user', content: '产品路线选择', sourceMessageId: null, createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '旧卡片', sourceMessageId: 'answer-1', createdAt: 2 }
  ]
  saved.set('turn-1', { id: 'turn-1', userMessageId: 'u1', userText: '产品路线选择', createdAt: 1, updatedAt: 2,
    status: 'answered', executionIds: [], executionCycles: {}, deliveries: {},
    segments: [{ cycle: 0, sourceMessageId: 'answer-1', answer: '旧卡片', parts: [], settled: true }] })
  const store = { listFocusTurns: () => [...saved.values()].map(value => JSON.parse(JSON.stringify(value))),
    saveFocusTurn(session, platform, conversation, turn) { saved.set(turn.id, JSON.parse(JSON.stringify(turn))) },
    listConversationMessages: () => messages, listExecutions: () => [] }
  const runtime = new exports.Runtime(), owner = { sessionId: 'session', platformId: 'chatgpt', conversationId: 'one' }
  Object.assign(runtime, { focusSending: false, focusRevision: null, focusUiRecovering: false, focusUiRecoveredTurn: null,
    ownsFocus: () => true, options: { store }, runner: { hasInFlightWork: () => false }, focusChat: new FocusChat('session', store) })
  const page = { path: '/c/one', ready: true, nativeDraft: false, waiting: false, generating: 'active',
    reply: { sourceMessageId: 'answer-new', parts: [], answer: '正在形成的新回复' } }
  runtime.embed = {
    async readFocusUiRecovery() { calls.push('read'); return { sourceMessageId: 'answer-1', userMessageId: 'native-user', userText: '按这个方向深入设计：综合工具箱型工作台' } },
    async adoptFocusUiRecovery() { calls.push('adopt'); return true }, async readFocusSnapshot() { return page }
  }
  runtime.captureConversationMessage = (platform, role, text, sourceMessageId, attachments, turnId) => {
    captured.push({ role, text, sourceMessageId })
    const id = 'saved-' + captured.length
    messages.push({ id, role, content: text, sourceMessageId, createdAt: 100 + captured.length })
    if (role === 'user') runtime.focusChat.linkUser(platform, turnId, id)
  }
  return { runtime, owner, page, captured, calls, messages, saved, diagnostics }
}

test('a missed native send recovers its focus turn, follows the streamed answer and settles once without resending', async () => {
  const f = recoveryRuntimeFixture()
  const streaming = await f.runtime.getFocusChat(f.owner)
  assert.equal(streaming.turns.length, 2)
  assert.equal(streaming.turns.at(-1).userText, '按这个方向深入设计：综合工具箱型工作台')
  assert.equal(streaming.turns.at(-1).segments[0].answer, '正在形成的新回复')
  assert.equal(streaming.turns.at(-1).status, 'working')
  assert.deepEqual(f.calls, ['read', 'adopt'])
  assert.equal(f.captured.length, 1)
  f.page.generating = 'idle'; f.page.reply.answer = '新回复完成'
  const settled = await f.runtime.getFocusChat(f.owner)
  assert.equal(settled.turns.at(-1).status, 'answered')
  assert.equal(settled.turns.at(-1).segments[0].answer, '新回复完成')
  assert.equal(f.captured.length, 2)
  await f.runtime.getFocusChat(f.owner)
  assert.equal(f.captured.length, 2)
  assert.equal(f.diagnostics.filter(item => item.event === 'smart-ui-recovered').length, 1)
  f.runtime.focusChat = new FocusChat('session', f.runtime.options.store)
  await f.runtime.getFocusChat(f.owner)
  assert.equal(f.captured.length, 2, 'reopening the app cannot import the same native user twice')
})

test('recovery does not overwrite a new user send or cross a conversation change during its read', async () => {
  for (const scenario of ['send', 'owner', 'running']) {
    const f = recoveryRuntimeFixture()
    if (scenario === 'running') f.runtime.runner.hasInFlightWork = () => true
    else f.runtime.embed.readFocusUiRecovery = async () => {
      if (scenario === 'send') f.runtime.focusSending = true
      else f.runtime.ownsFocus = () => false
      return { sourceMessageId: 'answer-1', userMessageId: 'native-user', userText: '原生新消息' }
    }
    await f.runtime.getFocusChat(f.owner)
    assert.equal(f.captured.length, 0, scenario)
    assert.equal(f.calls.includes('adopt'), false, scenario)
  }
})
