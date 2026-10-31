// User-run only: node --test tests/deepseek-analysis-retry.test.mjs tests/deepseek-reply-guards.test.mjs
// Actual retry helpers and native click bridge, fake DOM/timers only. No Electron, session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const pageSource = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function initializer(name) {
  const find = node => ts.isVariableDeclaration(node) && node.name.getText(pageSource) === name ? node.initializer : ts.forEachChild(node, find)
  const value = find(pageSource)
  assert.ok(value, name)
  return value.getText(pageSource)
}
const helpers = ['nativeEditRows', 'latestUserRow', 'nativeEditor', 'nativeEditRejection', 'startNativeEditRetry',
  'nativeEditPoint', 'nativeEditWait', 'nativeRetryPrefix', 'giveUpSafetyLeak', 'resendAfterSafetyLeak', 'replyLeakKind', 'retryReplyByEditing', 'handleSafetyLeak']
const code = helpers.map(name => `const ${name} = ${initializer(name)};`).join('\n')
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function fixture() {
  const events = [], timers = [], sent = []
  let now = 1000, opened = false, generating = false, failOpen = false, covered = false
  const rules = { rowSelector: '[data-virtual-list-item-key]', buttonSelector: '.edit', editorSelector: '.editor', submitSelector: '.send',
    analysisLeakPattern: '^<analysis>\\s*\\S', safetyLeakPattern: '^<ds_safety>[\\s\\S]*</ds_safety>\\s*Safe$', retryStoppedByEditing: true }
  const edit = { x: 10 }, send = { x: 30 }
  for (const button of [edit, send]) Object.assign(button, {
    scrollIntoView() {}, getBoundingClientRect: () => ({ left: button.x, top: 0, width: 10, height: 10 }),
    contains: node => node === button
  })
  const editor = { value: '【上一条命令执行结果】\n目录: /work/project\n原始完整输出，不得重写。', closest: () => row }
  const row = { key: '1', getAttribute: () => row.key, matches: () => false,
    querySelector: selector => selector === rules.buttonSelector ? edit : selector === rules.submitSelector ? send : null,
    querySelectorAll: selector => selector === rules.editorSelector && opened ? [editor] : [],
    contains: node => [edit, send, editor, row].includes(node) }
  const reply = { assistant: true, id: 'reply-2', markdown: '<analysis> 让我梳理整个对话' }
  const rows = [row, reply]
  const composer = { value: '' }
  const state = { enabled: true, computerUseEnabled: false, taskActive: true, awaitingReplySince: now,
    taskPromptGeneration: 4, pendingQuestion: null, programmatic: false, replyActionDetected: false }
  const context = {
    PAGE: { nativeEdit: rules, computerUseRequests: true, fileTurnPositionAttr: 'data-virtual-list-item-key' },
    state, location: { pathname: '/a/chat/s/one' }, Date: { now: () => now },
    safetyLeak: { count: 0, busy: false, failedKey: null }, nativeEditRetry: null,
    computerSourceSubmissionId: null, focusEditing: null, fileSend: null,
    focusReplyBaseline: null, focusBaselinePosition: null, focusReplyPosition: null,
    focusRowPosition: node => node === reply ? '2' : node?.key || null,
    queryAll: selectors => selectors.includes(rules.rowSelector) ? rows : selectors.includes(rules.editorSelector) && opened ? [editor] : [],
    queryAllAssistant: () => rows, latestReplyNode: nodes => nodes.at(-1), turnKeyOf: node => node.id,
    isAssistantTurn: node => !!node.assistant, isVisibleElement: node => !!node,
    collapse: text => String(text || '').replace(/\s+/g, ' ').trim(),
    getComposer: () => composer, readComposer: node => node?.value || '',
    hasDraftImageAttachment: () => false, draftAttachmentEvidence: () => false, attachmentSnapshot: () => ({}),
    controlDisabled: button => button.disabled === true,
    computerBaselineOf: () => ({ ids: new Set([reply.id]) }), lastAssistantId: () => reply.id,
    findStopButton: () => generating ? {} : null,
    readReplyMarkdown: node => node.markdown,
    setReplyWaiting(since) { state.awaitingReplySince = since }, scheduleCheck() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }) },
    document: { elementFromPoint: x => covered ? {} : x === 15 ? edit : send },
    report(event) {
      events.push(event)
      if (['analysis-leak-edit-click', 'stopped-retry-edit-click'].includes(event.reason) && !failOpen) opened = true
      if (['analysis-leak-send-click', 'stopped-retry-send-click'].includes(event.reason)) { sent.push(editor.value); opened = false; generating = true }
    }
  }
  context.api = new Script(code + '\n({ handleSafetyLeak, resendAfterSafetyLeak, replyLeakKind, retryReplyByEditing })').runInNewContext(context)
  return { context, state, row, reply, rows, composer, editor, edit, send, events, sent,
    recover() { return context.api.handleSafetyLeak(reply.id, reply.markdown, reply) },
    stopGenerating() { generating = false },
    failOpen() { failOpen = true }, cover() { covered = true },
    advance(delay) {
      now += delay
      const due = timers.filter(timer => timer.delay === delay)
      for (const timer of due) { timers.splice(timers.indexOf(timer), 1); timer.callback() }
    }
  }
}

test('terminal-mode analysis recovery clicks edit then send and preserves the complete original message', async () => {
  const f = fixture(), original = f.editor.value
  assert.equal(f.recover(), true)
  await tick()
  assert.deepEqual(f.events.filter(event => event.reason.endsWith('-click')).map(event => event.reason), ['analysis-leak-edit-click', 'analysis-leak-send-click'])
  assert.deepEqual(f.sent, [original])
  f.advance(200)
  assert.ok(f.events.some(event => event.reason === 'native-edit-retry'))
  assert.equal(f.state.replyActionDetected, false)
  assert.equal(f.state.lastCommandMessageId, null)
})

test('repeated abnormal replies share a two-attempt budget without requiring computer-use mode', async () => {
  const f = fixture()
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(f.recover(), true)
    await tick()
    f.advance(200)
    f.stopGenerating()
  }
  assert.equal(f.recover(), false)
  assert.equal(f.sent.length, 2)
  assert.ok(f.events.some(event => event.reason === 'analysis-leak-limit'))
})

test('stopped replies edit and resend the original user message even with only a reasoning panel', async () => {
  const f = fixture(), original = f.editor.value
  const reasoning = { id: 'stopped-reply', matches: () => false,
    querySelector: selector => selector === '.reasoning' ? {} : null }
  f.context.PAGE.focus = { reasoningSelectors: ['.reasoning'] }
  f.rows.push(reasoning)
  assert.equal(f.context.api.retryReplyByEditing(reasoning.id, 'stopped'), true)
  await tick()
  assert.deepEqual(f.events.filter(event => event.reason.endsWith('-click')).map(event => event.reason), ['stopped-retry-edit-click', 'stopped-retry-send-click'])
  assert.deepEqual(f.sent, [original])
  f.advance(200)
  assert.equal(f.state.lastCommandMessageId, null)
  assert.ok(f.events.some(event => event.reason === 'native-edit-retry'))
})

test('stopped and analysis recovery share one resend limit for the same user message', async () => {
  const f = fixture()
  f.recover(); await tick(); f.advance(200); f.stopGenerating()
  assert.equal(f.context.api.retryReplyByEditing(f.reply.id, 'stopped'), true)
  await tick(); f.advance(200); f.stopGenerating()
  assert.equal(f.context.api.retryReplyByEditing(f.reply.id, 'stopped'), false)
  assert.equal(f.sent.length, 2)
  assert.ok(f.events.some(event => event.reason === 'stopped-retry-limit'))
})

test('drafts, disabled/covered buttons and open questions never submit a retry', async () => {
  for (const condition of ['draft', 'disabled', 'covered', 'question']) {
    const f = fixture()
    if (condition === 'draft') f.composer.value = '用户正在输入'
    if (condition === 'disabled') f.edit.disabled = true
    if (condition === 'covered') f.cover()
    if (condition === 'question') f.state.pendingQuestion = { id: 'pending' }
    f.recover(); await tick()
    assert.equal(f.sent.length, 0, condition)
    assert.equal(f.events.some(event => event.reason === 'analysis-leak-edit-click'), false, condition)
  }
})

test('conversation, task, row or generation changes while opening the editor cancel resend', async () => {
  for (const condition of ['path', 'generation', 'stop', 'row', 'new-send']) {
    const f = fixture()
    f.recover()
    if (condition === 'path') f.context.location.pathname = '/a/chat/s/two'
    if (condition === 'generation') f.state.taskPromptGeneration++
    if (condition === 'stop') f.state.taskActive = false
    if (condition === 'row') f.row.key = 'another-user'
    if (condition === 'new-send') f.context.safetyLeak = { count: 0, busy: false, failedKey: null }
    await tick()
    assert.equal(f.sent.length, 0, condition)
  }
})

test('code examples and other platforms have no analysis recovery rule', () => {
  const f = fixture()
  f.reply.markdown = '```xml\n<analysis>示例</analysis>\n```'
  assert.equal(f.context.api.replyLeakKind('<analysis>示例</analysis>', f.reply), null)
  f.context.PAGE.nativeEdit = null
  assert.equal(f.context.api.replyLeakKind('<analysis>正文', f.reply), null)
})

const embedSource = ts.createSourceFile('embed.ts', readFileSync(new URL('../src/main/embed.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const embed = embedSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ChatGptEmbed')
const click = embed.members.find(node => node.name?.getText(embedSource) === 'clickNativeEdit')
const Bridge = new Script(compile(`class Bridge { ${click.getText(embedSource)} }; Bridge`)).runInNewContext({ URL })

test('native clicks are scoped to an active DeepSeek task, current generation and current URL', () => {
  for (const condition of ['valid', 'stopped-retry', 'stopped-disabled', 'platform', 'generation', 'route', 'stopped', 'question', 'safety-disabled']) {
    const clicks = [], bridge = Object.assign(new Bridge(), {
      platform: { id: 'deepseek', page: { nativeEdit: { retryStoppedByEditing: true } }, allowedOriginPattern: /^https:\/\/chat\.deepseek\.com\// },
      interceptor: { enabled: true, taskFinishedAt: null, pendingQuestion: null }, taskPromptGeneration: 4,
      computerUseRecognitionEnabled: false,
      liveContents: () => ({ getURL: () => 'https://chat.deepseek.com/a/chat/s/one' }),
      clickAt: (...point) => clicks.push(point)
    })
    const event = { reason: 'analysis-leak-edit-click', taskPromptGeneration: 4, taskActive: true, awaitingReply: true,
      pagePath: '/a/chat/s/one', x: 15, y: 5 }
    if (condition === 'platform') bridge.platform.id = 'chatgpt'
    if (condition === 'generation') event.taskPromptGeneration++
    if (condition === 'route') event.pagePath = '/a/chat/s/two'
    if (condition === 'stopped') bridge.interceptor.taskFinishedAt = 1
    if (condition === 'question') bridge.interceptor.pendingQuestion = {}
    if (condition === 'safety-disabled') event.reason = 'safety-leak-edit-click'
    if (condition === 'stopped-retry' || condition === 'stopped-disabled') event.reason = 'stopped-retry-send-click'
    if (condition === 'stopped-disabled') bridge.platform.page.nativeEdit.retryStoppedByEditing = false
    bridge.clickNativeEdit(event)
    assert.equal(clicks.length, condition === 'valid' || condition === 'stopped-retry' ? 1 : 0, condition)
  }
})
