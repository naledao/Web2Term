import { WebContentsView, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ChatPlatform } from '../shared/platforms'
import type { AppTheme, EmbedBounds } from '../shared/types'
import { questionChatBounds } from '../shared/deepseek-question'
import { questionPageCall } from './question-chat-page'
import { sendQuestionChatAttachment } from './question-chat-send'
import interceptorSource from './injected/send-interceptor.js?raw'
import readinessSource from './injected/question-chat-sender.js?raw'
import themeSource from './injected/theme.js?raw'

export interface CompactionPageSnapshot {
  path: string
  ready: boolean
  nativeDraft: boolean
  generating: 'active' | 'idle' | 'unknown'
  requestFound: boolean
  hasHistory: boolean
  replyId: string
  answer: string
  cutOff: boolean
  sendFailure: boolean
  oversized: boolean
  uploadReady: boolean
}

/** Isolated native page: no console bridge, command runner, terminal or tool handlers. */
export class CompactionPage {
  readonly view: WebContentsView
  private disposed = false
  private ownerVisible = true
  private viewportVisible = false
  private configuredUrl = ''
  private readonly parentClosed = (): void => this.close()
  constructor(private readonly parent: BrowserWindow, private readonly platform: ChatPlatform,
    private theme: AppTheme, url: string, onUrl: (url: string) => void, initialBounds?: EmbedBounds) {
    this.view = new WebContentsView({ webPreferences: { partition: platform.partition, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: false } })
    this.view.setBackgroundColor(theme === 'dark' ? '#0a0a0a' : '#ffffff')
    // Match the primary embed's Chromium UA rather than exposing Electron to auth pages.
    this.view.webContents.setUserAgent(this.view.webContents.getUserAgent()
      .replace(/\sElectron\/[^\s]+/g, '').replace(/\sweb2term\/[^\s]+/gi, ''))
    parent.contentView.addChildView(this.view)
    // Initialize the native content viewport while the view is still blank, before
    // hiding or loading. A 0x0 hidden viewport prevents virtual chat rows mounting.
    const [width, height] = parent.getContentSize()
    const bounds = initialBounds && initialBounds.width > 0 && initialBounds.height > 0
      ? questionChatBounds(initialBounds, width, height) : null
    this.view.setBounds(bounds && bounds.width > 0 && bounds.height > 0 ? bounds :
      { x: 0, y: 0, width: Math.max(1, Math.min(1280, width)), height: Math.max(1, Math.min(800, height)) })
    this.view.setVisible(false)
    this.keepRenderingWhileHidden()
    parent.once('closed', this.parentClosed)
    this.view.webContents.setWindowOpenHandler(({ url: target }) => {
      try { if (['https:', 'http:'].includes(new URL(target).protocol)) void shell.openExternal(target).catch(() => {}) } catch { /* Invalid link. */ }
      return { action: 'deny' }
    })
    this.view.webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) this.configuredUrl = '' })
    this.view.webContents.on('dom-ready', () => this.keepRenderingWhileHidden())
    this.view.webContents.on('did-finish-load', () => this.keepRenderingWhileHidden())
    this.view.webContents.on('did-navigate', (_event, target) => { this.keepRenderingWhileHidden(); onUrl(target) })
    this.view.webContents.on('did-navigate-in-page', (_event, target, main) => { if (main) { this.keepRenderingWhileHidden(); onUrl(target) } })
    void this.view.webContents.loadURL(url).catch(() => {})
  }
  get url(): string { return this.view.webContents.isDestroyed() ? '' : this.view.webContents.getURL() }
  get visible(): boolean { return !this.disposed && this.ownerVisible && this.viewportVisible }
  /** Automation does not depend on whether the optional troubleshooting page is shown. */
  get available(): boolean { return !this.disposed }
  setOwnerVisible(visible: boolean): void {
    this.ownerVisible = visible
    if (!visible) this.viewportVisible = false
    this.applyVisibility()
  }
  setViewport(raw: unknown, visible: boolean): void {
    if (this.disposed || this.parent.isDestroyed()) return
    const [width, height] = this.parent.getContentSize()
    const bounds = questionChatBounds(raw, width, height)
    this.viewportVisible = !!bounds && visible && bounds.width > 0 && bounds.height > 0
    // Hiding the optional UI must preserve the worker's last nonzero viewport.
    if (bounds && bounds.width > 0 && bounds.height > 0) this.view.setBounds(bounds)
    this.applyVisibility()
  }
  private applyVisibility(): void {
    if (this.disposed) return
    this.view.setVisible(this.visible)
    if (!this.visible) this.keepRenderingWhileHidden()
  }
  private keepRenderingWhileHidden(): void {
    if (this.disposed || this.view.webContents.isDestroyed()) return
    try { this.view.webContents.setBackgroundThrottling(false) } catch { /* Closing. */ }
  }
  setTheme(theme: AppTheme): void { this.theme = theme; this.configuredUrl = '' }
  async read(marker: string, fileName: 'source.md' | 'summary.md'): Promise<CompactionPageSnapshot | null> {
    const contents = this.view.webContents
    if (this.disposed || contents.isDestroyed()) throw new Error('压缩网页已关闭，请点“继续检查”重新打开。')
    const url = this.url
    try { if (new URL(url).origin !== new URL(this.platform.homeUrl).origin) return null } catch { return null }
    if (this.configuredUrl !== url) {
      const theme = this.platform.page.theme
      await questionPageCall(contents, `${interceptorSource}\n;window.__cmdTerminalInterceptor.configure(${JSON.stringify({
        enabled: false, computerUseEnabled: false, promptInjectionEnabled: false, prefix: '', armBaseline: true, page: this.platform.page
      })});${themeSource}\n;window.__cmdTerminalTheme.configure(${JSON.stringify({ theme: this.theme,
        dark: theme?.dark ?? [], light: theme?.light ?? [], storage: theme?.storage ?? [] })});true`)
      this.configuredUrl = url
    }
    const snapshot = await questionPageCall<CompactionPageSnapshot | null>(contents,
      `window.__cmdTerminalInterceptor?.compactionSnapshot(${JSON.stringify(marker)},${JSON.stringify(fileName)}) ?? null`)
    if (this.url !== url || !snapshot || snapshot.path !== new URL(url).pathname) return null
    const ready = await questionPageCall<{ uploadReady: boolean }>(contents,
      `${readinessSource}\n;window.__questionChatReady(${JSON.stringify(this.platform.page)})`)
    return { ...snapshot, uploadReady: ready.uploadReady === true }
  }
  send(path: string, prompt: string, signal: AbortSignal, isCurrent: () => boolean, beforeSubmit: () => void): ReturnType<typeof sendQuestionChatAttachment> {
    return sendQuestionChatAttachment(this.view.webContents, this.platform, path, prompt, signal,
      () => this.available && isCurrent(), beforeSubmit, 'unlimited')
  }
  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.parent.removeListener('closed', this.parentClosed)
    if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(this.view)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }
}
