import { parseTaskToolContext } from './autonomous-task'
import type { TaskToolContext } from './autonomous-task'

/** A line printed by the startup command, after it obtained the real child PID. */
export const BACKGROUND_TASK_MARKER = '__W2T_BACKGROUND_TASK__'

export interface BackgroundTaskRegistration {
  pid: number
  name: string
  log_path: string
  stderr_path?: string
  exit_code_path?: string
}

export type BackgroundTaskStatus = 'checking' | 'running' | 'completed' | 'failed' | 'exited' | 'stopped' | 'unknown'
export type BackgroundTaskDeliveryStatus = 'pending' | 'sending' | 'sent' | 'needs-attention' | 'cancelled' | 'superseded'
export type BackgroundTaskNotificationKind = 'created' | 'ready' | 'startup-timeout' | 'finished'
export interface BackgroundReadinessConfig { type: 'auto' | 'tcp' | 'http'; url?: string; port?: number; timeout_seconds?: number }
export interface BackgroundCommandOptions { kind: 'job' | 'service'; readiness?: BackgroundReadinessConfig }
export interface BackgroundStartupState {
  state: 'starting' | 'ready' | 'timeout' | 'failed'
  deadlineAt: number
  readyAt?: number
  url?: string
  evidence?: string
  stdoutOffset: number
  stderrOffset: number
  stdoutCarry: string
  stderrCarry: string
  applicationStarted?: boolean
}

/** Validate both the page protocol and persisted execution options. */
export function parseBackgroundOptions(value: unknown): BackgroundCommandOptions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as BackgroundCommandOptions
  if (!['job', 'service'].includes(item.kind)) return null
  if (item.readiness === undefined) return { kind: item.kind }
  const ready = item.readiness
  if (item.kind !== 'service' || !ready || typeof ready !== 'object' || Array.isArray(ready) || !['auto', 'tcp', 'http'].includes(ready.type)) return null
  if (ready.timeout_seconds !== undefined && (!Number.isInteger(ready.timeout_seconds) || ready.timeout_seconds < 10 || ready.timeout_seconds > 600)) return null
  if (ready.type === 'tcp' && (!Number.isInteger(ready.port) || ready.port! < 1 || ready.port! > 65535)) return null
  if (ready.type !== 'tcp' && ready.port !== undefined) return null
  if (ready.type === 'http') {
    try {
      if (typeof ready.url !== 'string' || ready.url.length > 2048) return null
      const url = new URL(ready.url)
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) return null
    } catch { return null }
  } else if (ready.url !== undefined) return null
  return { kind: item.kind, readiness: { type: ready.type, ...(ready.url ? { url: ready.url } : {}),
    ...(ready.port ? { port: ready.port } : {}), ...(ready.timeout_seconds ? { timeout_seconds: ready.timeout_seconds } : {}) } }
}

export interface BackgroundTask {
  /** Frozen startup provenance. An explicit null is invalid, never a legacy unscoped task. */
  taskContext?: TaskToolContext | null
  /** Live monitor confirmation, not a restart/resume grant. */
  resultSettled?: boolean
  id: string
  name: string
  pid: number
  transport: 'local' | 'ssh' | 'web2term'
  targetLabel: string
  conversationId: string
  command: string
  logPath: string
  stderrPath: string | null
  exitCodePath: string | null
  status: BackgroundTaskStatus
  exitCode: number | null
  createdAt: number
  checkedAt: number | null
  /** A confirmed manual stop request; retained until the observer confirms exit. */
  stopRequestedAt?: number
  /** Ephemeral control state, not restored from disk. */
  stopInProgress?: boolean
  backgroundOptions?: BackgroundCommandOptions
  /** Exact requested startup options, before optional service inference changes monitoring. */
  launchOptions?: BackgroundCommandOptions | null
  startup?: BackgroundStartupState
  readinessDeliveryStatus?: BackgroundTaskDeliveryStatus
  readinessDeliveryMessage?: string
  timeoutDeliveryStatus?: BackgroundTaskDeliveryStatus
  timeoutDeliveryMessage?: string
  message: string
  output: string
  errorOutput: string
  outputTruncated: boolean
  errorOutputTruncated: boolean
  deliveryStatus?: BackgroundTaskDeliveryStatus
  deliveryMessage?: string
  creationDeliveryStatus?: BackgroundTaskDeliveryStatus
  creationDeliveryMessage?: string
}

export interface BackgroundTasksState {
  tasks: BackgroundTask[]
}

export interface BackgroundTaskStopResult {
  ok: boolean
  message: string
}

/**
 * Enough to reopen a task's observer after a restart: WHERE it runs, never a live shell.
 * An SSH or Web2Term task is observed again only once that same host or device is back.
 */
export interface BackgroundTaskTargetDescriptor {
  transport: BackgroundTask['transport']
  key: string
  label: string
  kind: 'windows' | 'posix'
  cwd: string
  ssh?: { hostId: string; address: string }
  web2term?: { agentId: string; deviceName: string; backendUrl: string; userId: string }
}

/** One persisted task: its last known state, where it runs, and where its notifications go. */
export interface StoredBackgroundTask {
  task: BackgroundTask
  target: BackgroundTaskTargetDescriptor
  /** The startup command's execution id; part of the task's identity. */
  messageId: string
  /** The process start identity read while it ran, so a reused PID is not mistaken for it. */
  identity: string
  settled: boolean
  owner: { platformId: string; conversationId: string }
}

const STATUSES: readonly BackgroundTaskStatus[] = ['checking', 'running', 'completed', 'failed', 'exited', 'stopped', 'unknown']
const DELIVERIES: readonly BackgroundTaskDeliveryStatus[] = ['pending', 'sending', 'sent', 'needs-attention', 'cancelled', 'superseded']

/** A stored row as read back from disk, or null when any part of it is unusable. */
export function parseStoredBackgroundTask(raw: string): StoredBackgroundTask | null {
  try {
    if (raw.length > 1_000_000) return null
    const value = JSON.parse(raw) as StoredBackgroundTask
    const { task, target, owner } = value ?? {} as StoredBackgroundTask
    const text = (item: unknown, max = 4096): item is string => typeof item === 'string' && item.length <= max
    if (!task || !target || !owner || !text(value.messageId, 512) || !text(value.identity, 1024) || typeof value.settled !== 'boolean') return null
    if (!text(owner.platformId, 32) || !text(owner.conversationId, 512) || !owner.conversationId) return null
    if (!['local', 'ssh', 'web2term'].includes(target.transport) || !['windows', 'posix'].includes(target.kind) ||
      !text(target.key, 512) || !text(target.label, 500) || !text(target.cwd)) return null
    if (target.transport === 'ssh' && (!target.ssh || !text(target.ssh.hostId, 512) || !text(target.ssh.address, 1024))) return null
    if (target.transport === 'web2term' && (!target.web2term ||
      !['agentId', 'deviceName', 'backendUrl', 'userId'].every(key => text(target.web2term![key as keyof typeof target.web2term], 2048)))) return null
    if (!text(task.id, 128) || !text(task.name, 200) || !Number.isSafeInteger(task.pid) || task.transport !== target.transport ||
      !text(task.logPath) || !text(task.conversationId, 512) || !text(task.command, 200_000) || !STATUSES.includes(task.status) ||
      !(task.exitCode === null || Number.isSafeInteger(task.exitCode)) || !Number.isFinite(task.createdAt) ||
      !text(task.output, 300_000) || !text(task.errorOutput, 300_000) || !text(task.message, 4096)) return null
    if ((task.stderrPath !== null && !text(task.stderrPath)) || (task.exitCodePath !== null && !text(task.exitCodePath))) return null
    if (task.stopRequestedAt !== undefined && (!Number.isFinite(task.stopRequestedAt) || task.stopRequestedAt < 0)) return null
    if (task.backgroundOptions !== undefined && !parseBackgroundOptions(task.backgroundOptions)) return null
    if (task.launchOptions !== undefined && task.launchOptions !== null) {
      const launch = parseBackgroundOptions(task.launchOptions)
      if (!launch) return null
      task.launchOptions = launch
    }
    if (task.startup !== undefined) {
      const startup = task.startup
      if (!startup || !['starting', 'ready', 'timeout', 'failed'].includes(startup.state) || !Number.isFinite(startup.deadlineAt) ||
        ![startup.stdoutOffset, startup.stderrOffset].every(n => Number.isSafeInteger(n) && n >= 0) ||
        !text(startup.stdoutCarry, 4096) || !text(startup.stderrCarry, 4096) ||
        (startup.evidence !== undefined && !text(startup.evidence, 4096)) || (startup.url !== undefined && !text(startup.url, 2048)) ||
        (startup.readyAt !== undefined && !Number.isFinite(startup.readyAt))) return null
    }
    delete task.stopInProgress
    for (const key of ['deliveryStatus', 'creationDeliveryStatus', 'readinessDeliveryStatus', 'timeoutDeliveryStatus'] as const) {
      if (task[key] !== undefined && !DELIVERIES.includes(task[key]!)) return null
      if (task[key] === 'sending') {
        task[key] = 'needs-attention'
        const messageKey = key.replace('Status', 'Message') as 'deliveryMessage' | 'creationDeliveryMessage' | 'readinessDeliveryMessage' | 'timeoutDeliveryMessage'
        task[messageKey] = '应用重启前正在发送，结果未确认；请核对原对话，软件不会自动重复提交。'
      }
    }
    if (Object.hasOwn(task, 'taskContext')) task.taskContext = parseTaskToolContext(task.taskContext)
    delete task.resultSettled
    return value
  } catch { return null }
}

/** Recognize explicit command-output records, including a marker followed by JSON on the next line. */
export function parseBackgroundTaskRegistrations(output: string): BackgroundTaskRegistration[] {
  const registrations: BackgroundTaskRegistration[] = []
  const lines = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.startsWith(BACKGROUND_TASK_MARKER) || line.length > 16384) continue
    let payload = line.slice(BACKGROUND_TASK_MARKER.length)
    // Two Write-Output calls produce exactly this shape. Only consume the
    // immediately adjacent JSON object, never search later ordinary output.
    if (!payload.trim() && lines[index + 1]?.trimStart().startsWith('{')) {
      payload = lines[index + 1]
      index += 1
    }
    if (payload.length + BACKGROUND_TASK_MARKER.length > 16384) continue
    try {
      const value = JSON.parse(payload)
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || value.pid > 2147483647) continue
      if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) continue
      const validPath = (path: unknown): path is string => typeof path === 'string'
        && path.length > 0 && path.length <= 4096 && !/[\x00-\x1f]/.test(path)
      if (!validPath(value.log_path)) continue
      if (value.stderr_path !== undefined && !validPath(value.stderr_path)) continue
      if (value.exit_code_path !== undefined && !validPath(value.exit_code_path)) continue
      registrations.push({
        pid: value.pid, name: value.name.trim(), log_path: value.log_path,
        ...(value.stderr_path === undefined ? {} : { stderr_path: value.stderr_path }),
        ...(value.exit_code_path === undefined ? {} : { exit_code_path: value.exit_code_path })
      })
    } catch { /* Ordinary output and incomplete marker lines are never registrations. */ }
  }
  return registrations
}
