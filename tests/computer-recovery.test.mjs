// User-run only: node --test tests/computer-recovery.test.mjs
// Actual SQLite recovery/coordinator/progression + synthetic page receipts. No Electron,
// helper, real desktop, shell, network, application profile or external file operation.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { fixture, recovery, shared, TaskCoordinator, plain } from './fixtures/computer-action-runtime.mjs'

const result = (action = 'click', patch = {}) => ({ type: 'computer_result', version: 1, action,
  ok: true, code: 'ok', execution: 'executed', message: 'Synthetic actual receipt', ...patch })
const image = { id: 'img_' + 'a'.repeat(32), mime_type: 'image/png', sha256: 'b'.repeat(64) }
function dispatch(f) {
  const p = f.coordinator.current('deepseek').progress
  p.phase = 'executing-tool'; p.currentStep.status = 'executing'; p.currentStep.execution = 'unknown'
  const update = { ...f.lease(), executionId: p.currentStep.id, at: Date.now(), event: 'dispatch' }
  assert.equal(f.coordinator.updateProgress(f.lease(), p, update), true)
  return update
}
function stage(f, returned) {
  f.pause(true); f.loop.enqueue(f.request()); const update = dispatch(f)
  if (returned) f.coordinator.recordComputerAction({ ...update, event: 'result', result: returned })
  return update
}

test('startup cancels queued admissions and preserves requirements; repeated startup is idempotent', t => {
  const f = fixture(t); f.pause(true); const oldToken = f.request().stepToken; f.loop.enqueue(f.request())
  const claims = plain(f.claims()), at = Date.now() + 10
  assert.equal(recovery.recoverInterruptedComputerActions(f.db, at), 1)
  assert.equal(f.state().execution_state, 'cancelled'); assert.equal(f.state().execution_fact, 'not_executed')
  assert.equal(f.state().delivery_state, 'cancelled'); assert.deepEqual(plain(f.claims()), claims)
  const task = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
  assert.equal(task.status, 'interrupted'); assert.equal(task.originalRequest, f.first.originalRequest)
  assert.deepEqual(plain(task.inputs), plain(f.first.inputs)); assert.equal(task.recovery.requiresObservation, true)
  assert.equal(task.progress.currentStep.stepToken, undefined); assert.equal(task.progress.currentStep.nextStepToken, undefined)
  assert.equal(recovery.recoverInterruptedComputerActions(f.db, at + 10), 0)
  assert.deepEqual(plain(f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')), plain(task))
  const restored = new TaskCoordinator('session-a', f.store, () => {})
  restored.context('deepseek', 'chat-a'); assert.equal(restored.current('deepseek'), null)
  assert.notEqual(restored.computerStepToken('deepseek'), oldToken)
  assert.equal(f.executions.length, 0); assert.equal(f.sends.length, 0)
})

test('a crash after dispatch but before the executor receipt becomes unknown, never queued', t => {
  const f = fixture(t, { action: 'click' }), update = stage(f)
  recovery.recoverInterruptedComputerActions(f.db)
  assert.equal(f.state().execution_state, 'unknown'); assert.equal(f.state().execution_fact, 'unknown')
  assert.equal(f.state().result_json, null); assert.equal(f.state().delivery_attempts, 0)
  const saved = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
  assert.equal(saved.progress.currentStep.execution, 'unknown'); assert.equal(saved.recovery.unknownExecutionId, update.executionId)
  assert.throws(() => f.store.saveAutonomousTasks([], undefined, update), /already-dispatched/)
  assert.equal(f.executions.length, 0); assert.equal(f.sends.length, 0)
})

test('crashes during formatting, uploading and submission retain known execution facts and image identities', t => {
  for (const delivery of ['pending', 'failed', 'uploading', 'sending', 'sent', 'unknown']) {
    const f = fixture(t, { action: 'click' }), update = stage(f, result('click', { attachments: [image], data: { artifact: 'C:\\out.xlsx' } }))
    f.db.prepare('UPDATE computer_actions SET delivery_state = ? WHERE execution_id = ?').run(delivery, update.executionId)
    const before = f.state()
    recovery.recoverInterruptedComputerActions(f.db)
    assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().execution_fact, 'executed')
    assert.equal(f.state().result_json, before.result_json); assert.equal(f.state().dispatched_at, before.dispatched_at)
    const expected = ['pending', 'failed'].includes(delivery) ? 'cancelled' : ['sending', 'uploading'].includes(delivery) ? 'unknown' : delivery
    assert.equal(f.state().delivery_state, expected); assert.equal(f.observations()[0].delivery_state, expected)
    assert.equal(f.observations()[0].image_id, image.id); assert.equal(f.observations()[0].sha256, image.sha256)
    const task = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
    assert.equal(task.progress.currentStep.execution, 'executed', 'a stale executing summary cannot erase the actual receipt')
    assert.equal(task.progress.currentStep.delivery, expected === 'unknown' ? 'uncertain' : expected)
    assert.equal(task.progress.currentStep.status, expected === 'sent' ? 'delivered' : 'interrupted')
  }
})

test('failed and cancelled actions with an executed fact retain it across startup', t => {
  for (const code of ['click_failed', 'cancelled']) {
    const f = fixture(t, { action: 'click' }); stage(f, result('click', { ok: false, code }))
    const before = f.state(); recovery.recoverInterruptedComputerActions(f.db)
    assert.equal(f.state().execution_state, before.execution_state); assert.equal(f.state().execution_fact, 'executed')
    assert.equal(f.state().result_json, before.result_json)
  }
})

test('a failed task checkpoint rolls back action and observation recovery in the same transaction', t => {
  const f = fixture(t, { action: 'click' }); stage(f, result('click', { attachments: [image] }))
  f.db.exec("UPDATE computer_actions SET delivery_state = 'uploading'")
  f.db.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE ON autonomous_tasks BEGIN SELECT RAISE(FAIL, 'synthetic disk failure'); END")
  assert.throws(() => recovery.recoverInterruptedComputerActions(f.db), /synthetic disk failure/)
  assert.equal(f.state().delivery_state, 'uploading'); assert.equal(f.observations()[0].delivery_state, 'pending')
  assert.equal(JSON.parse(f.payload()).status, 'recorded')
  f.db.exec('DROP TRIGGER reject_recovery')
})

test('a checkpoint-only failure still saves the executor receipt independently and stops progression', async t => {
  const f = fixture(t)
  f.db.exec(`CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON autonomous_tasks
    WHEN json_extract(NEW.payload, '$.progress.currentStep.execution') = 'executed'
      AND json_extract(NEW.payload, '$.progress.currentStep.status') = 'executing'
    BEGIN SELECT RAISE(FAIL, 'synthetic checkpoint failure'); END`)
  await f.run(); await f.loop.wake()
  assert.equal(f.state().execution_fact, 'executed'); assert.equal(f.state().execution_state, 'completed')
  assert.ok(f.state().result_json); assert.equal(f.executions.length, 1)
  assert.equal(f.sends.length, 0); assert.equal(f.errors.length, 1)
  f.db.exec('DROP TRIGGER reject_checkpoint')
})

test('resume needs an explicit matching owner, creates a new generation and never copies old executable steps', t => {
  const f = fixture(t), old = f.first, token = f.coordinator.computerStepToken('deepseek')
  f.coordinator.stop('deepseek', 'interrupted')
  assert.equal(f.submit({ resume: { taskId: 'another-task', generation: old.generation } }), null)
  assert.equal(f.submit({ resume: { taskId: old.id, generation: old.generation }, machine: { ...old.machine, id: 'another-machine' } }), null)
  const task = f.submit({ resume: { taskId: old.id, generation: old.generation } })
  assert.notEqual(task.id, old.id); assert.equal(task.generation, old.generation + 1)
  assert.equal(task.originalRequest, old.originalRequest); assert.equal(task.recovery.sourceTaskId, old.id)
  assert.equal(task.recovery.requiresObservation, true); assert.equal(task.progress.currentStep, null)
  assert.equal(task.progress.stepCount, 0); assert.notEqual(f.coordinator.computerStepToken('deepseek'), token)
  assert.equal(f.executions.length, 0); assert.equal(f.sends.length, 0)
})

test('a helper/executor unknown result installs a durable barrier; only a new successful observation clears it', async t => {
  let returned = result('click', { ok: false, execution: 'unknown', code: 'executor_error' })
  const f = fixture(t, { action: 'click', execute: () => returned })
  await f.run(); const unknown = f.state().execution_id
  assert.equal(f.coordinator.current('deepseek').recovery.unknownExecutionId, unknown)
  assert.equal(f.sends[0].task_recovery.requiresObservation, true)
  await f.run(); assert.equal(f.executions.length, 1)
  assert.equal(f.state().execution_fact, 'not_executed'); assert.equal(f.sends.at(-1).code, 'recovery_required')
  returned = result('list_windows'); await f.run(f.request({ call: { action: 'list_windows', parameters: {} } }))
  assert.equal(f.coordinator.current('deepseek').recovery.requiresObservation, true)
  returned = result('observe', { ok: false, code: 'capture_failed', execution: 'not_executed' })
  await f.run(f.request({ call: { action: 'observe', parameters: { target: 'desktop' } } }))
  assert.equal(f.coordinator.current('deepseek').recovery.requiresObservation, true)
  returned = result('observe'); await f.run(f.request({ call: { action: 'observe', parameters: { target: 'desktop' } } }))
  assert.equal(f.coordinator.current('deepseek').recovery.requiresObservation, false)
  assert.equal(f.coordinator.current('deepseek').recovery.observationStepId, f.state().execution_id)
  returned = result('click'); await f.run(); assert.equal(f.executions.at(-1).call.action, 'click')
  assert.equal(f.errors.length, 0)
})
test('recovery permits bounded diagnostics and window preparation without lifting the input barrier', async t => {
  let returned = result('click', { ok: false, execution: 'unknown', code: 'executor_error' })
  const f = fixture(t, { action: 'click', execute: () => returned })
  await f.run()
  for (const action of ['inspect_interactions', 'validate_observation', 'wait_for', 'focus_window']) {
    returned = result(action)
    await f.run(f.request({ call: { action, parameters: {} } }))
    assert.equal(f.executions.at(-1).call.action, action)
    assert.equal(f.coordinator.current('deepseek').recovery.requiresObservation, true)
  }
  const executed = f.executions.length
  returned = result('click'); await f.run()
  assert.equal(f.executions.length, executed); assert.equal(f.sends.at(-1).code, 'recovery_required')
})

test('a late receipt from an old generation can refine history without clearing the resumed task barrier', t => {
  const f = fixture(t, { action: 'observe' }), old = stage(f)
  f.coordinator.stop('deepseek', 'interrupted')
  const next = f.submit({ resume: { taskId: f.first.id, generation: f.first.generation } })
  f.coordinator.recordComputerAction({ ...old, event: 'result', result: result('observe') })
  assert.equal(f.coordinator.current('deepseek').id, next.id)
  assert.equal(f.coordinator.current('deepseek').recovery.requiresObservation, true)
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().delivery_state, 'cancelled')
  assert.equal(f.sends.length, 0)
})

test('recovery messages retain verbatim requirements and actual facts without replay tokens or raw wire requests', async t => {
  const f = fixture(t); await f.run()
  const task = f.coordinator.current('deepseek'), records = f.store.listComputerActions(f.lease())
  const text = recovery.computerRecoveryMessage(task, records), context = JSON.parse(text.slice(text.indexOf('\n') + 1))
  assert.equal(context.original_request, task.originalRequest); assert.equal(context.recent_actions[0].execution, 'executed')
  assert.equal(context.goal_verified, false); assert.equal(context.requires_fresh_observation, true)
  const stale = { ...task, progress: { ...task.progress, currentStep: { ...task.progress.currentStep, delivery: 'uncertain', execution: 'unknown' } } }
  const fresh = JSON.parse(recovery.computerRecoveryMessage(stale, records).split('\n').slice(1).join('\n'))
  assert.equal(fresh.last_step.execution, 'executed'); assert.equal(fresh.last_step.delivery, 'sent')
  assert.equal(text.includes('step_token'), false); assert.equal(text.includes('nextStepToken'), false)
  assert.equal(text.includes('rawJson'), false); assert.equal(text.includes('dataBase64'), false)
  const expanded = Array.from({ length: 33 }, () => ({ ...records[0], resultJson: JSON.stringify(result('observe', { data: 'x'.repeat(3000) })) }))
  const bounded = recovery.computerRecoveryMessage(task, expanded)
  assert.ok(bounded.length <= 20_000); assert.equal(JSON.parse(bounded.split('\n').slice(1).join('\n')).action_history_truncated, true)
  assert.throws(() => recovery.computerRecoveryMessage({ ...task, originalRequest: '全'.repeat(20_000) }, []), /超过消息长度/)
})

test('recovery metadata is validated and malformed checkpoints cannot silently restore authority', t => {
  const f = fixture(t); f.coordinator.stop('deepseek', 'interrupted')
  const task = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
  assert.ok(shared.parseAutonomousTask(JSON.stringify(task)))
  for (const patch of [{ version: 2 }, { sourceGeneration: 0 }, { requiresObservation: false }, { observationStepId: 123 }, { extra: true }]) {
    assert.equal(shared.parseAutonomousTask(JSON.stringify({ ...task, recovery: { ...task.recovery, ...patch } })), null)
  }
})

// Extract actual runtime methods so recovery send/ack ordering is checked without Electron.
const source = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const declaration = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionRuntime')
const methods = ['resumeAutonomousTask', 'resumeAutonomousTaskNow', 'embedHandlers', 'refreshRemoteRipgrep'].map(name => declaration.members.find(n => n.name?.getText(source) === name).getText(source)).join('\n')
const Runtime = new Script(ts.transpileModule(`class Runtime { ${methods} }; Runtime`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText).runInNewContext({ structuredClone, process: { platform: 'win32', arch: 'x64' }, setTimeout,
  console: { warn() {} }, computerRecoveryMessage: recovery.computerRecoveryMessage, recoverySendBlockedMessage: recovery.recoverySendBlockedMessage,
  computerUseSendBlock: () => null, supportsFocusView: () => false })
function runtime(f, send, status = { enabled: true, promptInjectionEnabled: true, pendingQuestion: null }) {
  const owner = f.lease(); f.coordinator.stop('deepseek', 'interrupted')
  const capability = { available: true, scopeSupported: true, computerUseEnabled: true, context: { sessionId: 'session-a', platformId: 'deepseek' } }
  const forced = []
  const embed = { getComputerUsePageEpoch: () => 'document-a', getInterceptorStatus: () => ({ ...status }),
    setInterceptorEnabled: enabled => { status.enabled = enabled }, cancelQuestion: async () => { status.pendingQuestion = null },
    userSendBlockReason: async () => 'text-draft',
    sendUserTask: (text, force) => { forced.push(force); return send(text, subject) } }
  const subject = Object.assign(new Runtime(), { id: 'session-a', active: true, activePlatformId: 'deepseek', embed,
    lastSubmissions: new Map(),
    options: { store: f.store, localMachineId: 'machine-a' }, taskCoordinator: f.coordinator, taskProgression: { wake: async () => {} },
    embeds: new Map([['deepseek', { conversationId: 'chat-a', embed }]]),
    ownsFocus: request => request.sessionId === 'session-a' && request.platformId === 'deepseek' && request.conversationId === 'chat-a',
    getComputerUseCapability: () => capability, getAutonomousTask: () => f.coordinator.context('deepseek', 'chat-a'),
    stopAutonomousTask: (platform, status) => f.coordinator.stop(platform, status),
    runner: { hasInFlightWork: () => false, getAutomation: () => ({ paused: false }), getTerminalState: () => ({ cwd: 'C:\\work' }) },
    backgroundTaskResults: { isSending: false }, focusChat: { begin: () => 'turn-resume' }, environment: {}, taskRecoverySend: null,
    setPromptInjectionEnabled: enabled => { status.promptInjectionEnabled = enabled }, setPaused: paused => { subject.runner.getAutomation = () => ({ paused }) } })
  return { subject, owner, status, forced }
}

test('native confirmed sends alone create the resumed generation; another explicit click sends again', async t => {
  let sends = 0
  const f = fixture(t), { subject, owner, forced } = runtime(f, async () => { sends++; return 'stuck' })
  assert.match(await subject.resumeAutonomousTask(owner), /确认/)
  assert.equal(f.store.autonomousTaskGeneration('session-a'), 1)
  assert.match(await subject.resumeAutonomousTask(owner), /确认/); assert.equal(sends, 2, 'the user chose to continue again')
  assert.deepEqual(forced, [true, true], 'every resume asks the page to clear its own blockers')
  const pending = subject.taskRecoverySend
  subject.embedHandlers({ id: 'deepseek' }).onUserStarted(pending.text, [], undefined, { id: 'user:resume:late', kind: 'goal' })
  const next = f.coordinator.current('deepseek')
  assert.equal(next.generation, 2); assert.equal(next.originalRequest, f.first.originalRequest)
  assert.equal(next.recovery.requiresObservation, true); assert.equal(f.executions.length, 0)
})

test('known pre-submit rejection permits a new user attempt without restoring or replaying anything', async t => {
  let sends = 0
  const f = fixture(t), { subject, owner } = runtime(f, async () => { sends++; return 'busy' })
  assert.match(await subject.resumeAutonomousTask(owner), /未发送的文字或附件/); assert.equal(subject.taskRecoverySend, null)
  await subject.resumeAutonomousTask(owner); assert.equal(sends, 2)
  assert.equal(f.store.autonomousTaskGeneration('session-a'), 1); assert.equal(f.executions.length, 0)
})

test('a blocked live task is retired before recovery submission so old delivery timers cannot resume', async t => {
  const f = fixture(t), { subject } = runtime(f, async () => {
    assert.equal(f.coordinator.current('deepseek'), null)
    return 'busy'
  })
  f.submit(); const owner = f.lease(), p = f.coordinator.current('deepseek').progress
  p.phase = 'blocked'; f.coordinator.updateProgress(owner, p)
  await subject.resumeAutonomousTask(owner)
  assert.equal(f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a').status, 'interrupted')
  assert.equal(f.executions.length, 0)
})

test('stale task identities and other conversations cannot submit a recovery', async t => {
  let calls = 0
  const f = fixture(t), { subject, owner } = runtime(f, async () => { calls++; return 'busy' })
  for (const patch of [{ taskId: 'other-task' }, { generation: 99 }, { conversationId: 'another-chat' }, { platformId: 'chatgpt' }, { sessionId: 'other-session' }]) {
    assert.ok(await subject.resumeAutonomousTask({ ...owner, ...patch }))
  }
  assert.equal(calls, 0)
})

test("an explicit resume clears the app's own blockers: pause, terminal mode, prompt injection and an open question", async t => {
  let calls = 0
  const status = { enabled: false, promptInjectionEnabled: false, pendingQuestion: { messageId: 'question-a', questions: [] } }
  const f = fixture(t), { subject, owner, forced } = runtime(f, async () => { calls++; return 'stuck' }, status)
  subject.runner.getAutomation = () => ({ paused: true })
  assert.match(await subject.resumeAutonomousTask(owner), /确认/)
  assert.equal(calls, 1); assert.deepEqual(forced, [true])
  assert.equal(subject.runner.getAutomation().paused, false)
  assert.deepEqual(status, { enabled: true, promptInjectionEnabled: true, pendingQuestion: null })
})

test('late recovery acknowledgement after a replacement cannot create or fail the new goal', async t => {
  const f = fixture(t), { subject, owner } = runtime(f, async () => 'stuck')
  await subject.resumeAutonomousTask(owner); const pending = subject.taskRecoverySend
  const next = f.submit()
  subject.embedHandlers({ id: 'deepseek' }).onUserStarted(pending.text, [], undefined, { id: 'user:resume:obsolete', kind: 'goal' })
  assert.equal(f.coordinator.current('deepseek').id, next.id)
  assert.equal(f.store.autonomousTaskGeneration('session-a'), 2); assert.equal(subject.taskRecoverySend, null)
})

test('unexpected native user-send replies and thrown submission calls are uncertain', async () => {
  const ast = ts.createSourceFile('embed.ts', readFileSync(new URL('../src/main/embed.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'ChatGptEmbed')
  const method = cls.members.find(n => n.name?.getText(ast) === 'sendUserTask').getText(ast)
  const Embed = new Script(ts.transpileModule(`class Embed { ${method} }; Embed`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({ URL })
  let response = undefined
  const subject = Object.assign(new Embed(), { platform: { homeUrl: 'https://chat.deepseek.com/' },
    liveContents: () => ({ getURL: () => 'https://chat.deepseek.com/a/chat/s/chat-a', executeJavaScript: async () => {
      if (response instanceof Error) throw response
      return response
    } }) })
  for (const value of [undefined, null, false, 'unexpected', new Error('lost acknowledgement')]) {
    response = value; assert.equal(await subject.sendUserTask('恢复原任务'), 'stuck')
  }
  response = 'busy'; assert.equal(await subject.sendUserTask('恢复原任务'), 'busy')
})
