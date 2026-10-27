import { createHash, randomUUID } from 'node:crypto'
import { advanceCompletion, captureCompletionCommand, captureCompletionFiles, captureCompletionResult, completionContext, assessTaskCompletion, completionBackgroundBlockers, recheckCompletionFile } from './task-completion'
import { parseTaskCompletionState } from '../shared/task-completion'
import type { TaskCompletionClaim, TaskCompletionReport, TaskCompletionState } from '../shared/task-completion'
import type { BackgroundTask } from '../shared/background-tasks'
import { computerActionRequest } from '../shared/computer-actions'
import { createProgressState, admitProgressStep, inspectProgressAdmission, recordProgressResult, recordFileEvidence } from './task-progress-guard'
import { PROGRESS_STOP_MESSAGES } from '../shared/computer-progress'
import type { ComputerProgressState, ProgressStopReason } from '../shared/computer-progress'
import { diagnoseComputerResult } from '../shared/computer-diagnostics'
import type { ComputerActionClaim, ComputerActionUpdate } from '../shared/computer-actions'
import type { AutonomousTask, AutonomousTaskState, TaskLease, TaskMachine, TaskProgress, TaskSubmission, TaskToolContext, TaskToolEvent, TaskBackgroundDependency, TaskContinuity } from '../shared/autonomous-task'
import type { ComputerUseCapability, ComputerUsePageRequest, ComputerUseToolCall, ComputerUseToolResult } from '../shared/computer-use'
import type { FocusAttachmentInfo } from '../shared/focus-chat'
import { pendingTaskQuestion, sameQuestionSource, taskClarificationContext, validTaskQuestion, validTaskQuestionSource, validTaskAnswerSource } from '../shared/task-clarification'
import type { TaskQuestion, TaskQuestionSource } from '../shared/task-clarification'

export interface AutonomousTaskStore {
  autonomousTaskGeneration(sessionId: string): number
  latestAutonomousTask(sessionId: string, platformId: string, conversationId: string): AutonomousTask | null
  autonomousTaskBySubmission(sessionId: string, platformId: string, submissionId: string): AutonomousTask | null
  saveAutonomousTasks(tasks: AutonomousTask[], claim?: ComputerActionClaim, update?: ComputerActionUpdate): void
  hasComputerAction?(lease: TaskLease, sourceMessageId: string, receivedToken: string | null): boolean
}

/** Task context for computer use. Recording a goal does not execute a tool. */
export class TaskCoordinator {
  private readonly entries = new Map<string, AutonomousTaskState>()
  // Grants are process-local. Persisted task history can never restore a live grant.
  private readonly computerTokens = new Map<string, { value: string; taskId: string | null; generation: number | null; pending: boolean }>()
  // Also protect synthetic/in-memory stores; production adds the durable unique constraints.
  private readonly computerClaims = new Map<string, { answers: Set<string>; tokens: Set<string> }>()
  private readonly clocks = new Map<string, { last: number; elapsed: number; suspended: boolean; cancel: (() => void) | null }>()
  private dispatchBlocked = false
  private paused = false

  constructor(private readonly sessionId: string, private readonly store: AutonomousTaskStore,
    private readonly changed: (state: AutonomousTaskState) => void,
    private readonly timing: { now?(): number; schedule?(callback: () => void, delay: number): () => void } = {}) {}

  setDispatchBlocked(blocked: boolean): void { this.dispatchBlocked = blocked; if (blocked) this.computerTokens.clear() }

  private now(): number { return this.timing.now?.() ?? (typeof performance === 'undefined' ? Date.now() : performance.now()) }
  private control(task: AutonomousTask): ComputerProgressState {
    const control = structuredClone(task.control ?? createProgressState())
    if (!task.control) control.steps = task.progress?.stepCount ?? 0
    let clock = this.clocks.get(task.id)
    if (!clock) { clock = { last: this.now(), elapsed: control.elapsedMs, suspended: this.paused || task.progress?.phase === 'waiting-user', cancel: null }; this.clocks.set(task.id, clock) }
    const now = Math.max(clock.last, this.now())
    if (!clock.suspended) clock.elapsed += now - clock.last
    clock.last = now
    clock.suspended = this.paused || task.progress?.phase === 'waiting-user'
    control.elapsedMs = Math.floor(clock.elapsed)
    return control
  }
  private arm(task: AutonomousTask): void {
    const control = this.control(task), clock = this.clocks.get(task.id)!
    clock.cancel?.(); clock.cancel = null
    if (task.status !== 'recorded' || this.paused || task.progress?.phase === 'waiting-user') return
    const schedule = this.timing.schedule ?? ((callback, delay) => {
      if (typeof setTimeout === 'undefined') return () => {}
      const timer = setTimeout(callback, delay); timer.unref?.(); return () => clearTimeout(timer)
    })
    clock.cancel = schedule(() => {
      clock.cancel = null
      const state = this.entries.get(task.platformId)
      if (state?.task?.id !== task.id || state.task.status !== 'recorded') return
      if (this.paused || state.task.progress?.phase === 'waiting-user') return
      try {
        if (this.control(state.task).elapsedMs < control.limits.taskTimeoutMs) this.arm(state.task)
        else this.haltProgress(state.task, 'task_timeout')
      } catch { this.fail(state.platformId, state.conversationId) }
    }, Math.max(1, control.limits.taskTimeoutMs - control.elapsedMs))
  }
  setPaused(paused: boolean): void {
    for (const state of this.entries.values()) if (state.task?.status === 'recorded') {
      const task = { ...state.task, control: this.control(state.task), updatedAt: Date.now() }
      this.store.saveAutonomousTasks([task]); this.entries.set(state.platformId, { ...state, task })
    }
    this.paused = paused
    for (const state of this.entries.values()) if (state.task?.status === 'recorded') this.arm(state.task)
  }
  private haltProgress(task: AutonomousTask, reason: ProgressStopReason): void {
    const state = this.entries.get(task.platformId)
    if (!state || state.task?.id !== task.id || task.status !== 'recorded') return
    const finalReason = task.control?.halted ?? reason
    const stopped = this.interrupted(task, 'stopped')
    stopped.control = { ...this.control(task), halted: finalReason, pending: null }
    if (stopped.progress) stopped.progress.detail = PROGRESS_STOP_MESSAGES[finalReason]
    this.store.saveAutonomousTasks([stopped])
    this.computerTokens.delete(task.platformId); this.computerClaims.delete(task.id)
    this.publish({ ...state, task: stopped })
  }
  actionBudget(lease: TaskLease, wait = false): number {
    const task = this.current(lease.platformId)
    if (!task || !this.owns(lease)) return 0
    const c = this.control(task), remaining = c.limits.taskTimeoutMs - c.elapsedMs
    if (c.halted) { this.haltProgress(task, c.halted); return 0 }
    if (remaining <= 0) { this.haltProgress(task, 'task_timeout'); return 0 }
    return Math.max(1, Math.floor(Math.min(remaining, wait ? c.limits.waitTimeoutMs : c.limits.actionTimeoutMs)))
  }
  progressSummary(lease: TaskLease): unknown {
    const task = this.current(lease.platformId)
    if (!task || !this.owns(lease)) return undefined
    const c = this.control(task)
    return { steps: c.steps, elapsed_ms: c.elapsedMs, limits: c.limits, halted: !!c.halted, stop_reason: c.halted, goal_verified: false }
  }
  completionSummary(lease: TaskLease): unknown {
    const task = this.current(lease.platformId)
    return task && this.owns(lease) ? completionContext(task) : undefined
  }
  clarificationSummary(lease: TaskLease): unknown {
    const task = this.current(lease.platformId)
    return task && this.owns(lease) ? taskClarificationContext(task) : undefined
  }
  waitingForUser(platformId: string): boolean {
    const state = this.entries.get(platformId)
    return !this.dispatchBlocked && !state?.error && state?.task?.status === 'recorded' && !!pendingTaskQuestion(state.task)
  }

  recordQuestion(lease: TaskLease, question: TaskQuestion, source: TaskQuestionSource): boolean {
    const current = this.current(lease.platformId)
    if (!current?.progress || !this.owns(lease) || !validTaskQuestion(question) || !validTaskQuestionSource(source) || source.sourceSubmissionId !== current.sourceSubmissionId) return false
    const state = this.entries.get(lease.platformId)!, task = structuredClone(current)
    task.clarifications ??= { version: 1, items: [], truncated: false }
    const existing = task.clarifications.items.find(q => q.messageId === question.messageId)
    if (existing) return false // A duplicate or replay is history, never a new request for consent.
    const now = Date.now()
    for (const q of task.clarifications.items) if (!['answered', 'cancelled'].includes(q.state)) { q.state = 'cancelled'; q.updatedAt = now }
    task.clarifications.items.push({ messageId: question.messageId, questions: structuredClone(question.questions), id: randomUUID(), source: structuredClone(source), state: 'pending', answer: null, createdAt: now, updatedAt: now })
    if (task.clarifications.items.length > 32) { task.clarifications.items.shift(); task.clarifications.truncated = true }
    task.control = this.control(current)
    task.control.pending = null
    task.completion = advanceCompletion(task, 'clarification-question')
    const step = task.progress!.currentStep
    if (step && step.delivery !== 'sent') { step.status = 'interrupted'; step.delivery = step.delivery === 'sending' || step.delivery === 'uncertain' ? 'uncertain' : 'cancelled'; step.resultText = null; delete step.nextStepToken; step.updatedAt = now }
    task.progress = { ...task.progress!, phase: 'waiting-user', lastReply: { messageId: question.messageId, kind: 'question' }, detail: '模型提出必要澄清或任务内授权问题，等待真实用户回答；关闭问题和发送未知都不代表同意。' }
    task.recovery = { version: 1, reason: 'interrupted', sourceTaskId: task.id, sourceGeneration: task.generation, checkpointAt: now,
      requiresObservation: true, unknownExecutionId: task.recovery?.unknownExecutionId ?? (step?.execution === 'unknown' ? step.id : null), observationStepId: null }
    task.updatedAt = now
    this.store.saveAutonomousTasks([task]); this.computerTokens.delete(lease.platformId)
    this.publish({ ...state, task }); return true
  }

  questionState(lease: TaskLease, messageId: string, next: 'sending' | 'pending' | 'dismissed' | 'uncertain'): boolean {
    const current = this.current(lease.platformId), q = current && pendingTaskQuestion(current)
    if (!this.owns(lease) || !q || q.messageId !== messageId || next === 'sending' && !['pending', 'dismissed'].includes(q.state) || next === 'pending' && q.state !== 'sending') return false
    const task = structuredClone(current!), saved = task.clarifications!.items.find(item => item.id === q.id)!
    // A local dismissal never turns an unknown submission into a known unsent answer.
    saved.state = next === 'dismissed' && saved.state === 'uncertain' ? 'uncertain' : next
    saved.updatedAt = Date.now(); task.updatedAt = saved.updatedAt
    task.progress!.phase = 'waiting-user'
    task.progress!.detail = saved.state === 'uncertain' ? '回答提交尚未确认，保留上下文并等待核对；不会自动重发，也不把未知当作授权。'
      : saved.state === 'dismissed' ? '问题已在本地关闭，尚未获得回答；原任务保留并等待必要信息，可重新打开问题。'
        : saved.state === 'sending' ? '正在提交回答；只有原会话的真实发送确认才会记录为用户约束并继续。' : '回答尚未提交，原任务继续等待用户。'
    this.store.saveAutonomousTasks([task]); this.publish({ ...this.entries.get(lease.platformId)!, task }); return true
  }
  completionNotificationAllowed(platformId: string, conversationId: string | null): boolean {
    const state = this.entries.get(platformId)
    return state?.conversationId !== conversationId || !state.task || state.task.status === 'completed' &&
      (!!state.task.modelCompletion || state.task.completion?.report?.state === 'delivered')
  }
  reconcileCompletionDependencies(platformId: string, background: readonly BackgroundTask[]): void {
    const task = this.current(platformId)
    if (!task?.completion?.report || task.completion.report.state !== 'ready') return
    const blockers = completionBackgroundBlockers(task, background)
    if (!blockers.length) return
    const state = this.entries.get(platformId)!, next = structuredClone(task)
    next.completion!.report!.state = 'rejected'; next.completion!.report!.blockers = blockers.slice(0, 128)
    this.store.saveAutonomousTasks([next]); this.publish({ ...state, task: next })
  }
  rejectCompletionDelivery(lease: TaskLease, stepId: string): void {
    const task = this.current(lease.platformId)
    if (!task || !this.owns(lease) || task.completion?.report?.stepId !== stepId) return
    const state = this.entries.get(lease.platformId)!, next = structuredClone(task)
    next.completion!.report!.state = 'rejected'
    next.completion!.report!.blockers = ['完整结果报告未能序列化或超过交付预算，任务不能标记完成；请缩短报告后重新核对交付。']
    this.store.saveAutonomousTasks([next]); this.publish({ ...state, task: next })
  }
  completedTaskId(platformId: string, conversationId: string | null): string | null {
    const state = this.entries.get(platformId)
    return state?.conversationId === conversationId && state.task?.status === 'completed' ? state.task.id : null
  }
  async evaluateCompletion(lease: TaskLease, stepId: string, claim: TaskCompletionClaim, background: () => readonly BackgroundTask[], signal?: AbortSignal): Promise<TaskCompletionReport | null> {
    const task = this.current(lease.platformId)
    if (!task || !this.owns(lease) || signal?.aborted || this.paused) return null
    const report = await assessTaskCompletion(task, claim, stepId, background(), e => recheckCompletionFile(e, signal))
    const live = this.current(lease.platformId)
    if (!live || !this.owns(lease) || signal?.aborted || this.paused || live.progress?.currentStep?.id !== stepId ||
      live.inputs.length !== task.inputs.length || live.completion?.revision !== task.completion?.revision || !this.actionBudget(lease)) return null
    report.blockers = [...new Set([...report.blockers, ...completionBackgroundBlockers(live, background(), report.backgroundResolutions)])].slice(0, 128)
    if (report.blockers.length) report.state = 'rejected'
    return report
  }

  inspectComputerStep(lease: TaskLease, call: ComputerUseToolCall): ComputerUseToolResult | null {
    const task = this.current(lease.platformId)
    if (!task || !this.owns(lease)) return null
    const c = this.control(task), admission = inspectProgressAdmission(task, c, call)
    if (admission.hard && ['task_timeout', 'step_limit', 'recovery_limit'].includes(admission.hard)) {
      this.haltProgress(task, admission.hard); return null
    }
    return admission.blocked ? { type: 'computer_result', version: 1, action: call.action, ok: false, execution: 'not_executed',
      code: admission.hard ? 'progress_limit' : 'no_progress', message: admission.hard ? PROGRESS_STOP_MESSAGES[admission.hard]
        : '相同输入／启动动作在没有新状态证据时再次请求，本次未派发；请核对后状态、调整方法或换路径，不能盲目重复。' } : null
  }

  context(platformId: string, conversationId: string | null): AutonomousTaskState {
    const previous = this.entries.get(platformId)
    if (previous?.conversationId === conversationId) return structuredClone(previous)
    // The first confirmed send can precede the SPA assigning a conversation id.
    if (previous?.conversationId === null && conversationId && previous.task) {
      const task = { ...previous.task, conversationId, updatedAt: Date.now() }
      this.store.saveAutonomousTasks([task])
      return this.publish({ ...previous, conversationId, task })
    }
    this.stop(platformId, 'interrupted')
    const restored = conversationId ? this.store.latestAutonomousTask(this.sessionId, platformId, conversationId) : null
    // Restoring a page never starts work or claims a previous process is still running.
    const task = restored?.status === 'recorded' ? this.interrupted(restored, 'interrupted') : restored
    if (task && task !== restored) this.store.saveAutonomousTasks([task])
    return this.publish({ sessionId: this.sessionId, platformId, conversationId, task, error: null })
  }

  submit(input: {
    platformId: string; conversationId: string | null; submission: TaskSubmission; turnId?: string
    text: string; attachments: FocusAttachmentInfo[]; machine: TaskMachine; capability: ComputerUseCapability
    /** Only supplied by the main-process, user-initiated recovery send. */
    resume?: { taskId: string; generation: number }
  }): AutonomousTask | null {
    const { platformId, conversationId, submission, capability } = input
    if (this.dispatchBlocked) return null
    if (!submission || !submission.id || !['goal', 'clarification'].includes(submission.kind)) return null
    if (!capability.scopeSupported || !capability.computerUseEnabled ||
      capability.context.sessionId !== this.sessionId || capability.context.platformId !== platformId || !input.text.trim()) return null
    const state = this.context(platformId, conversationId)
    const existing = this.store.autonomousTaskBySubmission(this.sessionId, platformId, submission.id)
    if (existing) return existing
    const now = Date.now()
    const entry = { ...submission, text: input.text, attachments: structuredClone(input.attachments), receivedAt: now }
    const resumed = input.resume ? state.task : null
    if (input.resume && (!resumed || submission.kind !== 'goal' || resumed.id !== input.resume.taskId || resumed.generation !== input.resume.generation ||
      resumed.control?.halted ||
      resumed.conversationId !== conversationId || resumed.machine.id !== input.machine.id || resumed.machine.platform !== input.machine.platform || resumed.machine.arch !== input.machine.arch ||
      !(['interrupted', 'stopped'].includes(resumed.status) || resumed.status === 'recorded' && resumed.progress?.phase === 'blocked'))) return null
    if (submission.kind === 'clarification') {
      if (!state.task || state.task.status !== 'recorded' || state.task.inputs.some(item => item.id === submission.id)) return null
      const pending = pendingTaskQuestion(state.task)
      const answeredQuestion = submission.answerTo && state.task.clarifications?.items.find(q => q.messageId === submission.answerTo!.messageId)
      if ((pending || submission.answerTo) && (!answeredQuestion || answeredQuestion.state === 'answered' || !validTaskAnswerSource(submission.answerTo) ||
        !sameQuestionSource(answeredQuestion.source, submission.answerTo) || input.text.length > 20000)) return null
      const answersCurrent = !!answeredQuestion && answeredQuestion.id === pending?.id
      const task = { ...structuredClone(state.task), inputs: [...state.task.inputs, entry], updatedAt: now, completion: { ...advanceCompletion(state.task, 'clarification'), report: null } }
      if (answeredQuestion) {
        const answered = task.clarifications!.items.find(q => q.id === answeredQuestion.id)!
        answered.state = 'answered'; answered.answer = { submissionId: submission.id, text: input.text, receivedAt: now }; answered.updatedAt = now
      }
      if (answersCurrent) {
        // The prior step may still return after cancellation. Only future steps may clear the fresh-observation gate.
        if (task.progress) task.progress.currentStep = null
        task.recovery = { version: 1, reason: 'interrupted', sourceTaskId: task.id, sourceGeneration: task.generation, checkpointAt: now,
          requiresObservation: true, unknownExecutionId: task.recovery?.unknownExecutionId ?? null, observationStepId: null }
      }
      if (task.progress && !pendingTaskQuestion(task) && ['waiting-user', 'responded'].includes(task.progress.phase)) {
        task.progress = { ...task.progress, phase: 'waiting-model', detail: null }
      }
      this.store.saveAutonomousTasks([task])
      if (answersCurrent) this.computerTokens.set(platformId, { value: this.newComputerToken(), taskId: task.id, generation: task.generation, pending: false })
      this.publish({ ...state, task, error: null })
      return structuredClone(task)
    }
    const task: AutonomousTask = {
      id: randomUUID(), sessionId: this.sessionId, platformId, conversationId,
      generation: this.store.autonomousTaskGeneration(this.sessionId) + 1,
      sourceSubmissionId: submission.id, sourceTurnId: input.turnId ?? null,
      originalRequest: resumed?.originalRequest ?? input.text,
      inputs: resumed ? [...structuredClone(resumed.inputs), { ...entry, kind: 'clarification', text: '恢复原任务；先重新观察并核对实际状态。' }] : [entry],
      machine: structuredClone(input.machine), status: 'recorded', createdAt: now, updatedAt: now,
      control: resumed ? { ...this.control(resumed), pending: null }
        : createProgressState(capability.computerUseLimits),
      ...(resumed ? { continuity: structuredClone(resumed.continuity),
        recovery: { version: 1 as const, reason: 'resumed' as const, sourceTaskId: resumed.id, sourceGeneration: resumed.generation,
          checkpointAt: now, requiresObservation: true, unknownExecutionId: resumed.recovery?.unknownExecutionId ??
            (resumed.progress?.currentStep?.execution === 'unknown' ? resumed.progress.currentStep.id : null), observationStepId: null } } : {}),
      progress: { phase: 'waiting-model', stepCount: 0, handledMessageIds: [], currentStep: null, detail: null }
    }
    const previous = state.task?.status === 'recorded' ? this.interrupted(state.task, 'superseded') : null
    this.store.saveAutonomousTasks(previous ? [previous, task] : [task])
    if (previous) this.computerClaims.delete(previous.id)
    const initial = this.computerTokens.get(platformId)
    this.computerTokens.set(platformId, { value: initial?.taskId === null && !initial.pending ? initial.value : this.newComputerToken(),
      taskId: task.id, generation: task.generation, pending: false })
    this.publish({ ...state, task, error: null })
    return structuredClone(task)
  }

  stop(platformId: string, status: 'stopped' | 'interrupted' = 'stopped', reason?: 'user-ended' | 'global-emergency' | 'human-takeover'): void {
    const state = this.entries.get(platformId)
    const taskState = state?.task
    const supersedesTakeover = taskState?.status === 'stopped' && taskState.stop?.reason === 'human-takeover' && reason && reason !== 'human-takeover'
    if (!state || !taskState || taskState.status !== 'recorded' && !supersedesTakeover) return
    const task = taskState.status === 'recorded' ? this.interrupted(taskState, status) : { ...structuredClone(taskState), updatedAt: Date.now() }
    if (reason) {
      task.stop = { reason, requestedAt: Date.now() }
      if (task.progress) task.progress.detail = reason === 'human-takeover'
        ? '检测到真实人工输入，原任务已因人工接管暂停；保留要求和执行事实，等待用户明确继续并重新观察，不因焦点恢复或空闲而自动恢复。'
        : reason === 'global-emergency' ? '用户触发全局急停；已撤销自动执行和回传，后台进程保持独立生命周期，已发生操作没有回滚。' : '用户结束任务；已撤销自动执行和回传，后台进程保持独立生命周期，已发生操作没有回滚。'
    }
    this.store.saveAutonomousTasks([task])
    this.computerTokens.delete(platformId)
    this.computerClaims.delete(task.id)
    this.publish({ ...state, task })
  }

  /** The user's completion policy accepts a live model marker, without inventing evidence. */
  completeFromModel(lease: TaskLease, messageId: string): boolean {
    if (!this.owns(lease) || typeof messageId !== 'string' || !messageId.trim() || messageId.length > 512) return false
    const state = this.entries.get(lease.platformId)!, current = state.task!
    if (!current.progress) return false
    const task = this.interrupted(current, 'stopped')
    task.status = 'completed'
    task.modelCompletion = { messageId, receivedAt: task.updatedAt }
    task.progress!.phase = 'completed'
    task.progress!.lastReply = { messageId, kind: 'response' }
    task.progress!.detail = '模型已输出“任务完成”，本轮自动操作已结束。'
    this.store.saveAutonomousTasks([task])
    this.computerTokens.delete(lease.platformId)
    this.computerClaims.delete(task.id)
    this.publish({ ...state, task })
    return true
  }

  /** Does not restore history or bind a new conversation as a side effect. */
  current(platformId: string): AutonomousTask | null {
    const state = this.entries.get(platformId)
    return !this.dispatchBlocked && state?.task?.status === 'recorded' && !state.error ? structuredClone(state.task) : null
  }
  isLimited(platformId: string, conversationId: string | null): boolean {
    const state = this.entries.get(platformId)
    return state?.conversationId === conversationId && (!!state.task?.control?.halted && !state.task.modelCompletion || !!state.error)
  }

  owns(lease: TaskLease): boolean {
    if (typeof lease.conversationId !== 'string' || !lease.conversationId) return false
    const task = this.current(lease.platformId)
    return !!task && task.id === lease.taskId && task.generation === lease.generation &&
      task.sessionId === lease.sessionId && task.conversationId === lease.conversationId
  }

  /** Existing tools keep their executors and confirmation rules; only ownership/progress are shared. */
  reserveToolStep(lease: TaskLease, sourceMessageId: string, tool: TaskToolContext['tool'], machine: TaskMachine): TaskToolContext | null {
    const task = this.current(lease.platformId), p = task?.progress
    if (!this.owns(lease) || this.waitingForUser(lease.platformId) || !p || !sourceMessageId || sourceMessageId.length > 512 || p.handledMessageIds.includes(sourceMessageId) ||
      !['waiting-model', 'responded'].includes(p.phase) || machine.id !== task!.machine.id || machine.platform !== task!.machine.platform || machine.arch !== task!.machine.arch || machine.connection !== 'local') return null
    const control = this.control(task!), admission = inspectProgressAdmission(task!, control)
    if (admission.hard) { this.haltProgress(task!, admission.hard); return null }
    const now = Date.now(), stepId = randomUUID()
    const nextControl = admitProgressStep(task!, control, stepId); nextControl.pending = null
    if (!this.updateProgress(lease, { ...p, phase: 'waiting-tool', stepCount: p.stepCount + 1,
      handledMessageIds: [...p.handledMessageIds, sourceMessageId], detail: null,
      currentStep: { id: stepId, sourceMessageId, action: tool, tool, machine: structuredClone(machine), status: 'queued', execution: 'not_executed',
        delivery: 'pending', message: null, resultText: null, createdAt: now, updatedAt: now } }, undefined, nextControl)) return null
    return { sessionId: lease.sessionId, platformId: lease.platformId, conversationId: lease.conversationId, taskId: lease.taskId, generation: lease.generation,
      stepId, sourceMessageId, tool, machine: structuredClone(machine) }
  }

  ownsToolStep(context: TaskToolContext): boolean {
    const task = this.current(context.platformId), step = task?.progress?.currentStep
    return this.owns(context) && !task?.control?.halted && step?.id === context.stepId && step.tool === context.tool && step.sourceMessageId === context.sourceMessageId &&
      step.machine?.id === context.machine.id && step.machine.connection === context.machine.connection && step.machine.platform === context.machine.platform && step.machine.arch === context.machine.arch
  }

  noteToolStep(context: TaskToolContext, event: TaskToolEvent): boolean {
    if (!this.ownsToolStep(context)) return false
    const p = this.current(context.platformId)!.progress!, step = p.currentStep!
    if (event.execution) step.execution = event.execution
    if (event.message !== undefined) step.message = event.message
    if (event.resultText !== undefined) step.resultText = event.resultText.slice(0, 256000)
    if (event.stage === 'waiting-desktop') { step.status = 'queued'; p.phase = 'waiting-tool'; step.execution = 'not_executed'; p.detail = event.message ?? '等待全局桌面协调放行，本步尚未执行。' }
    if (event.stage === 'executing') { step.status = 'executing'; p.phase = 'executing-tool'; step.execution = 'unknown'; p.detail = null }
    if (event.stage === 'result-ready') { step.status = 'result-ready'; p.phase = 'waiting-delivery' }
    if (event.stage === 'sending') { step.delivery = 'sending'; p.phase = 'waiting-delivery' }
    if (event.stage === 'pending') { step.delivery = 'pending'; p.phase = 'waiting-delivery'; p.detail = event.message ?? '结果已保留，等待原工具回传。' }
    if (event.stage === 'delivered') { step.status = 'delivered'; step.delivery = 'sent'; step.resultText = null; p.phase = 'waiting-model'; p.detail = null }
    if (event.stage === 'skipped') { step.status = 'delivered'; step.delivery = 'cancelled'; p.phase = 'responded'; p.detail = event.message ?? '本步未执行。' }
    if (event.stage === 'background') { step.status = 'result-ready'; step.delivery = 'pending'; p.phase = 'waiting-model'; p.detail = '后台启动结果由既有通知链路交付；登记不表示任务完成。' }
    if (event.stage === 'uncertain' || event.stage === 'cancelled') { step.status = 'interrupted'; step.delivery = event.stage === 'uncertain' ? 'uncertain' : 'cancelled';
      p.phase = 'blocked'; p.detail = event.message ?? '本步已中断或交付未确认，不自动重放。' }
    step.updatedAt = Date.now()
    const control = this.control(this.current(context.platformId)!)
    if (event.stage === 'result-ready' && event.timedOut !== undefined) {
      control.consecutiveTimeouts = event.timedOut ? control.consecutiveTimeouts + 1 : 0
      if (event.timedOut) control.recovering = true
      if (control.consecutiveTimeouts >= control.limits.maxConsecutiveTimeouts) control.halted = 'consecutive_timeouts'
      if (control.halted) { p.phase = 'blocked'; p.detail = PROGRESS_STOP_MESSAGES[control.halted] }
    }
    const completion = context.tool === 'command' && event.stage === 'result-ready' && event.execution === 'executed' && event.commandResult
      ? captureCompletionCommand(this.current(context.platformId)!, context.stepId, event.commandResult, Date.now()) : undefined
    return this.updateProgress(context, p, undefined, control, completion)
  }

  private newComputerToken(): string { return `cu_${randomUUID().replace(/-/g, '')}` }

  /** A pre-send grant may be published before the first human send creates its task. */
  computerStepToken(platformId: string): string | null {
    if (this.dispatchBlocked || this.waitingForUser(platformId)) return null
    const task = this.current(platformId)
    let grant = this.computerTokens.get(platformId)
    if (!grant || grant.taskId !== (task?.id ?? null) || grant.generation !== (task?.generation ?? null)) {
      grant = { value: this.newComputerToken(), taskId: task?.id ?? null, generation: task?.generation ?? null, pending: false }
      this.computerTokens.set(platformId, grant)
    }
    return grant.pending ? null : grant.value
  }

  isComputerStepToken(lease: TaskLease, token: string, allowSending = false): boolean {
    const grant = this.computerTokens.get(lease.platformId)
    if (!this.owns(lease) || !grant || grant.taskId !== lease.taskId || grant.generation !== lease.generation || grant.value !== token) return false
    const step = this.current(lease.platformId)?.progress?.currentStep
    return !grant.pending || (allowSending && step?.delivery === 'sending' && step.nextStepToken === token)
  }

  /** Check before producing stale-token feedback: replay must not consume the new grant either. */
  hasComputerStep(lease: TaskLease, sourceMessageId: string, receivedToken: string | null): boolean {
    if (!this.owns(lease)) return false
    const memory = this.computerClaims.get(lease.taskId)
    return !!memory?.answers.has(sourceMessageId) || !!receivedToken && !!memory?.tokens.has(receivedToken) ||
      this.store.hasComputerAction?.(lease, sourceMessageId, receivedToken) === true
  }

  /** Consume before execution; an error reply also advances the grant without authorizing input. */
  reserveComputerStep(lease: TaskLease, progress: TaskProgress, receivedToken: string | null, feedback: boolean,
    request?: { call?: ComputerUseToolCall; result?: ComputerUseToolResult; receipt?: ComputerUsePageRequest }, originalCall?: ComputerUseToolCall): boolean {
    if (!this.owns(lease) || this.waitingForUser(lease.platformId)) return false
    const grant = this.computerTokens.get(lease.platformId)
    if (!grant || grant.pending || grant.taskId !== lease.taskId || grant.generation !== lease.generation ||
      this.hasComputerStep(lease, progress.currentStep!.sourceMessageId, receivedToken) ||
      (!feedback && receivedToken !== grant.value)) return false
    const nextToken = this.newComputerToken()
    const next = structuredClone(progress)
    next.currentStep!.stepToken = receivedToken && /^cu_[a-f0-9]{32}$/.test(receivedToken) ? receivedToken : null
    next.currentStep!.nextStepToken = nextToken
    const state = this.entries.get(lease.platformId)!
    const control = this.control(state.task!), admission = inspectProgressAdmission(state.task!, control, originalCall ?? request?.call)
    if (control.halted) { this.haltProgress(state.task!, control.halted); return false }
    if (admission.hard && ['task_timeout', 'step_limit', 'recovery_limit'].includes(admission.hard)) { this.haltProgress(state.task!, admission.hard); return false }
    const task = { ...state.task!, progress: next, updatedAt: Date.now(), control: admitProgressStep(state.task!, control, next.currentStep!.id, originalCall ?? request?.call) }
    let claim: ComputerActionClaim | undefined
    if (request) {
      const step = next.currentStep!, requestJson = computerActionRequest(request.call, request.result, request.receipt)
      claim = { sessionId: lease.sessionId, platformId: lease.platformId, conversationId: lease.conversationId, taskId: lease.taskId, generation: lease.generation,
        executionId: step.id, machineId: step.machine!.id, sourceMessageId: step.sourceMessageId, grantToken: grant.value,
        receivedToken: receivedToken && /^cu_[a-f0-9]{32}$/.test(receivedToken) ? receivedToken : null,
        action: step.action, kind: feedback ? 'feedback' : 'action', requestJson, requestHash: createHash('sha256').update(requestJson).digest('hex'), createdAt: step.createdAt }
    }
    this.store.saveAutonomousTasks([task], claim)
    const claims = this.computerClaims.get(lease.taskId) ?? { answers: new Set<string>(), tokens: new Set<string>() }
    claims.answers.add(next.currentStep!.sourceMessageId); claims.tokens.add(grant.value)
    this.computerClaims.set(lease.taskId, claims)
    this.computerTokens.set(lease.platformId, { value: nextToken, taskId: lease.taskId, generation: lease.generation, pending: true })
    this.publish({ ...state, task })
    return true
  }

  /** Late executor receipts update history only; they never publish state or reactivate a goal. */
  recordComputerAction(update: ComputerActionUpdate): ComputerUseToolResult | undefined {
    const state = this.entries.get(update.platformId), current = state?.task
    let assessedControl: ComputerProgressState | undefined
    if (update.event === 'result') {
      let result = update.result
      if (this.owns(update) && current?.progress?.currentStep?.id === update.executionId) {
        try {
          const assessment = recordProgressResult(this.control(current), update.executionId, result, update.actionTimedOut)
          assessedControl = assessment.state
          result = { ...result, progress_control: assessment.report }
        } catch (error) { this.store.saveAutonomousTasks([], undefined, update); throw error }
      }
      const live = this.owns(update) && current?.progress?.currentStep?.id === update.executionId
      try { result = { ...result, diagnosis: diagnoseComputerResult(result, { actions: live ? update.diagnosticContext?.actions ?? [] : [],
        otherTools: live ? update.diagnosticContext?.otherTools ?? [] : [], recoveryRequiresObservation: live && current?.recovery?.requiresObservation }) ?? undefined } }
      catch { result = { ...result, diagnosis: undefined } }
      update = { ...update, result }
    }
    if (update.event !== 'result' || !this.owns(update) || current?.progress?.currentStep?.id !== update.executionId) {
      this.store.saveAutonomousTasks([], undefined, update)
      return update.event === 'result' ? update.result : undefined
    }
    const task = structuredClone(current)
    task.control = assessedControl ?? this.control(current)
    task.completion = captureCompletionResult(task, update.result, update.executionId, update.at)
    if (update.result.action === 'complete_task' && update.result.data && typeof update.result.data === 'object') {
      const report = (update.result.data as { completion_report?: unknown }).completion_report
      const checked = parseTaskCompletionState({ ...task.completion, report })
      if (checked?.report?.stepId === update.executionId && (checked.report.state === 'rejected' || checked.report.state === 'ready' && update.result.ok && update.result.execution === 'executed')) task.completion = checked
    }
    const diagnosis = update.result.diagnosis
    if (diagnosis && !['partial_observation', 'target_not_found'].includes(diagnosis.category) &&
      !(diagnosis.category === 'loading_timeout' && !update.result.progress_control?.action_timed_out) &&
      !(diagnosis.category === 'no_progress' && ['list_apps', 'list_windows', 'observe', 'validate_observation', 'inspect_interactions', 'wait_for'].includes(update.result.action))) task.control.recovering = true
    if (update.result.execution === 'unknown' || update.result.diagnosis?.requires_fresh_observation) {
      task.recovery = { version: 1, reason: update.result.execution === 'unknown' ? 'unknown_result' : 'result_verification', sourceTaskId: task.id, sourceGeneration: task.generation,
        checkpointAt: update.at, requiresObservation: true, unknownExecutionId: update.result.execution === 'unknown' ? update.executionId : task.recovery?.unknownExecutionId ?? null, observationStepId: null }
    } else if (task.recovery?.requiresObservation && update.result.action === 'observe' && update.result.ok && update.result.execution === 'executed') {
      task.recovery = { ...task.recovery, requiresObservation: false, observationStepId: update.executionId, checkpointAt: update.at }
    }
    // The receipt and its recovery barrier commit together before formatting or delivery.
    task.progress!.currentStep!.execution = update.result.execution
    task.updatedAt = update.at
    try { this.store.saveAutonomousTasks([task], undefined, update) }
    catch (error) {
      // A checkpoint-only failure must not discard a receipt that can still be saved.
      // The caller stops progression on this error; no grant is released or result sent.
      this.store.saveAutonomousTasks([], undefined, update)
      throw error
    }
    this.publish({ ...state!, task })
    return update.result
  }

  updateProgress(lease: TaskLease, progress: TaskProgress, update?: ComputerActionUpdate, controlOverride?: ComputerProgressState, completionOverride?: TaskCompletionState): boolean {
    if (!this.owns(lease)) return false
    const state = this.entries.get(lease.platformId)!
    const timed = this.control(state.task!)
    const task = { ...state.task!, ...(completionOverride ? { completion: completionOverride } : {}), progress: structuredClone(progress), updatedAt: Date.now(), control: controlOverride ? { ...controlOverride, elapsedMs: timed.elapsedMs } : timed }
    if (progress.currentStep?.delivery === 'sent' && task.control.elapsedMs >= task.control.limits.taskTimeoutMs) task.control.halted ??= 'task_timeout'
    if (task.control.halted && progress.currentStep?.delivery === 'sent') {
      task.progress.phase = 'blocked'; task.progress.detail = PROGRESS_STOP_MESSAGES[task.control.halted]
    }
    if (pendingTaskQuestion(task)) { task.progress.phase = 'waiting-user'; task.progress.detail = state.task!.progress?.detail ?? '等待必要澄清，尚未取得真实回答。' }
    if (update?.event === 'dispatch' || progress.currentStep?.tool === 'command' && progress.currentStep.status === 'executing' && state.task!.progress?.currentStep?.status !== 'executing')
      task.completion = advanceCompletion(state.task!, progress.currentStep!.action, update?.event === 'dispatch' ? update.observationId : undefined)
    if (task.completion && progress.currentStep?.delivery === 'sent') {
      task.completion = structuredClone(task.completion)
      for (const e of task.completion.evidence) if (e.stepId === progress.currentStep.id) e.delivered = true
      const report = task.completion.report
      if (report?.state === 'ready' && report.stepId === progress.currentStep.id && !pendingTaskQuestion(task) && !task.control.halted && task.control.elapsedMs < task.control.limits.taskTimeoutMs && !task.recovery?.requiresObservation) {
        report.state = 'delivered'
        task.status = 'completed'
        task.progress.phase = 'completed'
        task.progress.detail = '目标已逐项核对，结果报告及产物位置已确认回传。'
        task.control.pending = null
      }
    }
    // Persist before any desktop input or submission, including their in-flight states.
    this.store.saveAutonomousTasks([task], undefined, update)
    if (task.status === 'completed') { this.computerTokens.delete(lease.platformId); this.computerClaims.delete(task.id) }
    const grant = this.computerTokens.get(lease.platformId)
    if (task.status !== 'completed' && grant?.pending && grant.taskId === lease.taskId && grant.generation === lease.generation &&
      task.progress.phase === 'waiting-model' && progress.currentStep?.delivery === 'sent' && progress.currentStep.nextStepToken === grant.value) grant.pending = false
    this.publish({ ...state, task })
    return true
  }

  noteReply(platformId: string, messageId: string, kind: 'response' | 'question'): void {
    const task = this.current(platformId)
    if (task && pendingTaskQuestion(task)) return
    if (!task?.conversationId || !task.progress || task.progress.handledMessageIds.includes(messageId) ||
      !['waiting-model', 'responded', 'waiting-user'].includes(task.progress.phase)) return
    const previous = task.progress.lastReply
    // The same question also arrives through the generic settled-answer callback.
    if (previous?.messageId === messageId && (previous.kind === 'question' || previous.kind === kind)) return
    this.updateProgress({ ...task, taskId: task.id, conversationId: task.conversationId }, {
      ...task.progress, phase: kind === 'question' ? 'waiting-user' : 'responded',
      lastReply: { messageId, kind },
      detail: kind === 'question' ? '等待回答模型的问题。' : '模型已回复；任务是否完成仍以实际结果为准。'
    })
  }

  recordBackgroundDependency(lease: TaskLease, dependency: TaskBackgroundDependency): boolean {
    const task = this.current(lease.platformId), step = task?.progress?.currentStep
    if (!this.owns(lease) || !step || step.id !== dependency.waitingStepId || step.action !== 'wait_for' ||
      step.tool !== 'computer' || step.status !== 'executing' || step.machine?.id !== dependency.machineId) return false
    const entries = task!.backgroundDependencies ?? []
    const existing = entries.findIndex(d => d.waitingStepId === dependency.waitingStepId)
    const next = structuredClone(entries)
    if (existing >= 0) next[existing] = structuredClone(dependency)
    else { if (next.length >= 64) next.shift(); next.push(structuredClone(dependency)) }
    const state = this.entries.get(lease.platformId)!
    const updated = { ...state.task!, backgroundDependencies: next, updatedAt: Date.now() }
    this.store.saveAutonomousTasks([updated])
    this.publish({ ...state, task: updated })
    return true
  }

  recordContinuity(lease: TaskLease, stepId: string, continuity: TaskContinuity): boolean {
    const task = this.current(lease.platformId), step = task?.progress?.currentStep
    if (!this.owns(lease) || !step || step.id !== stepId || step.status !== 'executing' || step.machine?.id !== continuity.machineId || task?.machine.id !== continuity.machineId) return false
    const state = this.entries.get(lease.platformId)!
    const updated = { ...state.task!, completion: captureCompletionFiles(state.task!, continuity, stepId, Date.now()), continuity: structuredClone(continuity), updatedAt: Date.now(), control: recordFileEvidence(this.control(state.task!), continuity, stepId) }
    this.store.saveAutonomousTasks([updated])
    this.publish({ ...state, task: updated })
    return true
  }

  /** An async notification must not overwrite a newer tool step. */
  noteBackgroundDelivery(context: TaskToolContext, uncertain: boolean): void {
    if (!this.owns(context)) return
    const p = this.current(context.platformId)?.progress
    if (!p || !['waiting-model', 'responded'].includes(p.phase)) return
    if (uncertain) { p.phase = 'blocked'; p.detail = '后台结果提交未确认，已停止自动推进，请核对原对话；不会重复提交或重启进程。' }
    else if (p.currentStep?.id === context.stepId) {
      p.currentStep.status = 'delivered'; p.currentStep.delivery = 'sent'; p.currentStep.resultText = null
      p.detail = '后台状态已回传，整体目标仍需根据真实结果判断。'
    }
    this.updateProgress(context, p)
  }

  private interrupted(task: AutonomousTask, status: 'stopped' | 'interrupted' | 'superseded'): AutonomousTask {
    const next = structuredClone(task)
    next.status = status
    next.updatedAt = Date.now()
    if (task.status === 'recorded') next.control = this.control(task)
    if (next.control) next.control.pending = null
    for (const q of next.clarifications?.items ?? []) if (!['answered', 'cancelled'].includes(q.state)) { q.state = q.state === 'sending' || q.state === 'uncertain' ? 'uncertain' : 'cancelled'; q.updatedAt = next.updatedAt }
    next.recovery = { version: 1, reason: 'interrupted', sourceTaskId: task.id, sourceGeneration: task.generation,
      checkpointAt: next.updatedAt, requiresObservation: true, unknownExecutionId: task.recovery?.unknownExecutionId ??
        (task.progress?.currentStep?.execution === 'unknown' ? task.progress.currentStep.id : null), observationStepId: null }
    for (const d of next.backgroundDependencies ?? []) if (d.state === 'waiting') { d.state = 'cancelled'; d.updatedAt = next.updatedAt }
    if (next.progress) {
      next.progress.phase = 'interrupted'
      const step = next.progress.currentStep
      if (step && step.status !== 'delivered') {
        step.status = 'interrupted'
        step.delivery = step.delivery === 'sending' || step.delivery === 'uncertain' ? 'uncertain' : 'cancelled'
        step.updatedAt = next.updatedAt
      }
      next.progress.detail = '自动推进已中断；已开始的动作或发送可能已生效，不会自动重放。'
    }
    return next
  }

  fail(platformId: string, conversationId: string | null): void {
    this.computerTokens.delete(platformId)
    const state = this.entries.get(platformId)
    this.publish({ sessionId: this.sessionId, platformId, conversationId,
      task: state?.conversationId === conversationId ? state.task : null,
      error: '任务记录未能保存或更新。请检查本地存储后重新提交目标。' })
  }

  dispose(): void {
    for (const platformId of this.entries.keys()) this.stop(platformId, 'interrupted')
    this.computerClaims.clear()
    for (const clock of this.clocks.values()) clock.cancel?.()
    this.clocks.clear()
  }

  private publish(state: AutonomousTaskState): AutonomousTaskState {
    for (const [id, clock] of this.clocks) if (id !== state.task?.id && ![...this.entries.values()].some(s => s.platformId !== state.platformId && s.task?.id === id && s.task.status === 'recorded')) {
      clock.cancel?.(); this.clocks.delete(id)
    }
    this.entries.set(state.platformId, structuredClone(state))
    if (state.task?.status === 'recorded' && !state.error) this.arm(state.task)
    else if (state.task) { this.clocks.get(state.task.id)?.cancel?.(); this.clocks.delete(state.task.id) }
    this.changed(structuredClone(state))
    return structuredClone(state)
  }
}
