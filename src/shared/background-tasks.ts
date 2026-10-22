/** A line printed by the startup command, after it obtained the real child PID. */
export const BACKGROUND_TASK_MARKER = '__W2T_BACKGROUND_TASK__'

export interface BackgroundTaskRegistration {
  pid: number
  name: string
  log_path: string
  stderr_path?: string
  exit_code_path?: string
}

export type BackgroundTaskStatus = 'checking' | 'running' | 'completed' | 'failed' | 'exited' | 'unknown'

export interface BackgroundTask {
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
  message: string
  output: string
  errorOutput: string
  outputTruncated: boolean
  errorOutputTruncated: boolean
}

export interface BackgroundTasksState {
  tasks: BackgroundTask[]
}

/** Only recognize complete, explicitly marked lines from a command's actual output. */
export function parseBackgroundTaskRegistrations(output: string): BackgroundTaskRegistration[] {
  const registrations: BackgroundTaskRegistration[] = []
  for (const line of output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    if (!line.startsWith(BACKGROUND_TASK_MARKER) || line.length > 16384) continue
    try {
      const value = JSON.parse(line.slice(BACKGROUND_TASK_MARKER.length))
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
