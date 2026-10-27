import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AutonomousTask, TaskContinuity, TaskToolEvent } from '../shared/autonomous-task'
import type { ComputerUseToolResult } from '../shared/computer-use'
import type { BackgroundTask } from '../shared/background-tasks'
import type { TaskCompletionClaim, TaskCompletionReport, TaskCompletionState, TaskEvidence } from '../shared/task-completion'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const readonly = new Set(['list_apps', 'list_windows', 'observe', 'validate_observation', 'inspect_interactions', 'wait_for', 'focus_window', 'complete_task'])
function evidenceWindowScope(e: TaskEvidence): { key: string; pid: number; alias: string | null } | null {
  if (e.kind !== 'observation') return null
  try {
    const facts = JSON.parse(e.facts), w = facts.window_identity
    if (!object(w) || !['hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name'].every(k => w[k] !== undefined && w[k] !== null)) return null
    if (!Number.isSafeInteger(w.pid) || Number(w.pid) < 1) return null
    return { key: createHash('sha256').update(JSON.stringify([w.hwnd, w.pid, w.process_started_at, w.thread_id, w.class_name])).digest('hex'),
      pid: Number(w.pid), alias: typeof facts.controls_observation_id === 'string' ? facts.controls_observation_id : null }
  } catch { return null }
}
export function completionState(task: AutonomousTask): TaskCompletionState {
  return structuredClone(task.completion ?? { version: 1, revision: 0, evidence: [], report: null })
}
export function advanceCompletion(task: AutonomousTask, action: string, observationId?: string): TaskCompletionState {
  const state = completionState(task)
  if (action !== 'read_files' && !readonly.has(action)) {
    const previous = state.revision++
    // Derive scope from this actual request's delivered observation, never a last-window hint:
    // a later desktop click can hit another app, and controls aliases may have no scoped fact.
    const source = observationId ? state.evidence.find(e => e.kind === 'observation' && e.delivered && (e.target === observationId || evidenceWindowScope(e)?.alias === observationId)) : undefined
    const target = source ? evidenceWindowScope(source) : null
    if (target && ['click', 'type_text', 'press_key', 'scroll', 'drag'].includes(action)) {
      for (const e of state.evidence) {
        const scope = evidenceWindowScope(e)
        // Same-process windows can be two views of one document. Preserve only another
        // process's current window facts; unknown commands/open/desktop scopes invalidate all.
        if (e.revision === previous && scope && scope.key !== target.key && scope.pid !== target.pid) e.revision = state.revision
      }
    }
  }
  state.report = null
  return state
}
function add(task: AutonomousTask, state: TaskCompletionState, stepId: string, entry: Pick<TaskEvidence, 'kind' | 'target' | 'sha256' | 'sizeBytes' | 'facts'>, at: number): void {
  const id = 'ev_' + createHash('sha256').update(JSON.stringify([task.id, task.generation, stepId, entry.kind, entry.target])).digest('hex').slice(0, 32)
  if (state.evidence.some(e => e.id === id)) return
  state.evidence.push({ id, stepId, stepNumber: task.progress!.stepCount, revision: state.revision, recordedAt: at, delivered: false, ...entry })
  if (state.evidence.length > 128) state.evidence.shift()
}
export function captureCompletionResult(task: AutonomousTask, result: ComputerUseToolResult, stepId: string, at: number): TaskCompletionState {
  const state = completionState(task), data = result.data
  if (!object(data) || result.execution === 'not_executed') return state
  // Only a real validated observation is evidence. A dispatch or upload receipt is not.
  const observed = result.action === 'observe' && result.ok ? data : object(data.observation) ? data.observation : object(data.refreshed_observation) ? data.refreshed_observation : null
  if (observed && typeof observed.observation_id === 'string' && /^obs_[a-f0-9]{32}$/.test(observed.observation_id) && (observed.geometry_consistent === true || observed.target === 'controls') &&
    (object(observed.image) && hash(observed.image.sha256) || object(observed.controls))) {
    const controls = object(observed.controls) ? observed.controls : null
    add(task, state, stepId, { kind: 'observation', target: observed.observation_id, sha256: object(observed.image) && hash(observed.image.sha256) ? observed.image.sha256 : null, sizeBytes: null,
        facts: JSON.stringify({ observation_id: observed.observation_id, target: observed.target, window_id: observed.window_id, window_identity: observed.window_identity ?? controls?.window_identity,
        image_sha256: object(observed.image) ? observed.image.sha256 : null, controls_observation_id: controls?.observation_id ?? null, controls_status: controls?.status ?? null,
        controls_complete: controls?.complete ?? null, limitations: controls?.limitations ?? [],
        basis: '已采集的真实后状态；具体业务含义由模型结合本次图像／控件判断' }).slice(0, 6000) }, at)
  }
  if (result.action === 'wait_for' && result.ok && data.condition_met === true && typeof data.background_id === 'string')
    add(task, state, stepId, { kind: 'background', target: data.background_id, sha256: null, sizeBytes: null,
      facts: JSON.stringify({ background_id: data.background_id, condition: data.condition, status: data.status, result_settled: data.result_settled,
        exit_code: data.exit_code, service_state: data.service_state, checked_at: data.checked_at, goal_verified: false }) }, at)
  return state
}
export function captureCompletionFiles(task: AutonomousTask, continuity: TaskContinuity, stepId: string, at: number): TaskCompletionState {
  const state = completionState(task)
  for (const r of continuity.resources) if (r.stepId === stepId && r.evidence === 'read-snapshot' && r.kind === 'file' && r.sha256 && r.sizeBytes)
    add(task, state, stepId, { kind: 'file', target: r.target, sha256: r.sha256, sizeBytes: r.sizeBytes,
      facts: '原文件快照已读取；交付确认后可供模型核对附件内容。散列和大小只证明字节，不证明内容满足目标。' }, at)
  return state
}
export function captureCompletionCommand(task: AutonomousTask, stepId: string, result: NonNullable<TaskToolEvent['commandResult']>, at: number): TaskCompletionState {
  const state = completionState(task)
  if (result.exitCode !== 0 || result.timedOut || result.interrupted || result.rejected || result.sessionLost || typeof result.output !== 'string' || !result.output.trim()) return state
  const digest = createHash('sha256').update(result.output).digest('hex')
  add(task, state, stepId, { kind: 'command', target: stepId, sha256: digest, sizeBytes: null,
    facts: JSON.stringify({ exit_code: result.exitCode, output_excerpt: result.output.slice(0, 800), output_truncated: result.output.length > 800,
      output_sha256: digest, basis: '实际命令输出；由模型核对输出中的校验结果，退出码 0 本身不证明业务完成' }) }, at)
  return state
}
export function completionContext(task: AutonomousTask): unknown {
  const report = task.completion?.report
  const context = { inputs: task.inputs.slice(0, 64).map(i => ({ input_id: i.id, kind: i.kind, text_excerpt: i.text.slice(0, 256), text_truncated: i.text.length > 256 })),
    input_count: task.inputs.length, inputs_truncated: task.inputs.length > 64,
    evidence: task.completion?.evidence.slice(-32) ?? [], evidence_truncated: (task.completion?.evidence.length ?? 0) > 32,
    last_report: report ? { state: report.state, summary: report.summary, blockers: report.blockers.slice(0, 8), artifact_count: report.artifacts.length } : null,
    current_revision: task.completion?.revision ?? 0, goal_verified: task.status === 'completed',
    guidance: '以“【任务完成】”开头回复即可结束任务并提示用户，complete_task 是可选的详细核对入口。若选择提交核对报告，须逐项对应所有输入，细分内容、位置和约束条件，引用实际证据。原始要求与补充要求以原对话完整内容为准，摘录有裁剪标记。刚回传的证据在发送确认后生效；文件核对附件内容，界面核对最后一次操作后的观察。报告不能以退出码 0、输入派发或上传成功代替业务验证。' }
  while (JSON.stringify(context).length > 48_000 && context.evidence.length > 1) { context.evidence.shift(); context.evidence_truncated = true }
  if (JSON.stringify(context).length > 48_000) for (const input of context.inputs) { input.text_excerpt = ''; input.text_truncated = true }
  return context
}
export function completionBackgroundBlockers(task: AutonomousTask, tasks: readonly BackgroundTask[], resolutions = task.completion?.report?.backgroundResolutions ?? []): string[] {
  const blockers: string[] = [], latest = new Map<string, NonNullable<AutonomousTask['backgroundDependencies']>[number]>()
  const owned = tasks.filter(bg => { const c = bg.taskContext; return !!c && c.sessionId === task.sessionId && c.platformId === task.platformId && c.conversationId === task.conversationId && c.taskId === task.id && c.generation === task.generation && c.machine.id === task.machine.id })
  const superseded = new Set<string>()
  for (const r of resolutions) {
    const bg = owned.find(bg => bg.id === r.background_id)
    const confirmed = bg && bg.resultSettled === true && ['failed', 'exited', 'stopped'].includes(bg.status) && ['sent', 'superseded'].includes(bg.deliveryStatus ?? '') &&
      r.evidence_ids.length > 0 && r.evidence_ids.every(id => task.completion?.evidence.some(e => e.id === id && e.delivered && e.kind !== 'background'))
    if (confirmed) superseded.add(r.background_id)
    else blockers.push(`后台替代说明 ${r.background_id} 缺少已结束事实、已交付结果或替代证据，不能忽略该任务。`)
  }
  for (const dep of task.backgroundDependencies ?? []) latest.set(dep.backgroundId + ':' + dep.condition, dep)
  for (const d of latest.values()) if (d.state !== 'satisfied' && !superseded.has(d.backgroundId)) blockers.push(`后台依赖 ${d.backgroundId} 的 ${d.condition} 尚未满足（${d.state}）。`)
  for (const bg of owned) {
    if (superseded.has(bg.id)) continue
    const ready = bg.backgroundOptions?.kind === 'service' && bg.status === 'running' && bg.startup?.state === 'ready' && bg.startup.readyAt !== undefined
    if (!ready && !(bg.status === 'completed' && bg.resultSettled && bg.exitCode === 0)) blockers.push(`后台任务 ${bg.id} 尚无可确认的成功结果／服务就绪状态（${bg.status}）。`)
    const delivery = ready ? bg.readinessDeliveryStatus : bg.deliveryStatus
    const waited = task.completion?.evidence.some(e => e.kind === 'background' && e.target === bg.id && e.delivered && (() => {
      try { const f = JSON.parse(e.facts); return f.condition === (ready ? 'background_ready' : 'background_finished') } catch { return false }
    })())
    if (delivery !== 'sent' && !(delivery === 'superseded' && waited)) blockers.push(`后台任务 ${bg.id} 的必要结果尚未确认交付（${delivery ?? 'unknown'}）。`)
  }
  return blockers
}
/** Recheck only an already read source. This never executes a command or opens an app. */
export async function recheckCompletionFile(e: TaskEvidence, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || e.kind !== 'file' || !e.sha256 || !e.sizeBytes || /\.(crdownload|part|partial|download|tmp)$/i.test(e.target)) return false
  const before = await lstat(e.target)
  if (!before.isFile() || before.isSymbolicLink() || before.size !== e.sizeBytes || before.size > 20 * 1024 * 1024 || resolve(await realpath(e.target)).toLowerCase() !== resolve(e.target).toLowerCase()) return false
  const handle = await open(e.target, 'r')
  try {
    const start = await handle.stat()
    if (!start.isFile() || start.size !== e.sizeBytes || signal?.aborted) return false
    const bytes = Buffer.alloc(start.size + 1)
    let offset = 0
    while (offset < bytes.length && !signal?.aborted) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead }
    const end = await handle.stat(), pathNow = await lstat(e.target)
    return !signal?.aborted && offset === start.size && start.size === end.size && start.mtimeMs === end.mtimeMs && start.ctimeMs === end.ctimeMs &&
      start.dev === pathNow.dev && start.ino === pathNow.ino && start.mtimeMs === pathNow.mtimeMs && start.size === pathNow.size && !pathNow.isSymbolicLink() &&
      createHash('sha256').update(bytes.subarray(0, offset)).digest('hex') === e.sha256
  } finally { await handle.close() }
}
export async function assessTaskCompletion(task: AutonomousTask, claim: TaskCompletionClaim, stepId: string, background: readonly BackgroundTask[],
  recheck: (e: TaskEvidence) => Promise<boolean> = recheckCompletionFile, now = Date.now()): Promise<TaskCompletionReport> {
  const state = completionState(task), blockers = completionBackgroundBlockers(task, background, claim.superseded_backgrounds ?? [])
  const block = (message: string): void => { if (!blockers.includes(message) && blockers.length < 128) blockers.push(message) }
  if (task.status !== 'recorded' || task.progress?.currentStep?.id !== stepId || task.progress.currentStep.action !== 'complete_task' || task.progress.currentStep.status !== 'executing') block('完成请求不属于当前正在执行的步骤。')
  if (task.control?.halted) block('任务已达到运行上限，保留未完成状态。')
  if (task.clarifications?.items.some(q => !['answered', 'cancelled'].includes(q.state))) block('必要澄清或任务内授权尚未获得真实回答，不能标记完成。')
  if (task.recovery?.requiresObservation) block('存在未核对的操作后状态，必须先重新观察。')
  const inputIds = new Set(task.inputs.map(i => i.id))
  if (claim.requirements.length !== inputIds.size || claim.requirements.some(r => !inputIds.has(r.input_id))) block('必须逐项覆盖本任务全部原始要求和补充要求。')
  if (claim.unconfirmed.length) block('仍有未确认事项。')
  const referenced = new Set(claim.requirements.flatMap(r => r.checks.flatMap(c => c.evidence_ids)))
  for (const r of claim.requirements) for (const c of r.checks) if (c.status !== 'passed') block(`检查未通过：${c.criterion}`)
  for (const resolution of claim.superseded_backgrounds ?? []) for (const id of resolution.evidence_ids) {
    if (!referenced.has(id)) block(`后台替代证据 ${id} 没有对应的业务检查。`)
    referenced.add(id)
  }
  for (const a of claim.artifacts) { if (!referenced.has(a.evidence_id)) block(`产物 ${a.label} 没有对应的业务内容检查。`); referenced.add(a.evidence_id) }
  const verifiedFiles = new Set<string>()
  for (const id of referenced) {
    const e = state.evidence.find(e => e.id === id)
    if (!e || !e.delivered) { block(`证据 ${id} 不存在于当前任务或尚未确认交付。`); continue }
    if (['observation', 'command'].includes(e.kind) && (e.revision !== state.revision || now < e.recordedAt || now - e.recordedAt > 15 * 60_000)) block(`后状态证据 ${id} 已过时；相关对象发生后续操作或超过证据保留期限，请补充核对。`)
    if (e.kind === 'file') {
      let valid = false
      try { valid = await recheck(e) } catch { /* Missing, locked, replaced or unreadable means unconfirmed. */ }
      if (valid) verifiedFiles.add(id)
      else block(`文件 ${e.target} 缺失、变化、尚未完成下载或无法核对；请重新回读实际文件。`)
    }
    if (e.kind === 'background') {
      const bg = background.find(b => b.id === e.target && b.taskContext?.taskId === task.id && b.taskContext.generation === task.generation && b.taskContext.machine.id === task.machine.id)
      if (!bg) block(`后台证据 ${id} 无当前同归属监视结果。`)
    }
  }
  const artifacts: TaskCompletionReport['artifacts'] = []
  for (const a of claim.artifacts) {
    const e = state.evidence.find(e => e.id === a.evidence_id)
    if (!e || e.kind !== 'file' || !verifiedFiles.has(e.id)) { block(`产物 ${a.label} 不是已核对的实际文件。`); continue }
    artifacts.push({ evidenceId: e.id, label: a.label, path: e.target, sizeBytes: e.sizeBytes!, sha256: e.sha256! })
  }
  const report: TaskCompletionReport = { version: 1, stepId, state: blockers.length ? 'rejected' : 'ready', checkedAt: now, summary: claim.summary,
    requirements: structuredClone(claim.requirements), artifacts, noArtifactReason: claim.no_artifact_reason, unconfirmed: [...claim.unconfirmed], blockers: blockers.slice(0, 128), basis: 'model-assessment-with-tool-evidence', backgroundResolutions: structuredClone(claim.superseded_backgrounds ?? []) }
  if (JSON.stringify(report).length > 128_000) {
    report.state = 'rejected'; report.artifacts = []
    report.blockers = ['完整核对报告超出单次交付预算；产物线索仍保存在任务证据中，请缩短检查说明后重新整理报告。']
  }
  return report
}
