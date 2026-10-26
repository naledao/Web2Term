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
const limits = patch => ({ ...plain(policy.normalizeComputerProgressLimits()), ...patch })
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

test('limits are strict, bounded and default safely for legacy or malformed settings', () => {
  const defaults = policy.normalizeComputerProgressLimits()
  assert.ok(policy.parseComputerProgressLimits(defaults))
  for (const key of policy.COMPUTER_PROGRESS_LIMIT_KEYS) {
    const rule = policy.COMPUTER_PROGRESS_LIMIT_FIELDS[key]
    for (const value of [rule.min - 1, rule.max + 1, NaN, Infinity, '3', null]) {
      assert.equal(policy.parseComputerProgressLimits({ ...defaults, [key]: value }), null)
    }
  }
  assert.equal(policy.parseComputerProgressLimits({ ...defaults, unexpected: 1 }), null)
  assert.deepEqual(plain(policy.normalizeComputerProgressLimits({ maxSteps: 0 })), plain(defaults))
})

test('new timestamps, references and step tokens do not establish observable progress', () => {
  const task = {}, call = { action: 'observe', parameters: { target: 'window', window_id: 'win_' + 'a'.repeat(32) } }
  let c = guard.createProgressState(limits({ maxRepeatedAction: 20, maxUnchangedObservations: 3 }))
  for (let n = 1; n <= 4; n++) {
    c = guard.admitProgressStep(task, c, 'step-' + n, call)
    const result = guard.recordProgressResult(c, 'step-' + n, receipt({ data: observed(n) }))
    c = result.state
    assert.equal(result.report.goal_verified, false)
  }
  assert.equal(c.epoch, 1); assert.equal(c.unchangedObservations, 3); assert.equal(c.halted, 'unchanged_observations')
  assert.ok(policy.parseComputerProgressState(c))
})

test('same input is blocked before dispatch without new evidence, including fresh observation and element ids', () => {
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
  assert.equal(decision.blocked, true); assert.equal(decision.repeat, 2)
  assert.equal(JSON.stringify(c).includes('Save'), false, 'stored control state contains hashes, not control text')
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
  assert.equal(again.blocked, true); assert.equal(again.repeat, 2)
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

test('repeated input receives a not-executed diagnostic and eventually halts; it is never replayed', async t => {
  const f = fixture(t, { action: 'launch_app', parameters: { app_id: 'synthetic', launch_reference_id: 'synthetic' }, limits: limits({ maxRepeatedAction: 3 }) })
  await f.run(); assert.equal(f.executions.length, 1)
  await f.run(); assert.equal(f.executions.length, 1); assert.equal(f.sends.at(-1).code, 'no_progress')
  assert.equal(f.state().execution_fact, 'not_executed')
  await f.run(); assert.equal(f.executions.length, 1); assert.equal(f.sends.at(-1).code, 'progress_limit')
  const task = f.coordinator.current('deepseek')
  assert.equal(task.control.halted, 'repeated_action'); assert.equal(task.progress.phase, 'blocked')
  assert.equal(f.sends.at(-1).progress_control.goal_verified, false)
  assert.equal(f.sends.at(-1).next_step_token, undefined)
  assert.equal(f.loop.enqueue(f.request()), 'busy'); assert.equal(f.executions.length, 1)
})

test('task deadline stops model-waiting goals and invalidates old leases without discarding the goal', t => {
  const clock = new Clock(), f = fixture(t, { clock, limits: limits({ taskTimeoutMs: 60_000 }) }), owner = f.lease()
  clock.advance(60_000)
  assert.equal(f.coordinator.owns(owner), false); assert.equal(f.coordinator.current('deepseek'), null)
  const stored = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
  assert.equal(stored.control.halted, 'task_timeout'); assert.equal(stored.originalRequest, f.first.originalRequest)
  assert.equal(stored.status, 'stopped'); assert.match(stored.progress.detail, /未完成/)
  assert.equal(f.executions.length, 0); assert.equal(f.sends.length, 0)
})

test('pause and waiting-user intervals do not consume the task clock', t => {
  const clock = new Clock(), f = fixture(t, { clock, limits: limits({ taskTimeoutMs: 60_000 }) })
  f.coordinator.setPaused(true); clock.advance(120_000); f.coordinator.setPaused(false)
  assert.ok(f.coordinator.current('deepseek'))
  f.coordinator.noteReply('deepseek', 'question-1', 'question'); clock.advance(120_000)
  f.submit({ submission: { id: 'user:answer:1', kind: 'clarification' }, text: '补充缺失资料。' })
  assert.ok(f.coordinator.current('deepseek'))
  clock.advance(59_999); assert.ok(f.coordinator.current('deepseek'))
  clock.advance(1); assert.equal(f.coordinator.current('deepseek'), null)
})

test('action expiry requests cancellation and keeps the desktop permit until the actual executor returns', async t => {
  const clock = new Clock(), done = deferred(); let released = 0
  const f = fixture(t, { clock, limits: limits({ actionTimeoutMs: 1000 }), execute: () => done.promise,
    acquire: async () => ({ release() { released++ } }) })
  f.loop.enqueue(f.request()); await tick()
  clock.advance(1000)
  assert.equal(f.executions[0].signal.aborted, true); assert.equal(released, 0)
  assert.equal(f.sends.length, 0)
  done.resolve(receipt({ execution: 'executed' })); await f.loop.wake()
  assert.equal(released, 1); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.sends[0].progress_control.action_timed_out, true)
  assert.equal(f.sends[0].code, 'ok', 'a late real success receipt is not changed into a fictitious failure')
})

test('consecutive wait timeouts halt with their actual result facts and a final report', async t => {
  const f = fixture(t, { action: 'wait_for', parameters: { condition: 'delay', timeout_ms: 1000 }, limits: limits({ maxConsecutiveTimeouts: 2 }),
    execute: () => receipt({ action: 'wait_for', ok: false, code: 'wait_timeout' }) })
  await f.run(); await f.run()
  assert.equal(f.executions.length, 2); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.coordinator.current('deepseek').control.halted, 'consecutive_timeouts')
  assert.equal(f.sends.at(-1).diagnosis.same_action_retry, 'stop')
  assert.equal(f.sends.at(-1).progress_control.stop_reason, 'consecutive_timeouts')
})

test('native helper timeout codes survive adapter context errors and count as timeouts', async t => {
  const f = fixture(t, { execute: () => receipt({ ok: false, code: 'inactive_context', execution: 'unknown', data: { helper_code: 'action_timeout' } }) })
  await f.run()
  assert.equal(f.sends[0].progress_control.action_timed_out, true)
  assert.equal(f.sends[0].progress_control.consecutive_timeouts, 1)
  assert.equal(f.sends[0].diagnosis.category, 'loading_timeout')
  assert.equal(f.state().execution_fact, 'unknown')
})

test('recovery is bounded even when the model keeps choosing different requests', async t => {
  const f = fixture(t, { limits: limits({ maxRecoverySteps: 2 }), execute: call => receipt({ action: call.action, ok: false, code: 'invalid_parameters', execution: 'not_executed' }) })
  for (let n = 0; n < 3; n++) await f.run(f.request({ call: { action: 'observe', parameters: { target: 'region', x: n, y: 0, width: 100, height: 100 } } }))
  assert.equal(f.coordinator.current('deepseek').control.halted, 'recovery_limit')
  assert.equal(f.executions.length, 3); assert.equal(f.sends.at(-1).progress_control.goal_verified, false)
})

test('delivery busy retries do not consume steps, repeats, timeout or recovery budgets', async t => {
  let attempts = 0
  const f = fixture(t, { send: () => ++attempts < 3 ? 'busy' : 'ok' })
  await f.run(); const before = plain(f.coordinator.current('deepseek').control), text = f.deliveries[0].text
  await f.retry(); await f.retry()
  const after = f.coordinator.current('deepseek').control
  assert.equal(after.steps, before.steps); assert.deepEqual(plain(after.repeats), before.repeats)
  assert.equal(after.consecutiveTimeouts, before.consecutiveTimeouts); assert.equal(after.recoverySteps, before.recoverySteps)
  assert.equal(f.executions.length, 1); assert.ok(f.deliveries.every(d => d.text === text))
})

test('legacy terminal/file steps share the quota and resumed goals retain the original policy/counters', t => {
  const f = fixture(t, { limits: limits({ maxSteps: 5 }) })
  const originalPolicy = plain(f.first.control.limits)
  for (let n = 0; n < 2; n++) {
    const step = f.coordinator.reserveToolStep(f.lease(), 'file-' + n, 'read_files', f.first.machine)
    f.coordinator.noteToolStep(step, { stage: 'delivered', execution: 'executed' })
  }
  f.coordinator.stop('deepseek', 'interrupted')
  const resumed = f.submit({ resume: { taskId: f.first.id, generation: f.first.generation } })
  assert.equal(resumed.control.steps, 2); assert.deepEqual(plain(resumed.control.limits), originalPolicy)
  const lease = f.lease()
  for (let n = 2; n < 5; n++) {
    const step = f.coordinator.reserveToolStep(lease, 'file-' + n, 'read_files', f.first.machine)
    assert.ok(step); f.coordinator.noteToolStep(step, { stage: 'delivered', execution: 'executed' })
  }
  assert.equal(f.coordinator.reserveToolStep(lease, 'one-too-many', 'command', f.first.machine), null)
  assert.equal(f.coordinator.current('deepseek'), null)
  assert.equal(f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a').control.halted, 'step_limit')
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

test('actual settings persistence validates before writes and falls back safely on corrupt saved JSON', () => {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL('../src/main/computer-use-settings.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, require: name => progressVmModules[name] })
  const values = new Map(), writes = []
  const store = { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => { writes.push(key); values.set(key, value) } }
  assert.throws(() => exports.saveComputerUsePreferences(store, { computerUseEnabled: true, computerUseLimits: { maxSteps: 0 } }), /运行上限/)
  assert.equal(writes.length, 0)
  exports.saveComputerUsePreferences(store, { computerUseLimits: limits({ maxSteps: 25 }) })
  assert.equal(exports.readComputerUsePreferences(store).computerUseLimits.maxSteps, 25)
  values.set('computerUseLimits', 'broken-json')
  assert.deepEqual(plain(exports.readComputerUsePreferences(store).computerUseLimits), plain(policy.normalizeComputerProgressLimits()))
})

test('a separately saved hard-limit receipt restores its stop reason after checkpoint failure', async t => {
  const f = fixture(t, { action: 'wait_for', parameters: { condition: 'delay' }, limits: limits({ maxConsecutiveTimeouts: 1 }),
    execute: () => receipt({ action: 'wait_for', ok: false, code: 'wait_timeout' }) })
  f.db.exec(`CREATE TRIGGER reject_limit_checkpoint BEFORE UPDATE ON autonomous_tasks
    WHEN json_extract(NEW.payload, '$.control.halted') = 'consecutive_timeouts'
    BEGIN SELECT RAISE(FAIL, 'synthetic checkpoint failure'); END`)
  await f.run(); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(JSON.parse(f.state().result_json).progress_control.halted, true)
  assert.equal(f.sends.length, 0)
  f.db.exec('DROP TRIGGER reject_limit_checkpoint')
  f.coordinator.stop('deepseek', 'interrupted') // Graceful close can save an older task snapshot after the error.
  recovery.recoverInterruptedComputerActions(f.db)
  const restored = f.store.latestAutonomousTask('session-a', 'deepseek', 'chat-a')
  assert.equal(restored.control.halted, 'consecutive_timeouts'); assert.equal(restored.control.consecutiveTimeouts, 1)
  assert.equal(restored.status, 'interrupted')
})

test('completion notifications are suppressed for a task stopped by its limits', () => {
  const ast = ts.createSourceFile('runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'SessionRuntime')
  const method = cls.members.find(n => n.name?.getText(ast) === 'notifyTaskCompleted').getText(ast)
  const Subject = new Script(ts.transpileModule(`class Subject { ${method} }; Subject`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({})
  let completed = 0
  const subject = Object.assign(new Subject(), { taskCoordinator: { isLimited: () => true }, activePlatformId: 'deepseek',
    embed: { getState: () => ({ conversationId: 'chat-a' }) }, options: { onTaskCompleted: () => completed++ } })
  subject.notifyTaskCompleted('模型称已完成')
  assert.equal(completed, 0)
})
