// User-run only: node --test tests/computer-action-dedup.test.mjs
// Actual SQLite/coordinator/progression fixture; no Electron, desktop, shell or network.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { test } from 'node:test'
import { fixture, actions, plain, deferred } from './fixtures/computer-action-runtime.mjs'

test('one answer executes once despite duplicate reports, renamed transport IDs or mutated JSON', async t => {
  const f = fixture(t), first = f.request(); assert.equal(await f.run(first), 'accepted')
  const currentToken = f.coordinator.computerStepToken('deepseek')
  assert.equal(await f.run(first), 'duplicate')
  const renamed = f.request({ stepToken: first.stepToken }); renamed.receipt.rawJson = first.receipt.rawJson
  assert.equal(await f.run(renamed), 'duplicate', 'a remounted reply cannot borrow a new message ID')
  assert.equal(await f.run({ ...first, stepToken: currentToken, call: { action: 'click', parameters: { x: 42, y: 7 } } }), 'duplicate')
  assert.equal(f.claims().length, 1); assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 1)
  assert.equal(f.coordinator.computerStepToken('deepseek'), currentToken, 'replays do not consume or rotate the next grant')
})

test('identical action parameters are allowed in distinct acknowledged steps and replacement goals', async t => {
  const f = fixture(t); await f.run(f.request({ receipt: undefined })); await f.run(f.request({ receipt: undefined }))
  assert.equal(f.executions.length, 2); assert.equal(f.claims().length, 2)
  assert.deepEqual(plain(f.executions[0].call), plain(f.executions[1].call))
  assert.notEqual(f.claims()[0].execution_id, f.claims()[1].execution_id)
  assert.notEqual(f.claims()[0].grant_token, f.claims()[1].grant_token)
  assert.equal(f.claims()[0].request_hash, f.claims()[1].request_hash, 'identical request fingerprints are not a global prohibition')
  const old = f.request(); f.submit(); assert.equal(await f.run(old), 'inactive')
  await f.run(); assert.equal(f.claims().length, 3); assert.equal(f.executions.length, 3)
})

test('SQLite still suppresses consumed tokens when the process-local claim cache is absent', async t => {
  const f = fixture(t), first = f.request(); await f.run(first)
  f.coordinator.computerClaims.clear()
  assert.equal(f.store.hasComputerAction(f.lease(), 'remounted-answer', first.stepToken), true)
  assert.equal(await f.run(f.request({ stepToken: first.stepToken })), 'duplicate')
  for (const patch of [{ sessionId: 'other' }, { platformId: 'other' }, { conversationId: 'other' }, { taskId: 'other' }, { generation: 2 }]) {
    assert.equal(f.store.hasComputerAction({ ...f.lease(), ...patch }, first.sourceMessageId, first.stepToken), false)
  }
  assert.equal(f.executions.length, 1)
})

test('action admission and task progress roll back together when the journal write fails', async t => {
  const f = fixture(t), before = f.payload()
  f.db.exec("CREATE TRIGGER reject_claim BEFORE INSERT ON computer_action_claims BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END")
  assert.equal(await f.run(), 'inactive')
  assert.equal(f.claims().length, 0); assert.equal(f.executions.length, 0); assert.equal(f.sends.length, 0)
  assert.equal(f.payload(), before); assert.equal(f.errors.length, 1)
})

test('SQL unique constraints reject a second reservation atomically even when preliminary checks are bypassed', async t => {
  const f = fixture(t); await f.run()
  const row = f.claims()[0], saved = f.coordinator.current('deepseek'), before = f.payload()
  const original = { sessionId: row.session_id, platformId: row.platform_id, conversationId: row.conversation_id, taskId: row.task_id,
    generation: row.generation, executionId: row.execution_id, machineId: row.machine_id, sourceMessageId: row.source_message_id,
    grantToken: row.grant_token, receivedToken: row.received_token, action: row.action, kind: row.kind,
    requestJson: row.request_json, requestHash: row.request_hash, createdAt: row.created_at }
  for (const change of [{ sourceMessageId: 'computer:renamed:1' }, { grantToken: 'cu_' + 'b'.repeat(32), receivedToken: 'cu_' + 'b'.repeat(32) }]) {
    const claim = { ...original, executionId: crypto.randomUUID(), ...change }, task = structuredClone(saved)
    if (!task.progress.handledMessageIds.includes(claim.sourceMessageId)) { task.progress.handledMessageIds.push(claim.sourceMessageId); task.progress.stepCount++ }
    Object.assign(task.progress.currentStep, { id: claim.executionId, sourceMessageId: claim.sourceMessageId, stepToken: claim.receivedToken, status: 'queued', execution: 'not_executed', delivery: 'pending' })
    task.progress.phase = 'waiting-tool'
    assert.throws(() => f.store.saveAutonomousTasks([task], claim), /already-claimed/)
    assert.equal(f.payload(), before); assert.equal(f.claims().length, 1)
  }
  assert.throws(() => f.store.saveAutonomousTasks([saved], { ...original, requestHash: '0'.repeat(64) }), /invalid-computer-action-claim/)
  assert.equal(f.payload(), before)
})

test('protocol feedback is claimed too, and repeated old feedback cannot rotate a later grant', async t => {
  const f = fixture(t), incoming = f.request()
  const feedback = { ...incoming, stepToken: null, result: { type: 'computer_result', version: 1, action: 'observe', ok: false,
    code: 'invalid_json', execution: 'not_executed', message: 'Synthetic malformed input' } }
  delete feedback.call
  feedback.receipt = { ...feedback.receipt, rawJson: '{"type":"computer",', outcome: 'invalid', issue: 'invalid-json' }
  assert.equal(await f.run(feedback), 'accepted'); assert.equal(f.executions.length, 0)
  assert.equal(f.claims()[0].kind, 'feedback'); assert.equal(f.claims()[0].received_token, null)
  const next = f.coordinator.computerStepToken('deepseek')
  assert.equal(await f.run(feedback), 'duplicate'); assert.equal(f.coordinator.computerStepToken('deepseek'), next)
  await f.run(); assert.equal(f.executions.length, 1); assert.equal(f.claims().length, 2)
})

test('a missing journal or failed lookup fails closed before an action is admitted', async t => {
  const f = fixture(t), before = f.payload(); f.db.exec('DROP TABLE computer_action_claims')
  assert.equal(await f.run(), 'inactive'); assert.equal(f.executions.length, 0); assert.equal(f.payload(), before)
  assert.equal(f.errors.length, 1)
})

test('busy delivery retries the saved result without another claim, token consumption or action', async t => {
  const outcomes = ['busy', 'no-composer', 'ok'], f = fixture(t, { send: () => outcomes.shift() })
  await f.run(); const first = f.claims()[0]
  await f.retry(); await f.retry()
  assert.equal(f.claims().length, 1); assert.equal(f.executions.length, 1); assert.equal(f.sends.length, 3)
  assert.equal(new Set(f.sends.map(result => result.step_id)).size, 1)
  assert.equal(f.sends[0].step_id, first.execution_id); assert.equal(f.coordinator.current('deepseek').progress.phase, 'waiting-model')
})

test('cancellation after dispatch retains admission history and suppresses late delivery or replay', async t => {
  const done = deferred(), f = fixture(t, { execute: () => done.promise }), first = f.request()
  f.loop.enqueue(first); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.claims().length, 1); assert.equal(f.executions.length, 1)
  f.submit(); assert.equal(f.executions[0].signal.aborted, true)
  done.resolve({ type: 'computer_result', version: 1, action: 'observe', ok: true, code: 'ok', execution: 'executed', message: 'Late result' })
  await f.loop.wake(); assert.equal(f.sends.length, 0); assert.equal(await f.run(first), 'inactive')
  assert.equal(f.claims().length, 1)
})

test('reopening persisted task history does not restore a grant or execute queued work', async t => {
  const f = fixture(t); f.pause(true); const old = f.request(); f.loop.enqueue(old); await f.loop.wake()
  assert.equal(f.claims().length, 1); assert.equal(f.executions.length, 0)
  f.loop.dispose()
  const coordinator = new TaskCoordinator('session-a', f.store, () => {})
  assert.equal(coordinator.context('deepseek', 'chat-a').task.status, 'interrupted')
  assert.equal(coordinator.owns(old), false); assert.equal(coordinator.isComputerStepToken(old, old.stepToken), false)
  assert.equal(f.claims().length, 1); assert.equal(f.executions.length, 0)
})

test('canonical requests retain Unicode, escapes, array order and nested values without content-only deduplication', () => {
  const call = { action: 'type_text', parameters: { text: 'C:\\报表\\a.xlsx\n{内容}', nested: { z: 0, a: false }, list: [2, 1] } }
  const reordered = { action: call.action, parameters: { list: [2, 1], nested: { a: false, z: 0 }, text: call.parameters.text } }
  assert.equal(actions.computerActionRequest(call), actions.computerActionRequest(reordered))
  assert.notEqual(actions.computerActionRequest(call), actions.computerActionRequest({ ...call, parameters: { ...call.parameters, list: [1, 2] } }))
  assert.equal(JSON.parse(actions.computerActionRequest(call)).call.parameters.text, call.parameters.text)
})
