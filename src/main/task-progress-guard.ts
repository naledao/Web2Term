import { createHash } from 'node:crypto'
import { normalizeComputerProgressLimits, PROGRESS_STOP_MESSAGES } from '../shared/computer-progress'
import type { ComputerProgressState, ComputerProgressReport, ComputerProgressLimits, ProgressStopReason } from '../shared/computer-progress'
import type { AutonomousTask } from '../shared/autonomous-task'
import type { TaskContinuity } from '../shared/autonomous-task'
import type { ComputerUseToolCall, ComputerUseToolResult } from '../shared/computer-use'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')
const readOnly = new Set(['list_apps', 'list_windows', 'observe', 'validate_observation', 'inspect_interactions', 'wait_for', 'complete_task'])

export function createProgressState(limits?: ComputerProgressLimits): ComputerProgressState {
  return { version: 1, limits: normalizeComputerProgressLimits(limits), elapsedMs: 0, steps: 0, epoch: 0, unchangedObservations: 0,
    consecutiveTimeouts: 0, recovering: false, recoverySteps: 0, halted: null, repeats: [], sources: [], latestTarget: null, elements: [], pending: null }
}
function fingerprint(task: AutonomousTask, state: ComputerProgressState, call: ComputerUseToolCall): string {
  const parameters = { ...call.parameters }
  delete parameters.observation_id // New observation UUIDs do not establish new state.
  if (typeof parameters.window_id === 'string') parameters.window_id = task.continuity?.windows.find(w => w.windowId === parameters.window_id)?.key ?? state.latestTarget ?? parameters.window_id
  if (typeof parameters.element_id === 'string') parameters.element_id = state.elements.find(e => e.id === parameters.element_id)?.fingerprint ?? parameters.element_id
  if (typeof parameters.app_id === 'string') {
    const app = task.continuity?.apps.find(a => a.appId === parameters.app_id)
    if (app) { parameters.app_id = hash([app.executablePath, app.name]); delete parameters.launch_reference_id }
  }
  return hash([call.action, state.latestTarget, parameters])
}
export function inspectProgressAdmission(task: AutonomousTask, state: ComputerProgressState, call?: ComputerUseToolCall) {
  const key = call ? fingerprint(task, state, call) : null
  const old = state.repeats.find(r => r.fingerprint === key && r.epoch === state.epoch)
  const repeat = key ? (old?.count ?? 0) + 1 : 0
  const hard: ProgressStopReason | null = state.halted ?? (state.elapsedMs >= state.limits.taskTimeoutMs ? 'task_timeout'
    : state.steps >= state.limits.maxSteps ? 'step_limit' : state.recovering && state.recoverySteps >= state.limits.maxRecoverySteps ? 'recovery_limit'
      : repeat >= state.limits.maxRepeatedAction ? 'repeated_action' : null)
  return { fingerprint: key, repeat, hard, blocked: !!hard || !!call && !readOnly.has(call.action) && repeat >= 2 }
}
export function admitProgressStep(task: AutonomousTask, state: ComputerProgressState, stepId: string, call?: ComputerUseToolCall): ComputerProgressState {
  const next = structuredClone(state), admission = inspectProgressAdmission(task, next, call)
  next.steps++; if (next.recovering) next.recoverySteps++
  if (admission.fingerprint) {
    next.repeats = next.repeats.filter(r => r.fingerprint !== admission.fingerprint)
    next.repeats.push({ fingerprint: admission.fingerprint, epoch: next.epoch, count: admission.repeat })
    if (next.repeats.length > 64) next.repeats.shift()
  }
  next.pending = { stepId, ...admission }
  return next
}

/** Hash semantic evidence only. UUIDs, timestamps, tokens and delivery events are not progress. */
function evidence(result: ComputerUseToolResult): { source: string; digest: string; target: string | null; elements: ComputerProgressState['elements'] } | null {
  if (!object(result.data)) return null
  const d = result.data, o = object(d.observation) ? d.observation : object(d.refreshed_observation) ? d.refreshed_observation
    : result.action === 'observe' && result.ok ? d : null
  if (o && typeof o.observation_id === 'string' && /^obs_[a-f0-9]{32}$/.test(o.observation_id)) {
    const controls = object(o.controls) ? o.controls : null
    const native = object(o.window_identity) ? o.window_identity : controls && object(controls.window_identity) ? controls.window_identity : null
    const target = native ? hash([native.hwnd, native.pid, native.process_started_at, native.thread_id, native.class_name]) : null
    const rows = controls && Array.isArray(controls.elements) ? controls.elements.slice(0, 200).filter(object) : []
    const entries = rows.map(r => ({ id: r.element_id, value: [r.role, r.name, r.bounds, r.enabled, r.focused, r.offscreen, r.patterns] }))
    const image = object(o.image) && typeof o.image.sha256 === 'string' && /^[a-f0-9]{64}$/.test(o.image.sha256) ? o.image.sha256 : null
    if (!image && !controls) return null
    return { source: hash(['observe', target ?? o.monitor_id ?? null, o.target, o.crop ?? null]),
      digest: hash([image, entries.map(r => r.value), controls?.complete, o.source_bounds]), target,
      elements: entries.filter(r => typeof r.id === 'string' && /^el_[a-f0-9]{32}$/.test(r.id)).map(r => ({ id: r.id as string, fingerprint: hash(r.value) })) }
  }
  if (result.ok && (result.action === 'list_apps' && Array.isArray(d.apps) || result.action === 'list_windows' && Array.isArray(d.windows))) {
    const rows = (result.action === 'list_apps' ? d.apps : d.windows) as unknown[]
    const values = rows.filter(object).map(r => result.action === 'list_apps' ? [r.name, r.executable_path, r.app_user_model_id]
      : [r.hwnd, r.pid, r.process_started_at, r.thread_id, r.class_name, r.title, r.visible, r.minimized, r.bounds])
    return { source: hash([result.action, d.query ?? null, d.pid ?? null]), digest: hash(values.map(v => JSON.stringify(v)).sort()), target: null, elements: [] }
  }
  return null
}
export function recordProgressResult(state: ComputerProgressState, stepId: string, result: ComputerUseToolResult, actionTimedOut = false): { state: ComputerProgressState; report: ComputerProgressReport } {
  const next = structuredClone(state), p = next.pending?.stepId === stepId ? next.pending : null
  const timeout = actionTimedOut || result.code === 'wait_timeout' || object(result.data) && result.data.helper_code === 'action_timeout'
  if (timeout) next.consecutiveTimeouts++
  else if (result.ok && result.execution === 'executed') next.consecutiveTimeouts = 0
  const seen = evidence(result)
  let changed = false
  if (seen) {
    const previous = next.sources.find(r => r.source === seen.source)
    changed = !previous || previous.digest !== seen.digest
    next.unchangedObservations = changed ? 0 : next.unchangedObservations + 1
    if (changed) { next.epoch++; next.recovering = false; next.recoverySteps = 0 }
    next.sources = next.sources.filter(r => r.source !== seen.source)
    next.sources.push({ source: seen.source, digest: seen.digest }); if (next.sources.length > 32) next.sources.shift()
    if (seen.target) { next.latestTarget = seen.target; next.elements = seen.elements }
  }
  const signals: string[] = []
  if (p && p.repeat >= 2 && !changed) signals.push('repeated_action')
  if (next.unchangedObservations >= Math.max(1, next.limits.maxUnchangedObservations - 1)) signals.push('unchanged_observations')
  if (timeout) signals.push('action_timeout')
  if (!result.ok || result.diagnosis || signals.length) next.recovering = true
  next.halted = next.halted ?? p?.hard ?? (next.elapsedMs >= next.limits.taskTimeoutMs ? 'task_timeout'
    : next.steps >= next.limits.maxSteps ? 'step_limit' : next.unchangedObservations >= next.limits.maxUnchangedObservations ? 'unchanged_observations'
    : next.consecutiveTimeouts >= next.limits.maxConsecutiveTimeouts ? 'consecutive_timeouts'
      : next.recovering && next.recoverySteps >= next.limits.maxRecoverySteps ? 'recovery_limit' : null)
  const reason = next.halted
  const report: ComputerProgressReport = { version: 1, steps: next.steps, elapsed_ms: next.elapsedMs, repeated_action_count: p?.repeat ?? 0,
    unchanged_observations: next.unchangedObservations, consecutive_timeouts: next.consecutiveTimeouts, recovery_steps: next.recoverySteps,
    action_timed_out: timeout, signals, halted: !!reason, stop_reason: reason,
    guidance: reason ? PROGRESS_STOP_MESSAGES[reason] : p?.blocked ? '没有新的状态变化证据，本次重复输入未派发；请先核对后状态或选择不同方法，不盲目点击、发送、保存或启动。'
      : signals.length ? '发现重复、相同状态或超时信号，请基于真实结果重新诊断，必要时换路径；新令牌或新观察编号不证明取得进展。'
        : '仅记录可观察变化与执行预算，不据此判定业务目标完成。', goal_verified: false }
  next.pending = null
  return { state: next, report }
}

/** Successful source-file snapshots may establish changed evidence; shell exit code alone cannot. */
export function recordFileEvidence(state: ComputerProgressState, continuity: TaskContinuity, stepId: string): ComputerProgressState {
  const next = structuredClone(state)
  let changed = false
  for (const file of continuity.resources) {
    if (file.stepId !== stepId || file.evidence !== 'read-snapshot' || !file.sha256) continue
    const source = hash(['file', file.target]), digest = hash([file.sha256, file.sizeBytes])
    const previous = next.sources.find(row => row.source === source)
    if (!previous || previous.digest !== digest) changed = true
    next.sources = next.sources.filter(row => row.source !== source)
    next.sources.push({ source, digest }); if (next.sources.length > 32) next.sources.shift()
  }
  if (changed && !next.halted) { next.epoch++; next.unchangedObservations = 0; next.recovering = false; next.recoverySteps = 0 }
  return next
}
