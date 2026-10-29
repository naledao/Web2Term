// User-run only. Actual task/SQLite/runtime/bridge code with synthetic page sends.
// No Electron, real helper, desktop, shell, app profile or external network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { fixture, plain, shared, deferred, recovery } from './fixtures/computer-action-runtime.mjs'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'

const metadata = progressVmModules['../shared/task-clarification']
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const sourceFor = f => ({ sourceSubmissionId: f.first.sourceSubmissionId, taskPromptGeneration: 3, pagePath: '/a/chat/s/chat-a', pageEpoch: 'document-a' })
const questionFor = (id = 'question:a') => ({ messageId: id, questions: [{ question: '无法从环境确定收件人；本次是否只生成文件、不发送？', placeholder: '', options: ['只生成，不发送', '提供收件人后再决定'] }] })
const task = f => f.coordinator.current('deepseek')
function ask(f, id) { return f.coordinator.recordQuestion(f.lease(), questionFor(id), sourceFor(f)) }
function answer(f, text = '只生成文件，不发送，不修改执行模式。', id = 'answer:a', questionId = 'question:a', source = sourceFor(f)) {
  return f.submit({ text, submission: { id, kind: 'clarification', answerTo: { messageId: questionId, ...source } } })
}
function actualClass(path, name, names, globals = {}) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name)
  const body = names.map(name => cls.members.find(node => node.name?.getText(source) === name).getText(source)).join('\n')
  return new Script(compile(`class Subject { ${body} }; Subject`)).runInNewContext({ structuredClone, URL, console: { info() {}, warn() {} }, ...metadata, ...globals })
}

test('a live question pauses admission, retains the goal and invalidates grants without changing execution settings', async t => {
  const f = fixture(t), original = f.first, token = f.coordinator.computerStepToken('deepseek')
  assert.equal(ask(f), true); assert.equal(ask(f), false)
  assert.equal(task(f).id, original.id); assert.equal(task(f).generation, original.generation)
  assert.equal(task(f).originalRequest, original.originalRequest); assert.deepEqual(plain(task(f).inputs), plain(original.inputs))
  assert.equal(task(f).progress.phase, 'waiting-user'); assert.equal(f.coordinator.waitingForUser('deepseek'), true)
  assert.equal(f.coordinator.computerStepToken('deepseek'), null)
  assert.equal(f.coordinator.reserveToolStep(f.lease(), 'command:a', 'command', original.machine), null)
  await f.run(f.request({ stepToken: token })); assert.equal(f.executions.length, 0)
  assert.ok(shared.parseAutonomousTask(f.payload()))
})

test('only a matching confirmed answer continues the same goal and requires a fresh observation', async t => {
  const f = fixture(t), before = f.coordinator.computerStepToken('deepseek'); ask(f)
  const updated = answer(f)
  assert.equal(updated.id, f.first.id); assert.equal(updated.generation, f.first.generation)
  assert.equal(updated.clarifications.items[0].state, 'answered')
  assert.equal(updated.inputs.at(-1).text, '只生成文件，不发送，不修改执行模式。')
  assert.equal(updated.progress.phase, 'waiting-model'); assert.equal(updated.progress.currentStep, null)
  assert.equal(updated.recovery.requiresObservation, true); assert.notEqual(f.coordinator.computerStepToken('deepseek'), before)
  const count = updated.inputs.length; answer(f); assert.equal(task(f).inputs.length, count)
  await f.run(f.request({ call: { action: 'click', parameters: {} } }))
  assert.equal(f.executions.length, 0); assert.equal(f.sends.at(-1).code, 'recovery_required')
  await f.run(f.request({ call: { action: 'observe', parameters: { target: 'desktop' } } }))
  assert.equal(task(f).recovery.requiresObservation, false)
  assert.ok(shared.parseAutonomousTask(f.payload()))
})

test('wrong question, source, page, prompt generation and orphaned answers cannot release the wait', t => {
  const f = fixture(t); ask(f)
  for (const patch of [{ pageEpoch: 'old' }, { taskPromptGeneration: 2 }, { pagePath: '/a/chat/s/other' }, { sourceSubmissionId: 'user:other:1' }])
    assert.equal(answer(f, '允许', 'answer:' + JSON.stringify(patch), 'question:a', { ...sourceFor(f), ...patch }), null)
  assert.equal(answer(f, '允许', 'answer:wrong-question', 'question:other'), null)
  assert.equal(f.submit({ submission: { id: 'answer:missing-source', kind: 'clarification' }, text: '允许' }), null)
  assert.equal(f.coordinator.waitingForUser('deepseek'), true); assert.equal(task(f).inputs.length, 1)
  f.submit({ text: '新的独立目标' })
  assert.equal(answer(f, '允许', 'answer:late'), null)
  assert.equal(task(f).originalRequest, '新的独立目标'); assert.equal(task(f).inputs.length, 1)
})

test('dismissal and unknown delivery never become consent; late actual answers may still resolve their own question', t => {
  const f = fixture(t); ask(f)
  assert.equal(f.coordinator.questionState(f.lease(), 'question:a', 'dismissed'), true)
  assert.equal(task(f).progress.phase, 'waiting-user'); assert.equal(task(f).inputs.length, 1)
  assert.equal(f.coordinator.questionState(f.lease(), 'question:a', 'sending'), true)
  assert.equal(f.coordinator.questionState(f.lease(), 'question:a', 'uncertain'), true)
  assert.equal(f.coordinator.questionState(f.lease(), 'question:a', 'sending'), false)
  f.coordinator.questionState(f.lease(), 'question:a', 'dismissed')
  assert.equal(task(f).clarifications.items[0].state, 'uncertain')
  assert.equal(f.coordinator.clarificationSummary(f.lease()).grants_permissions, false)
  assert.equal(answer(f).clarifications.items[0].state, 'answered')
})

test('a late answer to the previous question is saved without dismissing a newer question', t => {
  const f = fixture(t); ask(f); ask(f, 'question:b')
  answer(f, '第一题只生成文件，不发送。')
  assert.equal(task(f).clarifications.items[0].state, 'answered')
  assert.equal(task(f).clarifications.items[1].state, 'pending')
  assert.equal(task(f).progress.phase, 'waiting-user'); assert.equal(f.coordinator.computerStepToken('deepseek'), null)
  assert.ok(shared.parseAutonomousTask(f.payload()))
})

test('late executor output refines history but cannot clear the post-answer observation barrier', async t => {
  const held = deferred(), f = fixture(t, { execute: () => held.promise })
  f.loop.enqueue(f.request()); const running = f.loop.wake()
  for (let n = 0; n < 10 && !f.executions.length; n++) await new Promise(setImmediate)
  ask(f); f.loop.cancel(); answer(f)
  held.resolve({ type: 'computer_result', version: 1, action: 'observe', ok: true, code: 'ok', execution: 'executed', message: 'late real observation' })
  await running
  assert.equal(f.state().execution_fact, 'executed'); assert.equal(task(f).recovery.requiresObservation, true)
  assert.equal(task(f).progress.currentStep, null); assert.equal(f.sends.length, 0)
})

test('bounded question history retains every full confirmed answer as an original-task input', t => {
  const f = fixture(t)
  for (let n = 0; n < 34; n++) { ask(f, `question:${n}`); answer(f, `限制 ${n}：不发布、不覆盖。`, `answer:${n}`, `question:${n}`) }
  assert.equal(task(f).clarifications.items.length, 32); assert.equal(task(f).clarifications.truncated, true)
  assert.equal(task(f).inputs.length, 35); assert.equal(task(f).inputs[1].text, '限制 0：不发布、不覆盖。')
  assert.ok(shared.parseAutonomousTask(f.payload()))
  for (const patch of [{ state: 'approved' }, { source: { ...sourceFor(f), extra: true } }, { answer: { submissionId: 'missing', text: '允许', receivedAt: Date.now() } }]) {
    const corrupt = JSON.parse(f.payload()); Object.assign(corrupt.clarifications.items[0], patch)
    assert.equal(shared.parseAutonomousTask(JSON.stringify(corrupt)), null)
  }
})

test('restart turns an in-flight answer into unknown history and does not restore consent or live grants', t => {
  const f = fixture(t); ask(f); f.coordinator.questionState(f.lease(), 'question:a', 'sending')
  recovery.recoverInterruptedComputerActions(f.db)
  const restored = JSON.parse(f.payload())
  assert.equal(restored.status, 'interrupted'); assert.equal(restored.clarifications.items[0].state, 'uncertain')
  assert.equal(restored.clarifications.items[0].answer, null); assert.equal(restored.inputs.length, 1)
  const message = recovery.computerRecoveryMessage(restored, [])
  const context = JSON.parse(message.slice(message.indexOf('\n') + 1))
  assert.equal(context.clarification_history.grants_permissions, false); assert.equal(context.clarification_history.history_only, true)
  assert.ok(shared.parseAutonomousTask(f.payload()))
})

const Runtime = actualClass('../src/main/session-runtime.ts', 'SessionRuntime', ['answerQuestion', 'cancelQuestion', 'reopenTaskQuestion'])
function runtime(f, send) {
  ask(f)
  const calls = [], settings = { mode: 'manual', paused: true }, pending = questionFor()
  const embed = { getInterceptorStatus: () => ({ pendingQuestion: pending }), getComputerUsePageEpoch: () => 'document-a',
    async answerQuestion(id, text, source) { calls.push(['answer', id, text, source]); return send ? send(id, text, source) : (answer(f, text), { pendingQuestion: null }) },
    async cancelQuestion(id) { calls.push(['cancel', id]); return { pendingQuestion: null } },
    async replayQuestion(...args) { calls.push(['reopen', ...args]); return 'ok' } }
  const subject = Object.assign(new Runtime(), { id: f.first.sessionId, active: true, disposed: false, activePlatformId: 'deepseek', taskCoordinator: f.coordinator,
    embed, getComputerUseCapability: () => ({ computerUseEnabled: true, desktopControlEnabled: false }), runner: { getAutomation: () => settings },
    ownsFocus: value => value.sessionId === f.first.sessionId && value.platformId === 'deepseek' && value.conversationId === 'chat-a' })
  return { subject, calls, settings, request: () => ({ ...f.lease(), questionId: metadata.pendingTaskQuestion(task(f)).id }) }
}

test('runtime records confirmed refusal/limits without changing paused mode or desktop-control preferences', async t => {
  const f = fixture(t), r = runtime(f)
  await r.subject.answerQuestion('question:a', '不允许发送，只保存本地；继续保持手动模式。', r.request())
  assert.equal(task(f).clarifications.items[0].state, 'answered')
  assert.deepEqual(r.settings, { mode: 'manual', paused: true })
  assert.equal(r.subject.getComputerUseCapability().desktopControlEnabled, false)
  assert.equal(Object.hasOwn(task(f).clarifications.items[0], 'approved'), false)
})

test('known pre-submit rejection permits retry; unknown submission prevents duplicate sends', async t => {
  const f = fixture(t); let outcome = 'busy'
  const r = runtime(f, async () => { assert.equal(metadata.pendingTaskQuestion(task(f)).state, 'sending'); throw Object.assign(new Error('synthetic'), { questionOutcome: outcome }) })
  await assert.rejects(r.subject.answerQuestion('question:a', '只保存', r.request()), /synthetic/)
  assert.equal(metadata.pendingTaskQuestion(task(f)).state, 'pending')
  outcome = 'stuck'; await assert.rejects(r.subject.answerQuestion('question:a', '只保存', r.request()), /synthetic/)
  assert.equal(metadata.pendingTaskQuestion(task(f)).state, 'uncertain')
  await assert.rejects(r.subject.answerQuestion('question:a', '只保存', r.request()), /不会重复发送/)
  assert.equal(r.calls.length, 2); assert.equal(task(f).inputs.length, 1)
})

test('a page ok result without the matching human-send event is not task authorization', async t => {
  const f = fixture(t), r = runtime(f, async () => ({ pendingQuestion: null }))
  await assert.rejects(r.subject.answerQuestion('question:a', '允许', r.request()), /真实发送确认/)
  assert.equal(metadata.pendingTaskQuestion(task(f)).state, 'uncertain'); assert.equal(task(f).inputs.length, 1)
})

test('local close keeps the task waiting; reopening is scoped and sends no answer or new model task', async t => {
  const f = fixture(t), r = runtime(f), request = r.request()
  await r.subject.cancelQuestion('question:a', request)
  assert.equal(metadata.pendingTaskQuestion(task(f)).state, 'dismissed'); assert.equal(task(f).progress.phase, 'waiting-user')
  assert.match(await r.subject.reopenTaskQuestion({ ...request, generation: 2 }), /切换或停止/)
  assert.equal(await r.subject.reopenTaskQuestion(request), '')
  assert.deepEqual(r.calls.map(c => c[0]), ['cancel', 'reopen']); assert.equal(task(f).inputs.length, 1)
  assert.deepEqual(plain(r.calls[1][3]), sourceFor(f))
})

test('a stale dialog cannot answer or close a new task even when the assistant message id is reused', async t => {
  const f = fixture(t), r = runtime(f), oldOwner = r.request()
  f.submit({ text: '新任务' })
  f.coordinator.recordQuestion(f.lease(), questionFor(), { ...sourceFor(f), sourceSubmissionId: task(f).sourceSubmissionId })
  await assert.rejects(r.subject.answerQuestion('question:a', '允许', oldOwner), /所属任务或问题已变化/)
  await assert.rejects(r.subject.cancelQuestion('question:a', oldOwner), /所属任务或问题已变化/)
  await assert.rejects(r.subject.answerQuestion('question:a', '允许'), /所属任务或问题已变化/)
  assert.equal(r.calls.length, 0); assert.equal(task(f).progress.phase, 'waiting-user'); assert.equal(task(f).inputs.length, 1)
})

test('actual runtime question handling clears queued work, cancels only live dispatch and binds the dialog owner', t => {
  const f = fixture(t), observed = [], owners = [], cancelled = []
  const Subject = actualClass('../src/main/session-runtime.ts', 'SessionRuntime', ['recordTaskQuestion'])
  const subject = Object.assign(new Subject(), { id: f.first.sessionId, disposed: false, active: true, taskEnded: false, activePlatformId: 'deepseek',
    embeds: new Map([['deepseek', { platform: { conversationIdFromPath: () => 'chat-a' }, embed: {
      getComputerUsePageEpoch: () => 'document-a', setTaskQuestionContext: (...args) => owners.push(args) } }]]),
    getComputerUseCapability: () => ({ scopeSupported: true, computerUseEnabled: true }), syncAutonomousTask: (...args) => f.coordinator.context(...args),
    taskCoordinator: f.coordinator, taskProgression: { cancel: () => { cancelled.push(true); f.loop.cancel() } },
    pendingTaskCommand: {}, pendingTaskComputer: {}, pendingTaskReply: {}, deferredCommands: new Map([['old', {}]]), computerUseTool: {},
    options: { computerUseObservations: { invalidateInput: (...args) => observed.push(args) }, desktopCoordinator: { reconcile() {} } } })
  subject.recordTaskQuestion('deepseek', questionFor(), sourceFor(f))
  assert.equal(cancelled.length, 1); assert.equal(observed.length, 1); assert.equal(subject.deferredCommands.size, 0)
  assert.equal(subject.pendingTaskCommand, null); assert.equal(subject.pendingTaskComputer, null)
  assert.equal(owners[0][1].taskId, f.first.id); assert.equal(owners[0][1].questionId, task(f).clarifications.items[0].id)
  subject.recordTaskQuestion('deepseek', questionFor('stale'), { ...sourceFor(f), pageEpoch: 'old' })
  assert.equal(cancelled.length, 1)
})

function nativeQuestionApi(overrides = {}) {
  const source = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  let method
  const helpers = new Map()
  const visit = node => {
    if (ts.isMethodDeclaration(node) && node.name?.getText(source) === 'answerQuestion') method = node.getText(source)
    if (ts.isVariableDeclaration(node) && ['userPromptInjection', 'reportUserInjection', 'USER_TEXT_SENTINEL'].includes(node.name.getText(source))) helpers.set(node.name.getText(source), node.initializer.getText(source))
    ts.forEachChild(node, visit)
  }; visit(source)
  const events = [], calls = [], state = { enabled: true, promptInjectionEnabled: true, replyProtocolPrefix: 'SHORT\n\n', replyProtocolVersion: 1,
    injectedCount: 0, taskPromptInjected: true,
    pendingQuestion: { ...questionFor(), taskSource: { sourceSubmissionId: 'user:goal:1', taskPromptGeneration: 3, pagePath: '/a/chat/s/chat-a', pageEpoch: 'document-a' } }, taskPromptGeneration: 3 }
  const window = { synthetic: { async sendRaw(...args) { calls.push(args); state.pendingQuestion = null; return 'ok' } } }
  const helperSource = [...helpers].map(([name, value]) => `const ${name} = ${value};`).join('\n')
  const api = new Script(`${helperSource}\n({${method}})`).runInNewContext({ state, window, STATE_KEY: 'synthetic', computerPageEpoch: 'document-a', location: { pathname: '/a/chat/s/chat-a' },
    normalizeLineEndings: value => value.replace(/\r\n?/g, '\n'), report: event => events.push(event), ...overrides })
  return { api, state, events, calls, window }
}

test('actual page answer code captures provenance before the sender clears the pending question', async () => {
  const f = nativeQuestionApi(), source = f.state.pendingQuestion.taskSource
  assert.equal(await f.api.answerQuestion('question:a', '不发送', source), 'ok')
  const message = f.events.find(event => event.event === 'user-message')
  assert.equal(message.answeredQuestionId, 'question:a'); assert.deepEqual(plain(message.questionSource), source)
  assert.equal(message.text, '不发送')
  assert.equal(f.calls[0][0], 'SHORT\n\n\u2063\u2063不发送')
  assert.equal(f.events.find(event => event.event === 'injected').promptInjected, false)
  assert.equal(f.calls[0][2].generation, 3); assert.equal(f.calls[0][2].path, source.pagePath)
  const stale = nativeQuestionApi()
  assert.equal(await stale.api.answerQuestion('question:a', '允许', { ...source, pageEpoch: 'old' }), 'stale')
  assert.equal(stale.calls.length, 0)
})

test('question replies honor the injection switch and retain only their own failed prefixed draft for retry', async () => {
  const off = nativeQuestionApi()
  off.state.promptInjectionEnabled = false
  assert.equal(await off.api.answerQuestion('question:a', '只保存本地'), 'ok')
  assert.equal(off.calls[0][0], '只保存本地')
  assert.equal(off.events.some(event => event.event === 'injected'), false)

  const composer = { text: '' }
  const f = nativeQuestionApi({ getComposer: () => composer, composerMatches: (node, text) => node.text === text })
  f.window.synthetic.sendRaw = async text => { composer.text = text; return 'stuck' }
  assert.equal(await f.api.answerQuestion('question:a', '两行回答\n  第二行'), 'stuck')
  assert.equal(f.state.answerDraft.text, 'SHORT\n\n\u2063\u2063两行回答\n  第二行')
  assert.equal(f.state.pendingQuestion.messageId, 'question:a')
  assert.equal(f.events.length, 0, 'uncertain delivery cannot resolve the question or confirm the reminder')
  let retryDraft
  f.window.synthetic.sendRaw = async (_text, owned) => { retryDraft = owned; return 'ok' }
  assert.equal(await f.api.answerQuestion('question:a', '修改后的回答'), 'ok')
  assert.equal(retryDraft, 'SHORT\n\n\u2063\u2063两行回答\n  第二行')
  assert.equal(f.events.find(event => event.event === 'user-message').text, '修改后的回答')
})

test('actual main bridge binds live questions, excludes history/replay and preserves a newer question on a late answer', () => {
  const Embed = actualClass('../src/main/embed.ts', 'ChatGptEmbed', ['handlePageReport', 'taskActionSource'], {
    INTERCEPTOR_LOG_TAG: '[cmd-terminal] ', writeReplyDiagnostic() {}, writePromptDiagnostic() {}, conversationIdOf: () => 'chat-a'
  })
  const recorded = [], received = [], source = { sourceSubmissionId: 'user:goal:1', taskPromptGeneration: 3, pagePath: '/a/chat/s/chat-a', pageEpoch: 'document-a' }
  const embed = Object.assign(new Embed(), { platform: { id: 'deepseek', allowedOriginPattern: /^https:\/\/chat\.deepseek\.com\//, conversationIdFromPath: () => 'chat-a' },
    computerUseRecognitionEnabled: true, taskPromptGeneration: 3, computerPageEpoch: 'document-a', interceptor: { pendingQuestion: null },
    userSubmissions: new Set(), focusSendImages: new Map(), taskQuestionBindings: new Map(),
    liveContents: () => ({ getURL: () => 'https://chat.deepseek.com/a/chat/s/chat-a' }), getInterceptorStatus: () => ({}), deliverUserMessage() {},
    handlers: { onTaskQuestion: (...args) => recorded.push(args), onQuestion() {}, onQuestionRecorded() {}, onAssistantMessage() {}, onInterceptor() {},
      onUserStarted: (_text, _files, _edit, submission) => received.push(submission) } })
  const report = event => embed.handlePageReport('[cmd-terminal] ' + JSON.stringify(event))
  report({ event: 'question-history', messageId: 'history', rawJson: '{}' })
  report({ event: 'question', ...questionFor('replayed'), live: true, questionReplay: true, questionSource: source })
  assert.equal(recorded.length, 0)
  report({ event: 'question', ...questionFor(), live: true, questionSource: source })
  report({ event: 'question', ...questionFor('question:b'), live: true, questionSource: source })
  assert.equal(recorded.length, 2)
  report({ event: 'user-message', text: '第一题不发送', submissionId: 'user:answer:1', submissionKind: 'clarification',
    taskPromptGeneration: 3, questionSource: source, answeredQuestionId: 'question:a' })
  assert.equal(received[0].answerTo.messageId, 'question:a')
  assert.equal(embed.interceptor.pendingQuestion.messageId, 'question:b')
})
