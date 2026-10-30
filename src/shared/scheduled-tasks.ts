import type { ConversationToolsOwner } from './conversation-tools'

export type TaskSchedule = { kind: 'interval'; minutes: number }
  | { kind: 'cron'; expression: string; timeZone: string }

export interface ScheduledTaskRequest { type: 'scheduled_task'; schedule: TaskSchedule; prompt: string }
export type ScheduledTaskManagementRequest = { type: 'scheduled_task'; action: 'list'; offset: number }
  | { type: 'scheduled_task'; action: 'get'; id: string }
  | { type: 'scheduled_task'; action: 'update'; id: string; revision: number; schedule?: TaskSchedule; prompt?: string }
  | { type: 'scheduled_task'; action: 'delete'; id: string; revision: number }
export type ScheduledTaskToolRequest = ScheduledTaskRequest | ScheduledTaskManagementRequest
export interface ScheduledTaskTarget { machineId: string; transport: 'local' | 'ssh' | 'web2term'; key: string; cwd: string; label: string }
export interface ScheduledTask extends ScheduledTaskRequest {
  id: string
  owner: ConversationToolsOwner & { conversationId: string }
  target: ScheduledTaskTarget
  sourceKey: string
  receiptSubmissionId?: string
  enabled: boolean
  deleted: boolean
  revision: number
  nextRunAt: number
  createdAt: number
  updatedAt: number
}
export type ScheduledRunStatus = 'pending' | 'sending' | 'sent' | 'needs-attention' | 'cancelled' | 'skipped'
export interface ScheduledTaskRun {
  id: string
  taskId: string
  revision: number
  kind: 'task' | 'receipt'
  occurrenceKey: string
  plannedAt: number
  missedSince: number | null
  status: ScheduledRunStatus
  message: string
  text: string
  createdAt: number
  sentAt: number | null
  autonomousTaskId: string | null
}
export interface ScheduledTasksState { tasks: ScheduledTask[]; runs: ScheduledTaskRun[] }
export interface ScheduledToolCall { messageId: string; rawJson: string; conversationId: string; pageEpoch: string; sourceSubmissionId?: string }
export interface ScheduledTaskDraft {
  owner: ConversationToolsOwner
  requestId: string
  id?: string
  revision?: number
  schedule: TaskSchedule
  prompt: string
}
export type ScheduledTaskAction = 'pause' | 'resume' | 'delete' | 'run' | 'skip' | 'confirm-sent'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function parseTaskSchedule(value: unknown): TaskSchedule | null {
  if (!object(value)) return null
  if (value.kind === 'interval' && Object.keys(value).every(key => ['kind', 'minutes'].includes(key)) &&
    Number.isSafeInteger(value.minutes) && Number(value.minutes) >= 1 && Number(value.minutes) <= 5_256_000)
    return { kind: 'interval', minutes: Number(value.minutes) }
  if (value.kind !== 'cron' || Object.keys(value).some(key => !['kind', 'expression', 'timeZone'].includes(key)) ||
    typeof value.expression !== 'string' || value.expression.length > 120 || /\bH\b/i.test(value.expression) || value.expression.trim().split(/\s+/).length !== 5 ||
    typeof value.timeZone !== 'string' || value.timeZone.length > 100) return null
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0) } catch { return null }
  return { kind: 'cron', expression: value.expression.trim(), timeZone: value.timeZone }
}
export function parseScheduledTaskRequest(value: unknown): ScheduledTaskRequest | null {
  if (!object(value) || value.type !== 'scheduled_task' || Object.keys(value).some(key => !['type', 'schedule', 'prompt'].includes(key)) ||
    typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16_000 || value.prompt.includes('\0')) return null
  const schedule = parseTaskSchedule(value.schedule)
  return schedule ? { type: 'scheduled_task', schedule, prompt: value.prompt.trim() } : null
}
export function parseScheduledTaskToolRequest(value: unknown): ScheduledTaskToolRequest | null {
  if (!object(value) || value.type !== 'scheduled_task') return null
  if (value.action === undefined) return parseScheduledTaskRequest(value)
  const { action, ...rest } = value
  if (action === 'create') return parseScheduledTaskRequest(rest)
  if (action === 'list') {
    const offset = value.offset === undefined ? 0 : value.offset
    return Object.keys(value).every(key => ['type', 'action', 'offset'].includes(key)) &&
      Number.isSafeInteger(offset) && Number(offset) >= 0 && Number(offset) <= 1_000_000
      ? { type: 'scheduled_task', action, offset: Number(offset) } : null
  }
  if (typeof action !== 'string' || !['get', 'update', 'delete'].includes(action) || typeof value.id !== 'string' ||
    !/^[\w-]{1,128}$/.test(value.id)) return null
  if (action === 'get') return Object.keys(value).every(key => ['type', 'action', 'id'].includes(key))
    ? { type: 'scheduled_task', action, id: value.id } : null
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null
  if (action === 'delete') return Object.keys(value).every(key => ['type', 'action', 'id', 'revision'].includes(key))
    ? { type: 'scheduled_task', action, id: value.id, revision: Number(value.revision) } : null
  if (Object.keys(value).some(key => !['type', 'action', 'id', 'revision', 'schedule', 'prompt'].includes(key)) ||
    !Object.hasOwn(value, 'schedule') && !Object.hasOwn(value, 'prompt')) return null
  const schedule = Object.hasOwn(value, 'schedule') ? parseTaskSchedule(value.schedule) : undefined
  if (schedule === null || Object.hasOwn(value, 'prompt') && (typeof value.prompt !== 'string' ||
    !value.prompt.trim() || value.prompt.length > 16_000 || value.prompt.includes('\0'))) return null
  return { type: 'scheduled_task', action: 'update', id: value.id, revision: Number(value.revision),
    ...(schedule ? { schedule } : {}), ...(typeof value.prompt === 'string' ? { prompt: value.prompt.trim() } : {}) }
}
export function scheduleLabel(schedule: TaskSchedule): string {
  return schedule.kind === 'interval' ? `每 ${schedule.minutes} 分钟` : `${schedule.expression} · ${schedule.timeZone}`
}
export const scheduledTaskToolPrompt = [
  '【工具：scheduled_task】',
  '按用户要求创建、查询、修改或删除当前对话的周期计划，到期向绑定的 AI 对话提交 prompt。会话、平台、主机和目录由软件绑定，创建时不立即执行。',
  '',
  '仅输出一个 JSON 代码块：',
  '```json',
  '{"type":"scheduled_task","schedule":{"kind":"interval","minutes":30},"prompt":"检查当前项目的后台服务状态，发现异常时分析原因。"}',
  '```',
  '',
  '创建时只传 type、schedule、prompt（也可加 action:"create"）；prompt 为非空自然语言任务，最多 16000 字符，写清每次需要完成的事。',
  '固定间隔：minutes 为 1–5256000 的整数，首次在保存满一个周期后触发。',
  '日历周期：schedule 用 {"kind":"cron","expression":"0 9 * * 1-5","timeZone":"Asia/Shanghai"}；expression 为五段 Cron，不含秒或 H，timeZone 按实际任务填写有效的 IANA 时区。',
  '应用须运行，选中绑定会话并恢复原执行环境后投递；忙碌、草稿或暂停时排队，错过多次合并一次。',
  '',
  '管理已有计划时，每次单独输出一个 JSON 代码块，不能与创建或其他工具混用：',
  '查询当前对话的计划：{"type":"scheduled_task","action":"list"}。每页最多 10 条；结果有 nextOffset 时用 action:"list",offset:nextOffset 继续查询。',
  '读取完整任务：{"type":"scheduled_task","action":"get","id":"软件返回的任务编号"}。列表中的 prompt 可能截断，修改描述前先 get 读取完整内容。',
  '修改：{"type":"scheduled_task","action":"update","id":"软件返回的任务编号","revision":1,"prompt":"修改后的完整任务描述"}。schedule 和 prompt 至少提供一个；未提供的字段保留。可同时修改周期和描述。',
  '删除：{"type":"scheduled_task","action":"delete","id":"软件返回的任务编号","revision":1}。',
  'id 和 revision 必须使用查询或软件回执中的真实值；版本冲突时重新查询，不猜测编号和版本。只能管理当前工作区、平台、对话的计划，不能覆盖执行主机、目录和归属。',
  '用户要求修改或删除已有计划时，先查找原计划并操作原编号，不要删除重建或重复创建；存在多个匹配时先向用户澄清。',
  '修改后从保存时重新计算下次时间，暂停状态保留；删除后停止后续投递，已经发出的消息或正在执行的工作不会自动撤销。',
  '收到软件实际操作回执后再确认成功；回执不确定时先查询状态，不重复变更。勿编写等待或调度脚本。用户也可在「定时任务」页管理计划。'
].join('\n')
