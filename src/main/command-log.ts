import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPlatform } from '../shared/platforms'

type PlatformId = ChatPlatform['id']
type Metadata = Record<string, string | number | boolean | null>
const events = ['received', 'deferred', 'deferred-flush', 'stored', 'skipped', 'preparing', 'started', 'finished', 'delivery', 'error'] as const
const reasons = [
  'inactive-platform', 'missing-conversation', 'terminal-mode-off', 'duplicate', 'empty-command',
  'placeholder', 'manual-mode', 'paused', 'already-in-flight', 'missing-record', 'execution-status',
  'disposed', 'no-shell', 'superseded', 'conversation-changed', 'rejected', 'interrupted', 'exception'
] as const

export interface CommandDiagnostic {
  event: typeof events[number]
  reason?: typeof reasons[number]
  messageId?: string
  ownerConversationId?: string | null
  commandLength?: number
  requestId?: number
  waiting?: number
  live?: boolean
  active?: boolean
  enabled?: boolean
  mode?: 'manual' | 'auto'
  paused?: boolean
  autoRun?: boolean
  status?: string
  shellKind?: string
  shellAlive?: boolean
  shellRunning?: boolean
  exitCode?: number | null
  rejected?: boolean
  interrupted?: boolean
  timedOut?: boolean
  sessionLost?: boolean
  deliveryOutcome?: string
  errorType?: string
}

export interface CommandDiagnosticContext {
  sessionId: string
  conversationId: string | null
  appVersion: string
  /** Used only to classify the route. The URL and project name are never written. */
  pageUrl: string
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(value) ? value : null
}

/** Explicit whitelist: no command, description, output, path, URL or error message. */
export function commandDiagnosticMetadata(platformId: PlatformId, payload: CommandDiagnostic, context: CommandDiagnosticContext): Metadata | null {
  if (!['chatgpt', 'deepseek', 'claude', 'gemini'].includes(platformId) || !events.includes(payload.event)) return null
  let routeKind = platformId === 'chatgpt' ? 'other' : 'other-platform'
  try {
    const path = new URL(context.pageUrl).pathname
    if (platformId === 'chatgpt') {
      if (/^\/g\/[^/]+\/c\/[^/]+/.test(path)) routeKind = 'chatgpt-nested-conversation'
      else if (/^\/c\/[^/]+/.test(path)) routeKind = 'chatgpt-conversation'
    }
  } catch { routeKind = 'unavailable' }
  const details: Metadata = {
    platformId, event: payload.event, sessionId: identifier(context.sessionId),
    conversationId: identifier(context.conversationId), routeKind,
    appVersion: typeof context.appVersion === 'string' && context.appVersion.length <= 80 &&
      /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(context.appVersion) ? context.appVersion : null
  }
  if (payload.reason !== undefined) details.reason = reasons.includes(payload.reason) ? payload.reason : 'unknown'
  for (const key of ['messageId', 'ownerConversationId'] as const) {
    if (payload[key] !== undefined) details[key] = identifier(payload[key])
  }
  for (const key of ['commandLength', 'requestId', 'waiting'] as const) {
    if (Number.isSafeInteger(payload[key]) && Number(payload[key]) >= 0) details[key] = Number(payload[key])
  }
  for (const key of ['live', 'active', 'enabled', 'paused', 'autoRun', 'shellAlive', 'shellRunning', 'rejected', 'interrupted', 'timedOut', 'sessionLost'] as const) {
    if (typeof payload[key] === 'boolean') details[key] = payload[key]!
  }
  if (payload.exitCode === null || Number.isSafeInteger(payload.exitCode)) details.exitCode = payload.exitCode!
  if (['auto', 'manual'].includes(payload.mode ?? '')) details.mode = payload.mode!
  if (['windows', 'posix'].includes(payload.shellKind ?? '')) details.shellKind = payload.shellKind!
  if (['pending', 'blocked', 'running', 'done', 'failed', 'timeout', 'skipped', 'interrupted'].includes(payload.status ?? '')) details.status = payload.status!
  if (['ok', 'busy', 'stuck', 'no-composer', 'insert-failed'].includes(payload.deliveryOutcome ?? '')) details.deliveryOutcome = payload.deliveryOutcome!
  if (payload.errorType !== undefined) details.errorType = ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(payload.errorType) ? payload.errorType : 'Other'
  return details
}

/** Always on, bounded files; diagnostic failures never interrupt execution. */
export class CommandDiagnosticLog {
  private readonly directory: string
  private readonly maxBytes: number
  private readonly files = new Map<PlatformId, { path: string; bytes: number }>()
  private serial = 0
  private sequence = 0

  constructor(directory = join(tmpdir(), 'gpt-login-diag'), maxBytes = 2 * 1024 * 1024) {
    this.directory = directory
    this.maxBytes = maxBytes
  }

  write(platformId: PlatformId, payload: CommandDiagnostic, context: CommandDiagnosticContext): string | null {
    try {
      const details = commandDiagnosticMetadata(platformId, payload, context)
      if (!details) return null
      const now = new Date().toISOString()
      const line = `${now} ${JSON.stringify({ sequence: ++this.sequence, ...details })}\n`
      const bytes = Buffer.byteLength(line)
      let file = this.files.get(platformId)
      if (!file || file.bytes + bytes > this.maxBytes) {
        mkdirSync(this.directory, { recursive: true })
        file = { path: join(this.directory, `${platformId}-command-${now.replace(/[:.]/g, '-')}-${process.pid}-${++this.serial}.log`), bytes: 0 }
        this.files.set(platformId, file)
      }
      appendFileSync(file.path, line, 'utf8')
      file.bytes += bytes
      return file.path
    } catch { return null }
  }
}

const commandLog = new CommandDiagnosticLog()
export function writeCommandDiagnostic(platformId: PlatformId, payload: CommandDiagnostic, context: CommandDiagnosticContext): string | null {
  return commandLog.write(platformId, payload, context)
}
