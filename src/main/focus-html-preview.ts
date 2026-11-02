import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import type { FocusHtmlPreviewOutcome, FocusHtmlPreviewRequest } from '../shared/focus-html-preview'
import { validateFocusHtmlPreview } from '../shared/focus-html-preview'
import previewShell from './focus-html-preview.html?raw'

const RESOURCE_POLICY = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; " +
  "img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; worker-src blob:; "

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The supplied HTML occurs only as escaped text/attributes, never as shell markup or JS. */
export function focusHtmlPreviewDocument(request: FocusHtmlPreviewRequest): string {
  const bootstrap = `<script>(() => {
    const report = message => parent.postMessage({ type: 'focus-html-preview-error', message: String(message).slice(0, 500) }, '*');
    addEventListener('error', event => {
      if (event.target === window) report(event.message || '页面脚本运行出错。');
      else if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement) report('外部资源加载失败，请检查网络或资源地址。');
    }, true);
    addEventListener('unhandledrejection', event => report(event.reason?.message || event.reason || '页面脚本运行出错。'));
    addEventListener('securitypolicyviolation', () => report('页面请求了预览不支持的资源或能力。'));
  })();</script>`
  const document = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + RESOURCE_POLICY + "frame-src 'none'\">" + bootstrap +
    request.html.replace(/^\s*<!doctype[^>]*>/i, '')
  const values: Record<string, string> = {
    theme: request.theme,
    policy: escapeHtml(RESOURCE_POLICY + 'frame-src about:'),
    document: escapeHtml(document),
    source: escapeHtml(request.html)
  }
  // One replacement pass: a template token inside the user's code must remain literal.
  return previewShell.replace(/\{\{(theme|policy|document|source)\}\}/g, (_match, key: string) => values[key])
}

/** A fresh memory-only session and a renderer with no preload or app bridge per snapshot. */
export async function openFocusHtmlPreview(parent: BrowserWindow, value: unknown, proxy: string): Promise<FocusHtmlPreviewOutcome> {
  const outcome = validateFocusHtmlPreview(value)
  if (outcome !== 'ok') return outcome
  if (parent.isDestroyed()) return 'unavailable'
  const request = value as FocusHtmlPreviewRequest
  const previewSession = session.fromPartition(`focus-html-preview-${randomUUID()}`, { cache: false })
  let window: BrowserWindow | null = null
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    previewSession.webRequest.onBeforeRequest(null)
    previewSession.removeAllListeners('will-download')
    previewSession.setPermissionRequestHandler(null)
    previewSession.setPermissionCheckHandler(null)
    void previewSession.closeAllConnections().catch(() => {})
    void previewSession.clearStorageData().catch(() => {})
  }
  try {
    await previewSession.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'direct' })
    if (parent.isDestroyed()) { release(); return 'unavailable' }
    previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    previewSession.setPermissionCheckHandler(() => false)
    previewSession.on('will-download', event => event.preventDefault())
    // Enforce the protocol boundary for redirects and nested requests as well as HTML markup.
    previewSession.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false
      try { allowed = ['https:', 'data:', 'blob:', 'about:'].includes(new URL(details.url).protocol) } catch { /* Deny malformed URLs. */ }
      callback({ cancel: !allowed })
    })
    window = new BrowserWindow({
      parent, title: 'HTML 预览 · Web2Term', width: 1180, height: 820, minWidth: 520, minHeight: 400,
      show: false, autoHideMenuBar: true, backgroundColor: request.theme === 'dark' ? '#171923' : '#f5f6fa',
      webPreferences: {
        session: previewSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false,
        webSecurity: true, allowRunningInsecureContent: false, safeDialogs: true
      }
    })
    const preview = window
    const close = (): void => { if (!preview.isDestroyed()) preview.destroy() }
    parent.once('closed', close)
    preview.once('closed', () => {
      parent.removeListener('closed', close)
      release()
    })
    preview.setMenu(null)
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    preview.webContents.on('will-navigate', event => event.preventDefault())
    preview.webContents.on('will-frame-navigate', event => {
      if (event.isMainFrame || event.url !== 'about:srcdoc') event.preventDefault()
    })
    preview.webContents.on('will-attach-webview', event => event.preventDefault())
    preview.webContents.on('page-title-updated', event => event.preventDefault())
    preview.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); close() }
    })
    // Show the shell as soon as its DOM is ready; a slow CDN inside the frame must not hide the window.
    await Promise.race([
      new Promise<void>(resolve => preview.webContents.once('dom-ready', () => resolve())),
      preview.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(focusHtmlPreviewDocument(request)).toString('base64'))
    ])
    if (preview.isDestroyed() || parent.isDestroyed()) { close(); return 'unavailable' }
    preview.show()
    return 'ok'
  } catch (error) {
    if (window && !window.isDestroyed()) window.destroy()
    release()
    console.warn('[focus-html-preview] failed to open:', error instanceof Error ? error.name : 'unknown error')
    return 'unavailable'
  }
}
