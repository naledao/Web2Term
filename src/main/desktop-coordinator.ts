import type { TaskLease } from '../shared/autonomous-task'

export interface DesktopOwner extends TaskLease { machineId: string }
export interface DesktopPermit { release(): void }
export interface DesktopRequest {
  owner: DesktopOwner
  kind: 'desktop' | 'command'
  signal: AbortSignal
  current(): boolean
  eligible(): boolean
  /** Retain a desktop lease between model turns, never restored from storage. */
  keep(): boolean
  waiting?(): void
}
interface Entry extends DesktopRequest {
  key: string
  detach(): void
  resolve(permit: DesktopPermit): void
  reject(error: Error): void
}
const keyOf = (owner: DesktopOwner): string => JSON.stringify([owner.sessionId, owner.platformId, owner.conversationId, owner.taskId, owner.generation, owner.machineId])
const sameTask = (a: TaskLease, b: TaskLease): boolean => a.sessionId === b.sessionId && a.platformId === b.platformId && a.conversationId === b.conversationId && a.taskId === b.taskId && a.generation === b.generation
const check = (predicate: () => boolean): boolean => { try { return predicate() === true } catch { return false } }

/** Application-wide, process-local admission. Cancellation never releases an executing operation. */
export class DesktopCoordinator {
  private readonly queue: Entry[] = []
  private readonly running = new Map<DesktopPermit, Entry>()
  private owner: { key: string; value: DesktopOwner; keep(): boolean; revoked: boolean } | null = null
  private readonly listeners = new Set<() => void>()
  private emergencyStopped = false
  private humanControl = false
  private nativeBlocked = false
  private disposed = false
  private pumping = false
  private pumpAgain = false

  constructor(private readonly leaseChanged: () => void = () => {}) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getState(): { owner: DesktopOwner | null; draining: boolean; humanControl: boolean; nativeBlocked: boolean; queued: number; executing: number } {
    return { owner: this.owner ? { ...this.owner.value } : null, draining: this.owner?.revoked ?? false,
      humanControl: this.humanControl, nativeBlocked: this.nativeBlocked, queued: this.queue.length, executing: this.running.size }
  }
  /** A physical input belongs to the exact live desktop watch, never a historical session. */
  takeHumanControl(owner: DesktopOwner): boolean {
    if (!this.owner || this.owner.revoked || this.owner.key !== keyOf(owner) || this.emergencyStopped) return false
    this.humanControl = true; this.owner.revoked = true; this.reconcile(); return true
  }
  canReleaseHumanControl(): boolean { return !this.humanControl || !this.nativeBlocked && this.running.size === 0 }
  /** Only called after a new human submission is confirmed. Does not revive the old owner. */
  releaseHumanControl(): boolean {
    if (!this.canReleaseHumanControl()) return false
    this.humanControl = false; this.reconcile(); return true
  }
  setEmergencyStopped(active: boolean): void {
    this.emergencyStopped = active
    if (active) { for (const entry of [...this.queue]) this.cancel(entry); if (this.owner) this.owner.revoked = true }
    this.reconcile()
  }
  /** A retired helper may have resolved its request before its native process actually exits. */
  setNativeBlocked(blocked: boolean): void { if (this.nativeBlocked !== blocked) { this.nativeBlocked = blocked; this.reconcile() } }
  authorizes(permit: DesktopPermit | undefined, lease: TaskLease, kind: DesktopRequest['kind']): boolean {
    const entry = permit && this.running.get(permit)
    return !this.disposed && !this.emergencyStopped && !this.humanControl && !this.nativeBlocked && !!entry && entry.kind === kind && sameTask(entry.owner, lease) &&
      !entry.signal.aborted && check(entry.current) && (kind !== 'desktop' || this.owner?.key === entry.key && !this.owner.revoked)
  }
  acquire(request: DesktopRequest): Promise<DesktopPermit> {
    if (this.disposed || this.emergencyStopped || request.signal.aborted || !check(request.current)) return Promise.reject(new Error('desktop-request-cancelled'))
    if (this.queue.length >= 256) return Promise.reject(new Error('desktop-queue-full'))
    const owner = request.owner
    if (![owner.sessionId, owner.platformId, owner.conversationId, owner.taskId, owner.machineId].every(v => typeof v === 'string' && !!v.trim() && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v)) ||
      !Number.isSafeInteger(owner.generation) || owner.generation < 1) return Promise.reject(new Error('desktop-owner-invalid'))
    return new Promise((resolve, reject) => {
      const entry: Entry = { ...request, owner: { ...owner }, key: keyOf(owner), resolve, reject, detach: () => {} }
      const abort = (): void => { this.cancel(entry); this.reconcile() }
      entry.detach = () => request.signal.removeEventListener('abort', abort)
      request.signal.addEventListener('abort', abort, { once: true })
      this.queue.push(entry)
      this.reconcile()
      if (this.queue.includes(entry)) { try { request.waiting?.() } catch { this.cancel(entry); this.reconcile() } }
    })
  }
  releaseSession(sessionId: string): void {
    for (const entry of [...this.queue]) if (entry.owner.sessionId === sessionId) this.cancel(entry)
    if (this.owner?.value.sessionId === sessionId) this.owner.revoked = true
    this.reconcile()
  }
  reconcile(): void {
    if (this.pumping) { this.pumpAgain = true; return }
    this.pumping = true
    try {
      do { this.pumpAgain = false; this.pump() } while (this.pumpAgain)
    } finally { this.pumping = false }
    for (const listener of this.listeners) { try { listener() } catch { /* UI notification is not authority. */ } }
  }
  dispose(): void {
    this.disposed = true
    for (const entry of [...this.queue]) this.cancel(entry)
    if (this.owner) this.owner.revoked = true
    this.listeners.clear()
    this.reconcile()
  }
  private cancel(entry: Entry): void {
    const index = this.queue.indexOf(entry)
    if (index < 0) return // Executing callers keep their permit until their own finally.
    this.queue.splice(index, 1); entry.detach(); entry.reject(new Error('desktop-request-cancelled'))
  }
  private changeOwner(owner: typeof this.owner): void {
    this.owner = owner
    this.leaseChanged()
  }
  private grant(entry: Entry): void {
    this.queue.splice(this.queue.indexOf(entry), 1); entry.detach()
    const permit: DesktopPermit = { release: () => { if (this.running.delete(permit)) this.reconcile() } }
    this.running.set(permit, entry)
    entry.resolve(permit)
  }
  private pump(): void {
    for (const entry of [...this.queue]) if (this.disposed || entry.signal.aborted || !check(entry.current)) this.cancel(entry)
    if (this.owner && (!check(this.owner.keep) || this.disposed)) this.owner.revoked = true
    if (this.owner?.revoked && ![...this.running.values()].some(e => e.key === this.owner!.key)) this.changeOwner(null)
    if (this.disposed || this.emergencyStopped || this.humanControl || this.nativeBlocked || this.owner?.revoked) return
    if (this.owner) {
      if (this.running.size) return
      const next = this.queue.find(e => e.key === this.owner!.key && check(e.eligible))
      if (next) this.grant(next)
      return
    }
    while (true) {
      const next = this.queue.find(e => check(e.eligible))
      if (!next) return
      if (next.kind === 'desktop') {
        if (this.running.size) return
        this.changeOwner({ key: next.key, value: { ...next.owner }, keep: next.keep, revoked: false })
        this.grant(next); return
      }
      if ([...this.running.values()].some(e => e.key === next.key)) return
      this.grant(next)
    }
  }
}
