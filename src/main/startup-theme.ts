import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { AppTheme } from '../shared/types'

/** Read only the saved palette before the splash; leave migrations and recovery to ConversationStore. */
export function readStartupTheme(filePath: string): AppTheme {
  if (!existsSync(filePath)) return 'light'
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(filePath, { readOnly: true })
    const row = database.prepare('SELECT value FROM settings WHERE key = ?').get('theme') as { value?: unknown } | undefined
    return row?.value === 'dark' ? 'dark' : 'light'
  } catch {
    // The normal initialization path remains responsible for reporting database failures.
    console.warn('[splash] saved theme unavailable; using the default light palette')
    return 'light'
  } finally {
    database?.close()
  }
}
