import type { ComputerUseActionDefinition } from './computer-use'

/** Facts issued by the main process. A model's assessment is stored separately. */
export interface TaskEvidence {
  id: string
  stepId: string
  stepNumber: number
  revision: number
  recordedAt: number
  delivered: boolean
  kind: 'file' | 'observation' | 'background' | 'command'
  target: string
  sha256: string | null
  sizeBytes: number | null
  facts: string
}
export interface TaskRequirementCheck {
  input_id: string
  checks: Array<{ criterion: string; evidence_ids: string[]; status: 'passed' | 'failed' | 'unconfirmed'; assessment: string }>
}
export interface TaskCompletionClaim {
  summary: string
  requirements: TaskRequirementCheck[]
  artifacts: Array<{ evidence_id: string; label: string }>
  no_artifact_reason: string
  unconfirmed: string[]
  superseded_backgrounds?: Array<{ background_id: string; evidence_ids: string[]; reason: string }>
}
export interface TaskCompletionReport {
  version: 1
  stepId: string
  state: 'rejected' | 'ready' | 'delivered'
  checkedAt: number
  summary: string
  requirements: TaskRequirementCheck[]
  artifacts: Array<{ evidenceId: string; label: string; path: string; sizeBytes: number; sha256: string }>
  noArtifactReason: string
  unconfirmed: string[]
  blockers: string[]
  /** Goal semantics are assessed by the model against actual tool evidence. */
  basis: 'model-assessment-with-tool-evidence'
  backgroundResolutions: Array<{ background_id: string; evidence_ids: string[]; reason: string }>
}
export interface TaskCompletionState {
  version: 1
  revision: number
  evidence: TaskEvidence[]
  report: TaskCompletionReport | null
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const text = (v: unknown, max = 2000, empty = false): v is string => typeof v === 'string' && (empty || !!v.trim()) && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const evidenceId = (v: unknown): v is string => typeof v === 'string' && /^ev_[a-f0-9]{32}$/.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => text(s))
function requirements(v: unknown): v is TaskRequirementCheck[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(r => object(r) && exact(r, ['input_id', 'checks']) && text(r.input_id, 512) &&
    Array.isArray(r.checks) && r.checks.length > 0 && r.checks.length <= 16 && r.checks.every(c => object(c) && exact(c, ['criterion', 'evidence_ids', 'status', 'assessment']) &&
      text(c.criterion, 1000) && text(c.assessment) && ['passed', 'failed', 'unconfirmed'].includes(c.status as string) && Array.isArray(c.evidence_ids) && c.evidence_ids.length > 0 &&
      c.evidence_ids.length <= 8 && c.evidence_ids.every(evidenceId) && new Set(c.evidence_ids).size === c.evidence_ids.length)) &&
    new Set(v.map(r => r.input_id)).size === v.length
}
const resolutions = (v: unknown): boolean => Array.isArray(v) && v.length <= 32 && v.every(r => object(r) && exact(r, ['background_id', 'evidence_ids', 'reason']) &&
  text(r.background_id, 512) && text(r.reason, 1000) && Array.isArray(r.evidence_ids) && r.evidence_ids.length > 0 && r.evidence_ids.length <= 8 && r.evidence_ids.every(evidenceId) &&
  new Set(r.evidence_ids).size === r.evidence_ids.length) && new Set(v.map(r => r.background_id)).size === v.length
export function parseTaskCompletionClaim(v: unknown): TaskCompletionClaim | null {
  if (!object(v) || !exact(v, ['summary', 'requirements', 'artifacts', 'no_artifact_reason', 'unconfirmed', ...(Object.hasOwn(v, 'superseded_backgrounds') ? ['superseded_backgrounds'] : [])]) || !text(v.summary) || !requirements(v.requirements) ||
    !Array.isArray(v.artifacts) || v.artifacts.length > 32 || !v.artifacts.every(a => object(a) && exact(a, ['evidence_id', 'label']) && evidenceId(a.evidence_id) && text(a.label, 200)) ||
    new Set(v.artifacts.map(a => a.evidence_id)).size !== v.artifacts.length || !text(v.no_artifact_reason, 1000, v.artifacts.length > 0) || !strings(v.unconfirmed, 32) || (v.superseded_backgrounds !== undefined && !resolutions(v.superseded_backgrounds)) || JSON.stringify(v).length > 60_000) return null
  return structuredClone(v) as unknown as TaskCompletionClaim
}
export function parseTaskCompletionState(v: unknown): TaskCompletionState | null {
  if (!object(v) || !exact(v, ['version', 'revision', 'evidence', 'report']) || v.version !== 1 || !integer(v.revision) || !Array.isArray(v.evidence) || v.evidence.length > 128 ||
    !v.evidence.every(e => object(e) && exact(e, ['id', 'stepId', 'stepNumber', 'revision', 'recordedAt', 'delivered', 'kind', 'target', 'sha256', 'sizeBytes', 'facts']) &&
      evidenceId(e.id) && text(e.stepId, 512) && integer(e.stepNumber) && integer(e.revision) && e.revision <= Number(v.revision) && integer(e.recordedAt) && typeof e.delivered === 'boolean' &&
      ['file', 'observation', 'background', 'command'].includes(e.kind as string) && text(e.target, 4096) && text(e.facts, 6000) &&
      (e.sha256 === null || hash(e.sha256)) && (e.sizeBytes === null || integer(e.sizeBytes) && e.sizeBytes > 0 && e.sizeBytes <= 20 * 1024 * 1024) &&
      (e.kind !== 'file' || hash(e.sha256) && e.sizeBytes !== null)) || new Set(v.evidence.map(e => e.id)).size !== v.evidence.length) return null
  if (v.report !== null) {
    const r = v.report
    if (!object(r) || !exact(r, ['version', 'stepId', 'state', 'checkedAt', 'summary', 'requirements', 'artifacts', 'noArtifactReason', 'unconfirmed', 'blockers', 'basis', 'backgroundResolutions']) ||
      r.version !== 1 || !text(r.stepId, 512) || !['rejected', 'ready', 'delivered'].includes(r.state as string) || !integer(r.checkedAt) || !text(r.summary) || !requirements(r.requirements) ||
      !text(r.noArtifactReason, 1000, true) || !strings(r.unconfirmed, 32) || !strings(r.blockers, 128) || r.basis !== 'model-assessment-with-tool-evidence' || !resolutions(r.backgroundResolutions) ||
      !Array.isArray(r.artifacts) || r.artifacts.length > 32 || !r.artifacts.every(a => object(a) && exact(a, ['evidenceId', 'label', 'path', 'sizeBytes', 'sha256']) &&
        evidenceId(a.evidenceId) && text(a.label, 200) && text(a.path, 4096) && hash(a.sha256) && integer(a.sizeBytes) && a.sizeBytes > 0 && a.sizeBytes <= 20 * 1024 * 1024) ||
      new Set(r.artifacts.map(a => a.evidenceId)).size !== r.artifacts.length ||
      (r.state !== 'rejected' && (r.blockers.length || r.unconfirmed.length || r.requirements.some(q => q.checks.some(c => c.status !== 'passed'))))) return null
  }
  const parsed = v as unknown as TaskCompletionState
  if (parsed.report && parsed.report.state !== 'rejected') {
    if (!parsed.report.artifacts.length && !parsed.report.noArtifactReason.trim()) return null
    if (parsed.report.backgroundResolutions.some(r => r.evidence_ids.some(id => !parsed.report!.requirements.some(q => q.checks.some(c => c.evidence_ids.includes(id)))))) return null
    if (parsed.report.requirements.some(r => r.checks.some(c => c.evidence_ids.some(id => !parsed.evidence.some(e => e.id === id && e.delivered))))) return null
    if (parsed.report.artifacts.some(a => !parsed.evidence.some(e => e.id === a.evidenceId && e.delivered && e.kind === 'file' && e.target === a.path && e.sha256 === a.sha256 && e.sizeBytes === a.sizeBytes))) return null
  }
  return structuredClone(v) as unknown as TaskCompletionState
}
export const COMPLETE_TASK_ACTION: ComputerUseActionDefinition = {
  action: 'complete_task', description: '可选的详细结果核对和产物交付。逐项对应 task_completion_context.inputs 中的所有原始／补充要求，引用主进程证据编号。文件须先 read_files 回读内容；界面须观察真实后状态；纯终端任务可引用实际输出及校验结果，不能只依据退出码。模型负责语义核对，主进程检查本报告的事实、文件快照、归属和未决依赖。也可直接以“【任务完成】”开头回复来结束任务，无需先调用本动作。',
  parameters: [
    { name: 'summary', type: 'string', required: true, minLength: 1, maxLength: 2000, description: '具体完成结果，不能只写已完成。' },
    { name: 'requirements', type: 'array', required: true, maxItems: 64, description: '每项 {input_id,checks:[{criterion,evidence_ids,status,assessment}]}；status 为 passed／failed／unconfirmed，每条检查引用 1～8 个实际证据编号并说明如何满足要求。覆盖全部输入，不能遗漏约束。' },
    { name: 'artifacts', type: 'array', required: true, maxItems: 32, description: '实际文件交付 [{evidence_id,label}]，仅引用文件回读证据，路径由主进程填写；不得用截图上传地址代替产物。' },
    { name: 'no_artifact_reason', type: 'string', required: true, maxLength: 1000, description: '无文件交付时说明目标为何无需文件；有产物时可为空。' },
    { name: 'superseded_backgrounds', type: 'array', required: false, maxItems: 32, description: '换路径后不再需要的已结束失败后台作业：[{background_id,evidence_ids,reason}]，引用当前已交付的替代成功证据并说明目标如何满足；不能忽略仍在运行、退出未知或交付未确认的任务。' },
    { name: 'unconfirmed', type: 'array', required: true, maxItems: 32, description: '未确认事项字符串数组；存在未确认事项时保存部分结果并返回待处理原因，不标记成功。' }
  ],
  example: { summary: '报告已保存并回读核对内容。', requirements: [{ input_id: '原输入编号', checks: [{ criterion: '报告内容和保存位置满足用户要求', evidence_ids: ['ev_' + '1'.repeat(32)], status: 'passed', assessment: '已核对回读附件中的标题与正文。' }] }], artifacts: [{ evidence_id: 'ev_' + '1'.repeat(32), label: '最终报告' }], no_artifact_reason: '', unconfirmed: [] }
}
