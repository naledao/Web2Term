import { WebContentsView } from 'electron'
import type { Session, WebContents } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import { GEMINI_USAGE_REFRESH_MS, parseGeminiUsageSnapshot } from '../shared/gemini-usage'
import type { GeminiUsageResult } from '../shared/gemini-usage'
import { blockGeminiReadOnlyPagePermissions } from './embed-permissions'
import usageSource from './injected/gemini-usage.js?raw'

const GEMINI_ORIGIN = 'https://gemini.google.com'
const RETRY_MS = 60_000
const MIN_REFRESH_MS = 10_000
const LOAD_TIMEOUT_MS = 25_000

interface CachedUsage {
  result?: GeminiUsageResult
  startedAt: number
  nextReadAt: number
  pending?: Promise<GeminiUsageResult>
}

const accountUsage = new WeakMap<Session, Map<string, CachedUsage>>()

function canReadUsage(url: string, accountPrefix: string): boolean {
  try {
    const page = new URL(url)
    const path = page.pathname.replace(/\/$/, '')
    return page.origin === GEMINI_ORIGIN && (path === accountPrefix + 'usage' || (accountPrefix === '/' && path === '/u/0/usage'))
  } catch { return false }
}

async function fetchUsage(accountSession: Session, userAgent: string, accountPrefix: string): Promise<GeminiUsageResult> {
  const view = new WebContentsView({ webPreferences: {
    session: accountSession, nodeIntegration: false, sandbox: true, contextIsolation: true,
    webSecurity: true, backgroundThrottling: false, devTools: false
  } })
  const contents = view.webContents
  // Size the unattached view before loading so Google's visible quota cards render.
  view.setBounds({ x: 0, y: 0, width: 1100, height: 760 })
  blockGeminiReadOnlyPagePermissions(contents)
  contents.setUserAgent(userAgent)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  let stop: (result: GeminiUsageResult) => void = () => {}
  const stopped = new Promise<GeminiUsageResult>(resolve => { stop = resolve })
  const guardNavigation = (event: { isMainFrame: boolean; url: string; preventDefault(): void }): void => {
    if (event.isMainFrame && !canReadUsage(event.url, accountPrefix)) {
      event.preventDefault()
      stop({ outcome: 'redirected', snapshot: null })
    }
  }
  contents.on('will-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
  contents.once('render-process-gone', () => stop({ outcome: 'unavailable', snapshot: null }))
  const preventDownload = (event: Electron.Event, _item: Electron.DownloadItem, source: WebContents): void => {
    if (source === contents) event.preventDefault()
  }
  accountSession.on('will-download', preventDownload)
  const timer = setTimeout(() => stop({ outcome: 'timeout', snapshot: null }), LOAD_TIMEOUT_MS)
  try {
    const reading = (async (): Promise<GeminiUsageResult> => {
      await contents.loadURL(GEMINI_ORIGIN + accountPrefix + 'usage')
      while (!contents.isDestroyed()) {
        const page = contents.getURL()
        // A same-document route change does not emit will-navigate.
        if (!canReadUsage(page, accountPrefix)) return { outcome: 'redirected', snapshot: null }
        const raw: unknown = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: usageSource }]).catch(() => null)
        const snapshot = parseGeminiUsageSnapshot(raw, Date.now())
        if (snapshot && !contents.isDestroyed() && contents.getURL() === page) return { outcome: 'ok', snapshot }
        await delay(750)
      }
      return { outcome: 'unavailable', snapshot: null }
    })()
    return await Promise.race([reading, stopped])
  } finally {
    clearTimeout(timer)
    accountSession.removeListener('will-download', preventDownload)
    // Keep the unattached view alive until its WebContents has been closed.
    if (!contents.isDestroyed()) view.webContents.close()
  }
}

/** Share a short-lived read result only within the active chat's Chromium account session. */
export function readGeminiUsage(accountPage: WebContents, force: boolean): Promise<GeminiUsageResult> {
  const accountSession = accountPage.session
  const accountPrefix = /^\/u\/\d{1,3}\//.exec(new URL(accountPage.getURL()).pathname)?.[0] ?? '/'
  let accounts = accountUsage.get(accountSession)
  if (!accounts) {
    accounts = new Map()
    accountUsage.set(accountSession, accounts)
  }
  let entry = accounts.get(accountPrefix)
  if (!entry) {
    entry = { startedAt: 0, nextReadAt: 0 }
    accounts.set(accountPrefix, entry)
  }
  if (entry.pending) return entry.pending

  const now = Date.now()
  if (entry.result && (now - entry.startedAt < MIN_REFRESH_MS || (!force && now < entry.nextReadAt))) return Promise.resolve(entry.result)
  entry.startedAt = now
  const cache = entry
  cache.pending = fetchUsage(accountSession, accountPage.getUserAgent(), accountPrefix)
    .catch((): GeminiUsageResult => ({ outcome: 'unavailable', snapshot: null }))
    .then(result => {
      const snapshot = result.outcome === 'redirected' ? null : result.snapshot ?? cache.result?.snapshot ?? null
      cache.result = { outcome: result.outcome, snapshot }
      cache.nextReadAt = Date.now() + (result.outcome === 'ok' ? GEMINI_USAGE_REFRESH_MS : RETRY_MS)
      return cache.result
    }).finally(() => { cache.pending = undefined })
  return cache.pending
}
