import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DesktopActivityEvent } from './windows-helper'

let logPath: string | null = null

/**
 * Why a desktop run stopped: the event kind and the kind of input (keyboard/click/wheel) only.
 * Never key values, positions, window titles or task text. Focus changes are routine and skipped.
 */
export function writeDesktopActivityDiagnostic(event: DesktopActivityEvent, takeover: boolean): string | null {
  if (event.kind === 'focus-changed') return null
  const details = { event: 'desktop-activity', kind: event.kind, input: event.input, takeover,
    taskId: event.owner.taskId, taskGeneration: event.owner.generation, helperGeneration: event.generation }
  try {
    if (!logPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `desktop-activity-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(details)}\n`)
    return logPath
  } catch {
    // A logging failure must not affect the takeover itself.
    return null
  }
}
