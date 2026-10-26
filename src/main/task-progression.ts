import { randomUUID } from 'node:crypto'
import type { ComputerDiagnosticContext } from '../shared/computer-diagnostics'
import type { TaskLease, TaskProgress, TaskMachine } from '../shared/autonomous-task'
import type { ComputerUsePageRequest, ComputerUseToolCall, ComputerUseToolResult, ComputerUseImageReference } from '../shared/computer-use'
import type { TaskCoordinator } from './task-coordinator'
import type { DesktopPermit } from './desktop-coordinator'
import type { ComputerActionEvent, ComputerActionUpdate } from '../shared/computer-actions'

/** Already adapted/validated by the page and protocol layers; never raw renderer input. */
export type ComputerUseStepRequest = TaskLease & {
  sourceMessageId: string
  /** Present for every page-origin request, including null for malformed/missing tokens. */
  stepToken?: string | null
  receipt?: ComputerUsePageRequest
} & ({ call: ComputerUseToolCall; result?: never } | { call?: never; result: ComputerUseToolResult })

export type TaskResultSendOutcome = 'ok' | 'busy' | 'no-composer' | 'failed' | 'stuck' | 'insert-failed' | 'unknown' | 'stale'
export type StepAcceptance = 'accepted' | 'deferred' | 'duplicate' | 'busy' | 'inactive'

interface ProgressionDependencies {
  coordinator: TaskCoordinator
  isCurrent(lease: TaskLease): boolean
  canRun(lease: TaskLease): boolean
  machine?(lease: TaskLease): TaskMachine
  invoke(call: ComputerUseToolCall, lease: TaskLease, signal: AbortSignal, step: { id: string; token: string | null; sourceMessageId: string }, permit?: DesktopPermit): Promise<ComputerUseToolResult>
  acquire?(call: ComputerUseToolCall, lease: TaskLease, signal: AbortSignal, waiting: () => void): Promise<DesktopPermit | null>
  send(text: string, lease: TaskLease, signal: AbortSignal, attachments?: ComputerUseImageReference[]): Promise<TaskResultSendOutcome>
  release?(attachments: ComputerUseImageReference[], lease: TaskLease): void
  continuity?(call: ComputerUseToolCall, result: ComputerUseToolResult, lease: TaskLease, stepId: string): unknown
  diagnosticContext?(lease: TaskLease): ComputerDiagnosticContext
  onError(lease: TaskLease): void
  /** Returns a cancellation function. No model polling or app startup is performed. */
  schedule?(callback: () => void): () => void
  scheduleDeadline?(callback: () => void, delay: number): () => void
  /** The user's pause between an action's return and its result reaching the model. */
  resultDelaySeconds?(lease: TaskLease): number
}

interface Operation {
  request: ComputerUseStepRequest
  abort: AbortController
  stage: 'queued' | 'executing' | 'pending' | 'sending' | 'failed' | 'blocked'
  progress: TaskProgress
  attachments?: ComputerUseImageReference[]
  deliveryFailures: number
  completionReady?: boolean
  executionAbort?: AbortController
  cancelDeadline?: () => void
  /** Set while the saved result waits out the configured delay; delivery starts when it clears. */
  cancelResultDelay?: () => void
}

/** One observable desktop step, then one result, then the model chooses again. */
export class TaskProgression {
  private operation: Operation | null = null
  private deferred: ComputerUseStepRequest | null = null
  private deferredReply: { platformId: string; messageId: string; kind: 'response' | 'question' } | null = null
  private running: Promise<void> | null = null
  private wakeRequested = false
  private cancelTimer: (() => void) | null = null
  private disposed = false

  constructor(private readonly deps: ProgressionDependencies) {}

  enqueue(request: ComputerUseStepRequest): StepAcceptance {
    if (this.disposed || !this.valid(request) || !request.sourceMessageId || request.sourceMessageId.length > 512) return 'inactive'
    const task = this.deps.coordinator.current(request.platformId)!
    const progress = task.progress ?? { phase: 'waiting-model', stepCount: 0, handledMessageIds: [], currentStep: null, detail: null }
    if (progress.handledMessageIds.includes(request.sourceMessageId)) return 'duplicate'
    try {
      if (this.deps.coordinator.hasComputerStep(request, request.sourceMessageId, request.stepToken ?? null)) return 'duplicate'
    } catch { this.deps.onError(request); return 'inactive' }
    if (this.operation && !this.valid(this.operation.request)) this.cancel()
    if (this.operation) {
      // A fast model can reply before executeJavaScript acknowledges a successful send.
      // Hold one new candidate until that acknowledgement; never execute on an uncertain send.
      if (this.operation.stage === 'sending') {
        if (this.deferred?.sourceMessageId === request.sourceMessageId) return 'duplicate'
        if (this.deferred) return 'busy'
        this.deferred = structuredClone(request)
        return 'deferred'
      }
      return 'busy'
    }
    if (!['waiting-model', 'responded'].includes(progress.phase)) return 'busy'
    const originalCall = request.call
    // Recovery is an executor admission rule, not a replacement system prompt or plan.
    // Discovery may find the window to observe; only a successful fresh observe lifts it.
    if (request.call && task.recovery?.requiresObservation && !['list_apps', 'list_windows', 'observe'].includes(request.call.action)) {
      const { call, ...owner } = request
      request = { ...owner, result: { type: 'computer_result', version: 1, action: call.action, ok: false, execution: 'not_executed',
        code: 'recovery_required', message: '当前任务需要先核对真实后状态，包括任务恢复、未知回执或操作后的观察失败；请先使用 list_windows／observe，再决定补救步骤。本次动作未派发。',
        data: { recovery: task.recovery, history_only: true, requires_fresh_observation: true, goal_verified: false } } }
    }
    const progressBlocked = request.call ? this.deps.coordinator.inspectComputerStep(request, request.call) : null
    if (!this.valid(request)) return 'inactive'
    if (progressBlocked) {
      const { call: _call, ...owner } = request
      request = { ...owner, result: progressBlocked }
    }
    const now = Date.now()
    const next: TaskProgress = {
      ...progress,
      phase: 'waiting-tool', stepCount: progress.stepCount + 1,
      handledMessageIds: [...progress.handledMessageIds, request.sourceMessageId], detail: null,
      ...(request.receipt ? { computerRequest: { ...structuredClone(request.receipt), receivedAt: now } } : {}),
      currentStep: { id: randomUUID(), sourceMessageId: request.sourceMessageId, action: request.call?.action || request.result?.action || 'protocol', tool: 'computer',
        machine: structuredClone(this.deps.machine?.(request) ?? task.machine),
        status: 'queued', execution: 'not_executed', delivery: 'pending', message: null, resultText: null, createdAt: now, updatedAt: now }
    }
    try {
      const captured = structuredClone(request)
      const token = captured.stepToken === undefined ? this.deps.coordinator.computerStepToken(captured.platformId) : captured.stepToken
      const saved = this.deps.coordinator.reserveComputerStep(captured, next, token, !!captured.result, captured, originalCall)
      if (!saved) return 'inactive'
      this.operation = { request: captured, abort: new AbortController(), stage: 'queued',
        deliveryFailures: 0,
        progress: this.deps.coordinator.current(captured.platformId)!.progress! }
      if (this.running) this.wakeRequested = true
      void this.wake()
      return 'accepted'
    } catch {
      this.deps.onError(request)
      return 'inactive'
    }
  }

  /** Called on page/runner state changes and when the existing pause control resumes. */
  wake(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.running) return this.running
    if (this.operation?.stage === 'failed' && this.cancelTimer) return Promise.resolve()
    this.cancelTimer?.()
    this.cancelTimer = null
    const operation = this.operation
    this.running = this.pump().catch(() => {
      // A cancelled old promise must not fail a newer human goal.
      if (!operation || this.operation !== operation) return
      this.cancel()
      this.deps.onError(operation.request)
    }).finally(() => {
      this.running = null
      if (this.wakeRequested) { this.wakeRequested = false; void this.wake() }
    })
    return this.running
  }

  /** Abort is advisory to the executor; ownership checks also reject late completions. */
  cancel(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    const op = this.operation
    this.operation = null
    this.deferred = null
    this.deferredReply = null
    op?.abort.abort()
    op?.cancelDeadline?.(); op?.executionAbort?.abort(); op?.cancelResultDelay?.()
    if (op?.attachments) this.deps.release?.(op.attachments, op.request)
    if (op) {
      try { this.record(op, { event: 'cancel' }) }
      catch { if (this.deps.coordinator.owns(op.request)) this.deps.onError(op.request) }
    }
  }

  reconcile(): void {
    if (this.operation && !this.valid(this.operation.request)) this.cancel()
  }

  noteReply(platformId: string, messageId: string, kind: 'response' | 'question'): void {
    const op = this.operation
    if (op && this.current(op) && op.request.platformId === platformId && op.stage === 'sending' &&
      op.request.sourceMessageId !== messageId) {
      if (this.deferredReply?.messageId === messageId && this.deferredReply.kind === 'question') return
      this.deferredReply = { platformId, messageId, kind }
      return
    }
    this.deps.coordinator.noteReply(platformId, messageId, kind)
  }

  dispose(): void { this.disposed = true; this.cancel() }

  private valid(lease: TaskLease): boolean {
    return !this.disposed && this.deps.coordinator.owns(lease) && this.deps.isCurrent(lease)
  }

  private current(op: Operation): boolean {
    return this.operation === op && !op.abort.signal.aborted && this.valid(op.request)
  }

  private update(op: Operation, event: ComputerActionEvent): ComputerActionUpdate {
    const r = op.request
    return { sessionId: r.sessionId, platformId: r.platformId, conversationId: r.conversationId, taskId: r.taskId,
      generation: r.generation, executionId: op.progress.currentStep!.id, at: Date.now(), ...event }
  }

  private record(op: Operation, event: ComputerActionEvent): ComputerUseToolResult | undefined { return this.deps.coordinator.recordComputerAction(this.update(op, event)) }

  private save(op: Operation, event?: ComputerActionEvent): boolean {
    if (!this.current(op)) return false
    op.progress.currentStep!.updatedAt = Date.now()
    return this.deps.coordinator.updateProgress(op.request, op.progress, event && this.update(op, event))
  }

  private retryLater(): void {
    if (!this.operation || this.cancelTimer || this.disposed) return
    const schedule = this.deps.schedule ?? (callback => {
      const timer = setTimeout(callback, 1500)
      timer.unref()
      return () => clearTimeout(timer)
    })
    this.cancelTimer = schedule(() => {
      this.cancelTimer = null
      if (this.operation?.stage === 'failed' && this.operation.deliveryFailures < 3) this.operation.stage = 'pending'
      void this.wake()
    })
  }

  private async pump(): Promise<void> {
    const op = this.operation
    if (!op) return
    if (!this.current(op)) { this.cancel(); return }
    if (op.stage === 'blocked' || op.stage === 'failed') return
    if (!this.deps.canRun(op.request)) { this.retryLater(); return }
    const step = op.progress.currentStep!
    if (op.stage === 'queued') {
      let result: ComputerUseToolResult
      let actionTimedOut = false
      if (op.request.result) result = structuredClone(op.request.result)
      else {
        let permit: DesktopPermit | null = null, admissionFailed = false
        try {
          try {
            if (this.deps.acquire) permit = await this.deps.acquire(op.request.call, op.request, op.abort.signal, () => {
              if (!this.current(op)) return
              op.progress.detail = '等待全局桌面协调放行；本步尚未执行。'
              this.save(op)
            })
          } catch { if (!this.current(op)) return; admissionFailed = true }
          if (!this.current(op)) return
          if (!this.deps.canRun(op.request)) { this.retryLater(); return }
          if (admissionFailed) result = { type: 'computer_result', version: 1, action: step.action, ok: false, execution: 'not_executed', code: 'unavailable', message: '桌面排队已取消或未能接纳，本步未派发。' }
          else {
            const waiting = op.request.call.action === 'wait_for'
            const budget = this.deps.coordinator.actionBudget(op.request, waiting)
            if (!budget || !this.current(op)) return
            op.stage = 'executing'
            op.progress.phase = 'executing-tool'; op.progress.detail = null
            step.status = 'executing'; step.execution = 'unknown'
            if (!this.save(op, { event: 'dispatch' })) return
            op.executionAbort = new AbortController()
            const stop = (): void => op.executionAbort?.abort()
            op.abort.signal.addEventListener('abort', stop, { once: true })
            const schedule = this.deps.scheduleDeadline ?? ((callback, delay) => {
              if (typeof setTimeout === 'undefined') return () => {}
              const timer = setTimeout(callback, delay); timer.unref?.(); return () => clearTimeout(timer)
            })
            op.cancelDeadline = schedule(() => { actionTimedOut = true; op.executionAbort?.abort() }, budget)
            try { result = await this.deps.invoke(op.request.call, op.request, op.executionAbort.signal, { id: step.id, token: step.stepToken ?? op.request.stepToken ?? null, sourceMessageId: step.sourceMessageId }, permit ?? undefined) }
            catch { result = { type: 'computer_result', version: 1, action: step.action, ok: false,
              execution: 'unknown', code: 'executor_error', message: '执行器异常，操作是否生效尚未确认；应先观察实际状态。' } }
            finally { op.cancelDeadline?.(); op.cancelDeadline = undefined; op.abort.signal.removeEventListener('abort', stop) }
          }
        } finally { permit?.release() }
      }
      // Enrich once, before durable receipt storage. Delivery retries reuse the exact saved body.
      // An obsolete executor must not read a newer goal's capabilities or observations.
      let context: ComputerDiagnosticContext | undefined
      try { context = this.current(op) ? this.deps.diagnosticContext?.(op.request) : undefined } catch { /* Diagnose with no advertised alternatives. */ }
      try { result = this.record(op, { event: 'result', result, diagnosticContext: context, actionTimedOut }) ?? result }
      catch (error) { if (result.attachments) this.deps.release?.(result.attachments, op.request); throw error }
      if (!this.current(op)) { if (result.attachments) this.deps.release?.(result.attachments, op.request); return }
      op.attachments = result.attachments
      op.completionReady = result.action === 'complete_task' && result.ok
      const continuity = op.request.call ? this.deps.continuity?.(op.request.call, result, op.request, step.id) : undefined
      const envelope = { ...result, task_id: op.request.taskId, task_generation: op.request.generation,
        step_id: step.id, source_message_id: step.sourceMessageId,
        ...(continuity === undefined ? {} : { task_continuity: continuity }),
        ...(this.deps.coordinator.current(op.request.platformId)?.recovery ? { task_recovery: this.deps.coordinator.current(op.request.platformId)!.recovery } : {}),
        task_completion_context: this.deps.coordinator.completionSummary(op.request),
        task_clarification_context: this.deps.coordinator.clarificationSummary(op.request),
        task_context: { session_id: op.request.sessionId, platform_id: op.request.platformId, conversation_id: op.request.conversationId,
          task_id: op.request.taskId, task_generation: op.request.generation, step_id: step.id, source_message_id: step.sourceMessageId, tool: 'computer',
          machine: { id: step.machine!.id, label: step.machine!.label, platform: step.machine!.platform, arch: step.machine!.arch,
            connection: step.machine!.connection, working_directory: step.machine!.workingDirectory } },
        ...(step.nextStepToken && !result.progress_control?.halted && !(result.action === 'complete_task' && result.ok) ? { next_step_token: step.nextStepToken } : {}) }
      let text: string
      try {
        text = JSON.stringify(envelope)
        if (text.length > 256_000) throw new Error('oversized-result')
      } catch {
        if (result.action === 'complete_task') this.deps.coordinator.rejectCompletionDelivery(op.request, step.id)
        text = JSON.stringify({ type: 'computer_result', version: 1, action: result.action, execution: result.execution, ok: false, code: 'executor_error',
          task_id: op.request.taskId, task_generation: op.request.generation, step_id: step.id, source_message_id: step.sourceMessageId,
          progress_control: result.progress_control, ...(step.nextStepToken && !result.progress_control?.halted ? { next_step_token: step.nextStepToken } : {}),
          message: '动作已返回，但完整结果无法作为本轮文字发送；已保留实际回执，任务没有标记完成。请核对实际状态并缩短回传，勿据此盲目重复动作。' })
      }
      step.execution = result.execution
      step.status = 'result-ready'
      step.message = JSON.parse(text).message
      step.resultText = text
      op.stage = 'pending'
      op.progress.phase = 'waiting-delivery'
      // Once per result: delivery retries never wait again, and the action is never redone.
      const delaySeconds = this.deps.resultDelaySeconds?.(op.request) ?? 0
      if (delaySeconds > 0) {
        op.progress.detail = `按设置等待 ${delaySeconds} 秒后回传结果；动作不会重做。`
        const schedule = this.deps.scheduleDeadline ?? ((callback, delay) => {
          const timer = setTimeout(callback, delay); timer.unref?.(); return () => clearTimeout(timer)
        })
        op.cancelResultDelay = schedule(() => {
          op.cancelResultDelay = undefined
          if (this.operation !== op) return
          op.progress.detail = null
          if (this.running) this.wakeRequested = true
          void this.wake()
        }, delaySeconds * 1000)
      }
      if (!this.save(op, { event: 'ready', text })) { op.cancelResultDelay?.(); return }
    }
    if (op.stage !== 'pending' || op.cancelResultDelay) return
    if (!this.current(op)) return
    if (!this.deps.canRun(op.request)) { this.retryLater(); return }
    op.stage = 'sending'
    step.delivery = 'sending'
    const attemptId = randomUUID()
    if (!this.save(op, { event: 'delivery-start', attemptId })) return
    let outcome: TaskResultSendOutcome
    try { outcome = await this.deps.send(step.resultText!, op.request, op.abort.signal, op.attachments) }
    catch { outcome = 'unknown' }
    const deliveryEvent: ComputerActionEvent = { event: 'delivery-outcome', attemptId,
      outcome: outcome === 'ok' || outcome === 'busy' || outcome === 'no-composer' || outcome === 'failed' ? outcome : outcome === 'insert-failed' ? 'failed' : 'unknown' }
    if (!this.current(op)) { this.record(op, deliveryEvent); return }
    if (outcome === 'ok') {
      step.delivery = 'sent'
      step.status = 'delivered'
      step.resultText = null
      op.progress.phase = 'waiting-model'
      op.progress.detail = null
      if (!this.save(op, deliveryEvent)) return
      if (op.attachments) this.deps.release?.(op.attachments, op.request)
      op.attachments = undefined
      this.operation = null
      const deferred = this.deferred
      const reply = this.deferredReply
      this.deferred = null
      this.deferredReply = null
      const live = this.deps.coordinator.current(op.request.platformId)
      if (op.completionReady && live && !live.control?.halted && live.completion?.report?.state !== 'ready') {
        this.enqueue({ ...op.request, call: undefined, sourceMessageId: `completion-review:${step.id}`, receipt: undefined,
          stepToken: this.deps.coordinator.computerStepToken(op.request.platformId), result: { type: 'computer_result', version: 1, action: 'complete_task', ok: false, execution: 'not_executed',
            code: 'verification_required', message: '核对报告交付前，任务要求、依赖或完整报告可交付性发生变化；尚未标记任务完成，请基于最新上下文继续核对。',
            data: { completion_report: live.completion?.report ?? null, goal_verified: false } } })
      } else {
        if (reply) this.deps.coordinator.noteReply(reply.platformId, reply.messageId, reply.kind)
        if (deferred) this.enqueue(deferred)
      }
    } else if (outcome === 'busy' || outcome === 'no-composer') {
      step.delivery = 'pending'
      op.stage = 'pending'
      op.progress.detail = '等待页面空闲后回传已保存的结果；不会再次执行动作。'
      if (this.save(op, deliveryEvent)) this.retryLater()
    } else if (outcome === 'failed' || outcome === 'insert-failed') {
      step.delivery = 'failed'
      op.stage = 'failed'
      op.deliveryFailures++
      op.progress.phase = 'blocked'
      op.progress.detail = op.deliveryFailures < 3 ? '结果未提交，保留原结果并重试交付；不会重做动作。'
        : '结果交付连续失败，已保留执行事实；停止自动提交，不会重做动作。'
      if (this.save(op, deliveryEvent) && op.deliveryFailures < 3) this.retryLater()
    } else {
      if (op.attachments) this.deps.release?.(op.attachments, op.request)
      op.attachments = undefined
      step.delivery = 'uncertain'
      op.stage = 'blocked'
      op.progress.phase = 'blocked'
      op.progress.detail = '结果发送未能确认，已暂停自动提交；桌面动作不会重放。'
      this.deferred = null
      this.deferredReply = null
      this.save(op, deliveryEvent)
    }
  }
}
