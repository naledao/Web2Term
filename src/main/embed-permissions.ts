import { session } from 'electron'
import { GEMINI_PLATFORM } from '../shared/platforms'

/** Stop Gemini's reply toasts before its pages or service workers start. */
export function blockGeminiWebNotifications(): void {
  const geminiSession = session.fromPartition(GEMINI_PLATFORM.partition)
  // Notification checks can have no webContents (for example, a service worker).
  // Keep Electron's existing behavior for every permission except notifications.
  geminiSession.setPermissionCheckHandler((_contents, permission) => permission !== 'notifications')
  geminiSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission !== 'notifications')
  })
}
