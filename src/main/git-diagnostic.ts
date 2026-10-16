import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitDiagnosticContext {
  requestId: string
  backend: 'local' | 'ssh'
  operation: 'all' | 'files' | 'history' | 'stats' | 'diff'
  stage?: 'repo' | 'branch' | 'status' | 'history' | 'numstat' | 'working-file' | 'diff' | 'old-file'
}

interface GitDiagnosticDetails {
  event: 'request-start' | 'request-finish' | 'stage-start' | 'stage-finish' | 'ssh-open' | 'ssh-finish'
  status?: 'ok' | 'error' | 'timeout' | 'connection-changed' | 'output-limit' | 'exit-failed'
  elapsedMs?: number
  channelWaitMs?: number
  executionMs?: number
  bytes?: number
  exitCode?: number | null
  files?: number
  commits?: number
}

/** Metadata only: never record repository paths, Git arguments or file contents. */
export class GitDiagnosticLog {
  private readonly directory: string
  private readonly maxBytes: number
  private file: { path: string; bytes: number } | null = null
  private serial = 0

  constructor(directory = join(tmpdir(), 'gpt-login-diag'), maxBytes = 2 * 1024 * 1024) {
    this.directory = directory
    this.maxBytes = maxBytes
  }

  write(context: GitDiagnosticContext, details: GitDiagnosticDetails): string | null {
    try {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(context.requestId) || !['local', 'ssh'].includes(context.backend) ||
        !['all', 'files', 'history', 'stats', 'diff'].includes(context.operation) ||
        !['request-start', 'request-finish', 'stage-start', 'stage-finish', 'ssh-open', 'ssh-finish'].includes(details.event)) return null
      const metadata: Record<string, string | number | null> = {
        requestId: context.requestId, backend: context.backend, operation: context.operation, event: details.event
      }
      if (context.stage && ['repo', 'branch', 'status', 'history', 'numstat', 'working-file', 'diff', 'old-file'].includes(context.stage)) metadata.stage = context.stage
      if (details.status && ['ok', 'error', 'timeout', 'connection-changed', 'output-limit', 'exit-failed'].includes(details.status)) metadata.status = details.status
      for (const key of ['elapsedMs', 'channelWaitMs', 'executionMs', 'bytes', 'files', 'commits'] as const) {
        const value = details[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metadata[key] = Math.round(value)
      }
      if (details.exitCode === null || Number.isSafeInteger(details.exitCode)) metadata.exitCode = details.exitCode!
      const now = new Date().toISOString()
      const line = `${now} ${JSON.stringify(metadata)}\n`
      const bytes = Buffer.byteLength(line)
      if (!this.file || this.file.bytes + bytes > this.maxBytes) {
        mkdirSync(this.directory, { recursive: true })
        this.file = { path: join(this.directory, `git-performance-${now.replace(/[:.]/g, '-')}-${process.pid}-${++this.serial}.log`), bytes: 0 }
      }
      appendFileSync(this.file.path, line, 'utf8')
      this.file.bytes += bytes
      return this.file.path
    } catch { return null }
  }
}

const diagnosticLog = new GitDiagnosticLog()
export const writeGitDiagnostic = (context: GitDiagnosticContext, details: GitDiagnosticDetails): void => {
  diagnosticLog.write(context, details)
}

export function createGitDiagnostic(backend: 'local' | 'ssh', operation: GitDiagnosticContext['operation']): GitDiagnosticContext {
  return { requestId: randomUUID(), backend, operation }
}
