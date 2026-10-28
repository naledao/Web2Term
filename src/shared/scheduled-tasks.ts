import type { ConversationToolsOwner } from './conversation-tools'

export type TaskSchedule = { kind: 'interval'; minutes: number }
  | { kind: 'cron'; expression: string; timeZone: string }

export interface ScheduledTaskRequest { type: 'scheduled_task'; schedule: TaskSchedule; prompt: string }
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
export function scheduleLabel(schedule: TaskSchedule): string {
  return schedule.kind === 'interval' ? `每 ${schedule.minutes} 分钟` : `${schedule.expression} · ${schedule.timeZone}`
}
export const scheduledTaskToolPrompt = [
  '【工具：scheduled_task】',
  '用户要求周期性执行任务时，创建定时计划。只提供周期 schedule 和自然语言任务 prompt；会话、平台、主机和目录由软件绑定。创建时不立即执行。',
  '```json',
  '{"type":"scheduled_task","schedule":{"kind":"interval","minutes":30},"prompt":"检查当前项目的后台服务状态，发现异常时分析原因。"}',
  '```',
  '固定间隔 minutes 为至少 1 的整数；日历周期使用 {"kind":"cron","expression":"0 9 * * 1-5","timeZone":"Asia/Shanghai"}，expression 为五段 Cron。不要自行编写等待或调度脚本。',
  '软件确认已保存并返回任务编号、周期和下次时间后，简短确认；不要重复创建。应用需保持运行；原会话忙碌、未选中、存在草稿或已暂停时排队，错过多次合并一次。可在「定时任务」页管理计划。'
].join('\n')
