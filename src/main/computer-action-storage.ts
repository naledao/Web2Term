import type { DatabaseSync } from 'node:sqlite'
import type { ComputerActionClaim, ComputerActionUpdate, ComputerExecutionState } from '../shared/computer-actions'
import type { ComputerUseImageReference, ComputerUseToolResult } from '../shared/computer-use'

interface StoredAction {
  kind: string
  action: string
  execution_state: ComputerExecutionState
  execution_fact: ComputerUseToolResult['execution']
  delivery_state: string
  dispatched_at: number | null
  result_json: string | null
  delivery_text: string | null
  active_attempt_id: string | null
}

/** Called only inside the task/claim transaction. Existing admissions cannot be reset. */
export function insertComputerAction(db: DatabaseSync, claim: ComputerActionClaim): void {
  db.prepare(`INSERT INTO computer_actions (execution_id, execution_state, execution_fact, delivery_state, created_at, updated_at)
    VALUES (?, 'queued', 'not_executed', 'pending', ?, ?)`).run(claim.executionId, claim.createdAt, claim.createdAt)
}

/** Save history against the immutable claim, including late results from a cancelled old goal. */
export function writeComputerAction(db: DatabaseSync, update: ComputerActionUpdate): void {
  if (!Number.isSafeInteger(update.at) || update.at < 0) throw new Error('invalid-computer-action-time')
  const row = db.prepare(`SELECT a.*, c.kind, c.action FROM computer_actions a JOIN computer_action_claims c ON c.execution_id = a.execution_id
    WHERE c.execution_id = ? AND c.session_id = ? AND c.platform_id = ? AND c.conversation_id = ? AND c.task_id = ? AND c.generation = ?`)
    .get(update.executionId, update.sessionId, update.platformId, update.conversationId, update.taskId, update.generation) as unknown as StoredAction | undefined
  if (!row) throw new Error('computer-action-owner-mismatch')
  const touch = (sql: string, ...values: Array<string | number | null>): void => {
    db.prepare(sql).run(...values, update.at, update.executionId)
  }
  const images = (state: string): void => { touch('UPDATE computer_observations SET delivery_state = ?, updated_at = ? WHERE execution_id = ?', state) }
  if (update.event === 'dispatch') {
    if (row.kind !== 'action' || row.execution_state !== 'queued' || row.dispatched_at !== null || row.result_json !== null) throw new Error('computer-action-already-dispatched')
    touch("UPDATE computer_actions SET execution_state = 'dispatching', execution_fact = 'unknown', dispatched_at = ?, updated_at = ? WHERE execution_id = ?", update.at)
  } else if (update.event === 'result') {
    const result = update.result
    if (!['not_executed', 'executed', 'unknown'].includes(result.execution) || typeof result.ok !== 'boolean' ||
      typeof result.code !== 'string' || typeof result.message !== 'string' || result.message.length > 64_000)
      throw new Error('invalid-computer-action-result')
    if (row.dispatched_at === null && result.execution !== 'not_executed') throw new Error('computer-action-not-dispatched')
    if (row.kind === 'action' && result.action !== row.action) throw new Error('computer-action-result-mismatch')
    const references: ComputerUseImageReference[] = result.attachments ?? []
    if (!Array.isArray(references) || references.length > 8 || new Set(references.map(ref => ref?.id)).size !== references.length ||
      references.some(ref => !ref || typeof ref.id !== 'string' || !/^img_[a-f0-9]{32}$/.test(ref.id) || ref.mime_type !== 'image/png' || !/^[a-f0-9]{64}$/.test(ref.sha256)))
      throw new Error('invalid-computer-observation-reference')
    let encoded: string
    try {
      encoded = JSON.stringify(result)
      if (encoded.length > 256_000) throw new Error('oversized-result')
    } catch {
      // Keep the executor's input fact even if its extra data cannot be serialized.
      encoded = JSON.stringify({ type: 'computer_result', version: 1, action: result.action, ok: result.ok, code: result.code,
        execution: result.execution, message: result.message, attachments: references, diagnosis: result.diagnosis, progress_control: result.progress_control, serialization_error: true })
    }
    if (row.result_json !== null) { if (row.result_json !== encoded) throw new Error('computer-action-result-immutable'); return }
    const state = result.execution === 'unknown' ? 'unknown' : result.code === 'cancelled' || result.code === 'inactive_context' ? 'cancelled'
      : result.ok && result.execution === 'executed' ? 'completed' : 'failed'
    touch('UPDATE computer_actions SET execution_state = ?, execution_fact = ?, result_json = ?, finished_at = ?, updated_at = ? WHERE execution_id = ?', state, result.execution, encoded, update.at)
    const statement = db.prepare(`INSERT INTO computer_observations (execution_id, image_id, sha256, mime_type, delivery_state, created_at, updated_at)
      VALUES (?, ?, ?, 'image/png', ?, ?, ?)`)
    for (const ref of references) statement.run(update.executionId, ref.id, ref.sha256, row.delivery_state, update.at, update.at)
  } else if (update.event === 'ready') {
    if (row.result_json === null || typeof update.text !== 'string' || !update.text || update.text.length > 256_000 ||
      row.delivery_text !== null && row.delivery_text !== update.text) throw new Error('invalid-computer-delivery-text')
    touch('UPDATE computer_actions SET delivery_text = ?, updated_at = ? WHERE execution_id = ?', update.text)
  } else if (update.event === 'delivery-start') {
    if (!['pending', 'failed'].includes(row.delivery_state) || !row.delivery_text || row.result_json === null ||
      !/^[a-f0-9-]{36}$/.test(update.attemptId)) throw new Error('computer-delivery-not-retryable')
    const hasImage = !!db.prepare('SELECT 1 FROM computer_observations WHERE execution_id = ? LIMIT 1').get(update.executionId)
    const state = hasImage ? 'uploading' : 'sending'
    touch('UPDATE computer_actions SET delivery_state = ?, active_attempt_id = ?, delivery_attempts = delivery_attempts + 1, updated_at = ? WHERE execution_id = ?', state, update.attemptId)
    images(state)
  } else if (update.event === 'delivery-outcome') {
    if (row.active_attempt_id !== update.attemptId || !['uploading', 'sending', 'unknown'].includes(row.delivery_state)) throw new Error('computer-delivery-attempt-mismatch')
    // Cancellation during submission may leave a real acknowledgement in flight.
    // Only a positive acknowledgement can refine unknown back to sent.
    const state = update.outcome === 'ok' ? 'sent' : row.delivery_state === 'unknown' ? 'unknown'
      : update.outcome === 'busy' || update.outcome === 'no-composer' ? 'pending' : update.outcome === 'failed' ? 'failed' : 'unknown'
    touch('UPDATE computer_actions SET delivery_state = ?, updated_at = ? WHERE execution_id = ?', state)
    images(state)
  } else if (update.event === 'cancel') {
    const execution = row.execution_state === 'queued' ? 'cancelled' : row.execution_state === 'dispatching' ? 'unknown' : row.execution_state
    const fact = row.execution_state === 'queued' ? 'not_executed' : row.execution_fact
    const delivery = row.delivery_state === 'sent' ? 'sent' : ['sending', 'uploading', 'unknown'].includes(row.delivery_state) ? 'unknown' : 'cancelled'
    touch('UPDATE computer_actions SET execution_state = ?, execution_fact = ?, delivery_state = ?, updated_at = ? WHERE execution_id = ?', execution, fact, delivery)
    images(delivery)
  } else throw new Error('invalid-computer-action-event')
}
