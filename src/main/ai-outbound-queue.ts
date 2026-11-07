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

/** Retryable outcomes stop being retried after this many attempts (about five minutes at the default delay). */
export const DEFAULT_MAX_ATTEMPTS = 120
/** How many waiting items a queue state lists; the rest are only counted. */
const MAX_LISTED_QUEUED = 5
const PREVIEW_LENGTH = 160

/** Collapses whitespace and shortens text for a one-line summary. */
export function queuePreview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > PREVIEW_LENGTH ? line.slice(0, PREVIEW_LENGTH) + '…' : line
}

interface Job<T> extends AiOutboundQueueItem {
  execute(signal: AbortSignal, item: AiOutboundQueueItem): Promise<T>
  retryable(result: T): boolean
  retryDelayMs?: number
  maxAttempts?: number
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
  /** The caller has been answered. */
  settled?: boolean
  attempt?: number
  /** Set while waiting between attempts: the refusal being waited out. */
  retryReason?: string
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
  maxAttempts?: number
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
 *
 * A job that blocks the lane answers its caller at once with the uncertain outcome (the caller already
 * knows how to report "check the original conversation"). The lane stays paused until the user has
 * checked and skips it. The queue never re-sends a blocked message on its own: its caller has already
 * been answered, so a re-send's outcome would reach no one and could duplicate the caller's own retry.
 * Its dedupe key stays reserved while blocked, so the same message cannot be queued again meanwhile.
 */
export class AiOutboundQueue {
  private readonly jobs: Job<unknown>[] = []
  private readonly deduplicated = new Map<string, AiOutboundTicket<unknown>>()
  private running = false
  private current: Job<unknown> | null = null
  private blocked: Job<unknown> | null = null
  private blockedReason: string | undefined
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

  /**
   * Binds jobs that were queued for a not-yet-created conversation. Only the send that is running
   * for such a conversation can have created it; a mere navigation to another chat binds nothing.
   */
  bindUnassigned(platformId: string, conversationId: string): void {
    if (!conversationId || this.current?.owner.platformId !== platformId || this.current.owner.conversationId !== null) return
    for (const job of [this.current, ...this.jobs, ...(this.blocked ? [this.blocked] : [])]) {
      if (job.owner.platformId === platformId && job.owner.conversationId === null) job.owner.conversationId = conversationId
    }
    this.changed()
  }

  cancelPlatform(platformId: string): number {
    const jobs = this.jobs.filter(job => job.owner.platformId === platformId)
    for (const job of jobs) this.removeQueued(job.id)
    if (jobs.length) this.changed()
    return jobs.length
  }

  findByDedupeKey(key: string): AiOutboundTicket<unknown> | null { return this.deduplicated.get(key) ?? null }

  stateFor(owner: AiOutboundOwner): AiOutboundQueueState {
    const current = this.current
    const active = current && this.belongsTo(current, owner) ? { ...this.publicItem(current), ...(current.attempt ? { attempt: current.attempt } : {}),
      ...(current.retryReason !== undefined ? { retryReason: current.retryReason } : {}) } : null
    const blocked = this.blocked && this.belongsTo(this.blocked, owner) ? this.publicItem(this.blocked) : null
    const waiting = this.jobs.filter(job => this.belongsTo(job, owner))
    const pending = waiting.length + (active ? 1 : 0) + (blocked ? 1 : 0)
    const queued = waiting.slice(0, MAX_LISTED_QUEUED).map(job => this.publicItem(job))
    return { pending, active, ...(queued.length ? { queued } : {}), blocked, ...(blocked && this.blockedReason ? { blockedReason: this.blockedReason } : {}) }
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
    const job: Job<T> = { ...item, execute: request.execute, retryable: request.retryable, retryDelayMs: request.retryDelayMs, maxAttempts: request.maxAttempts,
      blockOnFailure: request.blockOnFailure, describeFailure: request.describeFailure, cancelled: request.cancelled, failed: request.failed,
      aborted: request.aborted, resolve, completion, dedupeKey: request.dedupeKey, externalSignal: request.signal }
    if (this.disposed || request.signal?.aborted) { job.resolve(job.cancelled()); return { item, completion } }
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

  /** User cancellation: stops the active send (or its retry wait), drops a queued one, or skips the blocked head. */
  cancel(id: string): boolean {
    if (this.disposed) return false
    if (this.current?.id === id) { this.current.controller?.abort(); return true }
    if (this.blocked?.id === id) return this.acknowledgeBlocked(id)
    return this.cancelQueued(id)
  }

  cancelQueued(id: string): boolean {
    if (!this.removeQueued(id)) return false
    this.changed()
    return true
  }

  isBlocked(id: string): boolean { return this.blocked?.id === id }

  /** The user checked the original conversation; the blocked head is dropped and the lane continues. */
  acknowledgeBlocked(id: string): boolean {
    if (!this.blocked || this.blocked.id !== id || this.disposed) return false
    const job = this.blocked
    this.blocked = null
    this.blockedReason = undefined
    // The caller was answered when the job blocked; this only releases its dedupe key.
    this.finish(job, job.cancelled())
    this.changed()
    void this.pump()
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
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
      const maxAttempts = Math.max(1, job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
      for (let attempt = 1; !this.disposed && !controller.signal.aborted; attempt++) {
        job.attempt = attempt
        if (job.retryReason !== undefined) { job.retryReason = undefined; this.changed() }
        try { result = await job.execute(controller.signal, job) }
        catch (error) { result = job.failed(error) }
        if (controller.signal.aborted || this.disposed) {
          result = job.aborted ? job.aborted(result) : job.cancelled()
          aborted = true
          break
        }
        // Exhausted retries are reported to the caller as-is; they never pause the lane.
        if (!job.retryable(result) || attempt >= maxAttempts) break
        // Tell the focus view why the head is not moving.
        job.retryReason = String(result)
        this.changed()
        const waited = await wait(Math.min(5000, job.retryDelayMs ?? 2500), controller.signal)
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
        // Answer the caller now, but keep the dedupe key reserved until the user skips the head.
        this.detach(job)
        this.settle(job, result)
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

  private belongsTo(job: Job<unknown>, owner: AiOutboundOwner): boolean {
    return job.owner.sessionId === owner.sessionId && job.owner.platformId === owner.platformId &&
      (job.owner.conversationId === owner.conversationId || job.owner.conversationId === null || owner.conversationId === null)
  }

  /** The focus view polls this; carry a one-line preview, not a whole tool result or file. */
  private publicItem(job: Job<unknown>): FocusOutboundQueueItem {
    return { id: job.id, kind: job.kind, platformId: job.owner.platformId, conversationId: job.owner.conversationId,
      ...(job.sourceId ? { sourceId: job.sourceId } : {}), ...(job.text !== undefined ? { text: queuePreview(job.text) } : {}),
      ...(job.attachments ? { attachments: job.attachments.map(file => ({ ...file })) } : {}) }
  }

  private abortJob(id: string): void {
    if (this.current?.id === id) { this.current.controller?.abort(); return }
    if (this.removeQueued(id)) this.changed()
  }

  private removeQueued(id: string): boolean {
    const index = this.jobs.findIndex(job => job.id === id)
    if (index < 0) return false
    const [job] = this.jobs.splice(index, 1)
    this.finish(job, job.cancelled())
    return true
  }

  private detach(job: Job<unknown>): void {
    if (job.abortListener && job.externalSignal) job.externalSignal.removeEventListener('abort', job.abortListener)
    job.abortListener = undefined
  }

  private settle<T>(job: Job<T>, result: T): void {
    if (job.settled) return
    job.settled = true
    job.resolve(result)
  }

  private finish<T>(job: Job<T>, result: T): void {
    this.detach(job as Job<unknown>)
    if (job.dedupeKey && this.deduplicated.get(job.dedupeKey)?.completion === job.completion) this.deduplicated.delete(job.dedupeKey)
    this.settle(job, result)
  }

  private changed(): void {
    const state = this.state()
    for (const listener of this.listeners) listener(state)
  }
}
