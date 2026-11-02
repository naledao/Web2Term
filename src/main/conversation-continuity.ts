import type { ConversationMessage, EmbedState, ExecutionRecord } from '../shared/types'
import type { FocusOwner, FocusTurn } from '../shared/focus-chat'
import { compactionHandoffMarker, compactionHandoffPrompt, compactionHandoffContext, compactionRequestMarker } from '../shared/conversation-compaction'
import type { CompactionBoundary } from '../shared/conversation-compaction'
import { selectionQuestionConversation } from '../shared/deepseek-question'
import type { StoredCompaction } from './conversation-compaction'
import type { ContextUsageEntry } from '../shared/context-usage'
import { estimateContextText } from '../shared/focus-token-usage'

export interface ConversationViewSnapshot {
  version: 1
  owner: FocusOwner
  messages: ConversationMessage[]
  turns: FocusTurn[]
  executions: ExecutionRecord[]
}
interface Continuation {
  version: 1
  jobId: string
  source: FocusOwner
  rootConversationId: string
  hiddenMessageIds: string[]
  hiddenSourceIds: string[]
  completedAt?: number
  beforeTokens?: number
  afterTokens?: number
}
interface ContinuityStore {
  contextUsage?: { save(platformId: string, entry: ContextUsageEntry): void }
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  listManagedSessions(): { id: string }[]
  listConversationMessages(conversationId: string): ConversationMessage[]
  listFocusTurns(sessionId: string, platformId: string, conversationId: string): FocusTurn[]
  listExecutions(conversationId: string, includeOutput?: boolean): ExecutionRecord[]
  appendConversationMessage(conversationId: string, role: 'user' | 'assistant', content: string, sourceMessageId?: string | null, now?: number): string | null
}
interface DisplayHistory {
  rootConversationId: string
  revision: string
  messages: ConversationMessage[]
  turns: FocusTurn[]
  executions: ExecutionRecord[]
  compactions: CompactionBoundary[]
}
const key = (platformId: string, conversationId: string): string => 'conversationContinuation:' + JSON.stringify([platformId, conversationId])
export const compactionViewKey = (jobId: string): string => 'compactionView:' + jobId
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)

/** Presentation lineage only. It never changes a page owner or grants tool authority. */
export class ConversationContinuity {
  private readonly cache = new Map<string, Continuation | null>()
  private readonly historyCache = new Map<string, DisplayHistory>()
  private readonly legacyChecked = new Set<string>()
  constructor(private readonly sessionId: string, private readonly store: ContinuityStore) {}
  private read(platformId: string, conversationId: string): Continuation | null {
    const id = key(platformId, conversationId)
    if (this.cache.has(id)) return this.cache.get(id) ?? null
    let value: Continuation | null = null
    try {
      const raw = this.store.getSetting(id), parsed: Continuation = raw ? JSON.parse(raw) : null
      if (parsed?.version === 1 && uuid(parsed.jobId) && parsed.source?.platformId === platformId &&
          typeof parsed.source.sessionId === 'string' && typeof parsed.source.conversationId === 'string' &&
          parsed.source.conversationId !== conversationId && typeof parsed.rootConversationId === 'string' &&
          Array.isArray(parsed.hiddenMessageIds) && parsed.hiddenMessageIds.every(item => typeof item === 'string') &&
          Array.isArray(parsed.hiddenSourceIds) && parsed.hiddenSourceIds.every(item => typeof item === 'string')) value = parsed
    } catch { /* Broken display metadata cannot replace live conversation data. */ }
    this.cache.set(id, value)
    return value
  }
  private ensureLegacy(platformId: string, conversationId: string): void {
    const id = key(platformId, conversationId)
    if (this.read(platformId, conversationId) || this.legacyChecked.has(id)) return
    this.legacyChecked.add(id)
    // Previous builds created a second managed session. Recover its trusted import
    // provenance lazily, without deleting or relabeling unrelated conversations.
    for (const session of this.store.listManagedSessions()) {
      try {
        const raw = this.store.getSetting('conversationCompaction:' + session.id)
        const job: StoredCompaction = raw ? JSON.parse(raw) : null
        if (job?.version !== 1 || !uuid(job.state?.id) || job.state.targetSessionId !== this.sessionId ||
            job.state.owner?.platformId !== platformId || !job.state.owner.conversationId ||
            job.state.owner.conversationId === conversationId || !job.state.hasSummary || !job.handoffUrl ||
            selectionQuestionConversation(platformId, job.handoffUrl)?.id !== conversationId) continue
        this.install(job, undefined)
        return
      } catch { /* Another workspace's old/incomplete task is irrelevant. */ }
    }
  }
  root(platformId: string, conversationId: string | null): string | null {
    if (!conversationId) return null
    this.ensureLegacy(platformId, conversationId)
    return this.read(platformId, conversationId)?.rootConversationId ?? conversationId
  }
  decorate(state: EmbedState, platformId: string): EmbedState {
    return { ...state, viewConversationId: this.root(platformId, state.conversationId) }
  }
  owns(platformId: string, conversationId: string | null, jobId: string): boolean {
    return !!conversationId && this.read(platformId, conversationId)?.jobId === jobId
  }
  private seedText(text: string, metadata: Continuation): boolean {
    const normalized = text.trim()
    return normalized === compactionHandoffPrompt(metadata.jobId) ||
      normalized.startsWith('请读取附件 summary.md，这是上一会话的交接摘要。\n') &&
      normalized.split(/\r?\n/).at(-1) === '任务标识：' + compactionRequestMarker(metadata.jobId, true)
  }
  private internal(message: ConversationMessage, metadata: Continuation | null): boolean {
    if (!metadata) return false
    if (metadata.hiddenMessageIds.includes(message.id) || message.sourceMessageId && metadata.hiddenSourceIds.includes(message.sourceMessageId)) return true
    // Native history may report the seed separately from the app's local expanded
    // attachment. Match the exact owned transport, never a user's prose prefix.
    return message.role === 'user' && this.seedText(message.content, metadata) ||
      message.role === 'assistant' && message.content.trim().split(/\r?\n/).at(-1) === compactionHandoffMarker(metadata.jobId)
  }
  visibleCurrent(platformId: string, conversationId: string): ConversationMessage[] {
    this.ensureLegacy(platformId, conversationId)
    const metadata = this.read(platformId, conversationId)
    return this.store.listConversationMessages(conversationId).filter(message => !this.internal(message, metadata))
  }
  visibleTurns(platformId: string, conversationId: string | null, turns: FocusTurn[]): FocusTurn[] {
    const metadata = conversationId ? this.read(platformId, conversationId) : null
    if (!metadata) return turns
    const internal = new Set(this.store.listConversationMessages(conversationId!).filter(message => this.internal(message, metadata)).map(message => message.id))
    return turns.filter(turn => (!turn.userMessageId || !internal.has(turn.userMessageId)) && !this.seedText(turn.userText, metadata))
  }
  capture(owner: FocusOwner, messages: ConversationMessage[], turns: FocusTurn[], executions: ExecutionRecord[], hiddenIds: string[]): ConversationViewSnapshot {
    const metadata = owner.conversationId ? this.read(owner.platformId, owner.conversationId) : null
    const hidden = new Set(hiddenIds)
    const visible = messages.filter(message => !hidden.has(message.id) && !this.internal(message, metadata))
    const internalIds = new Set(messages.filter(message => this.internal(message, metadata)).map(message => message.id))
    return { version: 1, owner: { ...owner }, messages: visible,
      turns: turns.filter(turn => !turn.supersededBy && !turn.archived && (!turn.userMessageId || !internalIds.has(turn.userMessageId))),
      executions: executions.filter(record => !record.archived).map(record => ({ ...record, output: '', outputDeferred: true })) }
  }
  install(job: StoredCompaction, summary: string | undefined): void {
    const owner = job.state.owner, target = job.handoffUrl && selectionQuestionConversation(owner.platformId, job.handoffUrl)
    if (!target || !owner.conversationId || owner.conversationId === target.id || !uuid(job.state.id)) throw new Error('会话承接来源无效。')
    const existing = this.read(owner.platformId, target.id)
    if (existing) {
      if (existing.jobId !== job.state.id) throw new Error('承接会话已有其他来源。')
      return
    }
    if (!this.store.getSetting(compactionViewKey(job.state.id))) {
      const turns = this.store.listFocusTurns(owner.sessionId, owner.platformId, owner.conversationId)
      const hidden = turns.flatMap(turn => turn.hiddenMessageIds ?? [])
      const superseded = new Set(turns.filter(turn => turn.supersededBy).flatMap(turn => turn.executionIds))
      const snapshot = this.capture(owner, this.store.listConversationMessages(owner.conversationId), turns,
        this.store.listExecutions(owner.conversationId, false).filter(record => !superseded.has(record.messageId)), hidden)
      this.store.setSetting(compactionViewKey(job.state.id), JSON.stringify(snapshot))
    }
    const userSource = 'compaction:' + job.state.id + ':user', answerSource = 'compaction:' + job.state.id + ':answer'
    // Keep context in the physical C transcript for future compaction, with explicit
    // ownership metadata preventing the expanded attachment appearing in the view.
    if (summary !== undefined) {
      this.store.appendConversationMessage(target.id, 'user', summary, userSource, job.state.createdAt)
      if (job.handoffAnswer) this.store.appendConversationMessage(target.id, 'assistant', job.handoffAnswer, answerSource)
    }
    const rows = this.store.listConversationMessages(target.id)
    const imported = summary ?? rows.find(row => row.sourceMessageId === userSource)?.content
    if (imported) {
      const context = compactionHandoffContext(job.state.id, imported, job.handoffAnswer ?? '')
      this.store.contextUsage?.save(owner.platformId, { id: 'compaction:' + job.state.id, conversationId: target.id,
        turnId: null, sourceMessageId: null, category: 'injection', state: 'sent',
        ...estimateContextText(context), images: 0, files: 1, createdAt: job.state.createdAt })
    }
    const metadata: Continuation = { version: 1, jobId: job.state.id, source: { ...owner },
      completedAt: job.state.updatedAt ?? job.state.createdAt,
      beforeTokens: job.budget?.beforeTokens,
      afterTokens: imported ? estimateContextText(compactionHandoffContext(job.state.id, imported, job.handoffAnswer ?? '')).estimatedTokens : undefined,
      rootConversationId: this.read(owner.platformId, owner.conversationId)?.rootConversationId ?? owner.conversationId,
      hiddenMessageIds: rows.filter(row => row.sourceMessageId === userSource || row.sourceMessageId === answerSource).map(row => row.id),
      hiddenSourceIds: [userSource, answerSource, ...(job.handoffReplyId ? [job.handoffReplyId] : [])] }
    this.store.setSetting(key(owner.platformId, target.id), JSON.stringify(metadata))
    this.cache.set(key(owner.platformId, target.id), metadata)
    this.historyCache.clear()
  }
  history(platformId: string, conversationId: string): DisplayHistory {
    this.ensureLegacy(platformId, conversationId)
    const id = key(platformId, conversationId), cached = this.historyCache.get(id)
    if (cached) return cached
    const segments: ConversationViewSnapshot[] = [], revisions: string[] = [], compactions: CompactionBoundary[] = [], seen = new Set([conversationId])
    let current = conversationId
    for (let depth = 0; depth < 128; depth++) {
      const metadata = this.read(platformId, current)
      if (!metadata || !metadata.source.conversationId || seen.has(metadata.source.conversationId)) break
      seen.add(metadata.source.conversationId)
      try {
        const raw = this.store.getSetting(compactionViewKey(metadata.jobId))
        const snapshot: ConversationViewSnapshot = raw ? JSON.parse(raw) : null
        if (snapshot?.version !== 1 || snapshot.owner.platformId !== platformId ||
            snapshot.owner.sessionId !== metadata.source.sessionId || snapshot.owner.conversationId !== metadata.source.conversationId ||
            !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.turns) || !Array.isArray(snapshot.executions) ||
            snapshot.messages.some(message => message.conversationId !== metadata.source.conversationId) ||
            snapshot.executions.some(record => record.conversationId !== metadata.source.conversationId)) break
        segments.unshift(snapshot); revisions.unshift(metadata.jobId)
        // Legacy lineage has no completion timestamp. Place its annotation after
        // the frozen source branch, without adding a synthetic model message.
        const lastSource = Math.max(0, ...snapshot.messages.map(message => message.createdAt), ...snapshot.turns.map(turn => turn.updatedAt))
        compactions.unshift({ id: 'compaction:' + metadata.jobId,
          createdAt: Math.max(Number.isFinite(metadata.completedAt) ? metadata.completedAt! : 0, lastSource + 1),
          beforeTokens: metadata.beforeTokens, afterTokens: metadata.afterTokens })
      } catch { break }
      current = metadata.source.conversationId
    }
    const result: DisplayHistory = { rootConversationId: this.root(platformId, conversationId)!, revision: revisions.join(':'),
      compactions,
      messages: segments.flatMap(segment => segment.messages.map(message => ({ ...message, archived: true }))),
      turns: segments.flatMap(segment => segment.turns.map(turn => ({ ...turn, archived: true }))),
      executions: segments.flatMap(segment => segment.executions.map(record => ({ ...record, archived: true }))) }
    this.historyCache.set(id, result)
    return result
  }
  displayMessages(platformId: string, conversationId: string): ConversationMessage[] {
    return [...this.history(platformId, conversationId).messages, ...this.visibleCurrent(platformId, conversationId)]
  }
}
