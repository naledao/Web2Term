import { session } from 'electron'
import { GEMINI_PLATFORM } from '../shared/platforms'

const blockedPartitions = new Set<string>()

/** Stop Gemini's reply toasts before its pages or service workers start. */
export function blockGeminiWebNotifications(partition = GEMINI_PLATFORM.partition): void {
  if (blockedPartitions.has(partition)) return
  blockedPartitions.add(partition)
  const geminiSession = session.fromPartition(partition)
  // Notification checks can have no webContents (for example, a service worker).
  // Keep Electron's existing behavior for every permission except notifications.
  geminiSession.setPermissionCheckHandler((_contents, permission) => permission !== 'notifications')
  geminiSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission !== 'notifications')
  })
}
