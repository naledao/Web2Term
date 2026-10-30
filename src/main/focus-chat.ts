import { randomUUID } from 'node:crypto'
import type { FocusTurn, FocusSegment, FocusPageSnapshot, FocusDelivery, FocusAttachmentInfo, FocusToolCall, FocusToolKind, FocusToolObserver, FocusToolUpdate } from '../shared/focus-chat'
import type { CommandRecoveryState, InterceptorPageEvent } from '../shared/types'
import { cleanFocusAnswer, cleanFocusUserText, supportsFocusView, validFocusToolCall } from '../shared/focus-chat'

interface FocusStore {
  listFocusTurns(sessionId: string, platformId: string, conversationId: string): FocusTurn[]
  saveFocusTurn(sessionId: string, platformId: string, conversationId: string, turn: FocusTurn): void
}
interface Entry {
  conversationId: string | null
  turns: FocusTurn[]
  current: string | null
  cycle: number
  dirty: Set<string>
  revision: number
  lastSave: number
  /** The newest turn that was still working when this entry was restored, until the task shows it is alive. */
  resumable: string | null
}
export class FocusChat {
  private readonly entries = new Map<string, Entry>()
  private revision = 0
  constructor(private readonly sessionId: string, private readonly store: FocusStore) {}
  context(platformId: string, conversationId: string | null): Entry {
    let entry = this.entries.get(platformId)
    if (entry && entry.conversationId === conversationId) return entry
    if (entry) this.persist(platformId, entry, true)
    if (entry && entry.conversationId === null && conversationId && entry.current) {
      entry.conversationId = conversationId
      this.changed(entry, ...entry.turns)
    } else {
      const turns = conversationId ? this.store.listFocusTurns(this.sessionId, platformId, conversationId) : []
      // Restored work is history. Never claim a previous process is still working.
      const last = turns.at(-1)
      const resumable = last && ['working', 'blocked'].includes(last.status) ? last.id : null
      for (const turn of turns) {
        if (turn.status === 'working') turn.status = 'stopped'
        if (turn.toolCalls) turn.toolCalls = (Array.isArray(turn.toolCalls) ? turn.toolCalls.filter(validFocusToolCall) : []).map(call => ({ ...call,
          status: call.status === 'running' ? 'unknown' : call.status,
          delivery: call.delivery === 'pending' ? 'blocked' : call.delivery,
          result: call.status === 'running' ? '上次调用已中断，执行结果尚未确认；请核对实际状态。' : call.result }))
        if (turn.commandRecovery && ['pending', 'sent'].includes(turn.commandRecovery.status)) {
          turn.commandRecovery = { ...turn.commandRecovery, status: 'blocked', message: '之前的指令格式恢复已中断，请在原始视图核对后继续。' }
        }
      }
      entry = { conversationId, turns, current: null, cycle: 0, dirty: new Set(), revision: ++this.revision, lastSave: 0, resumable }
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
    this.changed(entry, turn)
    this.persist(platformId, entry, true)
    if (entry.turns.length > 80) entry.turns = entry.turns.filter((item, index) =>
      index >= entry.turns.length - 80 || entry.dirty.has(item.id))
    return turn.id
  }
  linkUser(platformId: string, turnId: string | undefined, messageId: string | null): void {
    const entry = this.entries.get(platformId)
    const turn = entry?.turns.find(item => item.id === turnId)
    if (!entry || !turn || !messageId) return
    turn.userMessageId = messageId
    this.changed(entry, turn)
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
    for (const turn of entry.turns) if (replaced.has(turn.id)) {
      turn.supersededBy = id
      this.changed(entry, turn)
    }
    const replacement = entry.turns.find(turn => turn.id === id)!
    replacement.hiddenMessageIds = [...new Set([...hidden, ...messageIds])]
    this.changed(entry, replacement)
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
    this.changed(current.entry, current.turn)
    this.persist(platformId, current.entry, true)
  }
  commandRecovery(platformId: string, recovery: CommandRecoveryState): void {
    const current = this.current(platformId)
    if (!current || current.turn.status === 'stopped') return
    current.turn.commandRecovery = { ...recovery }
    current.turn.notice = 'parse-failed'
    current.turn.status = recovery.status === 'pending' || recovery.status === 'sent' ? 'working' : 'blocked'
    this.changed(current.entry, current.turn)
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
  /** Statistics may observe a resumed turn, but must never load/reopen a task or cross conversations. */
  contextUsageTurnId(platformId: string, conversationId: string | null): string | undefined {
    const entry = this.entries.get(platformId)
    if (!entry || entry.conversationId !== conversationId && !(entry.conversationId === null && entry.current)) return undefined
    const turns = entry.turns.filter(turn => !turn.supersededBy)
    return turns.find(turn => turn.id === entry.current)?.id ?? turns.at(-1)?.id
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
        this.changed(entry, turn)
        this.persist(platformId, entry)
      }
      return
    }
    const next = { sourceMessageId: page.reply.sourceMessageId, parts: page.reply.parts, answer: cleanFocusAnswer(page.reply.answer) }
    if (JSON.stringify([segment.sourceMessageId, segment.parts, segment.answer]) === JSON.stringify([next.sourceMessageId, next.parts, next.answer])) return
    Object.assign(segment, next)
    turn.updatedAt = Date.now()
    this.changed(entry, turn)
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
    this.changed(entry, turn)
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
        this.changed(entry, turn)
        changed = true
      }
    }
    if (!changed) return
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
    this.changed(entry, turn)
    this.persist(platformId, entry, true)
  }
  rawSent(platformId: string): void {
    const current = this.live(platformId)
    if (!current || current.turn.status === 'stopped') return
    current.entry.cycle++
    current.turn.status = 'working'
    current.turn.updatedAt = Date.now()
    this.changed(current.entry, current.turn)
    this.persist(platformId, current.entry, true)
  }
  delivery(platformId: string, conversationId: string | undefined, messageId: string | undefined, outcome: FocusDelivery): void {
    const entry = this.entries.get(platformId)
    if (!entry || !messageId || entry.conversationId !== conversationId) return
    const turn = entry.turns.find(item => item.executionIds.includes(messageId))
    if (!turn) return
    turn.deliveries[messageId] = outcome
    turn.updatedAt = Date.now()
    this.changed(entry, turn)
    this.persist(platformId, entry, true)
  }
  /** Capture the original owner and turn; late receipts can update history without touching a new goal. */
  observeTool(platformId: string, conversationId: string, sourceMessageId: string, tool: FocusToolKind,
    info: { title: string; request: string; status?: FocusToolCall['status']; working?: boolean }, turnId?: string): FocusToolObserver | undefined {
    let entry = this.entries.get(platformId)
    if (entry?.conversationId === null && entry.current && (!turnId || entry.current === turnId)) entry = this.context(platformId, conversationId)
    if (!entry || entry.conversationId !== conversationId || !sourceMessageId || sourceMessageId.length > 512) return undefined
    const owner = entry.turns.find(item => item.toolCalls?.some(call => call.sourceMessageId === sourceMessageId && call.tool === tool))
    const turn = owner ?? (turnId ? entry.turns.find(item => item.id === turnId && !item.supersededBy) : this.live(platformId)?.turn)
    if (!turn || !owner && turn.status === 'stopped' && !turnId) return undefined
    let call = turn.toolCalls?.find(item => item.sourceMessageId === sourceMessageId && item.tool === tool)
    if (!call) {
      let cycle = turn.segments.find(segment => segment.sourceMessageId === sourceMessageId)?.cycle ??
        (turn.id === entry.current ? entry.cycle : Math.max(-1, ...turn.segments.map(segment => segment.cycle)) + 1)
      const previous = turn.segments.find(segment => segment.cycle === cycle)
      if (previous?.answer.trim() && previous.sourceMessageId !== sourceMessageId) {
        cycle = Math.max(cycle, ...turn.segments.map(segment => segment.cycle)) + 1
        if (turn.id === entry.current) entry.cycle = cycle
      }
      const now = Date.now()
      call = { id: tool + ':' + sourceMessageId, sourceMessageId, tool, title: info.title.slice(0, 100), request: info.request.slice(0, 500),
        cycle, status: info.status ?? 'running', delivery: 'pending', result: '', createdAt: now, updatedAt: now }
      turn.toolCalls ??= []
      turn.toolCalls.push(call)
      let segment = turn.segments.find(item => item.cycle === cycle)
      if (!segment) { segment = { cycle, sourceMessageId, parts: [], answer: '', settled: true }; turn.segments.push(segment) }
      segment.sourceMessageId = sourceMessageId; segment.answer = ''; segment.settled = true
      if (turn.status !== 'stopped' && info.working !== false) turn.status = 'working'
      this.changed(entry, turn)
      this.persist(platformId, entry, true)
    }
    const ownerId = turn.id
    return update => this.updateTool(platformId, conversationId, sourceMessageId, update, { turnId: ownerId, tool })
  }
  updateTool(platformId: string, conversationId: string, messageId: string, update: FocusToolUpdate,
    owner?: { turnId: string; tool: FocusToolKind }): void {
    const entry = this.entries.get(platformId)
    const matchesCall = (call: FocusToolCall): boolean => call.sourceMessageId === messageId && (!owner || call.tool === owner.tool)
    const matchesTurn = (turn: FocusTurn): boolean => (!owner || turn.id === owner.turnId) && !!turn.toolCalls?.some(matchesCall)
    const cached = entry?.conversationId === conversationId ? entry.turns.find(matchesTurn) : undefined
    // A navigation replaces Entry objects. Merge into current history, including archived branches,
    // rather than writing the observer's old snapshot over a later edit or another receipt.
    const turn = cached ?? this.store.listFocusTurns(this.sessionId, platformId, conversationId).find(matchesTurn)
    const call = turn?.toolCalls?.find(matchesCall)
    if (!turn || !call) return
    const patch: FocusToolUpdate = { ...update }
    if (call.tool === 'computer') {
      // An interrupted task snapshot can outlive its late receipt. It cannot revoke known facts.
      if (['done', 'failed', 'blocked'].includes(call.status) && (patch.status === 'unknown' || patch.status === 'running')) {
        delete patch.status
        delete patch.result
      }
      if (call.delivery === 'sent' && patch.delivery !== 'sent') delete patch.delivery
    }
    if (patch.result !== undefined) patch.result = patch.result.length > 4000 ? patch.result.slice(0, 4000) + '\n（仅保留结果摘要）' : patch.result
    if (Object.entries(patch).every(([key, value]) => call[key as keyof FocusToolCall] === value)) return
    Object.assign(call, patch, { updatedAt: Date.now() })
    turn.updatedAt = call.updatedAt
    if (cached && entry) {
      this.changed(entry, turn)
      this.persist(platformId, entry, true)
    } else this.store.saveFocusTurn(this.sessionId, platformId, conversationId, turn)
  }
  stop(platformId: string, expectedTurnId?: string): void {
    const current = this.current(platformId)
    if (!current || !['working', 'blocked'].includes(current.turn.status) || (expectedTurnId && current.turn.id !== expectedTurnId)) return
    current.turn.status = 'stopped'
    for (const call of current.turn.toolCalls ?? []) {
      if (call.status === 'running') call.status = 'unknown'
      if (call.delivery === 'pending') call.delivery = 'blocked'
    }
    current.turn.updatedAt = Date.now()
    this.changed(current.entry, current.turn)
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
  version(platformId: string, conversationId: string | null): number {
    return this.context(platformId, conversationId).revision
  }
  private changed(entry: Entry, ...turns: FocusTurn[]): void {
    for (const turn of turns) entry.dirty.add(turn.id)
    entry.revision = ++this.revision
  }
  private persist(platformId: string, entry: Entry, force = false): void {
    if (!entry.conversationId || !entry.dirty.size || (!force && Date.now() - entry.lastSave < 1500)) return
    try {
      for (const turn of entry.turns) if (entry.dirty.has(turn.id)) {
        this.store.saveFocusTurn(this.sessionId, platformId, entry.conversationId, turn)
        entry.dirty.delete(turn.id)
      }
      entry.lastSave = Date.now()
    } catch {
      // A first-send route can arrive before the conversation row. Retry after upsert.
      // Successfully written turns stay clean; retry only the remaining turns.
    }
  }
}
