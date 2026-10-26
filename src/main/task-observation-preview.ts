import type { TaskLease } from '../shared/autonomous-task'
import type { TaskObservationSummary } from '../shared/task-presentation'

const key = (lease: TaskLease): string => JSON.stringify([lease.sessionId, lease.platformId, lease.conversationId, lease.taskId, lease.generation])
interface Entry { owner: object; summary: TaskObservationSummary; bytes: Uint8Array | null; expires: number }
/** Optional display cache only. Eviction never changes an input binding or model delivery. */
export class TaskObservationPreviewCache {
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly now = Date.now) {}
  private sweep(): void { for (const [k, e] of this.entries) if (e.expires <= this.now()) this.entries.delete(k) }
  record(owner: object, lease: TaskLease, summary: TaskObservationSummary, bytes: Uint8Array | null): void {
    this.sweep()
    if (bytes && bytes.byteLength > 8 * 1024 * 1024) bytes = null
    const k = key(lease)
    this.entries.delete(k)
    this.entries.set(k, { owner, summary: structuredClone(summary), bytes: bytes ? Uint8Array.from(bytes) : null, expires: this.now() + 15 * 60_000 })
    let total = [...this.entries.values()].reduce((sum, e) => sum + (e.bytes?.byteLength ?? 0), 0)
    while (this.entries.size > 16 || total > 32 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!
      total -= this.entries.get(oldest)?.bytes?.byteLength ?? 0
      this.entries.delete(oldest)
    }
  }
  summary(lease: TaskLease): TaskObservationSummary | null {
    this.sweep()
    const entry = this.entries.get(key(lease))
    return entry ? { ...structuredClone(entry.summary), previewAvailable: !!entry.bytes } : null
  }
  image(lease: TaskLease, observationId: string): Uint8Array | null {
    this.sweep()
    const entry = this.entries.get(key(lease))
    return entry?.summary.observationId === observationId && entry.bytes ? Uint8Array.from(entry.bytes) : null
  }
  removeOwner(owner: object): void { for (const [k, e] of this.entries) if (e.owner === owner) this.entries.delete(k) }
  clear(): void { this.entries.clear() }
}
