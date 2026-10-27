/** Pacing between a computer action's return and its result reaching the model. */
export const MAX_COMPUTER_RESULT_DELAY_SECONDS = 600
/** Whole seconds within 0–600; anything unusable means no wait. */
export function normalizeComputerResultDelay(value: unknown): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) ? Math.min(Math.max(Math.round(seconds), 0), MAX_COMPUTER_RESULT_DELAY_SECONDS) : 0
}

export interface ComputerProgressState {
  version: 2
  elapsedMs: number
  steps: number
  epoch: number
  unchangedObservations: number
  consecutiveTimeouts: number
  recovering: boolean
  recoverySteps: number
  repeats: Array<{ fingerprint: string; epoch: number; count: number }>
  sources: Array<{ source: string; digest: string }>
  latestTarget: string | null
  elements: Array<{ id: string; fingerprint: string }>
  pending: { stepId: string; fingerprint: string | null; repeat: number } | null
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
  guidance: string
  goal_verified: false
}
export function parseComputerProgressState(value: unknown): ComputerProgressState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  // Old checkpoints keep their execution facts, but their removed limits and stop flags have no authority.
  const legacy = (value as { version?: unknown }).version === 1
  const saved = value as ComputerProgressState & { limits?: unknown; halted?: unknown }
  const { limits: _limits, halted: _halted, ...fields } = saved
  if (!legacy && (_limits !== undefined || _halted !== undefined)) return null
  const v = { ...fields, version: legacy ? 2 : fields.version } as ComputerProgressState
  if (legacy && v.pending) {
    const { blocked: _blocked, hard: _hard, ...pending } = v.pending as ComputerProgressState['pending'] & { blocked?: unknown; hard?: unknown }
    v.pending = pending
  }
  const integer = (n: unknown): boolean => Number.isSafeInteger(n) && Number(n) >= 0
  const hash = (s: unknown): boolean => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
  if (Object.keys(v).length !== 13 || v.version !== 2 ||
    ![v.elapsedMs, v.steps, v.epoch, v.unchangedObservations, v.consecutiveTimeouts, v.recoverySteps].every(integer) || typeof v.recovering !== 'boolean' ||
    v.latestTarget !== null && !hash(v.latestTarget) ||
    !Array.isArray(v.repeats) || v.repeats.length > 64 || v.repeats.some(r => !r || Object.keys(r).length !== 3 || !hash(r.fingerprint) || !integer(r.epoch) || !integer(r.count)) ||
    !Array.isArray(v.sources) || v.sources.length > 32 || v.sources.some(r => !r || Object.keys(r).length !== 2 || !hash(r.source) || !hash(r.digest)) ||
    !Array.isArray(v.elements) || v.elements.length > 200 || v.elements.some(r => !r || Object.keys(r).length !== 2 || typeof r.id !== 'string' || !/^el_[a-f0-9]{32}$/.test(r.id) || !hash(r.fingerprint)) ||
    new Set(v.repeats.map(r => r.fingerprint)).size !== v.repeats.length || new Set(v.sources.map(r => r.source)).size !== v.sources.length ||
    new Set(v.elements.map(r => r.id)).size !== v.elements.length) return null
  const p = v.pending
  if (p !== null && (!p || Object.keys(p).length !== 3 || typeof p.stepId !== 'string' || !p.stepId || p.stepId.length > 512 ||
    p.fingerprint !== null && !hash(p.fingerprint) || !integer(p.repeat))) return null
  return structuredClone(v)
}
