import { randomUUID } from 'node:crypto'
import type { FocusOutboundQueueItem, FocusOutboundQueueState } from '../shared/focus-chat'

export type AiOutboundKind = 'user' | 'tool-result' | 'scheduled' | 'question' | 'recovery' | 'auxiliary'

export interface AiOutboundOwner {
  sessionId: string
  platformId: string
  conversationId: string | null
}

export interface AiOutboundQueueItem {
  id: string
  kind: AiOutboundKind
  owner: AiOutboundOwner
  sourceId?: string
  text?: string
  attachments?: { name: string; size: number }[]
}

export type AiOutboundQueueState = FocusOutboundQueueState

interface Job<T> extends AiOutboundQueueItem {
  execute(signal: AbortSignal, item: AiOutboundQueueItem): Promise<T>
  retryable(result: T): boolean
  retryDelayMs?: number
  blockOnFailure?: (result: T) => boolean
  describeFailure?: (result: T) => string
  cancelled(): T
  aborted?(result: T | undefined): T
  failed(error: unknown): T
  dedupeKey?: string
  resolve(result: T): void
  completion: Promise<T>
  controller?: AbortController
  externalSignal?: AbortSignal
  abortListener?: () => void
  finished?: boolean
}

export interface AiOutboundEnqueue<T> {
  kind: AiOutboundKind
  owner: AiOutboundOwner
  sourceId?: string
  text?: string
  attachments?: { name: string; size: number }[]
  execute(signal: AbortSignal, item: AiOutboundQueueItem): Promise<T>
  retryable(result: T): boolean
  retryDelayMs?: number
  blockOnFailure?: (result: T) => boolean
  describeFailure?: (result: T) => string
  cancelled(): T
  aborted?(result: T | undefined): T
  failed(error: unknown): T
  dedupeKey?: string
  signal?: AbortSignal
}

export interface AiOutboundTicket<T> {
  item: AiOutboundQueueItem
  completion: Promise<T>
}

const wait = (ms: number, signal: AbortSignal): Promise<boolean> => new Promise(resolve => {
  if (signal.aborted) { resolve(false); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(true) }, ms)
  const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(false) }
  signal.addEventListener('abort', abort, { once: true })
})

/**
 * A single FIFO lane for messages that mutate an AI conversation.
 *
 * The queue deliberately knows nothing about DOM or platform-specific outcomes. A job decides
 * which outcomes are safe to retry and which outcomes must stop the lane as unknown.
 */
export class AiOutboundQueue {
  private readonly jobs: Job<unknown>[] = []
  private readonly deduplicated = new Map<string, AiOutboundTicket<unknown>>()
  private running = false
  private current: Job<unknown> | null = null
  private blocked: Job<unknown> | null = null
  private blockedReason: string | undefined
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly listeners = new Set<(state: AiOutboundQueueState) => void>()

  onChanged(listener: (state: AiOutboundQueueState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state())
    return () => this.listeners.delete(listener)
  }

  state(): AiOutboundQueueState {
    return { pending: this.jobs.length + (this.current ? 1 : 0) + (this.blocked ? 1 : 0), active: this.current ? this.publicItem(this.current) : null,
      blocked: this.blocked ? this.publicItem(this.blocked) : null, ...(this.blockedReason ? { blockedReason: this.blockedReason } : {}) }
  }

  bindUnassigned(platformId: string, conversationId: string): void {
    if (!conversationId) return
    for (const job of this.jobs) if (job.owner.platformId === platformId && job.owner.conversationId === null) job.owner.conversationId = conversationId
    if (this.current?.owner.platformId === platformId && this.current.owner.conversationId === null) this.current.owner.conversationId = conversationId
    if (this.blocked?.owner.platformId === platformId && this.blocked.owner.conversationId === null) this.blocked.owner.conversationId = conversationId
    this.changed()
  }

  cancelPlatform(platformId: string): number {
    const jobs = this.jobs.filter(job => job.owner.platformId === platformId)
    for (const job of jobs) this.removeQueued(job.id)
    if (jobs.length) this.changed()
    return jobs.length
  }

  countFor(owner: AiOutboundOwner): { pending: number; active: boolean; position: number; blocked: boolean } {
    const matches = (job: Job<unknown>): boolean => job.owner.sessionId === owner.sessionId && job.owner.platformId === owner.platformId &&
      (job.owner.conversationId === owner.conversationId || job.owner.conversationId === null || owner.conversationId === null)
    const queued = this.jobs.filter(matches)
    const active = this.current !== null && matches(this.current)
    const before = this.jobs.findIndex(matches)
    const blocked = this.blocked !== null && matches(this.blocked)
    return { pending: queued.length + (active ? 1 : 0) + (blocked ? 1 : 0), active,
      position: before < 0 ? (active ? 0 : -1) : before + (this.current && !matches(this.current) ? 1 : 0), blocked }
  }

  findByDedupeKey(key: string): AiOutboundTicket<unknown> | null { return this.deduplicated.get(key) ?? null }

  stateFor(owner: AiOutboundOwner): AiOutboundQueueState {
    const matches = (job: Job<unknown>): boolean => job.owner.sessionId === owner.sessionId && job.owner.platformId === owner.platformId &&
      (job.owner.conversationId === owner.conversationId || job.owner.conversationId === null || owner.conversationId === null)
    const active = this.current && matches(this.current) ? this.publicItem(this.current) : null
    const blocked = this.blocked && matches(this.blocked) ? this.publicItem(this.blocked) : null
    const count = this.countFor(owner)
    return { pending: count.pending, active, blocked, ...(blocked && this.blockedReason ? { blockedReason: this.blockedReason } : {}) }
  }

  enqueue<T>(request: AiOutboundEnqueue<T>): AiOutboundTicket<T> {
    if (request.dedupeKey) {
      const existing = this.deduplicated.get(request.dedupeKey)
      if (existing) return existing as AiOutboundTicket<T>
    }
    const item: AiOutboundQueueItem = { id: randomUUID(), kind: request.kind, owner: { ...request.owner }, ...(request.sourceId ? { sourceId: request.sourceId } : {}),
      ...(request.text !== undefined ? { text: request.text } : {}), ...(request.attachments ? { attachments: request.attachments.map(file => ({ ...file })) } : {}) }
    let resolve!: (value: T) => void
    const completion = new Promise<T>(done => { resolve = done })
    const job: Job<T> = { ...item, execute: request.execute, retryable: request.retryable, retryDelayMs: request.retryDelayMs,
      blockOnFailure: request.blockOnFailure, describeFailure: request.describeFailure, cancelled: request.cancelled, failed: request.failed,
      aborted: request.aborted, resolve, completion, dedupeKey: request.dedupeKey, externalSignal: request.signal }
    if (this.disposed) { job.resolve(job.cancelled()); return { item, completion } }
    if (request.signal?.aborted) { job.resolve(job.cancelled()); return { item, completion } }
    const ticket = { item, completion }
    if (request.dedupeKey) {
      this.deduplicated.set(request.dedupeKey, ticket as AiOutboundTicket<unknown>)
      if (this.deduplicated.size > 1000) this.deduplicated.delete(this.deduplicated.keys().next().value!)
    }
    this.jobs.push(job as Job<unknown>)
    if (request.signal) {
      const abort = (): void => this.abortJob(item.id)
      job.abortListener = abort
      request.signal.addEventListener('abort', abort, { once: true })
    }
    this.changed()
    void this.pump()
    return ticket
  }

  cancelQueued(id: string): boolean {
    if (!this.removeQueued(id)) return false
    this.changed()
    return true
  }

  resumeBlocked(): boolean {
    if (!this.blocked || this.disposed) return false
    const job = this.blocked
    this.blocked = null
    this.blockedReason = undefined
    if (job.externalSignal?.aborted) {
      this.finish(job, job.cancelled())
      this.changed()
      void this.pump()
      return true
    }
    if (job.externalSignal) {
      const abort = (): void => this.abortJob(job.id)
      job.abortListener = abort
      job.externalSignal.addEventListener('abort', abort, { once: true })
    }
    this.jobs.unshift(job)
    this.changed()
    void this.pump()
    return true
  }

  acknowledgeBlocked(id: string): boolean {
    if (!this.blocked || this.blocked.id !== id || this.disposed) return false
    const job = this.blocked
    this.blocked = null
    this.blockedReason = undefined
    this.finish(job, job.cancelled())
    this.changed()
    void this.pump()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    this.current?.controller?.abort()
    const cancelled = [...this.jobs, ...(this.blocked ? [this.blocked] : [])]
    this.jobs.length = 0
    this.blocked = null
    this.blockedReason = undefined
    for (const job of cancelled) this.finish(job, job.cancelled())
    this.changed()
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed || this.blocked || !this.jobs.length) return
    this.running = true
    const job = this.jobs.shift()!
    const controller = new AbortController()
    job.controller = controller
    this.current = job
    this.changed()
    try {
      let result: unknown
      let aborted = false
      while (!this.disposed && !controller.signal.aborted) {
        try { result = await job.execute(controller.signal, job) }
        catch (error) { result = job.failed(error) }
        if (controller.signal.aborted || this.disposed) {
          result = job.aborted ? job.aborted(result) : job.cancelled()
          aborted = true
          break
        }
        if (!job.retryable(result)) break
        const delay = Math.min(5000, job.retryDelayMs ?? 2500)
        this.wakeTimer = setTimeout(() => { this.wakeTimer = null }, delay)
        const waited = await wait(delay, controller.signal)
        this.wakeTimer = null
        if (!waited && (controller.signal.aborted || this.disposed)) {
          result = job.aborted ? job.aborted(result) : job.cancelled()
          aborted = true
          break
        }
      }
      if (aborted) this.finish(job, result)
      else if (this.disposed) this.finish(job, job.cancelled())
      else if (job.blockOnFailure?.(result) === true) {
        this.blocked = job
        this.blockedReason = job.describeFailure?.(result) || '发送结果未确认，请先核对原始对话。'
        this.finish(job, result, true)
      } else if (job.retryable(result)) {
        this.blocked = job
        this.blockedReason = job.describeFailure?.(result) || '发送未能确认，请检查原始对话后处理队首消息。'
        this.finish(job, result, true)
      } else {
        this.finish(job, result)
      }
    } finally {
      if (this.current === job) this.current = null
      this.running = false
      this.changed()
      if (!this.disposed && !this.blocked) queueMicrotask(() => { void this.pump() })
    }
  }

  private publicItem(job: Job<unknown>): FocusOutboundQueueItem {
    return { id: job.id, kind: job.kind, platformId: job.owner.platformId, conversationId: job.owner.conversationId,
      ...(job.sourceId ? { sourceId: job.sourceId } : {}), ...(job.text !== undefined ? { text: job.text } : {}),
      ...(job.attachments ? { attachments: job.attachments.map(file => ({ ...file })) } : {}) }
  }

  private abortJob(id: string): void {
    if (this.current?.id === id) { this.current.controller?.abort(); return }
    this.removeQueued(id)
    this.changed()
  }

  private removeQueued(id: string): boolean {
    const index = this.jobs.findIndex(job => job.id === id)
    if (index < 0) return false
    const [job] = this.jobs.splice(index, 1)
    this.finish(job, job.cancelled())
    return true
  }

  private finish<T>(job: Job<T>, result: T, keepDedupe = false): void {
    if (job.abortListener && job.externalSignal) job.externalSignal.removeEventListener('abort', job.abortListener)
    job.abortListener = undefined
    if (!keepDedupe && job.dedupeKey && this.deduplicated.get(job.dedupeKey)?.completion === job.completion) this.deduplicated.delete(job.dedupeKey)
    if (job.finished) return
    job.finished = true
    job.resolve(result)
  }

  private changed(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }
}
