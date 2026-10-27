// User-run only: node --test tests/computer-progress.test.mjs
// Actual guard/coordinator/progression/SQLite with synthetic clocks and receipts.
// No Electron, native helper, shell, network, user profile or desktop input is used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
import { fixture, plain, deferred, shared, TaskCoordinator, recovery } from './fixtures/computer-action-runtime.mjs'

const policy = progressVmModules['./computer-progress'], guard = progressVmModules['./task-progress-guard']
const receipt = (patch = {}) => ({ type: 'computer_result', version: 1, action: 'observe', ok: true, code: 'ok', execution: 'executed', message: 'Synthetic real receipt', ...patch })
const observed = (serial, changed = false) => ({ observation_id: 'obs_' + serial.toString(16).padStart(32, '0'), target: 'window',
  window_id: 'win_' + serial.toString(16).padStart(32, '0'), observed_at: new Date(1000 + serial).toISOString(),
  window_identity: { hwnd: '0x123', pid: 17, process_started_at: '2026-10-26T00:00:00Z', thread_id: 19, class_name: 'Synthetic' },
  image: { sha256: (changed ? 'b' : 'a').repeat(64) }, source_bounds: { x: 0, y: 0, width: 800, height: 600 }, crop: { x: 0, y: 0, width: 800, height: 600 },
  binding: { source_step_id: 'new-every-time-' + serial, expires_at: new Date(100000 + serial).toISOString() } })
class Clock {
  time = 0
  serial = 0
  events = new Map()
  now = () => this.time
  schedule = (callback, delay) => {
    const id = ++this.serial; this.events.set(id, { at: this.time + delay, callback })
    return () => this.events.delete(id)
  }
  advance(ms) {
    const end = this.time + ms
    for (;;) {
      const due = [...this.events.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.events.delete(due[0]); this.time = due[1].at; due[1].callback()
    }
    this.time = end
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('legacy checkpoints drop all removed limits and stop flags while retaining execution statistics', () => {
  for (const halted of ['task_timeout', 'step_limit', 'repeated_action', 'unchanged_observations', 'consecutive_timeouts', 'recovery_limit']) {
    const old = { ...plain(guard.createProgressState()), version: 1, limits: { maxSteps: 1 }, halted, steps: 2500,
      pending: { stepId: 'old-step', fingerprint: 'a'.repeat(64), repeat: 21, blocked: true, hard: halted } }
    const migrated = policy.parseComputerProgressState(old)
    assert.equal(migrated.version, 2); assert.equal(migrated.steps, 2500)
    assert.deepEqual(plain(migrated.pending), { stepId: 'old-step', fingerprint: 'a'.repeat(64), repeat: 21 })
    assert.equal('limits' in migrated, false); assert.equal('halted' in migrated, false)
    assert.ok(policy.parseComputerProgressState(migrated))
  }
})

test('new timestamps, references and step tokens do not establish observable progress', () => {
  const task = {}, call = { action: 'observe', parameters: { target: 'window', window_id: 'win_' + 'a'.repeat(32) } }
  let c = guard.createProgressState()
  for (let n = 1; n <= 4; n++) {
    c = guard.admitProgressStep(task, c, 'step-' + n, call)
    const result = guard.recordProgressResult(c, 'step-' + n, receipt({ data: observed(n) }))
    c = result.state
    assert.equal(result.report.goal_verified, false)
  }
  assert.equal(c.epoch, 1); assert.equal(c.unchangedObservations, 3); assert.equal('halted' in c, false)
  assert.ok(policy.parseComputerProgressState(c))
})

test('same input is counted across fresh observation and element ids without rejecting it', () => {
  let c = guard.createProgressState(), task = {}
  const first = observed(1)
  first.controls = { complete: true, elements: [{ element_id: 'el_' + '1'.repeat(32), role: 'button', name: 'Save', enabled: true, focused: false, bounds: { x: 10, y: 20 } }] }
  c = guard.recordProgressResult(c, 'initial', receipt({ data: first })).state
  const call = { action: 'click', parameters: { observation_id: first.observation_id, element_id: first.controls.elements[0].element_id } }
  c = guard.admitProgressStep(task, c, 'click-1', call)
  c = guard.recordProgressResult(c, 'click-1', receipt({ action: 'click', data: { observation: first } })).state
  const next = observed(2)
  next.controls = { ...first.controls, elements: [{ ...first.controls.elements[0], element_id: 'el_' + '2'.repeat(32) }] }
  c = guard.recordProgressResult(c, 'refresh', receipt({ data: next })).state
  const decision = guard.inspectProgressAdmission(task, c, { action: 'click', parameters: { observation_id: next.observation_id, element_id: next.controls.elements[0].element_id } })
  assert.equal(decision.repeat, 2)
  assert.equal(guard.admitProgressStep(task, c, 'click-2', call).steps, 2)
  assert.equal(JSON.stringify(c).includes('Save'), false, 'stored control state contains hashes, not control text')
})
test('navigation and submit actions both remain available after repeated requests', () => {
  const task = {}
  for (const call of [{ action: 'scroll', parameters: { direction: 'down', amount: 3 } }, { action: 'press_key', parameters: { key: 'Control+Right' } }]) {
    let c = guard.createProgressState()
    c = guard.admitProgressStep(task, c, 'first', call)
    c = guard.recordProgressResult(c, 'first', receipt({ action: call.action })).state
    assert.equal(guard.inspectProgressAdmission(task, c, call).repeat, 2)
  }
  const submit = { action: 'press_key', parameters: { key: 'Enter' } }
  let c = guard.admitProgressStep(task, guard.createProgressState(), 'submit', submit)
  c = guard.recordProgressResult(c, 'submit', receipt({ action: 'press_key' })).state
  assert.equal(guard.admitProgressStep(task, c, 'submit-again', submit).steps, 2)
})

test('actual changed image evidence allows a new attempt, while exit success alone does not reset recovery', () => {
  let c = guard.createProgressState()
  c = guard.recordProgressResult(c, 'initial', receipt({ data: observed(1) })).state
  c.recovering = true; c.recoverySteps = 4
  const unchanged = guard.recordProgressResult(c, 'no-evidence', receipt({ action: 'focus_window' })).state
  assert.equal(unchanged.recoverySteps, 4)
  const changed = guard.recordProgressResult(c, 'new-image', receipt({ data: observed(2, true) })).state
  assert.equal(changed.epoch, c.epoch + 1); assert.equal(changed.recoverySteps, 0)
  assert.equal(changed.recovering, false)
})

test('application rediscovery does not make repeated startup a new semantic action', () => {
  let c = guard.createProgressState()
  const task = { continuity: { apps: [{ appId: 'app_old', name: 'Editor', executablePath: 'C:\\editor.exe' }] } }
  c = guard.admitProgressStep(task, c, 'launch', { action: 'launch_app', parameters: { app_id: 'app_old', launch_reference_id: 'launch_old' } })
  c = guard.recordProgressResult(c, 'launch', receipt({ action: 'launch_app' })).state
  task.continuity.apps[0].appId = 'app_new'
  const again = guard.inspectProgressAdmission(task, c, { action: 'launch_app', parameters: { app_id: 'app_new', launch_reference_id: 'launch_new' } })
  assert.equal(again.repeat, 2)
})

test('only current-step actual read snapshots reset recovery; historical file indexes do not', () => {
  let c = guard.createProgressState(); c.recovering = true; c.recoverySteps = 5
  const continuity = { resources: [{ kind: 'file', target: 'C:\\out.xlsx', evidence: 'read-snapshot', sha256: 'a'.repeat(64), sizeBytes: 100, stepId: 'file-step' }] }
  assert.equal(guard.recordFileEvidence(c, continuity, 'other-step').recoverySteps, 5)
  c = guard.recordFileEvidence(c, continuity, 'file-step')
  assert.equal(c.recoverySteps, 0)
  c.recovering = true; c.recoverySteps = 2
  assert.equal(guard.recordFileEvidence(c, continuity, 'file-step').recoverySteps, 2)
})

test('new model requests can repeat an action beyond its former ceiling; duplicate receipts still cannot execute twice', async t => {
  const f = fixture(t, { action: 'launch_app', parameters: { app_id: 'synthetic', launch_reference_id: 'synthetic' } })
  let request
  for (let n = 0; n < 24; n++) { request = f.request(); assert.equal(await f.run(request), 'accepted') }
  assert.equal(f.executions.length, 24); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.coordinator.current('deepseek').progress.phase, 'waiting-model')
  assert.equal(f.sends.at(-1).progress_control.repeated_action_count, 24)
  assert.equal(f.sends.at(-1).progress_control.goal_verified, false)
  assert.ok(f.sends.at(-1).next_step_token)
  assert.equal(await f.run(request), 'duplicate'); assert.equal(f.executions.length, 24)
})

test('unchanged observations remain diagnostics beyond the former configurable threshold', async t => {
  let serial = 0
  const f = fixture(t, { execute: () => receipt({ data: observed(++serial) }) })
  for (let n = 0; n < 55; n++) assert.equal(await f.run(), 'accepted')
  assert.equal(f.executions.length, 55)
  assert.equal(f.coordinator.current('deepseek').control.unchangedObservations, 54)
  assert.ok(f.sends.at(-1).progress_control.signals.includes('unchanged_observations'))
  assert.ok(f.sends.at(-1).next_step_token)
})

test('computer steps continue across the former total-step ceiling', async t => {
  const f = fixture(t), current = f.coordinator.current('deepseek')
  f.coordinator.updateProgress(f.lease(), current.progress, undefined, { ...current.control, steps: 1999 })
  for (let n = 0; n < 4; n++) assert.equal(await f.run(), 'accepted')
  assert.equal(f.coordinator.current('deepseek').control.steps, 2003)
  assert.equal(f.executions.length, 4); assert.ok(f.sends.at(-1).next_step_token)
})

test('model-waiting goals remain active past the former maximum task duration without scheduling a stop', async t => {
  const clock = new Clock(), f = fixture(t, { clock }), owner = f.lease()
  clock.advance(2 * 86_400_000)
  assert.equal(clock.events.size, 0); assert.equal(f.coordinator.owns(owner), true)
  assert.equal(f.coordinator.progressSummary(owner).elapsed_ms, 2 * 86_400_000)
  assert.equal(await f.run(), 'accepted'); assert.equal(f.executions.length, 1)
  assert.equal(f.coordinator.current('deepseek').originalRequest, f.first.originalRequest)
})

test('pause and waiting-user intervals do not consume the task clock', t => {
  const clock = new Clock(), f = fixture(t, { clock })
  f.coordinator.setPaused(true); clock.advance(120_000); f.coordinator.setPaused(false)
  assert.ok(f.coordinator.current('deepseek'))
  f.coordinator.noteReply('deepseek', 'question-1', 'question'); clock.advance(120_000)
  f.submit({ submission: { id: 'user:answer:1', kind: 'clarification' }, text: '补充缺失资料。' })
  assert.ok(f.coordinator.current('deepseek'))
  assert.equal(f.coordinator.progressSummary(f.lease()).elapsed_ms, 0)
  clock.advance(86_400_000)
  assert.equal(f.coordinator.progressSummary(f.lease()).elapsed_ms, 86_400_000)
  assert.ok(f.coordinator.current('deepseek'))
})

test('long actions keep running and retain the desktop permit until their real executor returns', async t => {
  const clock = new Clock(), done = deferred(); let released = 0
  const f = fixture(t, { clock, execute: () => done.promise,
    acquire: async () => ({ release() { released++ } }) })
  f.loop.enqueue(f.request()); await tick()
  clock.advance(3_600_001)
  assert.equal(clock.events.size, 0)
  assert.equal(f.executions[0].signal.aborted, false); assert.equal(released, 0)
  assert.equal(f.sends.length, 0)
  done.resolve(receipt({ execution: 'executed' })); await f.loop.wake()
  assert.equal(released, 1); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.sends[0].progress_control.action_timed_out, false)
  assert.equal(f.sends[0].code, 'ok', 'a late real success receipt is not changed into a fictitious failure')
})

test('user stop still cancels a long action and holds its permit until actual executor exit', async t => {
  const done = deferred(); let released = 0
  const f = fixture(t, { execute: () => done.promise, acquire: async () => ({ release() { released++ } }) })
  const owner = f.lease()
  f.loop.enqueue(f.request()); await tick()
  f.coordinator.stop('deepseek', 'stopped', 'user-ended')
  assert.equal(f.executions[0].signal.aborted, true)
  assert.equal(f.coordinator.owns(owner), false); assert.equal(released, 0)
  done.resolve(receipt()); await f.loop.wake()
  assert.equal(released, 1); assert.equal(f.sends.length, 0)
  assert.equal(f.state().execution_fact, 'executed', 'late actual facts remain history')
})

test('condition waits use the action request without a separate task-level wait deadline', async t => {
  const clock = new Clock(), done = deferred()
  const parameters = { condition: 'window_present', query: 'Large document', timeout_ms: 3_600_000 }
  const f = fixture(t, { clock, action: 'wait_for', parameters, execute: () => done.promise })
  f.loop.enqueue(f.request()); await tick()
  clock.advance(3_600_001)
  assert.deepEqual(plain(f.executions[0].call.parameters), parameters)
  assert.equal(clock.events.size, 0); assert.equal(f.executions[0].signal.aborted, false)
  done.resolve(receipt({ action: 'wait_for', ok: false, code: 'wait_timeout' })); await f.loop.wake()
  assert.equal(f.sends[0].code, 'wait_timeout'); assert.ok(f.sends[0].next_step_token)
})

test('consecutive executor timeouts remain diagnostic facts and do not stop later requests', async t => {
  const f = fixture(t, { action: 'wait_for', parameters: { condition: 'delay', timeout_ms: 1000 },
    execute: () => receipt({ action: 'wait_for', ok: false, code: 'wait_failed', data: { helper_code: 'action_timeout' } }) })
  for (let n = 0; n < 25; n++) assert.equal(await f.run(), 'accepted')
  assert.equal(f.executions.length, 25); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.coordinator.current('deepseek').control.consecutiveTimeouts, 25)
  assert.notEqual(f.sends.at(-1).diagnosis.same_action_retry, 'stop')
  assert.ok(f.sends.at(-1).next_step_token)
})
test('normal condition timeouts do not count as executor faults', async t => {
  const f = fixture(t, { action: 'wait_for', parameters: { condition: 'window_present', query: 'Large document', timeout_ms: 180000 },
    execute: () => receipt({ action: 'wait_for', ok: false, code: 'wait_timeout' }) })
  await f.run(); await f.run(); await f.run()
  const c = f.coordinator.current('deepseek').control
  assert.equal(f.executions.length, 3); assert.equal(c.consecutiveTimeouts, 0)
  assert.equal(f.sends.at(-1).progress_control.action_timed_out, false)
})

test('native helper timeout codes survive adapter context errors and count as timeouts', async t => {
  const f = fixture(t, { execute: () => receipt({ ok: false, code: 'inactive_context', execution: 'unknown', data: { helper_code: 'action_timeout' } }) })
  await f.run()
  assert.equal(f.sends[0].progress_control.action_timed_out, true)
  assert.equal(f.sends[0].progress_control.consecutive_timeouts, 1)
  assert.equal(f.sends[0].diagnosis.category, 'loading_timeout')
  assert.equal(f.state().execution_fact, 'unknown')
})

test('diagnostic recovery can continue beyond its former maximum without marking the goal complete', async t => {
  const f = fixture(t, { execute: call => receipt({ action: call.action, ok: false, code: 'invalid_parameters', execution: 'not_executed' }) })
  for (let n = 0; n < 105; n++) assert.equal(await f.run(f.request({ call: { action: 'observe', parameters: { target: 'region', x: n, y: 0, width: 100, height: 100 } } })), 'accepted')
  assert.equal(f.coordinator.current('deepseek').control.recoverySteps, 104)
  assert.equal(f.executions.length, 105); assert.equal(f.sends.at(-1).progress_control.goal_verified, false)
  assert.ok(f.sends.at(-1).next_step_token)
})

test('delivery busy retries do not inflate execution statistics or rerun the action', async t => {
  let attempts = 0
  const f = fixture(t, { send: () => ++attempts < 3 ? 'busy' : 'ok' })
  await f.run(); const before = plain(f.coordinator.current('deepseek').control), text = f.deliveries[0].text
  await f.retry(); await f.retry()
  const after = f.coordinator.current('deepseek').control
  assert.equal(after.steps, before.steps); assert.deepEqual(plain(after.repeats), before.repeats)
  assert.equal(after.consecutiveTimeouts, before.consecutiveTimeouts); assert.equal(after.recoverySteps, before.recoverySteps)
  assert.equal(f.executions.length, 1); assert.ok(f.deliveries.every(d => d.text === text))
})

test('terminal/file steps continue beyond the former maximum and resumed goals retain counters', t => {
  const f = fixture(t)
  for (let n = 0; n < 2; n++) {
    const step = f.coordinator.reserveToolStep(f.lease(), 'file-' + n, 'read_files', f.first.machine)
    f.coordinator.noteToolStep(step, { stage: 'delivered', execution: 'executed' })
  }
  const before = f.coordinator.current('deepseek')
  f.coordinator.updateProgress(f.lease(), before.progress, undefined, { ...before.control, steps: 1999 })
  f.coordinator.stop('deepseek', 'interrupted')
  const resumed = f.submit({ resume: { taskId: f.first.id, generation: f.first.generation } })
  assert.equal(resumed.control.steps, 1999); assert.equal('limits' in resumed.control, false)
  const lease = f.lease()
  for (let n = 1999; n < 2005; n++) {
    const step = f.coordinator.reserveToolStep(lease, 'file-' + n, 'read_files', f.first.machine)
    assert.ok(step); f.coordinator.noteToolStep(step, { stage: 'delivered', execution: 'executed' })
  }
  assert.ok(f.coordinator.reserveToolStep(lease, 'another-command', 'command', f.first.machine))
  assert.equal(f.coordinator.current('deepseek').control.steps, 2006)
})

test('a persisted goal stopped by an old limit can resume with its original facts and a fresh observation gate', t => {
  const f = fixture(t)
  f.coordinator.stop('deepseek', 'stopped')
  const old = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
  old.control = { ...old.control, version: 1, limits: { maxSteps: 200 }, halted: 'step_limit', steps: 200 }
  f.db.prepare('UPDATE autonomous_tasks SET payload = ? WHERE id = ?').run(JSON.stringify(old), old.id)
  const coordinator = new TaskCoordinator('session-a', f.store, () => {})
  try {
    const state = coordinator.context('deepseek', 'chat-a')
    assert.equal(state.task.control.steps, 200); assert.equal('halted' in state.task.control, false)
    assert.equal(coordinator.current('deepseek'), null, 'opening history never starts work')
    const resumed = coordinator.submit({ platformId: 'deepseek', conversationId: 'chat-a',
      submission: { id: 'user:resume:old-limit', kind: 'goal' }, text: '继续原任务', attachments: [], machine: old.machine,
      capability: { scopeSupported: true, computerUseEnabled: true, context: { sessionId: 'session-a', platformId: 'deepseek' } },
      resume: { taskId: old.id, generation: old.generation } })
    assert.ok(resumed); assert.equal(resumed.control.version, 2); assert.equal(resumed.control.steps, 200)
    assert.equal(resumed.originalRequest, old.originalRequest); assert.equal(resumed.recovery.requiresObservation, true)
  } finally { coordinator.dispose() }
})

test('restoring checkpoints never restores timers, work or grants, and malformed counters fail closed', async t => {
  const f = fixture(t); await f.run()
  const storedBefore = f.coordinator.current('deepseek'), stepCount = storedBefore.control.steps
  f.coordinator.stop('deepseek', 'interrupted')
  const restored = new TaskCoordinator('session-a', f.store, () => {})
  const state = restored.context('deepseek', 'chat-a')
  assert.equal(state.task.control.steps, stepCount); assert.equal(restored.current('deepseek'), null)
  for (const patch of [{ steps: -1 }, { elapsedMs: Infinity }, { halted: 'success' }, { repeats: [{ fingerprint: 'raw text' }] }, { extra: true }]) {
    assert.equal(shared.parseAutonomousTask(JSON.stringify({ ...state.task, control: { ...state.task.control, ...patch } })), null)
  }
  const summary = recovery.computerRecoveryMessage(state.task, f.store.listComputerActions({ ...f.first, taskId: f.first.id }))
  assert.equal(JSON.parse(summary.slice(summary.indexOf('\n') + 1)).progress_control.steps, stepCount)
})

test('settings ignore obsolete saved limits and patches while still validating current settings before writes', () => {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL('../src/main/computer-use-settings.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, require: name => progressVmModules[name] })
  const values = new Map(), writes = []
  const store = { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => { writes.push(key); values.set(key, value) } }
  assert.throws(() => exports.saveComputerUsePreferences(store, { computerUseEnabled: true, computerResultDelaySeconds: -1 }), /回传间隔/)
  assert.equal(writes.length, 0)
  const patch = exports.saveComputerUsePreferences(store, { computerUseEnabled: true, computerUseLimits: { maxSteps: 1 } })
  assert.equal(patch.computerUseEnabled, true); assert.equal('computerUseLimits' in patch, false)
  assert.equal(writes.includes('computerUseLimits'), false)
  values.set('computerUseLimits', 'broken-json')
  assert.equal('computerUseLimits' in exports.readComputerUsePreferences(store), false)
})

test('a separately saved receipt restores statistics after checkpoint failure without restoring legacy stop flags', async t => {
  const f = fixture(t, { action: 'wait_for', parameters: { condition: 'delay' },
    execute: () => receipt({ action: 'wait_for', ok: false, code: 'wait_failed', data: { helper_code: 'action_timeout' } }) })
  f.db.exec(`CREATE TRIGGER reject_limit_checkpoint BEFORE UPDATE ON autonomous_tasks
    WHEN json_extract(NEW.payload, '$.control.consecutiveTimeouts') = 1
    BEGIN SELECT RAISE(FAIL, 'synthetic checkpoint failure'); END`)
  await f.run(); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(JSON.parse(f.state().result_json).progress_control.consecutive_timeouts, 1)
  assert.equal(f.sends.length, 0)
  f.db.exec('DROP TRIGGER reject_limit_checkpoint')
  const saved = f.state(), legacyReceipt = JSON.parse(saved.result_json)
  legacyReceipt.progress_control.halted = true
  legacyReceipt.progress_control.stop_reason = 'consecutive_timeouts'
  f.db.prepare('UPDATE computer_actions SET result_json = ? WHERE execution_id = ?').run(JSON.stringify(legacyReceipt), saved.execution_id)
  f.coordinator.stop('deepseek', 'interrupted') // Graceful close can save an older task snapshot after the error.
  recovery.recoverInterruptedComputerActions(f.db)
  const restored = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
  assert.equal('halted' in restored.control, false); assert.equal(restored.control.consecutiveTimeouts, 1)
  assert.equal(restored.status, 'interrupted')
})

test('completion notifications are delivered once for the completed task even while the app is focused', () => {
  const ast = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionRuntime')
  const method = cls.members.find(n => n.name?.getText(ast) === 'notifyTaskCompleted').getText(ast)
  const Subject = new Script(ts.transpileModule(`class Subject { ${method} }; Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({})
  let completed = 0
  const subject = Object.assign(new Subject(), {
    id: 'session-a', active: true, completedTaskNotifications: new Set(), activePlatformId: 'deepseek',
    taskCoordinator: { hasError: () => false, completionNotificationAllowed: () => true, completedTaskId: () => 'finished-task' },
    window: { isDestroyed: () => false, isFocused: () => true },
    embed: { getState: () => ({ conversationId: 'chat-a' }) }, options: { onTaskCompleted: () => completed++ }
  })
  subject.notifyTaskCompleted('任务已完成')
  subject.notifyTaskCompleted('任务已完成')
  assert.equal(completed, 1)
})

test('completion notifications are suppressed when task persistence has failed', () => {
  const ast = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionRuntime')
  const method = cls.members.find(n => n.name?.getText(ast) === 'notifyTaskCompleted').getText(ast)
  const Subject = new Script(ts.transpileModule(`class Subject { ${method} }; Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({})
  let completed = 0
  const subject = Object.assign(new Subject(), { taskCoordinator: { hasError: () => true }, activePlatformId: 'deepseek',
    embed: { getState: () => ({ conversationId: 'chat-a' }) }, options: { onTaskCompleted: () => completed++ } })
  subject.notifyTaskCompleted('模型称已完成')
  assert.equal(completed, 0)
})
