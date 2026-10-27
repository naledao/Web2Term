// User-run only. Synthetic receipts, clocks, file verifiers and the actual in-memory SQLite store.
// No Electron, helper, desktop, shell, network or user artifact is accessed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
import { fixture, plain, shared, recovery, deferred } from './fixtures/computer-action-runtime.mjs'

const completion = progressVmModules['./task-completion']
const wire = progressVmModules['../shared/task-completion']
const eid = n => 'ev_' + String(n).repeat(32)
const snapshot = (patch = {}) => ({ id: eid(1), stepId: 'read-step', stepNumber: 1, revision: 0, recordedAt: 1000, delivered: true,
  kind: 'file', target: 'C:\work\report.txt', sha256: 'a'.repeat(64), sizeBytes: 32, facts: 'Actual source snapshot', ...patch })
function task(patch = {}) {
  return { id: 'goal-a', generation: 1, sessionId: 'session-a', platformId: 'deepseek', conversationId: 'chat-a', status: 'recorded',
    inputs: [{ id: 'input-a', kind: 'goal', text: '生成报告并检查内容', attachments: [], receivedAt: 1000 }],
    machine: { id: 'machine-a', connection: 'local' }, progress: { stepCount: 2, currentStep: { id: 'complete-step', action: 'complete_task', status: 'executing' } },
    completion: { version: 1, revision: 0, evidence: [snapshot()], report: null }, ...patch }
}
function claim(patch = {}) {
  return { summary: '报告已保存，回读后核对了标题和正文。', requirements: [{ input_id: 'input-a', checks: [{ criterion: '标题、正文、保存位置符合要求',
    evidence_ids: [eid(1)], status: 'passed', assessment: '已核对回读的实际附件内容。' }] }], artifacts: [{ evidence_id: eid(1), label: '报告' }], no_artifact_reason: '', unconfirmed: [], ...patch }
}
const assess = (t = task(), c = claim(), bg = [], recheck = async () => true, now = 2000) => completion.assessTaskCompletion(t, c, 'complete-step', bg, recheck, now)
const observation = (patch = {}) => ({ type: 'computer_result', version: 1, action: 'observe', ok: true, execution: 'executed', code: 'ok', message: 'Actual synthetic observation',
  data: { observation_id: 'obs_' + '1'.repeat(32), target: 'desktop', geometry_consistent: true, image: { sha256: 'b'.repeat(64) }, ...patch } })

test('exit code, dispatch, upload and discovery do not manufacture completion evidence', () => {
  const t = task({ completion: undefined })
  for (const action of ['command', 'click', 'launch_app', 'open', 'list_windows', 'list_apps']) {
    const result = { type: 'computer_result', version: 1, action, ok: true, execution: 'executed', code: 'ok', message: 'Success', data: { exit_code: 0, dispatch_status: 'dispatched', upload: 'ok' } }
    assert.equal(completion.captureCompletionResult(t, result, 'step', 1000).evidence.length, 0)
  }
})

test('actual image, controls-only and post-input observations receive scoped fact IDs', () => {
  const t = task({ completion: undefined })
  const image = completion.captureCompletionResult(t, observation(), 'step', 1000).evidence[0]
  assert.match(image.id, /^ev_[a-f0-9]{32}$/)
  assert.equal(image.delivered, false)
  assert.equal(image.sha256, 'b'.repeat(64))
  const controls = observation({ target: 'controls', geometry_consistent: undefined, image: undefined, controls: { complete: false, limitations: ['partial'] } })
  const ui = completion.captureCompletionResult(t, controls, 'controls-step', 1000).evidence[0]
  assert.equal(ui.sha256, null)
  assert.equal(JSON.parse(ui.facts).controls_complete, false)
  const post = { ...observation(), action: 'click', ok: false, data: { observation: observation().data } }
  assert.equal(completion.captureCompletionResult(t, post, 'input-step', 1000).evidence.length, 1)
  const foreign = completion.captureCompletionResult({ ...t, id: 'goal-b' }, observation(), 'step', 1000).evidence[0]
  assert.notEqual(image.id, foreign.id)
})

test('only current source snapshots enter the file evidence index; open-dispatched is insufficient', () => {
  const t = task({ completion: undefined })
  const resources = [
    { kind: 'file', target: 'C:\work\report.txt', evidence: 'read-snapshot', stepId: 'read-step', sha256: 'a'.repeat(64), sizeBytes: 32 },
    { kind: 'file', target: 'C:\work\old.txt', evidence: 'read-snapshot', stepId: 'old-step', sha256: 'b'.repeat(64), sizeBytes: 32 },
    { kind: 'file', target: 'C:\work\opened.txt', evidence: 'open-dispatched', stepId: 'read-step', sha256: null, sizeBytes: null }
  ]
  const state = completion.captureCompletionFiles(t, { resources }, 'read-step', 1000)
  assert.equal(state.evidence.length, 1)
  assert.equal(state.evidence[0].target, resources[0].target)
})

test('actual file paths and hashes are supplied by the main process, with a fresh snapshot check', async () => {
  const seen = []
  const report = await assess(task(), claim(), [], async e => { seen.push(e); return true })
  assert.equal(report.state, 'ready')
  assert.equal(report.basis, 'model-assessment-with-tool-evidence')
  assert.deepEqual(plain(report.artifacts), [{ evidenceId: eid(1), label: '报告', path: 'C:\work\report.txt', sizeBytes: 32, sha256: 'a'.repeat(64) }])
  assert.equal(seen.length, 1)
  assert.equal(wire.parseTaskCompletionClaim({ ...claim(), artifacts: [{ evidence_id: eid(1), label: '报告', path: 'C:\forged.txt' }] }), null)
})

test('changed, missing or unreadable files retain partial results without completing', async () => {
  for (const verify of [async () => false, async () => { throw new Error('missing') }]) {
    const report = await assess(task(), claim(), [], verify)
    assert.equal(report.state, 'rejected')
    assert.equal(report.artifacts.length, 0)
    assert.match(report.blockers.join(' '), /文件.*变化/)
  }
})

test('all original and additional inputs require distinct checks, without accepting self-created inputs', async () => {
  const t = task(); t.inputs.push({ id: 'clarification-b', kind: 'clarification', text: '保存为 UTF-8', attachments: [], receivedAt: 1100 })
  assert.equal((await assess(t)).state, 'rejected')
  const c = claim(); c.requirements.push({ ...structuredClone(c.requirements[0]), input_id: 'clarification-b' })
  assert.equal((await assess(t, c)).state, 'ready')
  c.requirements[1].input_id = 'invented-input'
  assert.equal((await assess(t, c)).state, 'rejected')
  c.requirements[1].input_id = 'input-a'
  assert.equal(wire.parseTaskCompletionClaim(c), null)
})

test('unconfirmed checks, missing evidence and unknown execution barriers block completion', async () => {
  const variants = [
    [task(), claim({ unconfirmed: ['正文中的一个数值仍未核实'] })],
    [task({ recovery: { requiresObservation: true } }), claim()],
    [task({ completion: { version: 1, revision: 0, evidence: [], report: null } }), claim()],
    [task({ completion: { version: 1, revision: 0, evidence: [snapshot({ delivered: false })], report: null } }), claim()]
  ]
  for (const [t, c] of variants) assert.equal((await assess(t, c)).state, 'rejected')
  const c = claim(); c.requirements[0].checks[0].status = 'failed'
  assert.equal((await assess(task(), c)).state, 'rejected')
})

test('new commands or input invalidate old UI evidence; read-only observations do not', async () => {
  const t = task(); t.completion.evidence = [snapshot({ kind: 'observation', target: 'obs_' + '1'.repeat(32), sha256: null, sizeBytes: null })]
  const c = claim({ artifacts: [], no_artifact_reason: '只需界面状态，无文件产物。' })
  assert.equal((await assess(t, c)).state, 'ready')
  t.completion = completion.advanceCompletion(t, 'click')
  assert.equal((await assess(t, c)).state, 'rejected')
  t.completion.evidence[0].revision = t.completion.revision
  t.completion = completion.advanceCompletion(t, 'observe')
  assert.equal((await assess(t, c)).state, 'ready')
  assert.equal((await assess(t, c, [], undefined, 122000)).state, 'ready')
  assert.equal((await assess(t, c, [], undefined, 16 * 60000)).state, 'rejected')
})
test('cross-window completion carries only independent current facts and never guesses a desktop click scope', async () => {
  const identity = n => ({ hwnd: '0x' + n, pid: n, process_started_at: '2026-10-27T00:00:00Z', thread_id: n + 1, class_name: 'Editor' })
  const a = snapshot({ kind: 'observation', target: 'obs_' + 'a'.repeat(32), sizeBytes: null, facts: JSON.stringify({ window_identity: identity(100) }) })
  const alias = 'obs_' + 'd'.repeat(32)
  const b = snapshot({ id: eid(2), kind: 'observation', target: 'obs_' + 'b'.repeat(32), sizeBytes: null, facts: JSON.stringify({ window_identity: identity(200), controls_observation_id: alias }) })
  const t = task({ completion: { version: 1, revision: 0, evidence: [a, b], report: null } })
  const checks = ids => claim({ requirements: [{ input_id: 'input-a', checks: [{ criterion: '各应用结果满足要求', evidence_ids: ids, status: 'passed', assessment: '根据相应窗口的真实观察核对' }] }], artifacts: [], no_artifact_reason: '只需界面结果' })
  t.completion = completion.advanceCompletion(t, 'focus_window')
  assert.equal((await assess(t, checks([eid(1), eid(2)]))).state, 'ready')
  t.completion = completion.advanceCompletion(t, 'type_text', alias)
  assert.equal((await assess(t, checks([eid(1)]))).state, 'ready', 'another window invalidated independent A evidence')
  assert.equal((await assess(t, checks([eid(2)]))).state, 'rejected', 'B input retained old B evidence')
  t.completion = completion.advanceCompletion(t, 'click', 'obs_' + 'c'.repeat(32))
  assert.equal((await assess(t, checks([eid(1)]))).state, 'rejected', 'unresolved desktop scope borrowed the last business window')
  const shared = task({ completion: { version: 1, revision: 0, evidence: [a, { ...b, facts: JSON.stringify({ window_identity: { ...identity(200), pid: 100 } }) }], report: null } })
  shared.completion = completion.advanceCompletion(shared, 'type_text', b.target)
  assert.equal((await assess(shared, checks([eid(1)]))).state, 'rejected', 'two views in the same app were assumed to be independent documents')
})

test('background jobs and required deliveries must settle; ready services can remain running', async () => {
  const t = task(), context = { sessionId: t.sessionId, platformId: t.platformId, conversationId: t.conversationId, taskId: t.id, generation: 1, machine: t.machine }
  const job = { id: 'bg-a', taskContext: context, status: 'running', resultSettled: false, exitCode: null, deliveryStatus: 'pending' }
  assert.equal((await assess(t, claim(), [job])).state, 'rejected')
  Object.assign(job, { status: 'completed', resultSettled: true, exitCode: 0, deliveryStatus: 'sent' })
  assert.equal((await assess(t, claim(), [job])).state, 'ready')
  job.taskContext = { ...context, taskId: 'another-goal' }; job.status = 'failed'
  assert.equal((await assess(t, claim(), [job])).state, 'ready')
  const service = { id: 'service-a', taskContext: context, backgroundOptions: { kind: 'service' }, status: 'running', startup: { state: 'ready', readyAt: 1000 }, readinessDeliveryStatus: 'sent' }
  assert.equal((await assess(t, claim(), [service])).state, 'ready')
  service.readinessDeliveryStatus = 'superseded'
  assert.equal((await assess(t, claim(), [service])).state, 'rejected')
  t.completion.evidence.push(snapshot({ id: eid(2), kind: 'background', target: service.id, sha256: null, sizeBytes: null, facts: JSON.stringify({ condition: 'background_ready' }) }))
  assert.equal((await assess(t, claim(), [service])).state, 'ready')
})

test('the latest explicit dependency condition must be satisfied, even if its process exited 0', async () => {
  const t = task({ backgroundDependencies: [{ backgroundId: 'job-a', condition: 'background_finished', state: 'waiting' }] })
  assert.equal((await assess(t)).state, 'rejected')
  t.backgroundDependencies.push({ backgroundId: 'job-a', condition: 'background_finished', state: 'satisfied' })
  assert.equal((await assess(t)).state, 'ready')
})

test('a final report with unresolved facts cannot be stored as delivered, and evidence stays bounded', async () => {
  const t = task(); const report = await assess(t, claim({ unconfirmed: ['未核对'] }))
  assert.ok(wire.parseTaskCompletionState({ ...t.completion, report }))
  report.state = 'delivered'
  assert.equal(wire.parseTaskCompletionState({ ...t.completion, report }), null)
  const invalid = structuredClone(t.completion); invalid.evidence.push(invalid.evidence[0])
  assert.equal(wire.parseTaskCompletionState(invalid), null)
  for (let i = 0; i < 140; i++) t.completion = completion.captureCompletionResult(t, observation({ observation_id: 'obs_' + i.toString(16).padStart(32, '0') }), `step-${i}`, 1000)
  assert.equal(t.completion.evidence.length, 128)
  assert.ok(JSON.stringify(completion.completionContext(t)).length <= 48000)
})

function liveClaim(f) {
  const current = f.coordinator.current('deepseek'), evidence = current.completion.evidence.at(-1)
  return claim({ requirements: [{ ...claim().requirements[0], input_id: current.inputs[0].id, checks: [{ ...claim().requirements[0].checks[0], evidence_ids: [evidence.id] }] }], artifacts: [], no_artifact_reason: '任务只要求核对界面，无文件产物。' })
}
function live(t, options = {}) {
  let f
  f = fixture(t, { ...options, execute: async call => {
    if (call.action !== 'complete_task') return observation()
    const report = await f.coordinator.evaluateCompletion(f.lease(), f.coordinator.current('deepseek').progress.currentStep.id, call.parameters, options.background ?? (() => []))
    return { type: 'computer_result', version: 1, action: 'complete_task', ok: report.state === 'ready', execution: 'executed',
      code: report.state === 'ready' ? 'ok' : 'verification_required', message: 'Synthetic completion assessment', data: { completion_report: report } }
  } })
  return f
}
const complete = f => f.request({ call: { action: 'complete_task', parameters: liveClaim(f) } })

test('a goal becomes completed only after the actual final report has positive delivery acknowledgement', async t => {
  const hold = deferred(); let sends = 0
  const f = live(t, { send: async () => ++sends === 2 ? hold.promise : 'ok' })
  await f.run()
  const lease = f.lease(), request = complete(f)
  f.loop.enqueue(request)
  const running = f.loop.wake()
  for (let i = 0; i < 10 && sends < 2; i++) await new Promise(r => setImmediate(r))
  assert.equal(JSON.parse(f.payload()).status, 'recorded')
  assert.equal(JSON.parse(f.payload()).completion.report.state, 'ready')
  assert.equal(f.sends.at(-1).next_step_token, undefined)
  hold.resolve('ok'); await running
  const done = JSON.parse(f.payload())
  assert.equal(done.status, 'completed')
  assert.equal(done.progress.phase, 'completed')
  assert.equal(done.completion.report.state, 'delivered')
  assert.equal(f.state().delivery_state, 'sent')
  assert.ok(shared.parseAutonomousTask(f.payload()))
  assert.equal(f.coordinator.current('deepseek'), null)
  assert.equal(f.coordinator.owns(lease), false)
  assert.equal(f.coordinator.completionNotificationAllowed('deepseek', 'chat-a'), true)
  recovery.recoverInterruptedComputerActions(f.db, Date.now() + 1)
  assert.equal(JSON.parse(f.payload()).status, 'completed')
})

test('busy delivery retries the saved completion report without evaluating it a second time', async t => {
  let sends = 0
  const f = live(t, { send: async () => ++sends === 2 ? 'busy' : 'ok' })
  await f.run(); await f.run(complete(f))
  assert.equal(JSON.parse(f.payload()).status, 'recorded')
  const text = f.deliveries.at(-1).text
  await f.retry()
  assert.equal(JSON.parse(f.payload()).status, 'completed')
  assert.equal(f.executions.length, 2)
  assert.equal(f.deliveries.at(-1).text, text)
})

test('an unknown final submission, stop, restart or old-task acknowledgement cannot declare success', async t => {
  const f = live(t, { send: async text => JSON.parse(text).action === 'complete_task' ? 'unknown' : 'ok' })
  await f.run(); await f.run(complete(f))
  assert.equal(JSON.parse(f.payload()).status, 'recorded')
  assert.equal(JSON.parse(f.payload()).progress.phase, 'blocked')
  assert.equal(f.coordinator.completionNotificationAllowed('deepseek', 'chat-a'), false)
  f.coordinator.stop('deepseek', 'interrupted')
  recovery.recoverInterruptedComputerActions(f.db)
  assert.equal(JSON.parse(f.payload()).status, 'interrupted')
  const damaged = JSON.parse(f.payload()); damaged.status = 'completed'
  assert.equal(shared.parseAutonomousTask(JSON.stringify(damaged)), null)
})

test('a new clarification while the report waits for delivery invalidates completion and sends fresh review feedback', async t => {
  let sends = 0
  const f = live(t, { send: async () => ++sends === 2 ? 'busy' : 'ok' })
  await f.run(); await f.run(complete(f))
  f.submit({ submission: { id: 'user:clarification', kind: 'clarification' }, text: '还需核对另一个窗口' })
  await f.retry(); await f.loop.wake()
  assert.equal(JSON.parse(f.payload()).status, 'recorded')
  assert.equal(f.executions.length, 2)
  assert.equal(f.sends.at(-1).code, 'verification_required')
  assert.equal(f.sends.at(-1).task_completion_context.inputs.length, 2)
})

test('a changing background dependency revokes a report before final acknowledgement', async t => {
  let sends = 0
  const f = live(t, { send: async () => ++sends === 2 ? 'busy' : 'ok' })
  await f.run(); await f.run(complete(f))
  const current = f.coordinator.current('deepseek')
  const background = [{ id: 'late-job', taskContext: { ...f.lease(), machine: current.machine }, status: 'failed', exitCode: 1, resultSettled: true, deliveryStatus: 'pending' }]
  f.coordinator.reconcileCompletionDependencies('deepseek', background)
  assert.equal(f.coordinator.current('deepseek').completion.report.state, 'rejected')
  await f.retry(); await f.loop.wake()
  assert.equal(JSON.parse(f.payload()).status, 'recorded')
  assert.equal(f.sends.at(-1).code, 'verification_required')
})


test('terminal evidence requires an actual nonempty output receipt and preserves its separate business assessment', async () => {
  const t = task({ completion: undefined })
  const actual = { exitCode: 0, output: 'checks: title=expected; rows=12; encoding=UTF-8', timedOut: false, interrupted: false, rejected: false, sessionLost: false }
  assert.equal(completion.captureCompletionCommand(t, 'verify-step', { ...actual, output: '' }, 1000).evidence.length, 0)
  assert.equal(completion.captureCompletionCommand(t, 'verify-step', { ...actual, timedOut: true }, 1000).evidence.length, 0)
  t.completion = completion.captureCompletionCommand(t, 'verify-step', actual, 1000)
  const evidence = t.completion.evidence[0]; evidence.delivered = true
  assert.equal(evidence.kind, 'command')
  assert.match(evidence.facts, /rows=12/)
  const c = claim({ artifacts: [], no_artifact_reason: '只交付终端查询结果，无新文件。' })
  c.requirements[0].checks[0].evidence_ids = [evidence.id]
  assert.equal((await assess(t, c)).state, 'ready')
  t.completion = completion.advanceCompletion(t, 'command')
  assert.equal((await assess(t, c)).state, 'rejected')
})

test('verification_required is a read-only diagnosis and never invents an input effect or recovery barrier', () => {
  const diagnose = progressVmModules['../shared/computer-diagnostics'].diagnoseComputerResult
  const diagnosis = diagnose({ type: 'computer_result', version: 1, action: 'complete_task', ok: false, execution: 'executed', code: 'verification_required', message: 'missing evidence' }, { actions: ['complete_task', 'observe'], otherTools: ['read_files'] })
  assert.equal(diagnosis.category, 'verification_required')
  assert.equal(diagnosis.may_have_side_effects, false)
  assert.equal(diagnosis.requires_fresh_observation, false)
})


test('a settled failed background job can be replaced with explicit goal evidence, without ignoring running or uncertain work', async () => {
  const t = task({ backgroundDependencies: [{ backgroundId: 'failed-job', condition: 'background_finished', state: 'failed' }] })
  const context = { sessionId: t.sessionId, platformId: t.platformId, conversationId: t.conversationId, taskId: t.id, generation: t.generation, machine: t.machine }
  const failed = { id: 'failed-job', taskContext: context, status: 'failed', resultSettled: true, exitCode: 1, deliveryStatus: 'superseded' }
  assert.equal((await assess(t, claim(), [failed])).state, 'rejected')
  const c = claim({ superseded_backgrounds: [{ background_id: failed.id, evidence_ids: [eid(1)], reason: '已改为文件工具处理，实际回读产物满足所有原要求；不需要原失败作业。' }] })
  assert.ok(wire.parseTaskCompletionClaim(c))
  const report = await assess(t, c, [failed])
  assert.equal(report.state, 'ready')
  assert.equal(report.backgroundResolutions.length, 1)
  assert.ok(wire.parseTaskCompletionState({ ...t.completion, report }))
  for (const patch of [{ status: 'running' }, { status: 'unknown' }, { resultSettled: false }, { deliveryStatus: 'needs-attention' }, { deliveryStatus: 'pending' }])
    assert.equal((await assess(t, c, [{ ...failed, ...patch }])).state, 'rejected')
  assert.equal((await assess(t, c, [failed], async () => false)).state, 'rejected')
})
