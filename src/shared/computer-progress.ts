export interface ComputerProgressLimits {
  taskTimeoutMs: number
  actionTimeoutMs: number
  waitTimeoutMs: number
  maxSteps: number
  maxRepeatedAction: number
  maxUnchangedObservations: number
  maxConsecutiveTimeouts: number
  maxRecoverySteps: number
}

export const COMPUTER_PROGRESS_LIMIT_FIELDS = {
  taskTimeoutMs: { label: '任务时限', min: 60_000, max: 86_400_000, default: 3_600_000, unit: 60_000, suffix: '分钟' },
  actionTimeoutMs: { label: '单步执行时限', min: 1000, max: 120_000, default: 120_000, unit: 1000, suffix: '秒' },
  waitTimeoutMs: { label: '条件等待时限', min: 1000, max: 3_600_000, default: 3_600_000, unit: 1000, suffix: '秒' },
  maxSteps: { label: '任务步骤上限', min: 5, max: 2000, default: 200, unit: 1, suffix: '步' },
  maxRepeatedAction: { label: '同一动作无进展上限', min: 2, max: 20, default: 4, unit: 1, suffix: '次' },
  maxUnchangedObservations: { label: '连续相同观察上限', min: 2, max: 50, default: 6, unit: 1, suffix: '次' },
  maxConsecutiveTimeouts: { label: '连续超时上限', min: 1, max: 20, default: 3, unit: 1, suffix: '次' },
  maxRecoverySteps: { label: '一次诊断恢复上限', min: 2, max: 100, default: 12, unit: 1, suffix: '步' }
} as const
export const COMPUTER_PROGRESS_LIMIT_KEYS = Object.keys(COMPUTER_PROGRESS_LIMIT_FIELDS) as Array<keyof ComputerProgressLimits>

/** Strict for writes; normalization of legacy/malformed saved settings uses safe defaults. */
export function parseComputerProgressLimits(value: unknown): ComputerProgressLimits | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== COMPUTER_PROGRESS_LIMIT_KEYS.length) return null
  const v = value as Record<string, unknown>
  for (const key of COMPUTER_PROGRESS_LIMIT_KEYS) {
    const rule = COMPUTER_PROGRESS_LIMIT_FIELDS[key]
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < rule.min || Number(v[key]) > rule.max) return null
  }
  return { ...v } as unknown as ComputerProgressLimits
}
export function normalizeComputerProgressLimits(value?: unknown): ComputerProgressLimits {
  return parseComputerProgressLimits(value) ?? Object.fromEntries(COMPUTER_PROGRESS_LIMIT_KEYS.map(k => [k, COMPUTER_PROGRESS_LIMIT_FIELDS[k].default])) as unknown as ComputerProgressLimits
}

/** Pacing between a computer action's return and its result reaching the model. */
export const MAX_COMPUTER_RESULT_DELAY_SECONDS = 600
/** Whole seconds within 0–600; anything unusable means no wait. */
export function normalizeComputerResultDelay(value: unknown): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.min(Math.max(Math.round(seconds), 0), MAX_COMPUTER_RESULT_DELAY_SECONDS) : 0
}

export type ProgressStopReason = 'task_timeout' | 'step_limit' | 'repeated_action' | 'unchanged_observations' | 'consecutive_timeouts' | 'recovery_limit'
export interface ComputerProgressState {
  version: 1
  limits: ComputerProgressLimits
  elapsedMs: number
  steps: number
  epoch: number
  unchangedObservations: number
  consecutiveTimeouts: number
  recovering: boolean
  recoverySteps: number
  halted: ProgressStopReason | null
  repeats: Array<{ fingerprint: string; epoch: number; count: number }>
  sources: Array<{ source: string; digest: string }>
  latestTarget: string | null
  elements: Array<{ id: string; fingerprint: string }>
  pending: { stepId: string; fingerprint: string | null; repeat: number; blocked: boolean; hard: ProgressStopReason | null } | null
}
export interface ComputerProgressReport {
  version: 1
  steps: number
  elapsed_ms: number
  repeated_action_count: number
  unchanged_observations: number
  consecutive_timeouts: number
  recovery_steps: number
  action_timed_out: boolean
  signals: string[]
  halted: boolean
  stop_reason: ProgressStopReason | null
  guidance: string
  goal_verified: false
}
export const PROGRESS_STOP_MESSAGES: Record<ProgressStopReason, string> = {
  task_timeout: '已达到任务时限，停止后续自动派发；已完成部分和可能已生效的操作已保留，目标仍未完成。',
  step_limit: '已达到任务步骤上限，停止后续自动派发；已完成部分已保留，目标仍未完成。',
  repeated_action: '同一动作在没有新状态证据时反复请求，已达到上限；停止自动推进，保留原执行事实，目标仍未完成。',
  unchanged_observations: '连续观察没有发现可区分的状态变化，已达到上限；停止自动推进，目标仍未完成。',
  consecutive_timeouts: '连续超时已达到上限，停止自动推进；超时不证明操作没有生效，目标仍未完成。',
  recovery_limit: '本轮诊断恢复步骤已达到上限，停止自动推进；已完成部分已保留，目标仍未完成。'
}

export function parseComputerProgressState(value: unknown): ComputerProgressState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as ComputerProgressState
  const integer = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) >= 0
  const hash = (s: unknown): boolean => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
  if (Object.keys(v).length !== 15 || v.version !== 1 || !parseComputerProgressLimits(v.limits) ||
    ![v.elapsedMs, v.steps, v.epoch, v.unchangedObservations, v.consecutiveTimeouts, v.recoverySteps].every(integer) || typeof v.recovering !== 'boolean' ||
    v.halted !== null && !Object.hasOwn(PROGRESS_STOP_MESSAGES, v.halted) || v.latestTarget !== null && !hash(v.latestTarget) ||
    !Array.isArray(v.repeats) || v.repeats.length > 64 || v.repeats.some(r => !r || Object.keys(r).length !== 3 || !hash(r.fingerprint) || !integer(r.epoch) || !integer(r.count)) ||
    !Array.isArray(v.sources) || v.sources.length > 32 || v.sources.some(r => !r || Object.keys(r).length !== 2 || !hash(r.source) || !hash(r.digest)) ||
    !Array.isArray(v.elements) || v.elements.length > 200 || v.elements.some(r => !r || Object.keys(r).length !== 2 || typeof r.id !== 'string' || !/^el_[a-f0-9]{32}$/.test(r.id) || !hash(r.fingerprint)) ||
    new Set(v.repeats.map(r => r.fingerprint)).size !== v.repeats.length || new Set(v.sources.map(r => r.source)).size !== v.sources.length ||
    new Set(v.elements.map(r => r.id)).size !== v.elements.length) return null
  const p = v.pending
  if (p !== null && (!p || Object.keys(p).length !== 5 || typeof p.stepId !== 'string' || !p.stepId || p.stepId.length > 512 ||
    p.fingerprint !== null && !hash(p.fingerprint) || !integer(p.repeat) || typeof p.blocked !== 'boolean' ||
    p.hard !== null && !Object.hasOwn(PROGRESS_STOP_MESSAGES, p.hard))) return null
  return structuredClone(v)
}
