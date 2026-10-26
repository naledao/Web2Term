import type { AutonomousTask, TaskLease, TaskToolStep } from './autonomous-task'
import type { ComputerActionRecord } from './computer-actions'
import type { TaskEvidence } from './task-completion'

/** Read-only presentation identifiers. Never a tool grant or an arbitrary file path. */
export type TaskObservationRequest = TaskLease & { observationId: string }
export type TaskArtifactRequest = TaskLease & { evidenceId: string }
export interface TaskObservationSummary {
  observationId: string
  stepId: string
  observedAt: string
  target: 'desktop' | 'window' | 'region' | 'controls'
  windowTitle: string | null
  application: string | null
  width: number | null
  height: number | null
  controls: { count: number; complete: boolean; focus: string } | null
  previewAvailable: boolean
}
export interface TaskActionSummary {
  id: string
  action: string
  kind: 'action' | 'feedback'
  state: ComputerActionRecord['executionState']
  execution: ComputerActionRecord['execution']
  delivery: ComputerActionRecord['deliveryState']
  deliveryAttempts: number
  createdAt: number
  updatedAt: number
}
export interface TaskActivity {
  lease: TaskLease
  readAt: number
  application: { title: string | null; executable: string | null; confirmedAt: number } | null
  actions: TaskActionSummary[]
  hasMoreActions: boolean
  currentTool: Pick<TaskToolStep, 'id' | 'action' | 'status' | 'execution' | 'delivery'> | null
  observation: TaskObservationSummary | null
}
const keys = ['sessionId', 'platformId', 'conversationId', 'taskId', 'generation']
export function validTaskPresentationRequest(value: unknown, extra?: 'observationId' | 'evidenceId'): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>, allowed = extra ? [...keys, extra] : keys
  return Object.keys(v).length === allowed.length && allowed.every(k => Object.hasOwn(v, k)) &&
    keys.filter(k => k !== 'generation').every(k => typeof v[k] === 'string' && !!v[k].trim() && v[k].length <= 512 && !/[\x00-\x1f\x7f]/.test(v[k])) &&
    Number.isSafeInteger(v.generation) && Number(v.generation) >= 1 && (!extra || (typeof v[extra] === 'string' &&
      (extra === 'observationId' ? /^obs_[a-f0-9]{32}$/ : /^ev_[a-f0-9]{32}$/).test(v[extra])))
}
export function taskPresentationLease(task: AutonomousTask): TaskLease | null {
  return task.conversationId ? { sessionId: task.sessionId, platformId: task.platformId, conversationId: task.conversationId, taskId: task.id, generation: task.generation } : null
}
export function samePresentationLease(a: TaskLease, b: TaskLease): boolean {
  return keys.every(k => a[k as keyof TaskLease] === b[k as keyof TaskLease])
}
/** Only facts are projected; raw requests, tool output and model text stay out of the activity feed. */
export function taskActivity(task: AutonomousTask, records: readonly ComputerActionRecord[], observation: TaskObservationSummary | null, now = Date.now()): TaskActivity | null {
  const lease = taskPresentationLease(task)
  if (!lease) return null
  const scoped = records.filter(r => samePresentationLease(r, lease) && r.machineId === task.machine.id)
    .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
  const transition = task.continuity?.transitions.slice().reverse().find(t => t.toWindowKey && ['observed', 'focus-confirmed'].includes(t.evidence))
  const window = transition ? task.continuity?.windows.find(w => w.key === transition.toWindowKey) : null
  const step = task.progress?.currentStep
  return { lease, readAt: now, application: window && transition ? { title: window.title, executable: window.executablePath, confirmedAt: transition.seenAt } : null,
    actions: scoped.slice(0, 50).map(r => ({ id: r.executionId, action: r.action.slice(0, 80), kind: r.kind, state: r.executionState,
      execution: r.execution, delivery: r.deliveryState, deliveryAttempts: r.deliveryAttempts, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    hasMoreActions: scoped.length > 50, currentTool: step ? { id: step.id, action: step.action, status: step.status, execution: step.execution, delivery: step.delivery } : null,
    observation }
}
export function reportedArtifactEvidence(task: AutonomousTask, evidenceId: string): TaskEvidence | null {
  const artifact = task.completion?.report?.artifacts.find(a => a.evidenceId === evidenceId)
  const evidence = task.completion?.evidence.find(e => e.id === evidenceId)
  return artifact && evidence?.kind === 'file' && evidence.target === artifact.path && evidence.sha256 === artifact.sha256 && evidence.sizeBytes === artifact.sizeBytes ? structuredClone(evidence) : null
}
