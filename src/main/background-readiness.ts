import type { BackgroundTask, BackgroundStartupState, BackgroundCommandOptions } from '../shared/background-tasks'
import type { EnvironmentKind } from '../shared/types'

const LOG_MARKER = '__W2T_STARTUP_LOG__'
const PROBE_MARKER = '__W2T_READY__'
const CHUNK_BYTES = 128 * 1024
const sh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const ps = (value: string): string => `'${value.replace(/'/g, "''")}'`

export function initialBackgroundStartup(createdAt: number, options?: BackgroundCommandOptions): BackgroundStartupState | undefined {
  if (options?.kind === 'job') return undefined
  return { state: 'starting', deadlineAt: createdAt + (options?.readiness?.timeout_seconds ?? 120) * 1000,
    stdoutOffset: 0, stderrOffset: 0, stdoutCarry: '', stderrCarry: '' }
}

export function inferBackgroundService(command: string): boolean {
  return /\bdotnet(?:\.exe)?\s+(?:run|watch)\b|\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?dev\b|\b(?:vite|next)\s+(?:dev|--host)\b|\bspring-boot:run\b/i.test(command)
}

/** Incremental bounded scanning is separate from the 64 KiB log tail used by the UI. */
export function backgroundStartupLogCommand(task: BackgroundTask, kind: EnvironmentKind): string {
  const startup = task.startup!
  if (kind === 'windows') return [
    'function Read-W2TStartup([string]$w2tPath, [long]$w2tOffset) {',
    '  $w2tStream = $null',
    '  try {',
    '    if (-not $w2tPath) { return @{data="";offset=$w2tOffset;reset=$false} }',
    '    $w2tStream = [IO.File]::Open($w2tPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)',
    '    $w2tReset = $w2tStream.Length -lt $w2tOffset; if ($w2tReset) { $w2tOffset = 0 }',
    '    $null = $w2tStream.Seek($w2tOffset, [IO.SeekOrigin]::Begin)',
    `    $w2tBuffer = New-Object byte[] ([int][Math]::Min(${CHUNK_BYTES}, $w2tStream.Length - $w2tOffset))`,
    '    $w2tRead = $w2tStream.Read($w2tBuffer, 0, $w2tBuffer.Length)',
    '    return @{data=[Convert]::ToBase64String($w2tBuffer, 0, $w2tRead);offset=($w2tOffset+$w2tRead);reset=$w2tReset}',
    '  } catch { return @{data="";offset=$w2tOffset;reset=$false} }',
    '  finally { if ($null -ne $w2tStream) { $w2tStream.Dispose() } }',
    '}',
    `$w2tStartup = @{stdout=(Read-W2TStartup ${ps(task.logPath)} ${startup.stdoutOffset});stderr=(Read-W2TStartup ${ps(task.stderrPath ?? '')} ${startup.stderrOffset})} | ConvertTo-Json -Compress -Depth 4`,
    '$Error.Clear()',
    `Write-Output ('${LOG_MARKER}' + $w2tStartup)`
  ].join('\n')
  return [
    'w2t_startup_log() {',
    '  w2t_offset=$2; w2t_reset=false',
    '  if [ -z "$1" ] || [ ! -r "$1" ]; then printf \'{"data":"","offset":%s,"reset":false}\' "$w2t_offset"; return; fi',
    '  w2t_bytes=$(wc -c < "$1" | tr -d "[:space:]")',
    '  if [ "$w2t_bytes" -lt "$w2t_offset" ]; then w2t_offset=0; w2t_reset=true; fi',
    `  w2t_data=$(tail -c "+$((w2t_offset+1))" "$1" 2>/dev/null | head -c ${CHUNK_BYTES} | base64 | tr -d "\\r\\n")`,
    '  w2t_length=${#w2t_data}; w2t_padding=0; case "$w2t_data" in *==) w2t_padding=2;; *=) w2t_padding=1;; esac',
    '  w2t_next=$((w2t_offset+w2t_length/4*3-w2t_padding))',
    '  printf \'{"data":"%s","offset":%s,"reset":%s}\' "$w2t_data" "$w2t_next" "$w2t_reset"',
    '}',
    `w2t_stdout=$(w2t_startup_log ${sh(task.logPath)} ${startup.stdoutOffset})`,
    `w2t_stderr=$(w2t_startup_log ${sh(task.stderrPath ?? '')} ${startup.stderrOffset})`,
    `printf '${LOG_MARKER}{"stdout":%s,"stderr":%s}\\n' "$w2t_stdout" "$w2t_stderr"`
  ].join('\n')
}

interface StartupChunk { data: string; offset: number; reset: boolean }
export function applyBackgroundStartupLogs(task: BackgroundTask, output: string): void {
  const frame = output.split(/\r?\n/).findLast(line => line.startsWith(LOG_MARKER))
  if (!frame || frame.length > CHUNK_BYTES * 3) throw new Error('启动日志读取结果无效。')
  const chunks = JSON.parse(frame.slice(LOG_MARKER.length)) as { stdout: StartupChunk; stderr: StartupChunk }
  for (const channel of ['stdout', 'stderr'] as const) {
    const chunk = chunks[channel], startup = task.startup!
    if (!chunk || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || typeof chunk.reset !== 'boolean' || typeof chunk.data !== 'string' ||
      chunk.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) throw new Error('启动日志片段无效。')
    const bytes = Buffer.from(chunk.data, 'base64')
    const previous = startup[channel + 'Offset' as 'stdoutOffset' | 'stderrOffset']
    if (bytes.length > CHUNK_BYTES || chunk.offset !== (chunk.reset ? 0 : previous) + bytes.length) throw new Error('启动日志偏移不匹配。')
    if (chunk.reset) { startup.applicationStarted = false; delete startup.url; delete startup.evidence }
    const carryKey = channel + 'Carry' as 'stdoutCarry' | 'stderrCarry'
    const text = (chunk.reset ? '' : startup[carryKey]) + bytes.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    const lines = text.split(/\r?\n/)
    startup[carryKey] = (lines.pop() ?? '').slice(-4096)
    startup[channel + 'Offset' as 'stdoutOffset' | 'stderrOffset'] = chunk.offset
    for (const line of lines) {
      // Explicit framework messages, never a generic "success" or an arbitrary URL.
      if (/Application started\. Press Ctrl\+C to shut down\.|\bStarted .+ in [\d.]+ seconds\b|\bVITE v[\d.]+\s+ready in\b/i.test(line)) {
        startup.applicationStarted = true
        startup.evidence = line.trim().slice(0, 1000)
      }
      const address = line.match(/(?:Now listening on:|Local:\s*|Tomcat started on port\(s\):?)\s*(https?:\/\/[^\s]+)/i)?.[1]
      if (address) {
        try {
          const url = new URL(address)
          if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '0.0.0.0', '[::]', '[::1]'].includes(url.hostname)) {
            if (['0.0.0.0', '[::]'].includes(url.hostname)) url.hostname = '127.0.0.1'
            url.username = ''; url.password = ''; url.hash = ''
            startup.url = url.origin
          }
        } catch { /* A partial or unsupported address is not readiness evidence. */ }
      }
    }
  }
}

/** All checks execute on the task's original target, including its loopback address. */
export function backgroundReadinessProbeCommand(task: BackgroundTask, identity: string, kind: EnvironmentKind): string | null {
  const config = task.backgroundOptions?.readiness ?? { type: 'auto' as const }
  const url = config.type === 'http' ? new URL(config.url!) : task.startup?.url ? new URL(task.startup.url) : null
  const port = config.type === 'tcp' ? config.port! : url ? Number(url.port || (url.protocol === 'https:' ? 443 : 80)) : null
  if (!port || (config.type === 'auto' && !task.startup?.applicationStarted)) return null
  if (!Number.isSafeInteger(task.pid) || task.pid <= 1 || !identity) return null
  if (kind === 'windows') return [
    '$w2tReady = $false',
    'try {',
    `  $w2tRoot = Get-Process -Id ${task.pid} -ErrorAction Stop`,
    `  if ([string]$w2tRoot.StartTime.ToUniversalTime().Ticks -eq ${ps(identity)}) {`,
    `    $w2tTree = @{}; $w2tTree[[int]${task.pid}] = $true`,
    '    $w2tProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '    do { $w2tAdded = $false; foreach ($w2tItem in $w2tProcesses) { if ($w2tTree.ContainsKey([int]$w2tItem.ParentProcessId) -and -not $w2tTree.ContainsKey([int]$w2tItem.ProcessId)) { $w2tTree[[int]$w2tItem.ProcessId] = $true; $w2tAdded = $true } } } while ($w2tAdded)',
    `    $w2tListeners = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop)`,
    '    $w2tReady = @($w2tListeners | Where-Object { $w2tTree.ContainsKey([int]$_.OwningProcess) }).Count -gt 0',
    ...(config.type === 'http' ? [
      '    if ($w2tReady) {',
      `      $w2tRequest = [Net.HttpWebRequest]::Create(${ps(config.url!)})`,
      '      $w2tRequest.AllowAutoRedirect = $false; $w2tRequest.Timeout = 2000; $w2tRequest.ReadWriteTimeout = 2000; $w2tRequest.Proxy = $null',
      '      $w2tResponse = $null',
      '      try { $w2tResponse = $w2tRequest.GetResponse(); $w2tReady = [int]$w2tResponse.StatusCode -ge 200 -and [int]$w2tResponse.StatusCode -lt 300 } finally { if ($null -ne $w2tResponse) { $w2tResponse.Dispose() } }',
      '    }'
    ] : []),
    `    $w2tRoot = Get-Process -Id ${task.pid} -ErrorAction Stop`,
    `    $w2tReady = $w2tReady -and ([string]$w2tRoot.StartTime.ToUniversalTime().Ticks -eq ${ps(identity)})`,
    '  }',
    '} catch { $w2tReady = $false }',
    '$Error.Clear(); $w2tReply = @{ok=$w2tReady} | ConvertTo-Json -Compress',
    `Write-Output ('${PROBE_MARKER}' + $w2tReply)`
  ].join('\n')
  return [
    '(',
    'w2t_ready_identity() { w2t_start=$(LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null); [ -n "$w2t_start" ] && printf \'%s\' "$w2t_start" | base64 | tr -d "\\r\\n"; }',
    'w2t_ready=false',
    `if [ "$(w2t_ready_identity ${task.pid})" = ${sh(identity)} ]; then`,
    `  w2t_tree=$(ps -e -o pid= -o ppid= | awk -v root=${task.pid} 'function children(p,i) { print p; for (i in parent) if (parent[i]==p) children(i) } { parent[$1]=$2 } END { children(root) }')`,
    '  w2t_owners=""',
    `  if command -v ss >/dev/null 2>&1; then w2t_owners=$(ss -Hltnp 'sport = :${port}' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2);`,
    `  elif command -v lsof >/dev/null 2>&1; then w2t_owners=$(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null); fi`,
    '  for w2t_owner in $w2t_owners; do for w2t_child in $w2t_tree; do if [ "$w2t_owner" = "$w2t_child" ]; then w2t_ready=true; fi; done; done',
    ...(config.type === 'http' ? [
      `  if [ "$w2t_ready" = true ]; then w2t_code=$(curl --noproxy '*' --silent --max-time 2 --max-redirs 0 --output /dev/null --write-out '%{http_code}' ${sh(config.url!)} 2>/dev/null); case "$w2t_code" in 2[0-9][0-9]) ;; *) w2t_ready=false;; esac; fi`
    ] : []),
    `  if [ "$(w2t_ready_identity ${task.pid})" != ${sh(identity)} ]; then w2t_ready=false; fi`,
    'fi',
    `printf '${PROBE_MARKER}{"ok":%s}\\n' "$w2t_ready"`,
    ')'
  ].join('\n')
}

export function parseBackgroundReadinessProbe(output: string): boolean {
  const frame = output.split(/\r?\n/).findLast(line => line.startsWith(PROBE_MARKER))
  if (!frame || frame.length > 1000) throw new Error('服务就绪检查结果无效。')
  const value = JSON.parse(frame.slice(PROBE_MARKER.length))
  if (typeof value?.ok !== 'boolean') throw new Error('服务就绪检查结果无效。')
  return value.ok
}
