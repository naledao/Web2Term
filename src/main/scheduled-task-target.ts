import { posix, win32 } from 'node:path'
import type { ScheduledTaskTarget } from '../shared/scheduled-tasks'

function directoryKey(value: string): string {
  if (/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)) {
    const normalized = win32.normalize(value)
    return (normalized.replace(/[\\/]+$/, '') || normalized).toLowerCase()
  }
  return posix.normalize(value).replace(/\/+$/, '') || '/'
}
export function sameScheduledTarget(a: ScheduledTaskTarget, b: ScheduledTaskTarget): boolean {
  return !!a.cwd && !!b.cwd && a.machineId === b.machineId && a.transport === b.transport && a.key === b.key && directoryKey(a.cwd) === directoryKey(b.cwd)
}
