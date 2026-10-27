import type { DatabaseSync } from 'node:sqlite'
import { parseAutonomousTask } from '../shared/autonomous-task'
import type { AutonomousTask } from '../shared/autonomous-task'
import type { ComputerActionRecord } from '../shared/computer-actions'
import { PROGRESS_STOP_MESSAGES } from '../shared/computer-progress'

// Restored advice never advertises capabilities from an older process.
const objectDiagnosis = (v: unknown): unknown => v && typeof v === 'object' && 'category' in v && 'requires_fresh_observation' in v
  && typeof v.category === 'string' && v.category.length <= 64 && typeof v.requires_fresh_observation === 'boolean'
  ? { category: v.category, requires_fresh_observation: v.requires_fresh_observation } : null

function restoreProgressReport(task: AutonomousTask, raw: string | null | undefined): void {
  if (!task.control || !raw) return
  try {
    const r = JSON.parse(raw).progress_control
    if (r && r.version === 1 && r.steps === task.control.steps &&
      [r.elapsed_ms, r.unchanged_observations, r.consecutive_timeouts, r.recovery_steps].every(v => Number.isSafeInteger(v) && v >= 0)) {
      task.control.elapsedMs = Math.max(task.control.elapsedMs, r.elapsed_ms)
      task.control.unchangedObservations = r.unchanged_observations
      task.control.consecutiveTimeouts = r.consecutive_timeouts
      task.control.recoverySteps = r.recovery_steps
      if (r.halted === true && typeof r.stop_reason === 'string' && Object.hasOwn(PROGRESS_STOP_MESSAGES, r.stop_reason)) task.control.halted = r.stop_reason
    }
  } catch { /* Original history remains readable without a valid progress report. */ }
}

/** Startup migration only. Never called on helper restarts or while live operations exist. */
export function recoverInterruptedComputerActions(db: DatabaseSync, at = Date.now()): number {
  db.exec('BEGIN IMMEDIATE')
  try {
    const changed = db.prepare(`UPDATE computer_actions SET
      execution_state = CASE execution_state WHEN 'queued' THEN 'cancelled' WHEN 'dispatching' THEN 'unknown' ELSE execution_state END,
      execution_fact = CASE execution_state WHEN 'queued' THEN 'not_executed' WHEN 'dispatching' THEN 'unknown' ELSE execution_fact END,
      delivery_state = CASE WHEN delivery_state IN ('uploading','sending') THEN 'unknown'
        WHEN delivery_state IN ('pending','failed') THEN 'cancelled' ELSE delivery_state END,
      updated_at = ? WHERE execution_state IN ('queued','dispatching') OR delivery_state IN ('pending','failed','uploading','sending')`).run(at).changes
    db.prepare(`UPDATE computer_observations SET delivery_state = (SELECT delivery_state FROM computer_actions a WHERE a.execution_id = computer_observations.execution_id),
      updated_at = ? WHERE delivery_state <> (SELECT delivery_state FROM computer_actions a WHERE a.execution_id = computer_observations.execution_id)`).run(at)
    const tasks = db.prepare('SELECT id, payload FROM autonomous_tasks').all() as unknown as Array<{ id: string; payload: string }>
    for (const row of tasks) {
      const task = parseAutonomousTask(row.payload)
      if (!task || task.id !== row.id) continue
      if (task.status === 'completed') continue // Completed by model marker or delivered report: history, never work to resume.
      if (task.status !== 'recorded') {
        // Graceful shutdown after a checkpoint error may already have interrupted this
        // task using an older snapshot. A durable hard-limit receipt still takes priority.
        if (task.control && task.progress?.currentStep) {
          const receipt = db.prepare(`SELECT a.result_json FROM computer_actions a JOIN computer_action_claims c ON c.execution_id = a.execution_id
            WHERE c.execution_id = ? AND c.task_id = ? AND c.generation = ? AND c.session_id = ? AND c.platform_id = ? AND c.conversation_id = ?`)
            .get(task.progress.currentStep.id, task.id, task.generation, task.sessionId, task.platformId, task.conversationId) as { result_json: string | null } | undefined
          const before = JSON.stringify(task)
          restoreProgressReport(task, receipt?.result_json)
          if (task.control.halted) task.progress.detail = PROGRESS_STOP_MESSAGES[task.control.halted]
          if (JSON.stringify(task) !== before) db.prepare('UPDATE autonomous_tasks SET payload = ? WHERE id = ?').run(JSON.stringify(task), task.id)
        }
        continue
      }
      task.status = 'interrupted'; task.updatedAt = at
      for (const question of task.clarifications?.items ?? []) if (!['answered', 'cancelled'].includes(question.state)) {
        question.state = question.state === 'sending' || question.state === 'uncertain' ? 'uncertain' : 'cancelled'
        question.updatedAt = at
      }
      if (task.control) task.control.pending = null
      for (const d of task.backgroundDependencies ?? []) if (d.state === 'waiting') { d.state = 'cancelled'; d.updatedAt = at }
      const step = task.progress?.currentStep
      if (task.progress) {
        task.progress.phase = 'interrupted'
        task.progress.detail = '客户端已重新启动；已保存执行事实和目标，恢复原任务前需要重新观察，不会重放历史动作或结果。'
      }
      if (step) {
        const action = db.prepare(`SELECT a.execution_fact, a.delivery_state, a.result_json FROM computer_actions a JOIN computer_action_claims c ON c.execution_id = a.execution_id
          WHERE c.execution_id = ? AND c.task_id = ? AND c.generation = ? AND c.session_id = ? AND c.platform_id = ? AND c.conversation_id = ?`)
          .get(step.id, task.id, task.generation, task.sessionId, task.platformId, task.conversationId) as { execution_fact: typeof step.execution; delivery_state: string; result_json: string | null } | undefined
        if (action) {
          step.execution = action.execution_fact
          step.delivery = action.delivery_state === 'unknown' ? 'uncertain' : action.delivery_state as typeof step.delivery
          step.status = step.delivery === 'sent' ? 'delivered' : 'interrupted'
          // A checkpoint-only failure may still have saved the real final limit receipt.
          // Restore counters/reasons, never observations, timers or executable work.
          restoreProgressReport(task, action.result_json)
        } else if (step.status !== 'delivered') {
          step.status = 'interrupted'
          step.delivery = step.delivery === 'sending' || step.delivery === 'uncertain' ? 'uncertain' : 'cancelled'
        }
        // No in-memory delivery buffer, token or screenshot is restored from this summary.
        step.resultText = null; delete step.stepToken; delete step.nextStepToken; step.updatedAt = at
      }
      task.recovery = { version: 1, reason: 'client_restart', sourceTaskId: task.id, sourceGeneration: task.generation,
        checkpointAt: at, requiresObservation: true, unknownExecutionId: task.recovery?.unknownExecutionId ??
          (step?.execution === 'unknown' ? step.id : null), observationStepId: null }
      if (task.control?.halted && task.progress) task.progress.detail = PROGRESS_STOP_MESSAGES[task.control.halted]
      db.prepare('UPDATE autonomous_tasks SET payload = ? WHERE id = ?').run(JSON.stringify(task), task.id)
    }
    db.exec('COMMIT')
    return Number(changed)
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** A user-visible recovery message, never system instructions or replayable model JSON. */
export function computerRecoveryMessage(task: AutonomousTask, records: ComputerActionRecord[]): string {
  const lastStep = task.progress?.currentStep, lastReceipt = records.find(record => record.executionId === lastStep?.id)
  const resultSummary = (record: ComputerActionRecord): unknown => {
    if (!record.resultJson) return null
    try {
      const result = JSON.parse(record.resultJson)
      const data = result.data === undefined ? '' : JSON.stringify(result.data)
      return { code: result.code, message: String(result.message ?? '').slice(0, 1000),
        diagnosis: objectDiagnosis(result.diagnosis),
        data_excerpt: data.slice(0, 2000), data_truncated: data.length > 2000 }
    } catch { return { unreadable: true } }
  }
  const context = {
    history_only: true, requires_fresh_observation: true, goal_verified: false,
    source_task_id: task.id, source_generation: task.generation,
    original_request: task.originalRequest,
    additional_requirements: task.inputs.filter(input => input.kind === 'clarification').map(input => input.text),
    attachments: task.inputs.flatMap(input => input.attachments),
    last_step: lastStep ? { id: lastStep.id, action: lastStep.action,
      execution: lastReceipt?.execution ?? lastStep.execution, delivery: lastReceipt?.deliveryState ?? lastStep.delivery } : null,
    recovery: task.recovery ?? null,
    pause_reason: task.stop?.reason === 'human-takeover' ? 'human_takeover' : null,
    clarification_history: task.clarifications ? { history_only: true, grants_permissions: false, truncated: task.clarifications.truncated || task.clarifications.items.length > 4,
      items: task.clarifications.items.slice(-4).map(q => ({ message_id: q.messageId, state: q.state,
        questions: q.questions.map(item => ({ excerpt: item.question.slice(0, 160), truncated: item.question.length > 160 })),
        answer: q.answer ? { input_id: q.answer.submissionId, excerpt: q.answer.text.slice(0, 400), truncated: q.answer.text.length > 400 } : null })) } : null,
    progress_control: task.control ? { steps: task.control.steps, elapsed_ms: task.control.elapsedMs, limits: task.control.limits, stop_reason: task.control.halted } : null,
    previous_completion: task.completion?.report ? { state: task.completion.report.state, summary: task.completion.report.summary.slice(0, 1000),
      artifacts: task.completion.report.artifacts.map(a => ({ path: a.path, label: a.label })), blockers: task.completion.report.blockers.slice(0, 16), history_only: true } : null,
    // Historical ids are hints only. Fresh catalogs/observations must issue usable references.
    known_resources: task.continuity?.resources ?? [],
    known_windows: task.continuity?.windows.map(w => ({ title: w.title, executable_path: w.executablePath, seen_at: w.seenAt })) ?? [],
    recent_actions: records.slice(0, 32).map(r => ({ execution_id: r.executionId, action: r.action,
      execution_state: r.executionState, execution: r.execution, delivery_state: r.deliveryState, updated_at: r.updatedAt, result: resultSummary(r) })),
    action_history_truncated: records.length > 32, resource_history_truncated: false, window_history_truncated: false
  }
  const header = '恢复原任务。请先重新观察真实界面，必要时读取实际产物，核对以下历史线索后再决定补救步骤。已派发或提交的操作可能已经生效，不要盲目重做；应用启动或命令成功不代表原目标完成。历史摘要可能有裁剪，附件仅保留元数据，不代表重新上传。\n'
  const encode = (): string => header + JSON.stringify(context)
  // Bounded hints may be trimmed (oldest first); original requirements stay verbatim.
  while (encode().length > 20_000 && context.known_windows.length) { context.known_windows.shift(); context.window_history_truncated = true }
  while (encode().length > 20_000 && context.recent_actions.length) { context.recent_actions.pop(); context.action_history_truncated = true }
  while (encode().length > 20_000 && context.known_resources.length) { context.known_resources = context.known_resources.slice(1); context.resource_history_truncated = true }
  while (encode().length > 20_000 && context.clarification_history?.items.length) { context.clarification_history.items.shift(); context.clarification_history.truncated = true }
  const text = encode()
  // Preserve requirements verbatim. Refuse an oversized recovery instead of silently losing them.
  if (text.length > 20_000) throw new Error('恢复上下文超过消息长度限制，请在原对话中重新提交完整目标和需要核对的产物。')
  return text
}

/** Why a forced resume still could not send, named from the page's refusal reason. */
export function recoverySendBlockedMessage(reason: string | null): string {
  switch (reason) {
    case 'text-draft': case 'attachment-draft': case 'image-draft':
      return '网页输入框里有你未发送的文字或附件；为免丢失没有清除。请清空或发出后再点继续原任务。'
    case 'conversation-changed': return '网页已不在原对话，请回到原对话后再点继续原任务。'
    case 'model-generating': return '网页上的回复没能停下来，请在原网页手动停止后再点继续原任务。'
    case 'awaiting-reply': return '网页仍在等待上一条回复且未能结束等待，请刷新页面后再点继续原任务。'
    case 'programmatic-send': case 'file-send': return '软件正在向网页发送其他内容，请几秒后再点继续原任务。'
    default: return '恢复消息未发送，请等待页面就绪后再点继续原任务。'
  }
}
