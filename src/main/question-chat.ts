import { WebContentsView, clipboard, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { questionChatBounds, isQuestionChatHome, selectionQuestionConversation } from '../shared/deepseek-question'
import type { QuestionChatAction, QuestionChatState } from '../shared/deepseek-question'
import senderSource from './injected/question-chat-sender.js?raw'
import themeSource from './injected/theme.js?raw'
import { questionPageCall, writeQuestionLog } from './question-chat-page'
import { sendQuestionChatAttachment } from './question-chat-send'
import type { AppTheme } from '../shared/types'
import type { ChatPlatform, ComposerKind } from '../shared/platforms'

interface QuestionChatReadiness {
  composer: boolean
  hasHistory: boolean
  uploadReady: boolean
  composerCount: number
  composerTag: string
  composerCandidateCount: number
  composerSelectorIndex: number
  composerSelectorCounts: number[]
  fileInputCount: number
  uploadEntryCount: number
  uploadRootFound: boolean
}

/** Native chat in the renderer's right-sidebar slot; no additional BrowserWindow. */
export class QuestionChat {
  readonly id = randomUUID()
  private readonly view: WebContentsView
  private readonly page: { composerKind: ComposerKind; composerSelectors: string[]; sendButtonSelectors: string[]; disabledControlSelectors: string[];
    messageSelectors: string[]; assistantSelectors: string[]; ignoreHiddenReplyNodes: boolean; fileLocalUploadSelector: string;
    fileUploadMenuSelectors: string[]; fileComposerRootSelector: string }
  private timer: NodeJS.Timeout | null = null
  private checking = false
  private readinessErrors = 0
  private lastReadiness = ''
  private attempted = false
  private closed = false
  private readonly uploadAbort = new AbortController()
  private readonly startedAt = Date.now()
  private ownerVisible = false
  private viewportVisible = false
  private readonly parentClosed = (): void => this.close()
  private statusText: string
  private statusError = false

  constructor(
    private readonly parent: BrowserWindow,
    private readonly platform: ChatPlatform,
    private theme: AppTheme,
    userAgent: string,
    private readonly prompt: string,
    private readonly selectedText: string,
    private readonly onState: (state: QuestionChatState | null) => void,
    private readonly contextPath: string
  ) {
    this.statusText = `正在打开新的 ${platform.label} 聊天…`
    this.view = new WebContentsView({ webPreferences: {
      partition: platform.partition, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, spellcheck: false, backgroundThrottling: false
    } })
    this.page = {
      composerKind: platform.page.composerKind,
      composerSelectors: platform.page.composerSelectors, sendButtonSelectors: platform.page.sendButtonSelectors,
      disabledControlSelectors: platform.page.disabledControlSelectors ?? [],
      messageSelectors: platform.page.messageSelectors, assistantSelectors: platform.page.assistantSelectors,
      ignoreHiddenReplyNodes: platform.page.ignoreHiddenReplyNodes ?? false,
      fileLocalUploadSelector: platform.page.fileLocalUploadSelector ?? '',
      fileUploadMenuSelectors: platform.page.fileUploadMenuSelectors ?? [],
      fileComposerRootSelector: platform.page.fileComposerRootSelector ?? ''
    }
    this.view.setBackgroundColor(this.background())
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    this.view.setVisible(false)
    this.parent.contentView.addChildView(this.view)
    this.parent.once('closed', this.parentClosed)
    const contents = this.view.webContents
    contents.setUserAgent(userAgent)
    contents.setWindowOpenHandler(({ url }) => {
      try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url).catch(() => {}) } catch { /* Invalid link. */ }
      return { action: 'deny' }
    })
    contents.on('dom-ready', () => {
      void this.installTheme()
      if (this.prompt && this.contextPath) void this.checkReady()
      else if (!this.closed) this.status('', false)
    })
    contents.on('did-fail-load', (_event, code, _description, _url, isMain) => {
      if (isMain && code !== -3) this.fail('page-load', this.contextPath
        ? `${platform.label} 加载失败（${code}）。可复制提问，待页面恢复后手动发送。`
        : `${platform.label} 加载失败（${code}），请检查网络后重新新建侧边聊天。`)
    })
    contents.on('render-process-gone', () => this.fail('renderer-gone', `${platform.label} 页面进程已退出，请从右侧「＋」重新新建侧边聊天。`))
    void contents.loadURL(platform.homeUrl).catch(() => {
      if (!this.closed) this.fail('page-load', this.contextPath
        ? `${platform.label} 未能打开。请检查网络，或复制提问后手动发送。`
        : `${platform.label} 未能打开，请检查网络后重新新建侧边聊天。`)
    })
    if (this.prompt && this.contextPath) this.timer = setInterval(() => { void this.checkReady() }, 500)
    writeQuestionLog('CHAT-OPEN', { platformId: platform.id, presentation: 'sidebar', mode: this.contextPath ? 'selection' : 'blank', terminalInterceptor: false })
    this.onState(this.getState())
  }

  private background(): string { return this.theme === 'dark' ? '#141a25' : '#ffffff' }
  getState(): QuestionChatState | null {
    return this.closed ? null : { id: this.id, platformId: this.platform.id, selectedText: this.selectedText, contextPath: this.contextPath, status: this.statusText, error: this.statusError }
  }
  setViewport(raw: unknown, visible: boolean): void {
    if (this.closed || this.parent.isDestroyed()) return
    const [width, height] = this.parent.getContentSize()
    const bounds = questionChatBounds(raw, width, height)
    this.viewportVisible = !!bounds && visible && bounds.width > 0 && bounds.height > 0
    if (bounds) this.view.setBounds(bounds)
    this.applyVisibility()
  }
  setOwnerVisible(visible: boolean): void {
    this.ownerVisible = visible
    // A newly activated session must receive a fresh rectangle from its own UI.
    if (!visible) this.viewportVisible = false
    this.applyVisibility()
  }
  private applyVisibility(): void {
    if (!this.closed) this.view.setVisible(this.ownerVisible && this.viewportVisible)
  }
  action(action: QuestionChatAction): void {
    if (this.closed) return
    if (action === 'close') this.close()
    if (action === 'copy-prompt' && this.prompt) { clipboard.writeText(this.prompt); this.status('提问已复制。手动发送时，请同时附上本地 Markdown。', false) }
    if (action === 'open-context' && this.contextPath) {
      void shell.openPath(this.contextPath).then(error => {
        if (error && !this.closed) this.status('无法打开 Markdown，请用“定位文件”查看保存位置。', true)
      }).catch(() => { if (!this.closed) this.status('无法打开 Markdown，请用“定位文件”查看保存位置。', true) })
    }
    if (action === 'reveal-context' && this.contextPath) shell.showItemInFolder(this.contextPath)
  }
  private stopPolling(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
  private status(text: string, error: boolean): void {
    if (text === this.statusText && error === this.statusError) return
    this.statusText = text; this.statusError = error
    if (!this.closed) this.onState(this.getState())
  }
  private fail(reason: string, text: string): void {
    this.stopPolling()
    if (this.attempted) this.uploadAbort.abort()
    this.status(text, true)
    writeQuestionLog('CHAT-ERROR', { platformId: this.platform.id, reason })
  }
  private async installTheme(): Promise<void> {
    if (this.closed) return
    const contents = this.view.webContents
    try { if (new URL(contents.getURL()).origin !== new URL(this.platform.homeUrl).origin) return } catch { return }
    const rules = this.platform.page.theme
    await questionPageCall(contents, `${themeSource};window.__cmdTerminalTheme.configure(${JSON.stringify({
      theme: this.theme, dark: rules?.dark ?? [], light: rules?.light ?? [], storage: rules?.storage ?? []
    })});true`).catch(() => {})
  }
  setTheme(theme: AppTheme): void {
    this.theme = theme
    if (this.closed) return
    this.view.setBackgroundColor(this.background())
    void this.installTheme()
  }
  private async checkReady(): Promise<void> {
    if (!this.prompt || !this.contextPath || this.closed || this.attempted || this.checking || !this.ownerVisible || !this.viewportVisible) return
    if (Date.now() - this.startedAt > 90000) {
      this.fail('ready-timeout', `尚未准备好发送。请完成 ${this.platform.label} 登录，再手动上传本地 Markdown 并粘贴提问。`); return
    }
    const contents = this.view.webContents
    if (contents.isDestroyed()) return
    let url: URL
    try { url = new URL(contents.getURL()) } catch { return }
    if (url.origin !== new URL(this.platform.homeUrl).origin) { this.status(`请先在下方完成 ${this.platform.label} 登录或验证。`, false); return }
    if (!isQuestionChatHome(this.platform.id, url.href)) {
      if (selectionQuestionConversation(this.platform.id, url.href)) this.fail('not-new-chat', '当前页面不是空白新聊天，已停止自动发送。可复制提问后手动开启新聊天。')
      else this.status(`请先完成 ${this.platform.label} 登录或验证，等待返回新聊天页面。`, false)
      return
    }
    this.checking = true
    try {
      const ready = await questionPageCall<QuestionChatReadiness>(contents, `${senderSource}\n;window.__questionChatReady(${JSON.stringify(this.page)})`)
      this.readinessErrors = 0
      if (this.closed || !this.ownerVisible || !this.viewportVisible) return
      const readiness = JSON.stringify(ready)
      if (readiness !== this.lastReadiness) {
        this.lastReadiness = readiness
        writeQuestionLog('CHAT-READY-STATE', { platformId: this.platform.id, elapsedMs: Date.now() - this.startedAt, ...ready })
      }
      if (ready.hasHistory) { this.fail('not-empty', '页面已有聊天内容，已停止自动发送。可复制提问后手动开启新聊天。'); return }
      if (!ready.composer) {
        this.status(ready.composerCount > 1 ? `请点击下方 ${this.platform.label} 输入框以继续发送。`
          : `等待 ${this.platform.label} 输入框就绪；如需登录，请在下方完成。`, false)
        return
      }
      if (!ready.uploadReady) { this.status(`等待 ${this.platform.label} 附件上传入口就绪…`, false); return }
      this.attempted = true
      this.stopPolling()
      this.status('正在上传本地对话 Markdown 并发送问题…', false)
      writeQuestionLog('CHAT-SEND-START', { platformId: this.platform.id, context: 'local-markdown', promptLength: this.prompt.length })
      const timeout = setTimeout(() => this.uploadAbort.abort(), 150000)
      let result: Awaited<ReturnType<typeof sendQuestionChatAttachment>>
      try {
        result = await sendQuestionChatAttachment(contents, this.platform, this.contextPath, this.prompt, this.uploadAbort.signal,
          () => !this.closed && !contents.isDestroyed())
      } finally { clearTimeout(timeout) }
      if (this.closed) return
      writeQuestionLog('CHAT-SEND-RESULT', { platformId: this.platform.id, outcome: result })
      if (result === 'ok') this.status('', false)
      else this.fail('send-' + result, result === 'unknown' || result === 'stuck'
        ? '已尝试发送，尚未确认附件和问题均已收到。请检查下方聊天，系统不会重复提交。'
        : result === 'unsupported-file-type'
          ? `${this.platform.label} 当前上传入口不接受 Markdown 文件。文件已保留，可打开检查；本次未自动发送问题。`
          : '附件和问题未能自动发送。请检查下方聊天；可用“定位文件”手动上传 Markdown，并用“复制提问”补充问题。')
    } catch {
      if (!this.closed && this.attempted) this.fail('send-interrupted', '发送时页面发生变化，请检查聊天是否已收到问题；系统不会重复发送。')
      else if (!this.closed && ++this.readinessErrors >= 3) this.fail('ready-check', `暂时无法读取 ${this.platform.label} 输入框，可用“复制提问”粘贴到下方聊天中发送。`)
    } finally { this.checking = false }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.uploadAbort.abort()
    this.stopPolling()
    this.parent.removeListener('closed', this.parentClosed)
    const contents = this.view.webContents
    if (!this.parent.isDestroyed()) this.parent.contentView.removeChildView(this.view)
    if (!contents.isDestroyed()) contents.close()
    this.onState(null)
    writeQuestionLog('CHAT-CLOSED', { platformId: this.platform.id, sendAttempted: this.attempted })
  }
}
