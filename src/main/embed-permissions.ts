import { session } from 'electron'
import type { WebContents } from 'electron'
import { GEMINI_PLATFORM } from '../shared/platforms'

const blockedPartitions = new Set<string>()
const readOnlyPages = new WeakSet<WebContents>()

export function blockGeminiReadOnlyPagePermissions(contents: WebContents): void {
  readOnlyPages.add(contents)
}

/** Stop Gemini's reply toasts before its pages or service workers start. */
export function blockGeminiWebNotifications(partition = GEMINI_PLATFORM.partition): void {
  if (blockedPartitions.has(partition)) return
  blockedPartitions.add(partition)
  const geminiSession = session.fromPartition(partition)
  // Notification checks can have no webContents (for example, a service worker).
  // Keep chat permissions apart from notifications, and deny them on quota pages.
  geminiSession.setPermissionCheckHandler((contents, permission) => permission !== 'notifications' && (!contents || !readOnlyPages.has(contents)))
  geminiSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission !== 'notifications' && !readOnlyPages.has(contents))
  })
}
