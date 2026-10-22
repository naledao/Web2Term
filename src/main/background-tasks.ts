import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { parseBackgroundTaskRegistrations } from '../shared/background-tasks'
import type { BackgroundTask, BackgroundTaskDeliveryStatus, BackgroundTaskNotificationKind, BackgroundTasksState } from '../shared/background-tasks'
import type { EnvironmentKind, ExecutionRecord } from '../shared/types'
import type { ExecutionShell } from './shell'

const POLL_INTERVAL_MS = 4000
export const BACKGROUND_LOG_BYTES = 64 * 1024
const SAMPLE_MARKER = '__W2T_BACKGROUND_SAMPLE__'

/** Captured before the startup command runs; never follows a later host switch. */
export interface BackgroundTaskTarget {
  key: string
  label: string
  transport: BackgroundTask['transport']
  kind: EnvironmentKind
  cwd: string
  available: () => boolean
  open: (signal: AbortSignal) => Promise<ExecutionShell>
}

interface LogSample {
  data: string | null
  bytes: number
  stamp: string
  error: string
}

interface Sample {
  alive: boolean | null
  identity: string
  exitCode: number | null
  stdout: LogSample
  stderr: LogSample
}

interface Entry {
  task: BackgroundTask
  target: BackgroundTaskTarget
  identity: string
  stdoutStamp: string
  stderrStamp: string
  /** One final read after exit captures output flushed during process teardown. */
  finalRead: boolean
  settled: boolean
  onSettled?: (task: BackgroundTask) => void
}

const quotePosix = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const quoteWindows = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** Read bounded log tails. Unchanged files send only metadata across remote transports. */
export function backgroundSampleCommand(task: Pick<BackgroundTask, 'pid' | 'logPath' | 'stderrPath' | 'exitCodePath'>,
  kind: EnvironmentKind, stdoutStamp = '', stderrStamp = ''): string {
  if (kind === 'windows') {
    return [
      'function Read-W2TLog([string]$w2tPath, [string]$w2tPrevious) {',
      '  if (-not $w2tPath) { return @{data=$null;bytes=0;stamp="";error=""} }',
      '  $w2tStream = $null',
      '  try {',
      '    $w2tFile = Get-Item -LiteralPath $w2tPath -ErrorAction Stop',
      '    if ($w2tFile.PSIsContainer) { throw "日志路径不是文件" }',
      '    $w2tStamp = [string]$w2tFile.Length + ":" + [string]$w2tFile.LastWriteTimeUtc.Ticks + ":" + [string]$w2tFile.CreationTimeUtc.Ticks',
      '    if ($w2tStamp -eq $w2tPrevious) { return @{data=$null;bytes=$w2tFile.Length;stamp=$w2tStamp;error=""} }',
      '    $w2tStream = [IO.File]::Open($w2tPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)',
      `    $w2tCount = [int][Math]::Min($w2tStream.Length, ${BACKGROUND_LOG_BYTES})`,
      '    $null = $w2tStream.Seek(-$w2tCount, [IO.SeekOrigin]::End)',
      '    $w2tBuffer = New-Object byte[] $w2tCount',
      '    $w2tRead = 0',
      '    while ($w2tRead -lt $w2tCount) { $w2tN = $w2tStream.Read($w2tBuffer, $w2tRead, $w2tCount - $w2tRead); if ($w2tN -eq 0) { break }; $w2tRead += $w2tN }',
      '    return @{data=[Convert]::ToBase64String($w2tBuffer, 0, $w2tRead);bytes=$w2tStream.Length;stamp=$w2tStamp;error=""}',
      '  } catch { return @{data=$null;bytes=0;stamp="";error="日志尚未生成或无法读取"} }',
      '  finally { if ($null -ne $w2tStream) { $w2tStream.Dispose() } }',
      '}',
      `$w2tProcess = Get-Process -Id ${task.pid} -ErrorAction SilentlyContinue`,
      '$w2tIdentity = ""; if ($null -ne $w2tProcess) { try { $w2tIdentity = [string]$w2tProcess.StartTime.ToUniversalTime().Ticks } catch {} }',
      '$w2tExitCode = $null',
      ...(task.exitCodePath ? [
        `try { $w2tExitFile = Get-Item -LiteralPath ${quoteWindows(task.exitCodePath)} -ErrorAction Stop; if ($w2tExitFile.Length -le 64) { $w2tExitText = [IO.File]::ReadAllText($w2tExitFile.FullName).Trim(); if ($w2tExitText -match '^-?[0-9]{1,10}$') { $w2tExitCode = [long]$w2tExitText } } } catch {}`
      ] : []),
      `$w2tStdout = Read-W2TLog ${quoteWindows(task.logPath)} ${quoteWindows(stdoutStamp)}`,
      `$w2tStderr = Read-W2TLog ${quoteWindows(task.stderrPath ?? '')} ${quoteWindows(stderrStamp)}`,
      '$w2tSample = @{alive=($null -ne $w2tProcess);identity=$w2tIdentity;exitCode=$w2tExitCode;stdout=$w2tStdout;stderr=$w2tStderr} | ConvertTo-Json -Compress -Depth 4',
      // The private observer reports expected missing-process/file errors in its sample.
      // ConversationShell otherwise counts even caught errors as a failed command.
      '$Error.Clear()',
      `Write-Output ('${SAMPLE_MARKER}' + $w2tSample)`
    ].join('\n')
  }
  return [
    'w2t_log() {',
    '  if [ -z "$1" ]; then printf \'{"data":null,"bytes":0,"stamp":"","error":""}\'; return; fi',
    '  if [ ! -f "$1" ] || [ ! -r "$1" ]; then printf \'{"data":null,"bytes":0,"stamp":"","error":"日志尚未生成或无法读取"}\'; return; fi',
    '  w2t_bytes=$(wc -c < "$1" 2>/dev/null | tr -d "[:space:]")',
    '  case "$w2t_bytes" in ""|*[!0-9]*) printf \'{"data":null,"bytes":0,"stamp":"","error":"日志大小读取失败"}\'; return;; esac',
    '  w2t_stamp=$({ stat -c "%s:%y:%i" "$1" 2>/dev/null || stat -f "%z:%m:%i" "$1" 2>/dev/null; } | base64 | tr -d "\\r\\n")',
    '  if [ -n "$w2t_stamp" ] && [ "$w2t_stamp" = "$2" ]; then',
    '    printf \'{"data":null,"bytes":%s,"stamp":"%s","error":""}\' "$w2t_bytes" "$w2t_stamp"',
    '  else',
    `    w2t_data=$(tail -c ${BACKGROUND_LOG_BYTES} "$1" 2>/dev/null | base64 | tr -d "\\r\\n")`,
    '    printf \'{"data":"%s","bytes":%s,"stamp":"%s","error":""}\' "$w2t_data" "$w2t_bytes" "$w2t_stamp"',
    '  fi',
    '}',
    'w2t_alive=null; w2t_identity=""',
    'if command -v ps >/dev/null 2>&1; then',
    `  w2t_start=$(LC_ALL=C ps -p ${task.pid} -o lstart= 2>/dev/null)`,
    `  if [ -n "$w2t_start" ]; then w2t_alive=true; w2t_identity=$(printf '%s' "$w2t_start" | base64 | tr -d '\\r\\n'); w2t_state=$(ps -p ${task.pid} -o stat= 2>/dev/null); case "$w2t_state" in *Z*) w2t_alive=false;; esac; elif kill -0 ${task.pid} 2>/dev/null; then w2t_alive=true; else w2t_alive=false; fi`,
    `elif kill -0 ${task.pid} 2>/dev/null; then w2t_alive=true; fi`,
    'w2t_exit=null',
    ...(task.exitCodePath ? [
      `if [ -f ${quotePosix(task.exitCodePath)} ] && [ -r ${quotePosix(task.exitCodePath)} ]; then`,
      `  w2t_code=$(head -c 32 ${quotePosix(task.exitCodePath)} 2>/dev/null | tr -d '[:space:]')`,
      '  if printf \'%s\\n\' "$w2t_code" | LC_ALL=C grep -Eq \'^-?(0|[1-9][0-9]{0,9})$\'; then w2t_exit=$w2t_code; fi',
      'fi'
    ] : []),
    `w2t_stdout=$(w2t_log ${quotePosix(task.logPath)} ${quotePosix(stdoutStamp)})`,
    `w2t_stderr=$(w2t_log ${quotePosix(task.stderrPath ?? '')} ${quotePosix(stderrStamp)})`,
    `printf '${SAMPLE_MARKER}{"alive":%s,"identity":"%s","exitCode":%s,"stdout":%s,"stderr":%s}\\n' "$w2t_alive" "$w2t_identity" "$w2t_exit" "$w2t_stdout" "$w2t_stderr"`
  ].join('\n')
}

export function parseBackgroundSample(output: string): Sample {
  const line = output.split(/\r?\n/).findLast(value => value.startsWith(SAMPLE_MARKER))
  if (!line || line.length > BACKGROUND_LOG_BYTES * 4) throw new Error('后台监控没有返回有效结果。')
  const value = JSON.parse(line.slice(SAMPLE_MARKER.length))
  const validLog = (log: LogSample): boolean => Boolean(log) && Number.isSafeInteger(log.bytes) && log.bytes >= 0
    && typeof log.stamp === 'string' && log.stamp.length <= 1024 && typeof log.error === 'string' && log.error.length <= 2048
    && (log.data === null || (typeof log.data === 'string' && log.data.length <= Math.ceil(BACKGROUND_LOG_BYTES / 3) * 4
      && log.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(log.data)
      && Buffer.from(log.data, 'base64').length <= BACKGROUND_LOG_BYTES))
  if (!value || ![true, false, null].includes(value.alive) || typeof value.identity !== 'string'
    || value.identity.length > 1024 || !(value.exitCode === null || Number.isSafeInteger(value.exitCode))
    || !validLog(value.stdout) || !validLog(value.stderr)) throw new Error('后台监控结果格式不正确。')
  return value
}

/** Tracks detached tasks; disposing observers never stops the registered processes. */
export class BackgroundTasks {
  private readonly entries = new Map<string, Entry>()
  private readonly monitors = new Map<string, ExecutionShell>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private disposed = false
  private readonly abort = new AbortController()

  constructor(private readonly onChanged: (state: BackgroundTasksState) => void) {}

  getState(): BackgroundTasksState {
    return { tasks: [...this.entries.values()].map(entry => ({ ...entry.task })) }
  }

  register(output: string, record: Pick<ExecutionRecord, 'messageId' | 'conversationId' | 'command'>,
    target: BackgroundTaskTarget, onSettled?: (task: BackgroundTask) => void,
    onRegistered?: (task: BackgroundTask) => void): number {
    if (this.disposed) return 0
    let count = 0
    for (const registration of parseBackgroundTaskRegistrations(output)) {
      const paths = [registration.log_path, registration.stderr_path, registration.exit_code_path].filter((path): path is string => path !== undefined)
      const dialect = target.kind === 'windows' ? win32 : posix
      if (paths.some(path => !dialect.isAbsolute(path))) continue
      const key = JSON.stringify([target.key, record.messageId, registration.pid, registration.log_path])
      if (this.entries.has(key)) continue
      // The same process may be reported again in a later command; keep its original record.
      if ([...this.entries.values()].some(entry => entry.target.key === target.key && entry.task.pid === registration.pid
        && entry.task.logPath === registration.log_path && !entry.settled)) continue
      const task: BackgroundTask = {
        id: randomUUID(), name: registration.name, pid: registration.pid, transport: target.transport,
        targetLabel: target.label, conversationId: record.conversationId, command: record.command,
        logPath: registration.log_path, stderrPath: registration.stderr_path ?? null,
        exitCodePath: registration.exit_code_path ?? null, status: 'checking', exitCode: null,
        createdAt: Date.now(), checkedAt: null, message: '正在读取进程状态和日志…',
        output: '', errorOutput: '', outputTruncated: false, errorOutputTruncated: false
      }
      this.entries.set(key, { task, target, identity: '', stdoutStamp: '', stderrStamp: '', finalRead: false, settled: false, onSettled })
      count += 1
      try { onRegistered?.({ ...task }) }
      catch (error) { console.warn('[background] registration callback failed:', error instanceof Error ? error.name : 'Error') }
    }
    if (count) {
      this.onChanged(this.getState())
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      void this.poll()
    }
    return count
  }

  setDelivery(id: string, status: BackgroundTaskDeliveryStatus, message: string, kind: BackgroundTaskNotificationKind = 'finished'): void {
    if (this.disposed) return
    const entry = [...this.entries.values()].find(item => item.task.id === id)
    if (!entry) return
    if (kind === 'created') {
      if (entry.task.creationDeliveryStatus === status && entry.task.creationDeliveryMessage === message) return
      entry.task.creationDeliveryStatus = status
      entry.task.creationDeliveryMessage = message
    } else {
      if (entry.task.deliveryStatus === status && entry.task.deliveryMessage === message) return
      entry.task.deliveryStatus = status
      entry.task.deliveryMessage = message
    }
    this.onChanged(this.getState())
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    if (this.timer) clearTimeout(this.timer)
    for (const shell of this.monitors.values()) shell.dispose()
    this.monitors.clear()
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.polling) return
    this.polling = true
    try {
      // Each target has its own observer shell; requests on that shell are serialized.
      const targets = [...new Set([...this.entries.values()].filter(entry => !entry.settled).map(entry => entry.target.key))]
      await Promise.allSettled(targets.map(async key => {
        for (const entry of this.entries.values()) {
          if (this.disposed) return
          if (entry.target.key === key && !entry.settled) await this.sample(entry)
        }
      }))
      if (!this.disposed) this.onChanged(this.getState())
    } finally {
      this.polling = false
      if (!this.disposed && [...this.entries.values()].some(entry => !entry.settled)) {
        this.timer = setTimeout(() => { this.timer = null; void this.poll() }, POLL_INTERVAL_MS)
      }
      for (const [key, shell] of this.monitors) {
        if (![...this.entries.values()].some(entry => entry.target.key === key && !entry.settled)) {
          shell.dispose()
          this.monitors.delete(key)
        }
      }
    }
  }

  private async sample(entry: Entry): Promise<void> {
    const { task, target } = entry
    try {
      if (!target.available()) {
        this.monitors.get(target.key)?.dispose()
        this.monitors.delete(target.key)
        throw new Error('任务所属的连接已断开或已切换；恢复原连接后继续读取。')
      }
      let shell = this.monitors.get(target.key)
      if (!shell?.alive) {
        shell?.dispose()
        shell = await target.open(this.abort.signal)
        if (this.disposed || !target.available()) { shell.dispose(); return }
        this.monitors.set(target.key, shell)
      }
      const result = await shell.run(backgroundSampleCommand(task, target.kind, entry.stdoutStamp, entry.stderrStamp), 30000)
      if (this.disposed) return
      if (result.rejected || result.interrupted || result.timedOut || result.sessionLost || result.exitCode !== 0) {
        this.monitors.delete(target.key)
        shell.dispose()
        throw new Error('后台监控通道暂不可用，将自动重试。')
      }
      const sample = parseBackgroundSample(result.output)
      task.checkedAt = Date.now()
      const messages = [sample.stdout.error, sample.stderr.error].filter(Boolean)
      if (sample.stdout.data !== null) {
        task.output = this.decodeLog(sample.stdout.data)
        task.outputTruncated = sample.stdout.bytes > BACKGROUND_LOG_BYTES
      }
      if (sample.stderr.data !== null) {
        task.errorOutput = this.decodeLog(sample.stderr.data)
        task.errorOutputTruncated = sample.stderr.bytes > BACKGROUND_LOG_BYTES
      }
      entry.stdoutStamp = sample.stdout.stamp
      entry.stderrStamp = sample.stderr.stamp
      const reused = Boolean(entry.identity && sample.identity && entry.identity !== sample.identity)
      if (!entry.identity && sample.alive) entry.identity = sample.identity
      if (reused) messages.push('原进程已退出，PID 已被其他进程复用。')
      const exitCode = sample.exitCode ?? task.exitCode
      if (exitCode !== null) {
        task.exitCode = exitCode
        task.status = exitCode === 0 ? 'completed' : 'failed'
      } else if (reused || sample.alive === false || entry.finalRead) {
        task.status = 'exited'
        messages.push('进程已结束，未取得退出码。')
      } else task.status = sample.alive ? 'running' : 'unknown'
      task.message = [...new Set(messages)].join('；') || (sample.alive === null ? '暂时无法判断进程状态。' : '')
      if (['completed', 'failed', 'exited'].includes(task.status)) {
        entry.settled = entry.finalRead
        entry.finalRead = true
        if (entry.settled) {
          // Publish only after the final read, including output flushed at exit.
          // Delivery failures must not reopen or rerun a completed task.
          try { entry.onSettled?.({ ...task }) }
          catch (error) { console.warn('[background] completion callback failed:', error instanceof Error ? error.name : 'Error') }
        }
      }
    } catch (error) {
      if (this.disposed) return
      task.status = 'unknown'
      task.message = error instanceof Error ? error.message : String(error)
    }
  }

  private decodeLog(data: string): string {
    return Buffer.from(data, 'base64').toString('utf8').replace(/^\uFEFF/, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
  }
}
