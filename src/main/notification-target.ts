import { isConversationId } from '../shared/types'
import { platformById } from '../shared/platforms'

export interface NotificationTarget {
  sessionId: string
  platformId: string
  conversationId: string | null
}

export function notificationProtocol(packaged: boolean): string {
  return packaged ? 'web2term' : 'web2term-dev'
}

export function notificationTargetUrl(protocol: string, target: NotificationTarget): string {
  const url = new URL(`${protocol}://notification/open`)
  url.searchParams.set('session', target.sessionId)
  url.searchParams.set('platform', target.platformId)
  if (target.conversationId) url.searchParams.set('conversation', target.conversationId)
  return url.href
}

export function parseNotificationTarget(value: string, protocol: string): NotificationTarget | null {
  if (value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== `${protocol}:` || url.hostname !== 'notification' || url.pathname !== '/open' ||
      url.username || url.password || url.port || url.hash) return null
    const allowed = new Set(['session', 'platform', 'conversation'])
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null
    }
    const sessionId = url.searchParams.get('session') ?? ''
    const platformId = url.searchParams.get('platform') ?? ''
    const conversationId = url.searchParams.get('conversation')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ||
      !platformById(platformId) || conversationId !== null && !isConversationId(conversationId)) return null
    return { sessionId, platformId, conversationId }
  } catch { return null }
}

function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[char]!)
}

export function notificationToastXml(url: string, title: string, body: string): string {
  // Protocol activation avoids Electron's COM relaunch of a bare electron.exe in development.
  return `<toast activationType="protocol" launch="${escapeXml(url)}"><visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual><audio silent="true"/></toast>`
}

/** Keep a cold-start click until the saved sessions and workspace selection have been restored. */
export class NotificationActivationRouter {
  private ready = false
  private pending: NotificationTarget | null = null

  constructor(
    private readonly protocol: string,
    private readonly activate: (target: NotificationTarget) => boolean,
    private readonly unavailable: () => void
  ) {}

  handleCommandLine(argv: string[]): boolean {
    for (const argument of argv) {
      const target = parseNotificationTarget(argument, this.protocol)
      if (!target) continue
      if (this.ready) this.open(target)
      else this.pending = target
      return true
    }
    return false
  }

  markReady(): void {
    this.ready = true
    const target = this.pending
    this.pending = null
    if (target) this.open(target)
  }

  private open(target: NotificationTarget): void {
    if (this.activate(target)) return
    console.warn('[notification] target conversation is unavailable or busy')
    this.unavailable()
  }
}
