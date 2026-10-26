import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { parseBackgroundTaskRegistrations } from '../shared/background-tasks'
import type {
  BackgroundTask, BackgroundTaskDeliveryStatus, BackgroundTaskNotificationKind, BackgroundTasksState,
  BackgroundTaskTargetDescriptor, BackgroundTaskStopResult, StoredBackgroundTask
} from '../shared/background-tasks'
import type { BackgroundTaskRegistration } from '../shared/background-tasks'
import type { EnvironmentKind, ExecutionRecord } from '../shared/types'
import type { ExecutionShell } from './shell'
import { initialBackgroundStartup, inferBackgroundService, backgroundStartupLogCommand, applyBackgroundStartupLogs,
  backgroundReadinessProbeCommand, parseBackgroundReadinessProbe } from './background-readiness'

const POLL_INTERVAL_MS = 4000
export const BACKGROUND_LOG_BYTES = 64 * 1024
const SAMPLE_MARKER = '__W2T_BACKGROUND_SAMPLE__'
const STOP_MARKER = '__W2T_BACKGROUND_STOP__'
const ended = (task: BackgroundTask): boolean => ['completed', 'failed', 'exited', 'stopped'].includes(task.status)

/** Captured before the startup command runs; never follows a later host switch. */
export interface BackgroundTaskTarget {
  key: string
  label: string
  transport: BackgroundTask['transport']
  kind: EnvironmentKind
  cwd: string
  available: () => boolean
  open: (signal: AbortSignal) => Promise<ExecutionShell>
  /** Where the target is, so a restart can rebuild it. Without one the task is not persisted. */
  descriptor?: BackgroundTaskTargetDescriptor
}

export type BackgroundTaskOwner = StoredBackgroundTask['owner']

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
  onCreated?: (task: BackgroundTask) => void
  creationDeadline?: number
  messageId: string
  owner?: BackgroundTaskOwner
  onStartup?: (task: BackgroundTask, kind: 'ready' | 'startup-timeout') => void
}

const quotePosix = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const quoteWindows = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** Stop only the captured process and its descendants, after checking its start identity. */
export function backgroundStopCommand(pid: number, identity: string, kind: EnvironmentKind): string {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2147483647 || !identity || identity.length > 1024) {
    throw new Error('后台任务的进程身份尚未确认。')
  }
  if (kind === 'windows') return [
    '$w2tStop = "failed"',
    'try {',
    `  $w2tStopProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    '  if ($null -eq $w2tStopProcess) { $w2tStop = "missing" }',
    `  elseif ([string]$w2tStopProcess.StartTime.ToUniversalTime().Ticks -ne ${quoteWindows(identity)}) { $w2tStop = "reused" }`,
    '  else {',
    // taskkill /T needs the original parent alive to find the workload's entire tree.
    `    & "$env:SystemRoot\\System32\\taskkill.exe" /PID ${pid} /T /F 2>&1 | Out-Null`,
    '    if ($LASTEXITCODE -eq 0) { $w2tStop = "signalled" }',
    '  }',
    '} catch { $w2tStop = "failed" }',
    '$LASTEXITCODE = 0; $Error.Clear()',
    `Write-Output ('${STOP_MARKER}' + $w2tStop)`
  ].join('\n')
  return [
    '(',
    'w2t_stop_identity() {',
    '  w2t_started=$(LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null)',
    '  [ -n "$w2t_started" ] && printf \'%s\' "$w2t_started" | base64 | tr -d "\\r\\n"',
    '}',
    'w2t_stop_task() {',
    `  w2t_actual=$(w2t_stop_identity ${pid})`,
    `  if [ -z "$w2t_actual" ]; then if kill -0 ${pid} 2>/dev/null; then printf unavailable; else printf missing; fi; return; fi`,
    `  if [ "$w2t_actual" != ${quotePosix(identity)} ]; then printf reused; return; fi`,
    // Snapshot the tree before signalling any parent. No process-group kill: legacy tasks
    // may share their group with the user's terminal or other background jobs.
    `  w2t_pids=$(LC_ALL=C ps -e -o pid= -o ppid= | awk -v root=${pid} 'function children(p, i) { for (i in parent) if (parent[i] == p) children(i); print p } { parent[$1]=$2 } END { children(root) }')`,
    '  w2t_entries=$(for w2t_child in $w2t_pids; do',
    '    w2t_birth=$(w2t_stop_identity "$w2t_child")',
    '    if [ -n "$w2t_birth" ]; then printf \'%s:%s\\n\' "$w2t_child" "$w2t_birth"; fi',
    '  done)',
    `  if [ "$(w2t_stop_identity ${pid})" != ${quotePosix(identity)} ]; then printf reused; return; fi`,
    '  w2t_failed=0',
    '  for w2t_entry in $w2t_entries; do',
    '    w2t_child=${w2t_entry%%:*}; w2t_birth=${w2t_entry#*:}',
    '    if [ "$(w2t_stop_identity "$w2t_child")" = "$w2t_birth" ]; then',
    '      kill -TERM "$w2t_child" 2>/dev/null || :',
    '    fi',
    '  done',
    '  sleep 1',
    // Retain the snapshot identities when children are reparented after the worker exits.
    '  for w2t_entry in $w2t_entries; do',
    '    w2t_child=${w2t_entry%%:*}; w2t_birth=${w2t_entry#*:}',
    '    if [ "$(w2t_stop_identity "$w2t_child")" = "$w2t_birth" ]; then',
    '      if ! kill -KILL "$w2t_child" 2>/dev/null && [ "$(w2t_stop_identity "$w2t_child")" = "$w2t_birth" ]; then w2t_failed=1; fi',
    '    fi',
    '  done',
    '  if [ "$w2t_failed" -eq 0 ]; then printf signalled; else printf failed; fi',
    '}',
    'w2t_stop_result=$(w2t_stop_task)',
    `printf '${STOP_MARKER}%s\\n' "$w2t_stop_result"`,
    ')'
  ].join('\n')
}

export function parseBackgroundStop(output: string): string {
  const result = output.split(/\r?\n/).findLast(line => line.startsWith(STOP_MARKER))?.slice(STOP_MARKER.length).trim()
  if (!result || !['signalled', 'missing', 'reused', 'unavailable', 'failed'].includes(result)) {
    throw new Error('停止结果尚未确认，请检查任务状态后再操作。')
  }
  return result
}

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
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly stops = new Map<string, Promise<BackgroundTaskStopResult>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private disposed = false
  private readonly abort = new AbortController()

  constructor(private readonly onChanged: (state: BackgroundTasksState) => void,
    private readonly persist?: (stored: StoredBackgroundTask) => void,
    private readonly captureStartup?: (owner: BackgroundTaskOwner, target: BackgroundTaskTarget) => (task: BackgroundTask, kind: 'ready' | 'startup-timeout') => void) {}

  getState(): BackgroundTasksState {
    return { tasks: [...this.entries.values()].map(entry => ({ ...entry.task, resultSettled: entry.settled, stopInProgress: this.stops.has(entry.task.id),
      ...(entry.task.taskContext ? { taskContext: structuredClone(entry.task.taskContext) } : {}),
      ...(entry.task.startup ? { startup: { ...entry.task.startup } } : {}) })) }
  }

  /** Serialize control and observation on the same target, including repeated clicks. */
  async stop(id: string): Promise<BackgroundTaskStopResult> {
    if (this.disposed) return { ok: false, message: '后台任务观察已关闭。' }
    const entry = [...this.entries.values()].find(item => item.task.id === id)
    if (!entry) return { ok: false, message: '后台任务不存在。' }
    const pending = this.stops.get(id)
    if (pending) return pending
    const operation = this.onTarget(entry.target.key, () => this.stopOnce(entry))
    this.stops.set(id, operation)
    this.onChanged(this.getState())
    try { return await operation }
    finally { this.stops.delete(id); if (!this.disposed) this.onChanged(this.getState()) }
  }

  private async onTarget<T>(key: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.operations.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
    this.operations.set(key, operation)
    try { return await operation }
    finally { if (this.operations.get(key) === operation) this.operations.delete(key) }
  }

  private async monitor(target: BackgroundTaskTarget): Promise<ExecutionShell> {
    if (this.disposed || !target.available()) throw new Error('任务所属的连接已断开或已切换；请恢复原连接后重试。')
    let shell = this.monitors.get(target.key)
    if (!shell?.alive) {
      shell?.dispose()
      shell = await target.open(this.abort.signal)
      if (this.disposed || !target.available()) { shell.dispose(); throw new Error('任务所属连接已失效。') }
      this.monitors.set(target.key, shell)
    }
    return shell
  }

  private async stopOnce(entry: Entry): Promise<BackgroundTaskStopResult> {
    if (this.disposed) return { ok: false, message: '后台任务观察已关闭。' }
    if (ended(entry.task) || entry.settled) return { ok: true, message: '任务已经结束。' }
    if (entry.task.stopRequestedAt !== undefined) return { ok: true, message: '停止请求已发送，正在确认进程退出。' }
    try {
      if (!entry.target.available()) throw new Error('任务所属的连接已断开或已切换；请恢复原连接后重试。')
      // Refresh an existing identity without ever replacing it with a reused PID's identity.
      await this.sample(entry)
      if (this.disposed) return { ok: false, message: '后台任务观察已关闭。' }
      if (ended(entry.task)) return { ok: true, message: '任务已经结束。' }
      if (entry.task.status !== 'running' || !entry.identity) throw new Error('尚未确认任务的进程身份，请等待状态更新后重试。')
      const shell = await this.monitor(entry.target)
      const result = await shell.run(backgroundStopCommand(entry.task.pid, entry.identity, entry.target.kind), 15000)
      if (this.disposed) return { ok: false, message: '后台任务观察已关闭。' }
      if (result.rejected || result.interrupted || result.timedOut || result.sessionLost || result.exitCode !== 0) {
        this.monitors.delete(entry.target.key)
        shell.dispose()
        throw new Error('停止结果尚未确认，请检查任务状态后再操作。')
      }
      const outcome = parseBackgroundStop(result.output)
      if (outcome === 'signalled') {
        entry.task.stopRequestedAt = Date.now()
        entry.task.message = '停止请求已发送，正在确认进程退出。'
        this.save(entry)
      } else if (!['missing', 'reused'].includes(outcome)) {
        throw new Error(outcome === 'unavailable' ? '无法核对进程身份，未执行停止。' : '进程未能停止，请检查当前用户是否有结束该进程的权限。')
      }
      await this.sample(entry)
      return { ok: true, message: outcome === 'signalled' ? '停止请求已发送。' : '原进程已经结束。' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '停止后台任务失败，请重试。' }
    } finally {
      if (!this.disposed) {
        this.onChanged(this.getState())
        if (!this.polling) {
          if (this.timer) clearTimeout(this.timer)
          this.timer = setTimeout(() => { this.timer = null; void this.poll() }, 0)
        }
      }
    }
  }

  /**
   * Bring back tasks saved before a restart. A task that was running is observed again
   * (its saved start identity still guards against a reused PID); one that had ended is
   * shown as history. `onSettled` supplies the completion hook, as `register` takes one.
   */
  restore(items: StoredBackgroundTask[], target: (descriptor: BackgroundTaskTargetDescriptor) => BackgroundTaskTarget,
    onSettled: (stored: StoredBackgroundTask) => ((task: BackgroundTask) => void) | undefined): void {
    if (this.disposed) return
    let resumed = false
    for (const stored of items) {
      const key = JSON.stringify([stored.target.key, stored.messageId, stored.task.pid, stored.task.logPath])
      if (this.entries.has(key)) continue
      const task: BackgroundTask = stored.settled ? { ...stored.task }
        : { ...stored.task, status: 'checking', message: '软件重启后正在恢复观察…', output: '', errorOutput: '' }
      if (!stored.settled && !task.startup && task.backgroundOptions?.kind !== 'job') {
        if (!task.backgroundOptions && inferBackgroundService(task.command)) task.backgroundOptions = { kind: 'service' }
        // Old records get a fresh bounded observation period, keeping the original PID identity.
        task.startup = initialBackgroundStartup(Date.now(), task.backgroundOptions)
      }
      const restoredTarget = target(stored.target)
      this.entries.set(key, { task, target: restoredTarget, identity: stored.identity, stdoutStamp: '', stderrStamp: '',
        finalRead: false, settled: stored.settled, onSettled: onSettled(stored), messageId: stored.messageId, owner: stored.owner,
        onStartup: this.captureStartup?.(stored.owner, restoredTarget) })
      resumed ||= !stored.settled
    }
    this.onChanged(this.getState())
    if (resumed) void this.poll()
  }

  register(output: string, record: Pick<ExecutionRecord, 'messageId' | 'conversationId' | 'command' | 'backgroundOptions' | 'taskContext'>,
    target: BackgroundTaskTarget, onSettled?: (task: BackgroundTask) => void,
    onRegistered?: (task: BackgroundTask) => void, owner?: BackgroundTaskOwner, onStartup?: Entry['onStartup']): number {
    return this.registerTasks(parseBackgroundTaskRegistrations(output), record, target, onSettled, onRegistered, owner, false, onStartup)
  }

  /** Typed software startup bypasses the model's marker protocol entirely. */
  registerTasks(registrations: BackgroundTaskRegistration[], record: Pick<ExecutionRecord, 'messageId' | 'conversationId' | 'command' | 'backgroundOptions' | 'taskContext'>,
    target: BackgroundTaskTarget, onSettled?: (task: BackgroundTask) => void,
    onRegistered?: (task: BackgroundTask) => void, owner?: BackgroundTaskOwner, waitForStartupOutput = false, onStartup?: Entry['onStartup']): number {
    if (this.disposed) return 0
    let count = 0
    for (const registration of registrations) {
      const paths = [registration.log_path, registration.stderr_path, registration.exit_code_path].filter((path): path is string => path !== undefined)
      const dialect = target.kind === 'windows' ? win32 : posix
      if (paths.some(path => !dialect.isAbsolute(path))) continue
      const key = JSON.stringify([target.key, record.messageId, registration.pid, registration.log_path])
      if (this.entries.has(key)) continue
      // The same process may be reported again in a later command; keep its original record.
      if ([...this.entries.values()].some(entry => entry.target.key === target.key && entry.task.pid === registration.pid
        && entry.task.logPath === registration.log_path && !entry.settled)) continue
      const task: BackgroundTask = {
        ...(record.taskContext ? { taskContext: structuredClone(record.taskContext) } : {}),
        launchOptions: record.backgroundOptions ? structuredClone(record.backgroundOptions) : null,
        id: randomUUID(), name: registration.name, pid: registration.pid, transport: target.transport,
        targetLabel: target.label, conversationId: record.conversationId, command: record.command,
        logPath: registration.log_path, stderrPath: registration.stderr_path ?? null,
        exitCodePath: registration.exit_code_path ?? null, status: 'checking', exitCode: null,
        createdAt: Date.now(), checkedAt: null, message: '正在读取进程状态和日志…',
        output: '', errorOutput: '', outputTruncated: false, errorOutputTruncated: false
      }
      task.backgroundOptions = record.backgroundOptions ?? (inferBackgroundService(record.command) ? { kind: 'service' } : undefined)
      task.startup = initialBackgroundStartup(task.createdAt, task.backgroundOptions)
      const entry: Entry = { task, target, identity: '', stdoutStamp: '', stderrStamp: '', finalRead: false, settled: false, onSettled,
        messageId: record.messageId, owner, onStartup: onStartup ?? (owner ? this.captureStartup?.(owner, target) : undefined) }
      if (waitForStartupOutput && onRegistered) {
        task.creationDeliveryStatus = 'pending'
        task.creationDeliveryMessage = '任务已登记，正在收集启动输出。'
        entry.onCreated = onRegistered
        entry.creationDeadline = Date.now() + 15000
      }
      this.entries.set(key, entry)
      this.save(entry)
      count += 1
      try { if (!waitForStartupOutput) onRegistered?.({ ...task }) }
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
    const statusKey = kind === 'created' ? 'creationDeliveryStatus' : kind === 'ready' ? 'readinessDeliveryStatus' : kind === 'startup-timeout' ? 'timeoutDeliveryStatus' : 'deliveryStatus'
    const messageKey = kind === 'created' ? 'creationDeliveryMessage' : kind === 'ready' ? 'readinessDeliveryMessage' : kind === 'startup-timeout' ? 'timeoutDeliveryMessage' : 'deliveryMessage'
    if (entry.task[statusKey] === status && entry.task[messageKey] === message) return
    entry.task[statusKey] = status
    entry.task[messageKey] = message
    this.save(entry)
    this.onChanged(this.getState())
  }

  /** Persist cancellation of future notifications as well as those already queued. */
  cancelAllNotifications(): void {
    const owners = new Map<string, BackgroundTaskOwner>()
    for (const entry of this.entries.values()) if (entry.owner) owners.set(JSON.stringify(entry.owner), entry.owner)
    for (const owner of owners.values()) this.cancelNotifications(owner)
  }

  cancelNotifications(owner: BackgroundTaskOwner): void {
    for (const entry of this.entries.values()) {
      if (entry.owner?.platformId !== owner.platformId || entry.owner.conversationId !== owner.conversationId) continue
      for (const kind of ['created', 'ready', 'startup-timeout', 'finished'] as const) {
        const key = kind === 'created' ? 'creationDeliveryStatus' : kind === 'ready' ? 'readinessDeliveryStatus' : kind === 'startup-timeout' ? 'timeoutDeliveryStatus' : 'deliveryStatus'
        if (!['sent', 'superseded', 'needs-attention'].includes(entry.task[key] ?? '')) this.setDelivery(entry.task.id, entry.task[key] === 'sending' ? 'needs-attention' : 'cancelled', '任务已手动结束，自动回传已取消；提交中的结果需核对，后台进程和日志保留。', kind)
      }
    }
  }

  /**
   * Write the task's restorable state. A running task is saved without its log tails —
   * they are re-read from the files after a restart; an ended one keeps its final output,
   * which a pending result notification still has to carry.
   */
  private save(entry: Entry): void {
    if (!this.persist || this.disposed || !entry.target.descriptor || !entry.owner) return
    const task = entry.settled ? { ...entry.task } : { ...entry.task, output: '', errorOutput: '' }
    try {
      this.persist({ task, target: entry.target.descriptor, messageId: entry.messageId, identity: entry.identity,
        settled: entry.settled, owner: entry.owner })
    } catch (error) {
      console.warn('[background] persist failed:', error instanceof Error ? error.name : 'Error')
    }
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
          if (entry.target.key === key && !entry.settled) await this.onTarget(key, () => this.sample(entry))
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
    const before = JSON.stringify([entry.task.status, entry.task.exitCode, entry.identity, entry.settled, entry.task.startup, entry.task.backgroundOptions])
    try {
      await this.sampleOnce(entry)
    } finally {
      this.publishCreated(entry)
      // Status, identity and settlement are what a restart needs; log tails are not.
      if (JSON.stringify([entry.task.status, entry.task.exitCode, entry.identity, entry.settled, entry.task.startup, entry.task.backgroundOptions]) !== before) this.save(entry)
    }
  }

  private publishCreated(entry: Entry, force = false): void {
    if (!entry.onCreated || this.disposed) return
    if (!force && !entry.task.output.trim() && !entry.task.errorOutput.trim() && Date.now() < (entry.creationDeadline ?? 0)) return
    const notify = entry.onCreated
    entry.onCreated = undefined
    try { notify({ ...entry.task }) }
    catch (error) { console.warn('[background] creation callback failed:', error instanceof Error ? error.name : 'Error') }
  }

  private async sampleOnce(entry: Entry): Promise<void> {
    const { task, target } = entry
    try {
      if (!target.available()) {
        this.monitors.get(target.key)?.dispose()
        this.monitors.delete(target.key)
        throw new Error('任务所属的连接已断开或已切换；恢复原连接后继续读取。')
      }
      const shell = await this.monitor(target)
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
      if (task.stopRequestedAt !== undefined && (reused || sample.alive === false || exitCode !== null)) {
        task.status = 'stopped'
        task.exitCode = exitCode
        messages.push('已手动停止，日志已保留。')
      } else if (exitCode !== null) {
        task.exitCode = exitCode
        task.status = exitCode === 0 ? 'completed' : 'failed'
      } else if (reused || sample.alive === false || entry.finalRead) {
        task.status = 'exited'
        messages.push('进程已结束，未取得退出码。')
      } else task.status = sample.alive ? 'running' : 'unknown'
      if (!ended(task) && task.stopRequestedAt !== undefined) messages.push('停止请求已发送，正在确认进程退出。')
      task.message = [...new Set(messages)].join('；') || (sample.alive === null ? '暂时无法判断进程状态。' : '')
      if (ended(task)) {
        if (task.startup && task.startup.state !== 'failed') task.startup.state = 'failed'
        entry.settled = entry.finalRead
        entry.finalRead = true
        if (entry.settled) {
          this.publishCreated(entry, true)
          // Publish only after the final read, including output flushed at exit.
          // Delivery failures must not reopen or rerun a completed task.
          try { entry.onSettled?.({ ...task }) }
          catch (error) { console.warn('[background] completion callback failed:', error instanceof Error ? error.name : 'Error') }
        }
      } else if (sample.alive && !reused && entry.identity && task.stopRequestedAt === undefined && !this.stops.has(task.id)) {
        await this.checkStartup(entry, shell)
      }
    } catch (error) {
      if (this.disposed) return
      task.status = 'unknown'
      task.message = error instanceof Error ? error.message : String(error)
    }
  }

  private async checkStartup(entry: Entry, shell: ExecutionShell): Promise<void> {
    const { task } = entry
    const startup = task.startup
    if (!startup || !['starting', 'timeout'].includes(startup.state) || (startup.state === 'timeout' && task.backgroundOptions?.kind !== 'service')) return
    // Entries without an owner/callback are used by embedders that only requested observation.
    if (!entry.onStartup) return
    const current = (): boolean => !this.disposed && entry.target.available() && !this.stops.has(task.id) && task.stopRequestedAt === undefined
    try {
      try {
        const logs = await shell.run(backgroundStartupLogCommand(task, entry.target.kind), 10000)
        if (!current()) return
        if (logs.exitCode === 0 && !logs.rejected && !logs.timedOut && !logs.sessionLost) applyBackgroundStartupLogs(task, logs.output)
      } catch { /* Explicit TCP/HTTP checks can succeed even when startup logs are unavailable. */ }
      if (!task.backgroundOptions && startup.applicationStarted && startup.url) task.backgroundOptions = { kind: 'service' }
      if (task.backgroundOptions?.kind === 'service') {
        const probe = backgroundReadinessProbeCommand(task, entry.identity, entry.target.kind)
        if (probe) {
          const result = await shell.run(probe, 15000)
          if (!current()) return
          if (result.exitCode === 0 && !result.rejected && !result.timedOut && !result.sessionLost && parseBackgroundReadinessProbe(result.output)) {
            startup.state = 'ready'; startup.readyAt = Date.now()
            if (task.backgroundOptions.readiness?.type === 'http') startup.url = task.backgroundOptions.readiness.url
            startup.evidence = (startup.evidence ? startup.evidence + '；' : '') + (task.backgroundOptions.readiness?.type === 'http' ? '健康接口返回成功状态，监听端口属于本任务进程树。' : '监听端口属于本任务进程树。')
            this.save(entry)
            this.publishCreated(entry, true)
            entry.onStartup?.({ ...task, startup: { ...startup } }, 'ready')
            return
          }
        }
      }
    } catch { /* Keep observing until the bounded startup deadline, never restart a task. */ }
    if (current() && startup.state === 'starting' && Date.now() >= startup.deadlineAt) {
      startup.state = 'timeout'
      this.save(entry)
      if (task.backgroundOptions?.kind === 'service') {
        this.publishCreated(entry, true)
        entry.onStartup?.({ ...task, startup: { ...startup } }, 'startup-timeout')
      }
    }
  }

  private decodeLog(data: string): string {
    return Buffer.from(data, 'base64').toString('utf8').replace(/^\uFEFF/, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n')
  }
}
