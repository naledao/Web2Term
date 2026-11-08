import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ManagedSessionRecord } from './db'
import type { CompactionPage } from './compaction-page'
import type { CompactionPageSnapshot } from './compaction-page'
import type { WebContents } from 'electron'
import { compactionViewKey } from './conversation-continuity'
import type { ConversationViewSnapshot } from './conversation-continuity'
import type { FocusOwner } from '../shared/focus-chat'
import type { ConversationToolPreferences } from '../shared/conversation-tools'
import type { Web2termSessionBinding } from './web2term-shell'
import type { CompactionPhase, CompactionSource, CompactionState, CompactionBudget } from '../shared/conversation-compaction'
import { COMPACTION_ACTIVE, compactionSourceMarkdown, compactionPrompt, compactionHandoffPrompt, compactionRequestMarker,
  compactionRecoveryPrompt, compactionReplyText, supportsCompaction } from '../shared/conversation-compaction'
import { compactionBudget } from '../shared/conversation-compaction'
import { estimateContextText } from '../shared/focus-token-usage'
import { isQuestionChatHome, selectionQuestionConversation } from '../shared/deepseek-question'

export interface CompactionSeed {
  session: Omit<ManagedSessionRecord, 'updatedAt'>
  preferences: ConversationToolPreferences
  binding?: Web2termSessionBinding
}
export interface StoredCompaction {
  version: 1
  state: CompactionState
  seed: CompactionSeed
  sourceHash: string
  summaryHash: string
  sourceUrl: string | null
  handoffUrl: string | null
  sourceDelivery: 'none' | 'uncertain' | 'sent'
  handoffDelivery: 'none' | 'uncertain' | 'sent'
  handoffAnswer: string | null
  handoffReplyId?: string
  targetId: string
  budget?: CompactionBudget
}
interface SettingsStore { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
type Page = Pick<CompactionPage, 'url' | 'available' | 'setViewport' | 'setOwnerVisible' | 'setTheme' | 'read' | 'clearDraft' | 'send' | 'close'>
interface Options {
  sessionId: string
  directory: string
  store: SettingsStore
  makePage(platformId: string, url: string, onUrl: (url: string) => void): Page
  canWork(owner: FocusOwner): boolean
  canAdopt?(owner: FocusOwner): boolean
  createTarget(job: StoredCompaction, summary: string): string
  onStateChanged?(): void
  isAdopted?(job: StoredCompaction): boolean
  now?: () => number
  pause?: () => Promise<void>
  sendPageMessage?(owner: FocusOwner, contents: WebContents, platform: import('../shared/platforms').ChatPlatform,
    path: string, prompt: string, signal: AbortSignal, current: () => boolean, beforeSubmit: () => void): Promise<import('../shared/file-requests').FileSendOutcome>
}
const sameOwner = (a: FocusOwner, b: FocusOwner): boolean => a.sessionId === b.sessionId && a.platformId === b.platformId && a.conversationId === b.conversationId
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
let logPath = ''
function log(job: StoredCompaction): void {
  try {
    if (!logPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `conversation-compaction-${Date.now()}-${process.pid}.log`)
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify({ jobId: job.state.id, platformId: job.state.owner.platformId,
      phase: job.state.phase, sourceDelivery: job.sourceDelivery, handoffDelivery: job.handoffDelivery,
      sourceMessages: job.state.sourceMessages, beforeTokens: job.budget?.beforeTokens,
      summaryTokens: job.state.summaryTokens, maxSummaryTokens: job.budget?.maxSummaryTokens,
      hasSummary: job.state.hasSummary, hasTarget: !!job.state.targetSessionId })}\n`, 'utf8')
  } catch { /* Diagnostics never include transcript or summary bodies. */ }
}

/** Durable two-submit workflow. A possibly dispatched submission is never replayed. */
export class ConversationCompaction {
  private job: StoredCompaction | null = null
  private page: Page | null = null
  private pageHandoff = false
  private pageEpoch = 0
  private controller: AbortController | null = null
  private running = false
  private disposed = false
  private readonly now: () => number
  private readonly pause: () => Promise<void>
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now
    this.pause = options.pause ?? (() => new Promise(resolve => setTimeout(resolve, 900)))
    const raw = options.store.getSetting(this.key)
    try {
      const job: StoredCompaction = raw ? JSON.parse(raw) : null
      if (job?.version === 1 && uuid(job.state?.id) && uuid(job.targetId) && job.state.owner?.sessionId === options.sessionId &&
          typeof job.state.owner.conversationId === 'string' && !!job.state.owner.conversationId && supportsCompaction(job.state.owner.platformId) &&
          [...COMPACTION_ACTIVE, 'completed', 'paused', 'failed', 'cancelled', 'uncertain'].includes(job.state.phase) &&
          typeof job.state.hasSource === 'boolean' && typeof job.state.hasSummary === 'boolean' &&
          ['none', 'uncertain', 'sent'].includes(job.sourceDelivery) && ['none', 'uncertain', 'sent'].includes(job.handoffDelivery) &&
          typeof job.sourceHash === 'string' && typeof job.summaryHash === 'string' && job.seed?.session?.id === options.sessionId &&
          job.seed.session.platformId === job.state.owner.platformId && job.seed.session.conversationId === job.state.owner.conversationId &&
          (job.sourceUrl === null || !!selectionQuestionConversation(job.state.owner.platformId, job.sourceUrl)) &&
          (job.handoffUrl === null || !!selectionQuestionConversation(job.state.owner.platformId, job.handoffUrl)) &&
          (job.handoffAnswer === null || typeof job.handoffAnswer === 'string' && job.handoffAnswer.length <= 250000)) {
        this.job = job
        job.state.workerVisible = false
        if (options.isAdopted?.(job)) {
          job.state.targetSessionId = options.sessionId
          this.update('completed', '对话已压缩，可以继续聊天。')
        } else if (COMPACTION_ACTIVE.includes(job.state.phase)) this.update('paused', '上次压缩已中断。点“继续检查”从已保存的阶段恢复；不会重复提交已发送的消息。')
      }
    } catch { /* Invalid saved state is never used to navigate or send. */ }
  }
  private get key(): string { return 'conversationCompaction:' + this.options.sessionId }
  private path(name: 'source.md' | 'summary.md'): string { return join(this.options.directory, this.job!.state.id, name) }
  file(name: 'source.md' | 'summary.md'): string | null {
    return this.job && (name === 'source.md' ? this.job.state.hasSource : this.job.state.hasSummary) ? this.path(name) : null
  }
  compressionUrl(): string | null { return this.job?.sourceUrl ?? null }
  recoveryPrompt(): string {
    if (!this.job || this.job.sourceDelivery !== 'sent' || this.job.state.hasSummary || this.running) {
      throw new Error('请先等待原始快照发送和压缩回答结束，再补全摘要。')
    }
    return compactionRecoveryPrompt(this.job.state.id, this.job.budget ?? compactionBudget(this.job.state.sourceTokens))
  }
  state(owner: FocusOwner): CompactionState | null {
    return this.job && sameOwner(owner, this.job.state.owner) ? { ...this.job.state, owner: { ...this.job.state.owner } } : null
  }
  get busy(): boolean { return this.running }
  get inProgress(): boolean { return !!this.job && COMPACTION_ACTIVE.includes(this.job.state.phase) }
  private save(): void {
    if (!this.job) return
    this.options.store.setSetting(this.key, JSON.stringify(this.job))
    log(this.job)
    this.options.onStateChanged?.()
  }
  private update(phase: CompactionPhase, message: string): void {
    if (!this.job) return
    this.job.state = { ...this.job.state, phase, message, updatedAt: this.now(),
      workerVisible: this.job.state.workerVisible && !!this.page }
    this.save()
  }
  async start(owner: FocusOwner, capture: () => Promise<{ source: CompactionSource; seed: CompactionSeed; view?: ConversationViewSnapshot; contextTokens?: number }>): Promise<CompactionState> {
    if (this.running || this.job && !['completed', 'cancelled'].includes(this.job.state.phase)) throw new Error('已有压缩任务，请先继续检查或取消该任务。')
    if (!supportsCompaction(owner.platformId) || !owner.conversationId || this.disposed) throw new Error('当前会话不能压缩。')
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    const previous = this.job
    try {
      const { source, seed, view, contextTokens } = await capture()
      controller.signal.throwIfAborted()
      if (!sameOwner(owner, source.owner) || !this.options.canWork(owner)) throw new Error('原会话已切换，请返回原会话后重试。')
      const snapshot = compactionSourceMarkdown(source)
      const budget = compactionBudget(contextTokens ?? snapshot.tokens)
      this.closePage()
      this.job = { version: 1, seed, budget, targetId: randomUUID(), sourceHash: hash(snapshot.markdown), summaryHash: '',
        sourceUrl: null, handoffUrl: null, sourceDelivery: 'none', handoffDelivery: 'none', handoffAnswer: null,
        state: { id: randomUUID(), owner: { ...owner }, phase: 'preparing', message: '正在保存会话快照…', createdAt: this.now(),
          updatedAt: this.now(), sourceMessages: snapshot.messageCount, sourceTokens: snapshot.tokens, summaryTokens: null,
          hasSource: false, hasSummary: false, workerVisible: false, targetSessionId: null } }
      this.save()
      if (view) this.options.store.setSetting(compactionViewKey(this.job.state.id), JSON.stringify(view))
      await mkdir(join(this.options.directory, this.job.state.id), { recursive: true })
      await writeFile(this.path('source.md'), snapshot.markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal: controller.signal })
      controller.signal.throwIfAborted()
      this.job.state.hasSource = true
      this.update('opening', '正在压缩对话…')
    } catch (error) {
      if (this.job && this.job !== previous && this.controller === controller && !controller.signal.aborted) this.update('failed', error instanceof Error ? error.message : '保存会话快照失败。')
      throw error
    } finally { this.running = false; if (this.controller === controller) this.controller = null }
    void this.resume(owner)
    return this.state(owner)!
  }
  async resume(owner: FocusOwner): Promise<void> {
    if (this.running || this.disposed || !this.job || !sameOwner(owner, this.job.state.owner) ||
        ['completed', 'cancelled'].includes(this.job.state.phase)) return
    const controller = new AbortController()
    this.controller = controller
    this.running = true
    try {
      if (!this.job.state.hasSource) throw new Error('原始快照未保存成功，请取消任务后重新压缩。')
      this.job.budget ??= compactionBudget(this.job.state.sourceTokens)
      if (!this.job.state.hasSummary) {
        await this.checkedFile('source.md', this.job.sourceHash)
        this.current(controller.signal)
        const answer = await this.exchange(false, controller.signal)
        this.current(controller.signal)
        const summary = compactionReplyText(answer) + '\n'
        this.job.state.summaryTokens = estimateContextText(summary).estimatedTokens
        this.update('saving', '正在保存交接摘要…')
        const temporary = join(this.options.directory, this.job.state.id, `summary-${randomUUID()}.tmp`)
        await writeFile(temporary, summary, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal: controller.signal })
        this.current(controller.signal)
        await rename(temporary, this.path('summary.md'))
        this.current(controller.signal)
        this.job.summaryHash = hash(summary)
        this.job.state.hasSummary = true
        this.job.state.summaryTokens = estimateContextText(summary).estimatedTokens
        this.save()
      }
      this.current(controller.signal)
      const summary = await this.checkedFile('summary.md', this.job.summaryHash)
      this.current(controller.signal)
      if (!this.job.handoffAnswer) {
        const answer = await this.exchange(true, controller.signal)
        this.current(controller.signal)
        this.job.handoffAnswer = compactionReplyText(answer)
        this.save()
      }
      // The isolated pages can finish in the background. Adoption also waits for
      // the source platform and its shared runtime to be safe to replace.
      if (this.options.canAdopt?.(this.job.state.owner) === false) {
        this.update('importing', '摘要已准备完成，等待返回来源平台并结束当前操作后接入…')
      }
      while (!this.options.canWork(this.job.state.owner) || this.options.canAdopt?.(this.job.state.owner) === false) {
        this.current(controller.signal); await this.pause()
      }
      this.current(controller.signal)
      this.job.state.targetSessionId = this.options.createTarget(this.job, summary)
      this.closePage()
      this.update('completed', '对话已压缩，可以继续聊天。')
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted) {
        const uncertain = this.job.sourceDelivery === 'uncertain' || this.job.handoffDelivery === 'uncertain'
        this.update(uncertain ? 'uncertain' : 'failed', error instanceof Error ? error.message : '压缩流程中断，请检查网页后继续。')
      }
    } finally {
      if (this.controller === controller) this.controller = null
      this.running = false
    }
  }
  private current(signal: AbortSignal): void { signal.throwIfAborted(); if (this.disposed || !this.job) throw new Error('压缩任务已结束。') }
  private async waitRunnable(signal: AbortSignal): Promise<void> {
    while (true) {
      this.current(signal)
      if (this.options.canWork(this.job!.state.owner) && this.page?.available) return
      await this.pause()
    }
  }
  private async checkedFile(name: 'source.md' | 'summary.md', expected: string): Promise<string> {
    const content = await readFile(this.path(name), 'utf8')
    if (!expected || hash(content) !== expected) throw new Error(`${name} 已被修改或不完整，请保留文件并重新开始压缩。`)
    return content
  }
  private ensurePage(handoff: boolean): Page {
    const job = this.job!
    const delivery = handoff ? job.handoffDelivery : job.sourceDelivery
    const url = handoff ? job.handoffUrl : job.sourceUrl
    if (url && !selectionQuestionConversation(job.state.owner.platformId, url)) throw new Error('保存的压缩会话地址无效。')
    if (this.page && this.pageHandoff === handoff && (!url ||
        selectionQuestionConversation(job.state.owner.platformId, this.page.url)?.id === selectionQuestionConversation(job.state.owner.platformId, url)?.id)) return this.page
    this.closePage()
    if (delivery !== 'none' && (!url || !selectionQuestionConversation(job.state.owner.platformId, url))) {
      throw new Error('上次消息是否已发送尚未确认，且没有保存到会话地址。请先在平台历史中核对；为避免重复发送，本任务不会重新提交。可取消任务后手动处理。')
    }
    const home = job.state.owner.platformId === 'deepseek' ? 'https://chat.deepseek.com/' : 'https://chatgpt.com/'
    this.pageHandoff = handoff
    const epoch = ++this.pageEpoch
    this.page = this.options.makePage(job.state.owner.platformId, url ?? home, target => {
      if (this.job !== job || this.pageHandoff !== handoff || this.pageEpoch !== epoch) return
      const currentDelivery = handoff ? job.handoffDelivery : job.sourceDelivery
      const key = handoff ? 'handoffUrl' : 'sourceUrl'
      if (currentDelivery !== 'none' && selectionQuestionConversation(job.state.owner.platformId, target) && !job[key]) {
        job[key] = target; this.save()
      }
    })
    job.state.workerVisible = false
    this.save()
    return this.page
  }
  private async exchange(handoff: boolean, signal: AbortSignal): Promise<string> {
    this.current(signal)
    const job = this.job!, id = job.state.id, platform = job.state.owner.platformId
    const deliveryKey = handoff ? 'handoffDelivery' : 'sourceDelivery'
    const urlKey = handoff ? 'handoffUrl' : 'sourceUrl'
    const name = handoff ? 'summary.md' : 'source.md'
    const page = this.ensurePage(handoff)
    this.update(handoff ? 'importing' : 'opening', '正在压缩对话…')
    let activeMs = 0, readErrors = 0, last = '', stableSince = 0, draftClears = 0
    for (;;) {
      await this.waitRunnable(signal)
      const started = this.now()
      let snapshot: CompactionPageSnapshot | null
      try { snapshot = await page.read(compactionRequestMarker(id, handoff), name); readErrors = 0 }
      catch (error) { if (++readErrors >= 5) { this.closePage(); throw error } await this.pause(); continue }
      this.current(signal)
      if (snapshot) {
        const pinned = job[urlKey]
        const actual = selectionQuestionConversation(platform, page.url)
        if (pinned && actual?.id !== selectionQuestionConversation(platform, pinned)?.id) throw new Error('压缩网页已切换到其他页面。请返回本次任务的会话后继续检查。')
        if (job[deliveryKey] === 'none') {
          if (snapshot.hasHistory) throw new Error('压缩网页中已有消息，已停止自动发送。请取消任务后重新压缩。')
          if (snapshot.nativeDraft) {
            // The shared partition can restore any unsent new-chat draft; it must never ride along with the request.
            if (++draftClears > 5 || !await page.clearDraft()) throw new Error('压缩网页输入框中的内容无法清除，已停止自动发送。请取消任务后重新压缩。')
            this.current(signal)
          } else if (snapshot.ready && snapshot.uploadReady && snapshot.generating === 'idle' && isQuestionChatHome(platform, page.url)) {
            await this.checkedFile(name, handoff ? job.summaryHash : job.sourceHash)
            this.current(signal)
            this.update(handoff ? 'importing' : 'uploading', handoff ? '正在上传交接摘要并发送到新会话…' : '正在上传原始快照并发送压缩请求…')
            const result = await page.send(this.path(name), handoff ? compactionHandoffPrompt(id) : compactionPrompt(id, job.budget), signal,
              () => this.options.canWork(job.state.owner), () => {
                this.current(signal)
                if (!this.options.canWork(job.state.owner)) throw new Error('原会话当前不可操作。')
                job[deliveryKey] = 'uncertain'; this.save()
              }, this.options.sendPageMessage
                ? (contents, chatPlatform, path, prompt, sendSignal, current, beforeSubmit) => this.options.sendPageMessage!(job.state.owner,
                  contents, chatPlatform, path, prompt, sendSignal, current, beforeSubmit)
                : undefined)
            this.current(signal)
            if (result === 'ok') {
              const conversation = selectionQuestionConversation(platform, page.url)
              if (!conversation || job[urlKey] && selectionQuestionConversation(platform, job[urlKey]!)?.id !== conversation.id) throw new Error('消息已提交，但会话身份未确认，请先检查网页。')
              job[urlKey] = page.url; job[deliveryKey] = 'sent'; this.save()
            } else if ((job[deliveryKey] as StoredCompaction['sourceDelivery']) === 'uncertain') {
              if (!job[urlKey] && selectionQuestionConversation(platform, page.url)) { job[urlKey] = page.url; this.save() }
              throw new Error('发送结果尚未确认。请检查下方网页，点“继续检查”只核对已发送消息，不会重复提交。')
            } else {
              this.closePage()
              throw new Error(result === 'unsupported-file-type' ? '网页当前不接受 Markdown 附件。原始文件已保留。' : '附件未发送成功。文件已保留，点“继续检查”可重新打开空白页后尝试。')
            }
            this.update(handoff ? 'importing' : 'summarizing', handoff ? '等待新会话读取摘要并确认…' : '正在生成交接摘要…')
            activeMs = 0
          }
        } else if ((snapshot.requestFound || job[deliveryKey] === 'sent' && !!pinned) && actual &&
            (!pinned || actual.id === selectionQuestionConversation(platform, pinned)?.id)) {
          if (job[deliveryKey] !== 'sent') { job[deliveryKey] = 'sent'; job[urlKey] = page.url; this.save() }
          if (snapshot.sendFailure) throw new Error('网页报告消息发送失败。请在下方网页处理后继续检查；软件不会重复提交。')
          if (snapshot.oversized) throw new Error('网页回答超过可完整读取的范围，已停止迁移。')
          const signature = snapshot.replyId + '\n' + snapshot.answer
          if (signature !== last || snapshot.generating !== 'idle') { last = signature; stableSince = this.now() }
          const stable = this.now() - stableSince
          // No content protocol: the reply is done once the page is idle and unchanged for a while.
          if (snapshot.answer.trim() && snapshot.generating === 'idle' && !snapshot.cutOff && !snapshot.nativeDraft && stable >= 6500) {
            if (handoff && snapshot.replyId) job.handoffReplyId = snapshot.replyId
            return snapshot.answer
          }
          if (snapshot.cutOff && snapshot.generating === 'idle') throw new Error('回答被平台截断，请在下方点“继续生成”，结束后点“继续检查”。')
        }
      }
      await this.pause()
      activeMs += this.now() - started
      if (activeMs > 30_000 && (!snapshot?.ready || job[deliveryKey] === 'none' && !snapshot.uploadReady)) {
        throw new Error('压缩页面尚未就绪，可能需要登录或完成验证。请点“处理问题”查看页面，处理后重试。')
      }
      if (activeMs > (job[deliveryKey] === 'none' ? 120_000 : 15 * 60_000)) throw new Error('等待网页超时。请完成登录、检查网络或补全回答，再点“继续检查”。')
    }
  }
  setViewport(owner: FocusOwner, id: string, raw: unknown, visible: boolean): void {
    if (!this.job || !this.job.state.workerVisible || this.job.state.id !== id || !sameOwner(owner, this.job.state.owner)) return
    this.page?.setOwnerVisible(visible && this.options.canWork(owner))
    this.page?.setViewport(raw, visible && this.options.canWork(owner))
  }
  showPage(): void {
    if (!this.job || ['completed', 'cancelled'].includes(this.job.state.phase)) throw new Error('当前没有需要处理的压缩任务。')
    this.ensurePage(this.job.state.hasSummary)
    this.job.state.workerVisible = true
    this.save()
  }
  hide(): void {
    this.page?.setOwnerVisible(false)
    if (this.job?.state.workerVisible) { this.job.state.workerVisible = false; this.save() }
  }
  setTheme(theme: Parameters<Page['setTheme']>[0]): void { this.page?.setTheme(theme) }
  pauseTask(message: string): void {
    if (!this.job || ['completed', 'cancelled'].includes(this.job.state.phase)) return
    this.controller?.abort()
    this.closePage()
    this.update('paused', message)
  }
  cancel(): void {
    this.controller?.abort()
    this.closePage()
    if (this.job) this.update('cancelled', '压缩已取消，已保存的文件和已发送的网页消息仍保留。')
  }
  private closePage(): void {
    this.pageEpoch++
    this.page?.close(); this.page = null
    if (this.job) this.job.state.workerVisible = false
  }
  dispose(): void {
    this.disposed = true
    this.controller?.abort()
    this.closePage()
    if (this.job && COMPACTION_ACTIVE.includes(this.job.state.phase)) this.update('paused', '软件已退出，点“继续检查”可恢复已保存的步骤。')
  }
}
