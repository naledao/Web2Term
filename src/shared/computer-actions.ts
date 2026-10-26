import type { TaskLease } from './autonomous-task'
import type { ComputerUsePageRequest, ComputerUseToolCall, ComputerUseToolResult } from './computer-use'
import type { ComputerDiagnosticContext } from './computer-diagnostics'

export type ComputerExecutionState = 'queued' | 'dispatching' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type ComputerDeliveryState = 'pending' | 'uploading' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled'
export type ComputerActionEvent =
  | { event: 'dispatch' }
  | { event: 'result'; result: ComputerUseToolResult; diagnosticContext?: ComputerDiagnosticContext; actionTimedOut?: boolean }
  | { event: 'ready'; text: string }
  | { event: 'delivery-start'; attemptId: string }
  | { event: 'delivery-outcome'; attemptId: string; outcome: 'ok' | 'busy' | 'no-composer' | 'failed' | 'unknown' }
  | { event: 'cancel' }
export type ComputerActionUpdate = TaskLease & { executionId: string; at: number } & ComputerActionEvent

/** Journal snapshots contain no executable callback, temporary path or image bytes. */
export interface ComputerActionRecord extends TaskLease {
  executionId: string
  action: string
  kind: 'action' | 'feedback'
  machineId: string
  sourceMessageId: string
  executionState: ComputerExecutionState
  execution: ComputerUseToolResult['execution']
  deliveryState: ComputerDeliveryState
  resultJson: string | null
  deliveryText: string | null
  deliveryAttempts: number
  createdAt: number
  updatedAt: number
}

/** Immutable admission history only. A stored claim never authorizes execution. */
export interface ComputerActionClaim extends TaskLease {
  executionId: string
  machineId: string
  sourceMessageId: string
  grantToken: string
  receivedToken: string | null
  action: string
  kind: 'action' | 'feedback'
  requestJson: string
  requestHash: string
  createdAt: number
}

/** Canonicalize object keys, preserving array order and all request values. */
export function computerActionRequest(call?: ComputerUseToolCall, feedback?: ComputerUseToolResult, receipt?: ComputerUsePageRequest): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value
  const data = JSON.parse(JSON.stringify({ kind: call ? 'action' : 'feedback', call: call ?? null,
    feedback: feedback ? { action: feedback.action, code: feedback.code, execution: feedback.execution, message: feedback.message, data: feedback.data } : null,
    receipt: receipt ?? null })) as unknown
  const encoded = JSON.stringify(canonical(data))
  if (encoded.length > 256_000) throw new Error('computer-action-request-too-large')
  return encoded
}

export function validComputerActionClaim(value: unknown): value is ComputerActionClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as ComputerActionClaim
  const text = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && s.length <= 512 && !/[\x00-\x1f\x7f]/.test(s)
  if (![c.sessionId, c.platformId, c.conversationId, c.taskId, c.machineId, c.sourceMessageId, c.action].every(text) ||
    !Number.isSafeInteger(c.generation) || c.generation < 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.executionId) ||
    !/^cu_[a-f0-9]{32}$/.test(c.grantToken) || (c.receivedToken !== null && !/^cu_[a-f0-9]{32}$/.test(c.receivedToken)) ||
    !['action', 'feedback'].includes(c.kind) || (c.kind === 'action' && c.receivedToken !== c.grantToken) || !/^[a-f0-9]{64}$/.test(c.requestHash) ||
    typeof c.requestJson !== 'string' || !c.requestJson || c.requestJson.length > 256_000 || !Number.isSafeInteger(c.createdAt) || c.createdAt < 0) return false
  try {
    const payload = JSON.parse(c.requestJson)
    return payload?.kind === c.kind && (c.kind === 'action' ? payload.call?.action === c.action && payload.feedback === null
      : payload.call === null && typeof payload.feedback === 'object' && payload.feedback !== null)
  } catch { return false }
}
