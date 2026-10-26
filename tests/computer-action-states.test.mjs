// User-run only: node --test tests/computer-action-states.test.mjs
// Actual SQLite/state/progression code with synthetic tools, acknowledgements and images.
// No Electron, helper, desktop, network, real files, shell or process is started.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fixture, plain, deferred } from './fixtures/computer-action-runtime.mjs'

const image = { id: 'img_' + 'a'.repeat(32), sha256: 'b'.repeat(64), mime_type: 'image/png' }
const result = (call, patch = {}) => ({ type: 'computer_result', version: 1, action: call.action, ok: true, code: 'ok', execution: 'executed', message: 'Actual synthetic input result', ...patch })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('queued cancellation records no execution and never starts a tool', async t => {
  const f = fixture(t); f.pause(true); f.loop.enqueue(f.request()); await f.loop.wake()
  assert.equal(f.state().execution_state, 'queued'); assert.equal(f.state().execution_fact, 'not_executed')
  assert.equal(f.state().delivery_state, 'pending'); f.loop.cancel()
  assert.equal(f.state().execution_state, 'cancelled'); assert.equal(f.state().execution_fact, 'not_executed')
  assert.equal(f.state().delivery_state, 'cancelled'); assert.equal(f.executions.length, 0)
})

test('dispatch is committed before input; a successful click remains completed while its image is uploading', async t => {
  const ack = deferred(); let f
  f = fixture(t, { action: 'click', parameters: { observation_id: 'fresh-observation', x: 4, y: 5 },
    execute: call => {
      assert.equal(f.state().execution_state, 'dispatching'); assert.equal(f.state().execution_fact, 'unknown')
      return result(call, { attachments: [image] })
    }, send: () => ack.promise })
  f.loop.enqueue(f.request()); await tick()
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.state().delivery_state, 'uploading'); assert.equal(f.state().delivery_attempts, 1)
  assert.equal(f.observations()[0].delivery_state, 'uploading'); assert.equal(f.observations()[0].sha256, image.sha256)
  assert.equal(Object.keys(f.observations()[0]).some(key => /path|bytes|base64/.test(key)), false)
  ack.resolve('ok'); await f.loop.wake()
  assert.equal(f.state().delivery_state, 'sent'); assert.equal(f.observations()[0].delivery_state, 'sent')
  assert.ok(f.state().result_json); assert.ok(f.state().delivery_text, 'history retains the exact payload even after delivery')
  assert.equal(f.coordinator.current('deepseek').progress.currentStep.resultText, null)
})

test('a proven pre-submit upload failure retries the same result and image without repeating the click', async t => {
  const outcomes = ['failed', 'ok'], f = fixture(t, { action: 'click', execute: call => result(call, { attachments: [image] }), send: () => outcomes.shift() })
  await f.run(); const saved = f.state().result_json
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.state().delivery_state, 'failed'); assert.equal(f.released.length, 0)
  await f.loop.wake(); assert.equal(f.sends.length, 1, 'unrelated page events do not bypass the delivery retry delay')
  await f.retry()
  assert.equal(f.executions.length, 1); assert.equal(f.claims().length, 1); assert.equal(f.state().delivery_attempts, 2)
  assert.equal(f.state().delivery_state, 'sent'); assert.equal(f.state().result_json, saved)
  assert.equal(f.deliveries[0].text, f.deliveries[1].text)
  assert.deepEqual(plain(f.deliveries[0].attachments), plain(f.deliveries[1].attachments)); assert.equal(f.released.length, 1)
})

test('three confirmed delivery failures stop retrying while keeping the execution fact and original payload', async t => {
  const f = fixture(t, { execute: call => result(call, { attachments: [image] }), send: () => 'failed' })
  await f.run(); await f.retry(); await f.retry(); await f.loop.wake()
  assert.equal(f.sends.length, 3); assert.equal(f.executions.length, 1)
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().delivery_state, 'failed')
  assert.equal(f.state().delivery_attempts, 3); assert.ok(f.state().delivery_text)
  assert.equal(f.coordinator.current('deepseek').progress.currentStep.delivery, 'failed')
})

test('a text insertion failure retries only its persisted text and never the desktop action', async t => {
  const outcomes = ['insert-failed', 'ok'], f = fixture(t, { send: () => outcomes.shift() })
  await f.run(); assert.equal(f.state().delivery_state, 'failed')
  await f.retry(); assert.equal(f.state().delivery_state, 'sent'); assert.equal(f.executions.length, 1)
  assert.equal(f.deliveries[0].text, f.deliveries[1].text)
})

test('unconfirmed submission never retries or downgrades a known successful action', async t => {
  for (const outcome of ['unknown', 'stuck', 'stale']) {
    const f = fixture(t, { execute: call => result(call, { attachments: [image] }), send: () => outcome })
    await f.run(); await f.loop.wake()
    assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().execution_fact, 'executed')
    assert.equal(f.state().delivery_state, 'unknown'); assert.equal(f.observations()[0].delivery_state, 'unknown')
    assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.released.length, 1)
  }
})

test('failed or unknown executor results can be delivered successfully without becoming successful actions', async t => {
  for (const [execution, expected] of [['not_executed', 'failed'], ['unknown', 'unknown'], ['executed', 'failed']]) {
    const f = fixture(t, { execute: call => result(call, { ok: false, code: 'click_failed', execution }) })
    await f.run(); assert.equal(f.state().execution_state, expected); assert.equal(f.state().execution_fact, execution)
    assert.equal(f.state().delivery_state, 'sent')
  }
})

test('an executor exception persists an unknown input fact independently from delivery', async t => {
  const f = fixture(t, { execute: () => { throw new Error('synthetic executor loss') } })
  await f.run(); assert.equal(f.state().execution_state, 'unknown'); assert.equal(f.state().execution_fact, 'unknown')
  assert.equal(f.state().delivery_state, 'sent'); assert.equal(JSON.parse(f.state().result_json).code, 'executor_error')
})

test('a cancelled running old goal can record its late actual result without advancing the new goal', async t => {
  const done = deferred(), f = fixture(t, { execute: () => done.promise }), owner = f.lease()
  f.loop.enqueue(f.request()); await tick(); f.submit()
  assert.equal(f.state().execution_state, 'unknown'); assert.equal(f.state().delivery_state, 'cancelled')
  const next = f.coordinator.current('deepseek'), token = f.coordinator.computerStepToken('deepseek')
  done.resolve(result({ action: 'observe' }, { attachments: [image] })); await f.loop.wake()
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.state().delivery_state, 'cancelled'); assert.equal(f.observations()[0].delivery_state, 'cancelled')
  assert.equal(f.sends.length, 0); assert.equal(f.released.length, 1)
  assert.equal(f.coordinator.current('deepseek').id, next.id); assert.equal(f.coordinator.computerStepToken('deepseek'), token)
  assert.equal(f.store.listComputerActions(owner)[0].executionState, 'completed')
  assert.equal(f.store.listComputerActions(f.lease()).length, 0)
})

test('cancel during submission preserves uncertainty; a real late acknowledgement updates only history', async t => {
  const ack = deferred(), f = fixture(t, { send: () => ack.promise })
  f.loop.enqueue(f.request()); await tick(); f.submit()
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().delivery_state, 'unknown')
  const token = f.coordinator.computerStepToken('deepseek'); ack.resolve('ok'); await f.loop.wake()
  assert.equal(f.state().delivery_state, 'sent'); assert.equal(f.coordinator.current('deepseek').progress.stepCount, 0)
  assert.equal(f.coordinator.computerStepToken('deepseek'), token)
})

test('failure saving a send acknowledgement cannot erase the earlier completed input record', async t => {
  const f = fixture(t)
  f.db.exec("CREATE TRIGGER reject_ack BEFORE UPDATE OF delivery_state ON computer_actions WHEN NEW.delivery_state = 'sent' BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END")
  await f.run(); assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 1)
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.state().delivery_state, 'unknown'); assert.ok(f.state().result_json); assert.equal(f.errors.length, 1)
})

test('a failure building task continuity still retains the already returned action fact', async t => {
  const f = fixture(t, { continuity: () => { throw new Error('synthetic formatting failure') } })
  await f.run(); assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 0)
  assert.equal(f.state().execution_state, 'completed'); assert.equal(f.state().execution_fact, 'executed')
  assert.equal(f.state().delivery_state, 'cancelled'); assert.ok(f.state().result_json)
})

test('failure saving the executor result leaves an unknown record and never automatically repeats input', async t => {
  const f = fixture(t)
  f.db.exec("CREATE TRIGGER reject_result BEFORE UPDATE OF result_json ON computer_actions BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END")
  await f.run(); await f.loop.wake()
  assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 0)
  assert.equal(f.state().execution_state, 'unknown'); assert.equal(f.state().execution_fact, 'unknown')
  assert.equal(f.state().result_json, null); assert.equal(f.errors.length, 1)
})

test('wrong owners, stale delivery attempts and redispatch of completed actions are rejected atomically', async t => {
  const f = fixture(t); await f.run(); const row = f.state(), owner = f.lease()
  const update = event => ({ ...owner, executionId: row.execution_id, at: Date.now(), ...event })
  assert.throws(() => f.store.saveAutonomousTasks([], undefined, update({ event: 'dispatch' })), /already-dispatched/)
  assert.throws(() => f.store.saveAutonomousTasks([], undefined, { ...update({ event: 'cancel' }), taskId: 'other-task' }), /owner-mismatch/)
  assert.throws(() => f.store.saveAutonomousTasks([], undefined, update({ event: 'delivery-outcome', attemptId: randomUUID(), outcome: 'ok' })), /attempt-mismatch/)
  assert.throws(() => f.store.saveAutonomousTasks([], undefined, update({ event: 'result', result: result({ action: 'observe' }, { message: 'Changed result' }) })), /immutable/)
  assert.equal(f.state().delivery_state, 'sent'); assert.equal(f.state().result_json, row.result_json)
})

test('admission-only old history gets unknown states without recreating an executor or grant', async t => {
  const f = fixture(t); await f.run(); f.db.exec('DELETE FROM computer_observations'); f.db.exec('DELETE FROM computer_actions')
  const source = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
  const backfill = source.match(/INSERT OR IGNORE INTO computer_actions[\s\S]*?FROM computer_action_claims;/)[0]
  f.db.exec(backfill); f.db.exec(backfill)
  assert.equal(f.state().execution_state, 'unknown'); assert.equal(f.state().delivery_state, 'unknown')
  assert.equal(f.executions.length, 1); assert.equal(f.state().delivery_attempts, 0)
})
