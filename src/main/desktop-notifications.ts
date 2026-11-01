import { app, Notification } from 'electron'
import { APP_ID } from './app-identity'
import { notificationProtocol, notificationTargetUrl, notificationToastXml } from './notification-target'
import type { NotificationTarget } from './notification-target'

let protocolRegistered = false
let notificationSound = 'ms-winsoundevent:Notification.Default'
let lastSoundRequestedAt = -Infinity
const visibleNotifications = new Set<Notification>()

/** Register before any session can send a notification. Only the primary instance calls this. */
export function registerDesktopNotifications(sound?: string): void {
  notificationSound = sound ?? 'ms-winsoundevent:Notification.Default'
  if (process.platform !== 'win32') return
  app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.development`)
  const protocol = notificationProtocol(app.isPackaged)
  // Windows must receive an absolute application entry in development. Launching just
  // process.execPath opens Electron's welcome page instead of loading Web2Term.
  protocolRegistered = app.isPackaged
    ? app.setAsDefaultProtocolClient(protocol)
    : app.setAsDefaultProtocolClient(protocol, process.execPath, [app.getAppPath()])
  if (!protocolRegistered) console.warn('[notification] could not register the notification activation protocol')
}

export function showDesktopNotification(
  target: NotificationTarget, title: string, body: string, onClick: () => void
): void {
  if (!Notification.isSupported()) return
  const windows = process.platform === 'win32'
  if (windows && !protocolRegistered) return
  const requestedAt = performance.now()
  const silent = windows && requestedAt - lastSoundRequestedAt < 1000
  const notification = new Notification({ title, body,
    ...(windows ? { silent, toastXml: notificationToastXml(
      notificationTargetUrl(notificationProtocol(app.isPackaged), target), title, body, silent ? null : notificationSound
    ) } : {}) })
  // Coalesce bursts, but leave delivery, sound playback and all mute policies to Windows.
  if (windows && !silent) lastSoundRequestedAt = requestedAt
  visibleNotifications.add(notification)
  const release = (): void => { visibleNotifications.delete(notification) }
  // Windows opens the URI through second-instance/process.argv. Its native click
  // event only releases the reference, so it cannot race the URI and navigate twice.
  notification.once('click', () => { release(); if (!windows) onClick() })
  notification.once('close', release)
  notification.once('failed', (_event, error) => {
    if (windows && !silent && lastSoundRequestedAt === requestedAt) lastSoundRequestedAt = -Infinity
    release()
    console.warn('[notification] failed to show notification:', error)
  })
  notification.show()
}
