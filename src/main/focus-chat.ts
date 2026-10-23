import { randomUUID } from 'node:crypto'
import type { FocusTurn, FocusSegment, FocusPageSnapshot, FocusDelivery, FocusAttachmentInfo } from '../shared/focus-chat'
import type { CommandRecoveryState, InterceptorPageEvent } from '../shared/types'
import { cleanFocusAnswer, cleanFocusUserText, supportsFocusView } from '../shared/focus-chat'

interface FocusStore {
  listFocusTurns(sessionId: string, platformId: string, conversationId: string): FocusTurn[]
  saveFocusTurn(sessionId: string, platformId: string, conversationId: string, turn: FocusTurn): void
}
interface Entry {
  conversationId: string | null
  turns: FocusTurn[]
  current: string | null
  cycle: number
  dirty: boolean
  lastSave: number
  /** The newest turn that was still working when this entry was restored, until the task shows it is alive. */
  resumable: string | null
}
export class FocusChat {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly sessionId: string, private readonly store: FocusStore) {}
  context(platformId: string, conversationId: string | null): Entry {
    let entry = this.entries.get(platformId)
    if (entry && entry.conversationId === conversationId) return entry
    if (entry) this.persist(platformId, entry, true)
    if (entry && entry.conversationId === null && conversationId && entry.current) {
      entry.conversationId = conversationId
      entry.dirty = true
    } else {
      const turns = conversationId ? this.store.listFocusTurns(this.sessionId, platformId, conversationId) : []
      // Restored work is history. Never claim a previous process is still working.
      const last = turns.at(-1)
      const resumable = last && ['working', 'blocked'].includes(last.status) ? last.id : null
      for (const turn of turns) {
        if (turn.status === 'working') turn.status = 'stopped'
        if (turn.commandRecovery && ['pending', 'sent'].includes(turn.commandRecovery.status)) {
          turn.commandRecovery = { ...turn.commandRecovery, status: 'blocked', message: '之前的指令格式恢复已中断，请在原始视图核对后继续。' }
        }
      }
      entry = { conversationId, turns, current: null, cycle: 0, dirty: false, lastSave: 0, resumable }
    }
    this.entries.set(platformId, entry)
    return entry
  }
  begin(platformId: string, conversationId: string | null, text: string, files: FocusAttachmentInfo[] = []): string | undefined {
    if (!supportsFocusView(platformId)) return undefined
    const entry = this.context(platformId, conversationId)
    this.stop(platformId)
    const turn: FocusTurn = { id: randomUUID(), userMessageId: null, userText: cleanFocusUserText(text), createdAt: Date.now(),
      userAttachments: files,
      updatedAt: Date.now(), status: 'working', segments: [], executionIds: [], executionCycles: {}, deliveries: {} }
    entry.turns.push(turn)
    entry.current = turn.id
    entry.resumable = null
    entry.cycle = 0
    entry.dirty = true
    this.persist(platformId, entry, true)
    if (entry.turns.length > 80) entry.turns = entry.turns.slice(-80)
    return turn.id
  }
  linkUser(platformId: string, turnId: string | undefined, messageId: string | null): void {
    const entry = this.entries.get(platformId)
    const turn = entry?.turns.find(item => item.id === turnId)
    if (!entry || !turn || !messageId) return
    turn.userMessageId = messageId
    entry.dirty = true
    this.persist(platformId, entry, true)
  }
  ownsTurn(platformId: string, turnId: string): boolean {
    return this.entries.get(platformId)?.turns.some(turn => turn.id === turnId && !turn.supersededBy) === true
  }
  /** Called only by the page's confirmed edit acknowledgement, never optimistically. */
  revise(platformId: string, conversationId: string, text: string, turnIds: string[], messageIds: string[]): string | undefined {
    const hidden = this.hiddenMessageIds(platformId, conversationId)
    const id = this.begin(platformId, conversationId, text)
    const entry = this.entries.get(platformId)
    if (!id || !entry) return undefined
    const replaced = new Set(turnIds)
    for (const turn of entry.turns) if (replaced.has(turn.id)) turn.supersededBy = id
    entry.turns.find(turn => turn.id === id)!.hiddenMessageIds = [...new Set([...hidden, ...messageIds])]
    entry.dirty = true
    this.persist(platformId, entry, true)
    return id
  }
  hiddenMessageIds(platformId: string, conversationId: string | null): string[] {
    return [...new Set(this.context(platformId, conversationId).turns.flatMap(turn => turn.hiddenMessageIds ?? []))]
  }
  supersededExecutionIds(platformId: string, conversationId: string | null): Set<string> {
    return new Set(this.context(platformId, conversationId).turns.filter(turn => turn.supersededBy).flatMap(turn => turn.executionIds))
  }
  parseFailed(platformId: string, failure?: InterceptorPageEvent): void {
    const current = failure?.live === true ? this.live(platformId) : this.current(platformId)
    if (!current || current.turn.status === 'stopped') return
    current.turn.notice = 'parse-failed'
    current.turn.status = 'blocked'
    if (failure?.messageId) {
      const failures = current.turn.parseFailures ??= []
      if (!failures.some(item => item.messageId === failure.messageId)) failures.push({
        messageId: failure.messageId, text: (failure.text ?? '').slice(0, 20000),
        code: failure.parseErrorCode ?? 'invalid-json', createdAt: Date.now()
      })
      current.turn.parseFailures = failures.slice(-10)
    }
    current.entry.dirty = true
    this.persist(platformId, current.entry, true)
  }
  commandRecovery(platformId: string, recovery: CommandRecoveryState): void {
    const current = this.current(platformId)
    if (!current || current.turn.status === 'stopped') return
    current.turn.commandRecovery = { ...recovery }
    current.turn.notice = 'parse-failed'
    current.turn.status = recovery.status === 'pending' || recovery.status === 'sent' ? 'working' : 'blocked'
    current.entry.dirty = true
    this.persist(platformId, current.entry, true)
  }
  private current(platformId: string): { entry: Entry; turn: FocusTurn } | null {
    const entry = this.entries.get(platformId)
    const turn = entry?.turns.find(item => item.id === entry.current)
    return entry && turn ? { entry, turn } : null
  }
  /**
   * The current turn, or the restored one the task has just shown is still running.
   *
   * An app restart restores a working turn as stopped and forgets it as current, while the
   * page's task carries on (a 继续生成, the next command, a result sent back). Without this
   * every later event is dropped and the turn reads 已停止 while the loop is visibly running.
   * Only live task events call it, and only the newest turn qualifies; a turn the user ended
   * keeps `current` and stays stopped.
   */
  private live(platformId: string): { entry: Entry; turn: FocusTurn } | null {
    const current = this.current(platformId)
    if (current) return current
    const entry = this.entries.get(platformId)
    const turn = entry?.turns.at(-1)
    if (!entry || !turn || turn.id !== entry.resumable) return null
    entry.current = turn.id
    entry.resumable = null
    entry.cycle = Math.max(-1, ...turn.segments.map(segment => segment.cycle)) + 1
    turn.status = 'working'
    return { entry, turn }
  }
  private segment(entry: Entry, turn: FocusTurn): FocusSegment {
    let segment = turn.segments.find(item => item.cycle === entry.cycle)
    if (!segment) {
      segment = { cycle: entry.cycle, sourceMessageId: null, parts: [], answer: '', settled: false }
      turn.segments.push(segment)
    }
    return segment
  }
  token(platformId: string): string {
    const current = this.current(platformId)
    return current ? JSON.stringify([current.entry.conversationId, current.turn.id, current.entry.cycle]) : ''
  }
  currentTurnId(platformId: string): string | undefined {
    return this.current(platformId)?.turn.id
  }
  snapshot(platformId: string, token: string, page: FocusPageSnapshot): void {
    if (token !== this.token(platformId)) return
    const current = this.current(platformId)
    if (!current || !page.reply || current.turn.status === 'stopped') return
    const { entry, turn } = current
    const segment = this.segment(entry, turn)
    // A settled Markdown read is authoritative; a late streaming sample cannot replace it.
    if (segment.settled) {
      if (segment.sourceMessageId === page.reply.sourceMessageId && JSON.stringify(segment.parts) !== JSON.stringify(page.reply.parts)) {
        segment.parts = page.reply.parts
        entry.dirty = true
        this.persist(platformId, entry)
      }
      return
    }
    const next = { sourceMessageId: page.reply.sourceMessageId, parts: page.reply.parts, answer: cleanFocusAnswer(page.reply.answer) }
    if (JSON.stringify([segment.sourceMessageId, segment.parts, segment.answer]) === JSON.stringify([next.sourceMessageId, next.parts, next.answer])) return
    Object.assign(segment, next)
    turn.updatedAt = Date.now()
    entry.dirty = true
    this.persist(platformId, entry)
  }
  settled(platformId: string, messageId: string, text: string): void {
    const current = this.live(platformId)
    if (!current || current.turn.status === 'stopped') return
    const { entry, turn } = current
    const segment = this.segment(entry, turn)
    segment.sourceMessageId = messageId
    segment.answer = cleanFocusAnswer(text)
    segment.settled = true
    delete turn.notice
    delete turn.commandRecovery
    turn.status = 'answered'
    turn.updatedAt = Date.now()
    entry.dirty = true
    this.persist(platformId, entry, true)
  }
  /**
   * Re-read text for an answer already saved in a turn — the page re-rendered its history and
   * the Markdown conversion has since improved (a ChatGPT chart saved as spelled-out SVG text
   * before charts were understood). Only a settled prose answer is replaced; a command
   * segment's empty answer stays empty, and nothing else about the turn changes.
   */
  refreshAnswer(platformId: string, conversationId: string, messageId: string, text: string): void {
    const entry = this.context(platformId, conversationId)
    const answer = cleanFocusAnswer(text)
    if (!answer.trim()) return
    let changed = false
    for (const turn of entry.turns) {
      for (const segment of turn.segments) {
        if (segment.sourceMessageId !== messageId || !segment.settled || !segment.answer || segment.answer === answer) continue
        segment.answer = answer
        changed = true
      }
    }
    if (!changed) return
    entry.dirty = true
    this.persist(platformId, entry, true)
  }
  command(platformId: string, messageId: string, live: boolean): void {
    const current = live ? this.live(platformId) : null
    if (!current || current.turn.status === 'stopped') return
    const { entry, turn } = current
    if (!turn.executionIds.includes(messageId)) {
      turn.executionIds.push(messageId)
      turn.executionCycles[messageId] = entry.cycle
      turn.deliveries[messageId] = 'pending'
    }
    // A protocol response is represented by its execution, never rendered as prose.
    const segment = this.segment(entry, turn)
    segment.sourceMessageId = messageId
    segment.answer = ''
    segment.settled = true
    delete turn.notice
    delete turn.commandRecovery
    turn.status = 'working'
    turn.updatedAt = Date.now()
    entry.dirty = true
    this.persist(platformId, entry, true)
  }
  rawSent(platformId: string): void {
    const current = this.live(platformId)
    if (!current || current.turn.status === 'stopped') return
    current.entry.cycle++
    current.turn.status = 'working'
    current.turn.updatedAt = Date.now()
    current.entry.dirty = true
    this.persist(platformId, current.entry, true)
  }
  delivery(platformId: string, conversationId: string | undefined, messageId: string | undefined, outcome: FocusDelivery): void {
    const entry = this.entries.get(platformId)
    if (!entry || !messageId || entry.conversationId !== conversationId) return
    const turn = entry.turns.find(item => item.executionIds.includes(messageId))
    if (!turn) return
    turn.deliveries[messageId] = outcome
    turn.updatedAt = Date.now()
    entry.dirty = true
    this.persist(platformId, entry, true)
  }
  stop(platformId: string, expectedTurnId?: string): void {
    const current = this.current(platformId)
    if (!current || !['working', 'blocked'].includes(current.turn.status) || (expectedTurnId && current.turn.id !== expectedTurnId)) return
    current.turn.status = 'stopped'
    current.turn.updatedAt = Date.now()
    current.entry.dirty = true
    this.persist(platformId, current.entry, true)
  }
  turns(platformId: string, conversationId: string | null): FocusTurn[] {
    const entry = this.context(platformId, conversationId)
    this.persist(platformId, entry)
    return entry.turns.filter(turn => !turn.supersededBy)
  }
  flush(platformId?: string): void {
    for (const [id, entry] of this.entries) if (!platformId || platformId === id) this.persist(id, entry, true)
  }
  private persist(platformId: string, entry: Entry, force = false): void {
    if (!entry.conversationId || !entry.dirty || (!force && Date.now() - entry.lastSave < 1500)) return
    try {
      for (const turn of entry.turns) this.store.saveFocusTurn(this.sessionId, platformId, entry.conversationId, turn)
      entry.dirty = false
      entry.lastSave = Date.now()
    } catch {
      // A first-send route can arrive before the conversation row. Retry after upsert.
      entry.dirty = true
    }
  }
}
