import { randomUUID } from 'node:crypto'
import { DeepSeekQuestionError, deepSeekConversation, deepSeekAttachmentPrompt } from '../shared/deepseek-question'
import type { DeepSeekSelection, QuestionChatAction, QuestionChatState } from '../shared/deepseek-question'
import { createDeepSeekSelectionShare, questionPageCall, releaseDeepSeekHeaders, writeQuestionLog } from './deepseek-share'
import { QuestionChat } from './question-chat'
import { saveDeepSeekContextHtml } from './deepseek-context-html'
import type { AppTheme } from '../shared/types'
import type { ChatPlatform } from '../shared/platforms'
import type { BrowserWindow } from 'electron'

export class DeepSeekQuestion {
  readonly reportTag = '[deepseek-question-' + randomUUID() + '] '
  private nativeEnterAt = 0
  private active: AbortController | null = null
  private chat: QuestionChat | null = null
  private destroyed = false
  private readonly contentsId: number
  private visible = true

  constructor(
    private readonly contents: Electron.WebContents,
    private readonly parent: BrowserWindow,
    private readonly platform: ChatPlatform,
    private readonly theme: () => AppTheme,
    private readonly onState: (state: QuestionChatState | null) => void = () => {}
  ) {
    this.contentsId = contents.id
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Enter' && !input.isAutoRepeat &&
          !input.shift && !input.control && !input.alt && !input.meta && !input.isComposing) this.nativeEnterAt = Date.now()
    })
    contents.on('console-message', details => {
      if (details.frame !== contents.mainFrame || !details.message.startsWith(this.reportTag)) return
      try {
        const event = JSON.parse(details.message.slice(this.reportTag.length)) as { event?: unknown }
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
  setVisible(visible: boolean): void { this.visible = visible; this.chat?.setOwnerVisible(visible) }
  setViewport(id: string, bounds: unknown, visible: boolean): void { if (this.chat?.id === id) this.chat.setViewport(bounds, visible) }
  action(id: string, action: QuestionChatAction): void { if (this.chat?.id === id) this.chat.action(action) }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancel()
    this.chat?.close()
    this.chat = null
    releaseDeepSeekHeaders(this.contentsId)
  }
  private async status(message: string, pending = false): Promise<void> {
    if (this.destroyed || this.contents.isDestroyed()) return
    await questionPageCall(this.contents, `window.__cmdTerminalSelectionQuestion?.setStatus(${JSON.stringify(message)},${pending});true`).catch(() => {})
  }
  private async submit(): Promise<void> {
    if (this.destroyed || this.active || this.parent.isDestroyed()) return
    const controller = new AbortController()
    this.active = controller
    const timer = setTimeout(() => controller.abort(), 30000)
    let timedOut = false
    controller.signal.addEventListener('abort', () => { timedOut = this.active === controller }, { once: true })
    try {
      const source = deepSeekConversation(this.contents.getURL())
      const draft = await questionPageCall<DeepSeekSelection | null>(this.contents, 'window.__cmdTerminalSelectionQuestion?.getSubmission() || null')
      if (!source || !draft || draft.sourcePath !== source.path ||
          !['selectedText', 'question', 'answerText'].every(key => typeof draft[key as keyof DeepSeekSelection] === 'string') ||
          !draft.question.trim() || !draft.selectedText.trim() || draft.question.length > 20000 ||
          draft.selectedText.length > 20000 || draft.answerText.length > 500000) {
        throw new DeepSeekQuestionError('invalid-selection', '选区已失效，请重新选中文字并输入问题。')
      }
      const isCurrent = (): boolean => !this.destroyed && this.active === controller && !controller.signal.aborted &&
        !this.contents.isDestroyed() && deepSeekConversation(this.contents.getURL())?.path === source.path
      if (!isCurrent()) return
      writeQuestionLog('QUESTION-SUBMIT', { selectedLength: draft.selectedText.length, questionLength: draft.question.length })
      await this.status('正在获取分享链接…', true)
      let htmlPath = ''
      const url = await createDeepSeekSelectionShare(this.contents, source.id, draft, controller.signal, isCurrent, async snapshot => {
        htmlPath = await saveDeepSeekContextHtml(snapshot)
        writeQuestionLog('HTML-SAVED', { path: htmlPath, messageCount: snapshot.messages.length })
      })
      if (!isCurrent()) return
      this.chat?.close()
      this.chat = new QuestionChat(this.parent, this.platform, this.theme(), this.contents.getUserAgent(),
        url, deepSeekAttachmentPrompt(draft), draft.selectedText, this.onState, htmlPath)
      this.chat.setOwnerVisible(this.visible)
      // Clear ownership before dismiss() reports a cancellation of the busy UI.
      this.active = null
      await this.contents.executeJavaScript('window.__cmdTerminalSelectionQuestion?.dismiss();true').catch(() => {})
    } catch (error) {
      if (this.destroyed || (controller.signal.aborted && !timedOut)) return
      const category = error instanceof DeepSeekQuestionError ? error.category : controller.signal.aborted ? 'timeout' : 'request-failed'
      const path = writeQuestionLog('QUESTION-ERROR', { category })
      const message = controller.signal.aborted ? '获取分享链接超时，请按 Enter 重试。' : error instanceof DeepSeekQuestionError
        ? error.message : '获取分享链接失败，请检查网络后按 Enter 重试。'
      await this.status(`${message}${path ? '\n日志：' + path : ''}`)
    } finally {
      clearTimeout(timer)
      if (this.active === controller) this.active = null
    }
  }
}
