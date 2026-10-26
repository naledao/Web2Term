import type { Client, ClientChannel } from 'ssh2'

export interface RemoteProcessIdentity {
  pid: number
  /** Base64 of the shell's ps lstart value, captured before its first command. */
  started: string
}

const STOP_MARKER = '__CT_REMOTE_STOP__'

/** A separate SSH channel can stop a busy non-PTY shell even when SSH signals are ignored. */
export function remoteStopCommand(identity: RemoteProcessIdentity): string {
  const { pid, started } = identity
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2147483647
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(started) || started.length > 512) {
    throw new Error('无法核对远端命令的进程身份，未执行停止。')
  }
  return [
    'ct_stop_identity() {',
    '  ct_start=$(LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null)',
    '  [ -n "$ct_start" ] && printf \'%s\' "$ct_start" | base64 | tr -d "\\r\\n"',
    '}',
    'ct_stop_task() {',
    `  [ "$(ct_stop_identity ${pid})" = '${started}' ] || return 1`,
    // Snapshot children and their identities before any parent can exit and reparent them.
    // Never kill a process group: it may contain other user terminals or services.
    `  ct_pids=$(LC_ALL=C ps -e -o pid= -o ppid= | awk -v root=${pid} 'function children(p, i) { for (i in parent) if (parent[i] == p) children(i); print p } { parent[$1]=$2 } END { children(root) }')`,
    '  ct_entries=$(for ct_pid in $ct_pids; do',
    '    ct_birth=$(ct_stop_identity "$ct_pid")',
    '    if [ -n "$ct_birth" ]; then printf \'%s:%s\\n\' "$ct_pid" "$ct_birth"; elif kill -0 "$ct_pid" 2>/dev/null; then printf \'unavailable\\n\'; fi',
    '  done)',
    '  case "$ct_entries" in *unavailable*) return 1;; esac',
    `  [ "$(ct_stop_identity ${pid})" = '${started}' ] || return 1`,
    `  printf '%s\\n' "$ct_entries" | grep -q '^${pid}:${started}$' || return 1`,
    '  for ct_entry in $ct_entries; do',
    '    ct_pid=${ct_entry%%:*}; ct_birth=${ct_entry#*:}',
    '    if [ "$(ct_stop_identity "$ct_pid")" = "$ct_birth" ]; then kill -TERM "$ct_pid" 2>/dev/null || :; fi',
    '  done',
    '  sleep 1',
    '  for ct_entry in $ct_entries; do',
    '    ct_pid=${ct_entry%%:*}; ct_birth=${ct_entry#*:}',
    '    if [ "$(ct_stop_identity "$ct_pid")" = "$ct_birth" ]; then kill -KILL "$ct_pid" 2>/dev/null || :; fi',
    '  done',
    '  sleep 1',
    '  for ct_entry in $ct_entries; do',
    '    ct_pid=${ct_entry%%:*}; ct_birth=${ct_entry#*:}',
    '    ct_actual=$(ct_stop_identity "$ct_pid")',
    '    if [ "$ct_actual" = "$ct_birth" ]; then',
    '      ct_state=$(LC_ALL=C ps -p "$ct_pid" -o stat= 2>/dev/null)',
    '      case "$ct_state" in *Z*) :;; *) return 1;; esac',
    '    elif [ -z "$ct_actual" ] && kill -0 "$ct_pid" 2>/dev/null; then return 1; fi',
    '  done',
    '}',
    `if ct_stop_task; then printf '${STOP_MARKER}stopped\\n'; else printf '${STOP_MARKER}unconfirmed\\n'; fi`
  ].join('\n')
}

/** The caller's deadline also covers opening the control channel; abort closes only that channel. */
export function stopSshCommand(client: Client, identity: RemoteProcessIdentity, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let stream: ClientChannel | undefined
    let output = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) {
        try { stream?.close() } catch { /* disconnected */ }
        reject(error)
      } else resolve()
    }
    const abort = (): void => finish(new Error('远端停止确认已取消。'))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    try {
      client.exec(remoteStopCommand(identity), (error, channel) => {
        stream = channel
        if (settled) { try { channel?.close() } catch { /* disconnected */ }; return }
        if (error) { finish(new Error(`无法打开远端停止通道：${error.message}`)); return }
        channel.on('error', (error: Error) => finish(error))
        channel.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-4096) })
        channel.on('close', (code: number | null) => {
          if (code === 0 && output.split(/\r?\n/).includes(STOP_MARKER + 'stopped')) finish()
          else finish(new Error('远端未确认命令及其子进程已停止。'))
        })
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
