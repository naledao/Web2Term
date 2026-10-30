import type { DatabaseSync } from 'node:sqlite'
import { emptyContextUsage } from '../shared/context-usage'
import type { ContextUsageEntry, ContextUsageSummary } from '../shared/context-usage'

export class ContextUsageStore {
  private readonly summaries = new Map<string, { version: string; value: ContextUsageSummary }>()
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS context_usage (
      id TEXT NOT NULL, platform_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turn_id TEXT, source_message_id TEXT, category TEXT NOT NULL, state TEXT NOT NULL,
      tokens INTEGER NOT NULL, characters INTEGER NOT NULL, images INTEGER NOT NULL, files INTEGER NOT NULL, created_at INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'char-mix-v1',
      PRIMARY KEY(platform_id, conversation_id, id)
    ); CREATE INDEX IF NOT EXISTS idx_context_usage_conversation ON context_usage(platform_id, conversation_id);`)
  }
  save(platformId: string, entry: ContextUsageEntry): void {
    if (!entry.conversationId || !entry.id || entry.id.length > 1000 || !['injection', 'tool-definition', 'tool-result', 'tool-request', 'attachment'].includes(entry.category) ||
      !['sent', 'unknown'].includes(entry.state) || [entry.estimatedTokens, entry.characters, entry.images, entry.files, entry.createdAt]
        .some(value => !Number.isSafeInteger(value) || value < 0)) return
    this.db.prepare(`INSERT INTO context_usage
      (id, platform_id, conversation_id, turn_id, source_message_id, category, state, tokens, characters, images, files, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform_id, conversation_id, id) DO UPDATE SET state = CASE WHEN context_usage.state = 'sent' THEN 'sent' ELSE excluded.state END`)
      .run(entry.id, platformId, entry.conversationId, entry.turnId, entry.sourceMessageId, entry.category, entry.state,
        entry.estimatedTokens, entry.characters, entry.images, entry.files, entry.createdAt)
  }
  summary(platformId: string, conversationId: string): ContextUsageSummary {
    // total_changes covers this connection; data_version also covers another app process.
    const changes = this.db.prepare('SELECT total_changes() AS n').get() as { n: number }
    const external = this.db.prepare('PRAGMA data_version').get() as { data_version: number }
    const version = changes.n + ':' + external.data_version
    const key = JSON.stringify([platformId, conversationId])
    const cached = this.summaries.get(key)
    if (cached?.version === version) return cached.value
    const result = emptyContextUsage()
    // Parse each referenced turn once, rather than its growing JSON payload once per tool event.
    const rows = this.db.prepare(`WITH referenced_turns AS MATERIALIZED (
        SELECT DISTINCT turn_id FROM context_usage WHERE platform_id = ? AND conversation_id = ? AND turn_id IS NOT NULL
      ), archived_turns AS MATERIALIZED (
        SELECT turn.id FROM referenced_turns ref JOIN focus_turns turn ON turn.id = ref.turn_id
        WHERE CASE WHEN json_valid(turn.payload) THEN json_extract(turn.payload, '$.supersededBy') END IS NOT NULL
      )
      SELECT usage.* FROM context_usage usage WHERE platform_id = ? AND conversation_id = ?
      AND NOT EXISTS (SELECT 1 FROM archived_turns turn WHERE turn.id = usage.turn_id)`)
      .all(platformId, conversationId, platformId, conversationId) as unknown as Array<{ category: ContextUsageEntry['category']; state: ContextUsageEntry['state'];
        source_message_id: string | null; tokens: number; characters: number; images: number; files: number; created_at: number }>
    for (const row of rows) {
      result.observedSince = Math.min(result.observedSince ?? row.created_at, row.created_at)
      if (row.state === 'unknown') {
        result.uncertain.estimatedTokens += row.tokens; result.uncertain.characters += row.characters; result.uncertainCount++
        continue
      }
      const bucket = row.category === 'injection' ? result.injections : row.category === 'tool-definition' ? result.toolDefinitions : row.category === 'tool-result' ? result.toolResults
        : row.category === 'tool-request' ? result.toolRequests : null
      if (bucket) { bucket.estimatedTokens += row.tokens; bucket.characters += row.characters }
      if (row.source_message_id) result.requestSourceIds.push(row.source_message_id)
      result.images += row.images; result.files += row.files
    }
    if (this.summaries.size >= 32) this.summaries.delete(this.summaries.keys().next().value!)
    this.summaries.set(key, { version, value: result })
    return result
  }
}
