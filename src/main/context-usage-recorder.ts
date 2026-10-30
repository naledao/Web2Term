import { randomUUID } from 'node:crypto'
import { estimateContextText } from '../shared/focus-token-usage'
import type { ContextUsageCategory, ContextUsageEntry } from '../shared/context-usage'
import type { FocusTextUsage } from '../shared/focus-token-usage'

type Ticket = Omit<ContextUsageEntry, 'state'>
/** Metadata-only observations of real payloads. Recording never authorizes a send or retries one. */
export class ContextUsageRecorder {
  private readonly scope = randomUUID()
  constructor(private readonly owner: () => { conversationId: string | null; turnId: string | null },
    private readonly emit: (entry: ContextUsageEntry) => void) {}
  begin(text: string, category: ContextUsageCategory, key: string = randomUUID(), media: { images: number; files: number } = { images: 0, files: 0 }): Ticket | undefined {
    try {
      if (category === 'tool-result' && text.startsWith('【工具说明】')) category = 'tool-definition'
      return { ...this.owner(), ...estimateContextText(text.replace(/\r\n?/g, '\n')), id: this.scope + ':' + key, sourceMessageId: null,
        category, images: media.images, files: media.files, createdAt: Date.now() }
    } catch { return undefined }
  }
  confirmedUsage(usage: FocusTextUsage & { id: string }, category: ContextUsageCategory, key: string): void {
    if (typeof usage.id !== 'string' || !/^[a-z0-9:]{1,100}$/.test(usage.id) ||
      !Number.isSafeInteger(usage.characters) || usage.characters < 0 || usage.characters > 1_000_000 ||
      !Number.isSafeInteger(usage.estimatedTokens) || usage.estimatedTokens < 0 || usage.estimatedTokens > usage.characters) return
    const ticket = this.begin('', category, key)
    if (ticket) this.finish({ ...ticket, estimatedTokens: usage.estimatedTokens, characters: usage.characters }, 'ok')
  }
  finish(ticket: Ticket | undefined, outcome: unknown): void {
    if (!ticket || !['ok', 'sent', 'stuck', 'unknown'].includes(String(outcome))) return
    try { this.emit({ ...ticket, state: outcome === 'ok' || outcome === 'sent' ? 'sent' : 'unknown' }) }
    catch { /* A statistics failure must never change an execution or delivery result. */ }
  }
  confirmed(text: string, category: ContextUsageCategory, key: string, sourceMessageId: string | null = null): void {
    const ticket = this.begin(text, category, key)
    if (!ticket) return
    if (sourceMessageId && ticket.conversationId) {
      // Native assistant identities survive reloads; re-reading their history is not another request.
      ticket.id = 'request:' + ticket.conversationId + ':' + sourceMessageId
      ticket.sourceMessageId = sourceMessageId
    }
    this.finish(ticket, 'ok')
  }
}
