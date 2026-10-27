import type { FocusAttachmentInfo } from './focus-chat'
import type { ComputerUsePageRequest } from './computer-use'
import { parseComputerProgressState } from './computer-progress'
import type { ComputerProgressState } from './computer-progress'
import { parseTaskCompletionState } from './task-completion'
import type { TaskCompletionState } from './task-completion'
import { parseTaskClarifications, validTaskAnswerSource, sameQuestionSource, pendingTaskQuestion } from './task-clarification'
import type { TaskClarificationState, TaskAnswerSource } from './task-clarification'

export interface TaskOwner {
  sessionId: string
  platformId: string
  conversationId: string | null
}

/** Issued only after the page confirms a human message was submitted. */
export interface TaskSubmission {
  id: string
  kind: 'goal' | 'clarification'
  /** Confirmed human answer provenance, supplied by the page transport and checked in main. */
  answerTo?: TaskAnswerSource
}

export interface TaskMachine {
  id: string
  label: string
  platform: string
  arch: string
  connection: 'local'
  workingDirectory: string
}

/** A lease is captured by the main process before accepting a live tool request. */
export interface TaskLease extends TaskOwner {
  taskId: string
  generation: number
  conversationId: string
}

/** Main-issued association for an existing terminal/file execution, never model parameters. */
export interface TaskToolContext extends TaskLease {
  stepId: string
  sourceMessageId: string
  tool: 'command' | 'read_files'
  machine: TaskMachine
}
export interface TaskToolEvent {
  stage: 'waiting-desktop' | 'executing' | 'result-ready' | 'sending' | 'pending' | 'delivered' | 'uncertain' | 'cancelled' | 'skipped' | 'background'
  execution?: 'not_executed' | 'executed' | 'unknown'
  message?: string
  resultText?: string
  timedOut?: boolean
  /** Actual local shell receipt supplied by CommandRunner; never model JSON. */
  commandResult?: { exitCode: number | null; output: string; timedOut: boolean; interrupted: boolean; rejected: boolean; sessionLost: boolean }
}

export function parseTaskToolContext(value: unknown): TaskToolContext | null {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const text = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v)
  const keys = ['sessionId', 'platformId', 'conversationId', 'taskId', 'generation', 'stepId', 'sourceMessageId', 'tool', 'machine']
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k)) ||
    ![value.sessionId, value.platformId, value.conversationId, value.taskId, value.stepId, value.sourceMessageId].every(v => text(v)) ||
    !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || !['command', 'read_files'].includes(value.tool as string)) return null
  const m = value.machine
  if (!object(m) || Object.keys(m).length !== 6 || !['id', 'label', 'platform', 'arch', 'connection', 'workingDirectory'].every(k => Object.hasOwn(m, k)) ||
    ![m.id, m.label, m.platform, m.arch].every(v => text(v)) || m.connection !== 'local' || typeof m.workingDirectory !== 'string' ||
    m.workingDirectory.length > 4096 || /[\x00-\x1f\x7f]/.test(m.workingDirectory)) return null
  return structuredClone(value) as unknown as TaskToolContext
}

export function taskToolResultContext(lease: TaskLease, stepId: string, sourceMessageId: string, tool: string, machine: TaskMachine): Record<string, unknown> {
  return { session_id: lease.sessionId, platform_id: lease.platformId, conversation_id: lease.conversationId,
    task_id: lease.taskId, task_generation: lease.generation, step_id: stepId, source_message_id: sourceMessageId, tool,
    machine: { id: machine.id, label: machine.label, platform: machine.platform, arch: machine.arch, connection: machine.connection, working_directory: machine.workingDirectory } }
}

export interface TaskToolStep {
  id: string
  sourceMessageId: string
  action: string
  status: 'queued' | 'executing' | 'result-ready' | 'delivered' | 'interrupted'
  execution: 'not_executed' | 'executed' | 'unknown'
  delivery: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled'
  message: string | null
  /** Text delivery only. Screenshots use the later attachment pipeline. */
  resultText: string | null
  /** Model-authored display intent, not an execution receipt. Absent in legacy records. */
  description?: string
  createdAt: number
  updatedAt: number
  stepToken?: string | null
  nextStepToken?: string
  tool?: 'computer' | 'command' | 'read_files'
  machine?: TaskMachine
}

export interface TaskProgress {
  phase: 'waiting-model' | 'waiting-tool' | 'executing-tool' | 'waiting-delivery' | 'waiting-user' | 'responded' | 'blocked' | 'interrupted' | 'completed'
  stepCount: number
  handledMessageIds: string[]
  currentStep: TaskToolStep | null
  detail: string | null
  lastReply?: { messageId: string; kind: 'response' | 'question' }
  /** Receipt is local history, not authorization to run or resume a tool. */
  computerRequest?: ComputerUsePageRequest & { receivedAt: number }
}

export interface TaskBackgroundDependency {
  backgroundId: string
  startupStepId: string
  waitingStepId: string
  machineId: string
  condition: 'background_ready' | 'background_finished'
  state: 'waiting' | 'satisfied' | 'failed' | 'unconfirmed' | 'timed-out' | 'cancelled'
  createdAt: number
  updatedAt: number
}

/** Evidence index for continuing a goal. None of these stored hints authorize an action. */
export interface TaskContinuity {
  version: 1
  machineId: string
  apps: Array<{ appId: string; name: string; executablePath: string | null; stepId: string; seenAt: number }>
  windows: Array<{ key: string; windowId: string; hwnd: string; pid: number; processStartedAt: string; threadId: number; className: string;
    title: string | null; executablePath: string | null; stepId: string; seenAt: number }>
  resources: Array<{ kind: 'file' | 'directory' | 'url'; target: string; evidence: 'read-snapshot' | 'open-dispatched' | 'open-unconfirmed';
    stepId: string; seenAt: number; sizeBytes: number | null; sha256: string | null }>
  lastWindowKey: string | null
  transitions: Array<{ stepId: string; action: string; fromWindowKey: string | null; toWindowKey: string | null;
    evidence: 'observed' | 'focus-confirmed' | 'dispatched' | 'unconfirmed' | 'files-read'; seenAt: number }>
}

export function parseTaskContinuity(value: unknown): TaskContinuity | null {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const text = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v)
  const nullable = (v: unknown, max: number): boolean => v === null || text(v, max)
  const stamp = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const rows = (v: unknown, max: number, fields: string[], valid: (r: Record<string, unknown>) => boolean): boolean => Array.isArray(v) && v.length <= max &&
    v.every(r => object(r) && Object.keys(r).length === fields.length && fields.every(k => Object.hasOwn(r, k)) && valid(r))
  if (!object(value) || Object.keys(value).length !== 7 || value.version !== 1 || !text(value.machineId) || !nullable(value.lastWindowKey, 36) ||
    !rows(value.apps, 32, ['appId', 'name', 'executablePath', 'stepId', 'seenAt'], r => text(r.appId, 36) && /^app_[a-f0-9]{32}$/.test(r.appId) && text(r.name, 200) && nullable(r.executablePath, 1024) && text(r.stepId) && stamp(r.seenAt)) ||
    !rows(value.windows, 48, ['key', 'windowId', 'hwnd', 'pid', 'processStartedAt', 'threadId', 'className', 'title', 'executablePath', 'stepId', 'seenAt'], r =>
      text(r.key, 35) && /^tw_[a-f0-9]{32}$/.test(r.key) && text(r.windowId, 36) && /^win_[a-f0-9]{32}$/.test(r.windowId) && text(r.hwnd, 18) && /^0x[1-9a-f][a-f0-9]*$/.test(r.hwnd) &&
      Number.isSafeInteger(r.pid) && Number(r.pid) > 0 && Number(r.pid) <= 0xffffffff && Number.isSafeInteger(r.threadId) && Number(r.threadId) > 0 && Number(r.threadId) <= 0xffffffff &&
      text(r.processStartedAt, 64) && Number.isFinite(Date.parse(r.processStartedAt)) && text(r.className, 256) && nullable(r.title, 256) && nullable(r.executablePath, 1024) && text(r.stepId) && stamp(r.seenAt)) ||
    !rows(value.resources, 64, ['kind', 'target', 'evidence', 'stepId', 'seenAt', 'sizeBytes', 'sha256'], r => ['file', 'directory', 'url'].includes(r.kind as string) && text(r.target, 4096) &&
      ['read-snapshot', 'open-dispatched', 'open-unconfirmed'].includes(r.evidence as string) && text(r.stepId) && stamp(r.seenAt) &&
      (r.sizeBytes === null || Number.isSafeInteger(r.sizeBytes) && Number(r.sizeBytes) > 0 && Number(r.sizeBytes) <= 20 * 1024 * 1024) &&
      (r.sha256 === null || typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256)) &&
      (r.evidence !== 'read-snapshot' || r.kind === 'file' && r.sizeBytes !== null && r.sha256 !== null)) ||
    !rows(value.transitions, 32, ['stepId', 'action', 'fromWindowKey', 'toWindowKey', 'evidence', 'seenAt'], r => text(r.stepId) && text(r.action, 64) && nullable(r.fromWindowKey, 35) && nullable(r.toWindowKey, 35) &&
      ['observed', 'focus-confirmed', 'dispatched', 'unconfirmed', 'files-read'].includes(r.evidence as string) && stamp(r.seenAt))) return null
  const result = value as unknown as TaskContinuity
  if (new Set(result.apps.map(r => r.appId)).size !== result.apps.length || new Set(result.windows.map(r => r.key)).size !== result.windows.length ||
    new Set(result.resources.map(r => JSON.stringify([r.kind, r.target]))).size !== result.resources.length ||
    new Set(result.transitions.map(r => r.stepId)).size !== result.transitions.length || result.lastWindowKey !== null && !result.windows.some(r => r.key === result.lastWindowKey)) return null
  return structuredClone(result)
}

export interface AutonomousTask extends TaskOwner {
  id: string
  generation: number
  sourceSubmissionId: string
  sourceTurnId: string | null
  originalRequest: string
  /** Requirements and expected outputs stay verbatim in originalRequest and inputs. */
  inputs: Array<TaskSubmission & { text: string; attachments: FocusAttachmentInfo[]; receivedAt: number }>
  machine: TaskMachine
  status: 'recorded' | 'stopped' | 'interrupted' | 'superseded' | 'completed'
  /** Optional so tasks recorded before automatic progression remain readable. */
  progress?: TaskProgress
  /** Dependency history only. Restoring it never resumes an await or authorizes work. */
  backgroundDependencies?: TaskBackgroundDependency[]
  continuity?: TaskContinuity
  /** Durable recovery checkpoint; never restores grants, observations or queued work. */
  recovery?: TaskRecovery
  /** Bounded evidence/counters only; neither executable history nor task completion proof. */
  control?: ComputerProgressState
  /** Task-scoped evidence and the final delivery report; no replay authority. */
  completion?: TaskCompletionState
  /** A live model completion marker ends the task without requiring an evidence report. */
  modelCompletion?: { messageId: string; receivedAt: number }
  clarifications?: TaskClarificationState
  stop?: { reason: 'user-ended' | 'global-emergency' | 'human-takeover'; requestedAt: number }
  createdAt: number
  updatedAt: number
}

export interface TaskRecovery {
  version: 1
  reason: 'client_restart' | 'unknown_result' | 'result_verification' | 'resumed' | 'interrupted'
  sourceTaskId: string
  sourceGeneration: number
  checkpointAt: number
  requiresObservation: boolean
  unknownExecutionId: string | null
  observationStepId: string | null
}

export interface TaskResumeRequest extends TaskLease {}

export interface AutonomousTaskState extends TaskOwner {
  task: AutonomousTask | null
  error: string | null
}

/** Stored task data is local history, never an instruction to execute. */
export function parseAutonomousTask(payload: string): AutonomousTask | null {
  try {
    const task = JSON.parse(payload) as AutonomousTask & { intent?: unknown }
    const text = (value: unknown): value is string => typeof value === 'string'
    if (!task || !text(task.id) || !text(task.sessionId) || !text(task.platformId) ||
      (task.conversationId !== null && !text(task.conversationId)) || !Number.isSafeInteger(task.generation) || task.generation < 1 ||
      !text(task.sourceSubmissionId) || (task.sourceTurnId !== null && !text(task.sourceTurnId)) ||
      !text(task.originalRequest) || !task.originalRequest.trim() ||
      !['recorded', 'stopped', 'interrupted', 'superseded', 'completed'].includes(task.status) ||
      !Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt) ||
      !task.machine || task.machine.connection !== 'local' ||
      ![task.machine.id, task.machine.label, task.machine.platform, task.machine.arch, task.machine.workingDirectory].every(text) ||
      !Array.isArray(task.inputs) || !task.inputs.length || task.inputs.some(item => !item || !text(item.id) ||
        !['goal', 'clarification'].includes(item.kind) || !text(item.text) || !Number.isFinite(item.receivedAt) ||
        !Array.isArray(item.attachments) || item.attachments.some(file => !file || !text(file.fileName) || !text(file.mimeType) ||
          !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1))) return null
    // Older versions stored a pending extraction placeholder. It is not a prerequisite
    // for a tool call and is discarded without changing the original request or owner.
    delete task.intent
    if (task.inputs.some(input => input.answerTo !== undefined && (input.kind !== 'clarification' || !validTaskAnswerSource(input.answerTo)))) return null
    if (task.clarifications !== undefined) {
      const questions = parseTaskClarifications(task.clarifications)
      if (!questions || questions.items.some(q => q.source.sourceSubmissionId !== task.sourceSubmissionId || q.answer &&
        !task.inputs.some(input => input.kind === 'clarification' && input.id === q.answer!.submissionId && input.text === q.answer!.text &&
          input.answerTo?.messageId === q.messageId && sameQuestionSource(input.answerTo, q.source)))) return null
      task.clarifications = questions
    }
    if (task.stop !== undefined && (!task.stop || Object.keys(task.stop).length !== 2 || !['user-ended', 'global-emergency', 'human-takeover'].includes(task.stop.reason) || !Number.isSafeInteger(task.stop.requestedAt) || task.stop.requestedAt < 0)) return null
    if (task.completion !== undefined) {
      const completion = parseTaskCompletionState(task.completion)
      if (!completion) return null
      task.completion = completion
    }
    if (task.modelCompletion !== undefined && (!task.modelCompletion || Object.keys(task.modelCompletion).length !== 2 ||
      !text(task.modelCompletion.messageId) || !task.modelCompletion.messageId.trim() || task.modelCompletion.messageId.length > 512 ||
      !Number.isSafeInteger(task.modelCompletion.receivedAt) || task.modelCompletion.receivedAt < 0 ||
      task.status !== 'completed' || task.progress?.phase !== 'completed' || task.progress.lastReply?.kind !== 'response' ||
      task.progress.lastReply.messageId !== task.modelCompletion.messageId)) return null
    if (task.status === 'completed' && !task.modelCompletion && (task.completion?.report?.state !== 'delivered' || task.progress?.phase !== 'completed' ||
      task.progress.currentStep?.id !== task.completion.report.stepId || task.progress.currentStep.delivery !== 'sent' || task.progress.currentStep.status !== 'delivered' || task.progress.currentStep.action !== 'complete_task' ||
      task.progress.currentStep.execution !== 'executed' || task.control?.halted || task.recovery?.requiresObservation)) return null
    if (task.status !== 'completed' && (task.completion?.report?.state === 'delivered' || task.progress?.phase === 'completed')) return null
    if (task.status === 'completed' && task.completion?.report?.state === 'delivered' && (task.completion.report.requirements.length !== new Set(task.inputs.map(i => i.id)).size ||
      task.completion!.report!.requirements.some(r => !task.inputs.some(i => i.id === r.input_id)))) return null
    if (task.control !== undefined) {
      const control = parseComputerProgressState(task.control)
      if (!control) return null
      task.control = control
    }
    if (task.recovery !== undefined) {
      const r = task.recovery
      if (!r || Object.keys(r).length !== 8 || r.version !== 1 ||
        !['client_restart', 'unknown_result', 'result_verification', 'resumed', 'interrupted'].includes(r.reason) ||
        !text(r.sourceTaskId) || !r.sourceTaskId || !Number.isSafeInteger(r.sourceGeneration) || r.sourceGeneration < 1 ||
        !Number.isSafeInteger(r.checkpointAt) || r.checkpointAt < 0 || typeof r.requiresObservation !== 'boolean' ||
        (r.unknownExecutionId !== null && (!text(r.unknownExecutionId) || !r.unknownExecutionId)) ||
        (r.observationStepId !== null && (!text(r.observationStepId) || !r.observationStepId)) ||
        (!r.requiresObservation && r.observationStepId === null)) return null
    }
    if (task.continuity !== undefined) {
      const continuity = parseTaskContinuity(task.continuity)
      if (!continuity || continuity.machineId !== task.machine.id) return null
      task.continuity = continuity
    }
    if (task.backgroundDependencies !== undefined && (!Array.isArray(task.backgroundDependencies) || task.backgroundDependencies.length > 64 ||
      task.backgroundDependencies.some(d => !d || Object.keys(d).length !== 8 ||
        ![d.backgroundId, d.startupStepId, d.waitingStepId, d.machineId].every(v => text(v) && !!v && v.length <= 512) ||
        !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(d.backgroundId) ||
        !['background_ready', 'background_finished'].includes(d.condition) ||
        !['waiting', 'satisfied', 'failed', 'unconfirmed', 'timed-out', 'cancelled'].includes(d.state) ||
        !Number.isFinite(d.createdAt) || !Number.isFinite(d.updatedAt)))) return null
    if (task.progress !== undefined) {
      const p = task.progress
      if (!p || !['waiting-model', 'waiting-tool', 'executing-tool', 'waiting-delivery', 'waiting-user', 'responded', 'blocked', 'interrupted', 'completed'].includes(p.phase) ||
        !Number.isSafeInteger(p.stepCount) || p.stepCount < 0 || !Array.isArray(p.handledMessageIds) ||
        p.handledMessageIds.some(id => !text(id) || !id) || new Set(p.handledMessageIds).size !== p.handledMessageIds.length ||
        p.stepCount !== p.handledMessageIds.length || (p.detail !== null && !text(p.detail))) return null
      if (p.lastReply !== undefined && (!p.lastReply || !text(p.lastReply.messageId) ||
        !['response', 'question'].includes(p.lastReply.kind))) return null
      if (p.computerRequest !== undefined) {
        const request = p.computerRequest
        if (!request || ![request.messageId, request.sourceSubmissionId, request.pagePath, request.rawJson].every(text) ||
          request.sourceSubmissionId !== task.sourceSubmissionId || request.rawJson.length > 64_000 ||
          (request.pageEpoch !== undefined && (!text(request.pageEpoch) || !request.pageEpoch)) ||
          !Number.isSafeInteger(request.taskPromptGeneration) || request.taskPromptGeneration < 0 ||
          !['candidate', 'invalid'].includes(request.outcome) ||
          ![null, 'invalid-json', 'ambiguous-request', 'oversized-request'].includes(request.issue) ||
          !Number.isFinite(request.receivedAt)) return null
      }
      const step = p.currentStep
      if (step?.description !== undefined && (typeof step.description !== 'string' || !step.description.trim() || step.description.length > 160 ||
        /[\x00-\x1f\x7f\u2028\u2029]/.test(step.description))) return null
      if (step !== null && (!step || ![step.id, step.sourceMessageId, step.action].every(value => text(value) && !!value) ||
        !p.handledMessageIds.includes(step.sourceMessageId) ||
        !['queued', 'executing', 'result-ready', 'delivered', 'interrupted'].includes(step.status) ||
        !['not_executed', 'executed', 'unknown'].includes(step.execution) ||
        !['pending', 'sending', 'sent', 'failed', 'uncertain', 'cancelled'].includes(step.delivery) ||
        (step.message !== null && !text(step.message)) || (step.resultText !== null && !text(step.resultText)) ||
        !Number.isFinite(step.createdAt) || !Number.isFinite(step.updatedAt))) return null
      if (step && ((step.stepToken !== undefined && step.stepToken !== null && !/^cu_[a-f0-9]{32}$/.test(step.stepToken)) ||
        (step.nextStepToken !== undefined && !/^cu_[a-f0-9]{32}$/.test(step.nextStepToken)))) return null
      if (step?.tool !== undefined && !['computer', 'command', 'read_files'].includes(step.tool)) return null
      if (step?.machine !== undefined && !parseTaskToolContext({ sessionId: task.sessionId, platformId: task.platformId, conversationId: task.conversationId,
        taskId: task.id, generation: task.generation, stepId: step.id, sourceMessageId: step.sourceMessageId, tool: 'command', machine: step.machine })) return null
    }
    if (task.status === 'recorded' && pendingTaskQuestion(task) && task.progress?.phase !== 'waiting-user') return null
    return task
  } catch { return null }
}
