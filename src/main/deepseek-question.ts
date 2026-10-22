import { randomUUID } from 'node:crypto'
import { DeepSeekQuestionError, selectionQuestionConversation, selectionQuestionPrompt, supportsSelectionQuestion } from '../shared/deepseek-question'
import type { SelectionQuestionDraft, QuestionChatAction, QuestionChatState } from '../shared/deepseek-question'
import { questionPageCall, writeQuestionLog } from './question-chat-page'
import { QuestionChat } from './question-chat'
import { saveQuestionContextMarkdown } from './deepseek-context-markdown'
import { savedQuestionSnapshot } from '../shared/deepseek-context-markdown'
import type { SavedQuestionContextReader } from '../shared/deepseek-context-markdown'
import type { AppTheme } from '../shared/types'
import type { ChatPlatform } from '../shared/platforms'
import type { BrowserWindow } from 'electron'

export class SelectionQuestion {
  readonly reportTag: string
  private nativeEnterAt = 0
  private active: AbortController | null = null
  private chat: QuestionChat | null = null
  private destroyed = false
  private visible = true

  constructor(
    private readonly contents: Electron.WebContents,
    private readonly parent: BrowserWindow,
    private readonly platform: ChatPlatform,
    private readonly theme: () => AppTheme,
    private readonly onState: (state: QuestionChatState | null) => void,
    private readonly readContext: SavedQuestionContextReader
  ) {
    this.reportTag = '[' + platform.id + '-question-' + randomUUID() + '] '
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Enter' && !input.isAutoRepeat &&
          !input.shift && !input.control && !input.alt && !input.meta && !input.isComposing) this.nativeEnterAt = Date.now()
    })
    contents.on('console-message', details => {
      if (details.frame !== contents.mainFrame || !details.message.startsWith(this.reportTag)) return
      try {
        const event = JSON.parse(details.message.slice(this.reportTag.length)) as Record<string, unknown>
        if (event.event === 'question-ui') {
          if (!['configured', 'drag-start', 'drag-end', 'no-selection', 'answer-rejected', 'previously-dismissed', 'out-of-view', 'shown', 'selection-error'].includes(String(event.phase))) return
          const metadata: Record<string, unknown> = { platformId: this.platform.id, phase: event.phase }
          for (const key of ['selectorCount', 'answerCount', 'selectedLength']) {
            const value = event[key]
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000000) metadata[key] = value
          }
          for (const key of ['startAnswerFound', 'endAnswerFound', 'sameAnswer', 'popoverSupported', 'trustedTypesBlocked']) {
            if (typeof event[key] === 'boolean') metadata[key] = event[key]
          }
          if (['Error', 'TypeError', 'NotSupportedError', 'InvalidStateError'].includes(String(event.errorName))) metadata.errorName = event.errorName
          if (['selection-read', 'answer-match', 'ui-create', 'popover-open', 'position'].includes(String(event.errorStage))) metadata.errorStage = event.errorStage
          writeQuestionLog('QUESTION-UI', metadata)
          return
        }
        if (event.event === 'question-cancel') { this.cancel(); return }
        if (event.event !== 'question-submit' || Date.now() - this.nativeEnterAt > 1500) return
        this.nativeEnterAt = 0
        void this.submit()
      } catch { /* Unknown page reports are ignored. */ }
    })
    contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) this.cancel() })
    contents.on('did-navigate-in-page', (_event, _url, isMain) => { if (isMain) this.cancel() })
    contents.once('destroyed', () => this.destroy())
  }

  cancel(): void { const previous = this.active; this.active = null; previous?.abort() }
  setTheme(theme: AppTheme): void { this.chat?.setTheme(theme) }
  getState(): QuestionChatState | null { return this.chat?.getState() ?? null }
  createChat(): QuestionChatState | null {
    if (this.destroyed || this.contents.isDestroyed() || this.parent.isDestroyed() || !supportsSelectionQuestion(this.platform.id)) return null
    this.cancel()
    this.nativeEnterAt = 0
    const previous = this.chat
    this.chat = null
    previous?.close()
    this.chat = new QuestionChat(this.parent, this.platform, this.theme(), this.contents.getUserAgent(),
      '', '', this.onState, '')
    this.chat.setOwnerVisible(this.visible)
    void this.contents.executeJavaScript('window.__cmdTerminalSelectionQuestion?.dismiss();true').catch(() => {})
    return this.chat.getState()
  }
  setVisible(visible: boolean): void { this.visible = visible; this.chat?.setOwnerVisible(visible) }
  setViewport(id: string, bounds: unknown, visible: boolean): void { if (this.chat?.id === id) this.chat.setViewport(bounds, visible) }
  action(id: string, action: QuestionChatAction): void {
    const chat = this.chat
    if (chat?.id !== id) return
    if (action === 'close') this.chat = null
    chat.action(action)
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancel()
    this.chat?.close()
    this.chat = null
  }
  private async status(message: string, pending = false): Promise<void> {
    if (this.destroyed || this.contents.isDestroyed()) return
    await questionPageCall(this.contents, `window.__cmdTerminalSelectionQuestion?.setStatus(${JSON.stringify(message)},${pending});true`).catch(() => {})
  }
  private async submit(): Promise<void> {
    await this.open(() => questionPageCall<SelectionQuestionDraft | null>(this.contents, 'window.__cmdTerminalSelectionQuestion?.getSubmission() || null'),
      (message, pending) => this.status(message, pending))
  }

  /**
   * The app's own focus view asks with a draft it built from its rendered answer.
   *
   * Same pipeline as a page selection — local transcript, Markdown, side chat — but the
   * outcome goes back to the caller instead of the page's popup, which the focus view
   * covers. The draft is bound to the conversation the page shows right now.
   *
   * @returns '' once the side chat is open, otherwise the message to show.
   */
  async askFromFocus(draft: Omit<SelectionQuestionDraft, 'sourcePath'>): Promise<string> {
    if (this.active) return '上一个提问仍在整理，请稍候。'
    const source = selectionQuestionConversation(this.platform.id, this.contents.getURL())
    if (!source) return '当前页面不是可追问的会话，请等待会话打开后重试。'
    let failure = ''
    const opened = await this.open(async () => ({ ...draft, sourcePath: source.path }), async (message, pending) => {
      if (!pending) failure = message
    })
    return opened ? '' : failure || '提问未完成，请重试。'
  }

  /** @returns true once the side chat for this draft is open. */
  private async open(readDraft: () => Promise<SelectionQuestionDraft | null>,
    status: (message: string, pending?: boolean) => Promise<void>): Promise<boolean> {
    if (this.destroyed || this.active || this.parent.isDestroyed()) return false
    const platformId = this.platform.id
    if (!supportsSelectionQuestion(platformId)) return false
    const controller = new AbortController()
    this.active = controller
    const timer = setTimeout(() => controller.abort(), 30000)
    let timedOut = false
    controller.signal.addEventListener('abort', () => { timedOut = this.active === controller }, { once: true })
    try {
      const source = selectionQuestionConversation(platformId, this.contents.getURL())
      const draft = await readDraft()
      if (!source || !draft || draft.sourcePath !== source.path ||
          !['selectedText', 'question', 'answerText'].every(key => typeof draft[key as keyof SelectionQuestionDraft] === 'string') ||
          !draft.question.trim() || !draft.selectedText.trim() || draft.question.length > 20000 ||
          draft.selectedText.length > 20000 || draft.answerText.length > 500000 ||
          (draft.sourceMessageId !== undefined && (typeof draft.sourceMessageId !== 'string' || draft.sourceMessageId.length > 512))) {
        throw new DeepSeekQuestionError('invalid-selection', '选区已失效，请重新选中文字并输入问题。')
      }
      const isCurrent = (): boolean => !this.destroyed && this.active === controller && !controller.signal.aborted &&
        !this.contents.isDestroyed() && selectionQuestionConversation(platformId, this.contents.getURL())?.path === source.path
      if (!isCurrent()) return false
      writeQuestionLog('QUESTION-SUBMIT', { platformId, selectedLength: draft.selectedText.length, questionLength: draft.question.length })
      await status('正在整理本地对话…', true)
      const context = await this.readContext(source.id)
      if (!isCurrent()) return false
      const snapshot = savedQuestionSnapshot(context, source.id, draft, platformId)
      const contextPath = await saveQuestionContextMarkdown(snapshot, controller.signal)
      writeQuestionLog('CONTEXT-SAVED', { platformId, source: 'local-transcript', format: 'markdown', path: contextPath, messageCount: snapshot.messages.length })
      if (!isCurrent()) return false
      this.chat?.close()
      this.chat = new QuestionChat(this.parent, this.platform, this.theme(), this.contents.getUserAgent(),
        selectionQuestionPrompt(draft, platformId), draft.selectedText, this.onState, contextPath)
      this.chat.setOwnerVisible(this.visible)
      // Clear ownership before dismiss() reports a cancellation of the busy UI.
      this.active = null
      await this.contents.executeJavaScript('window.__cmdTerminalSelectionQuestion?.dismiss();true').catch(() => {})
      return true
    } catch (error) {
      if (this.destroyed || (controller.signal.aborted && !timedOut)) return false
      const category = error instanceof DeepSeekQuestionError ? error.category : controller.signal.aborted ? 'timeout' : 'request-failed'
      const path = writeQuestionLog('QUESTION-ERROR', { platformId, category })
      const message = controller.signal.aborted ? '整理本地对话超时，请按 Enter 重试。' : error instanceof DeepSeekQuestionError
        ? error.message : '读取或保存本地对话失败，请按 Enter 重试。'
      await status(`${message}${path ? '\n日志：' + path : ''}`)
      return false
    } finally {
      clearTimeout(timer)
      if (this.active === controller) this.active = null
    }
  }
}

// Keep the existing controller import available to callers and regression fixtures.
export { SelectionQuestion as DeepSeekQuestion }
