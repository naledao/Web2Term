export type ContextUsageCategory = 'injection' | 'tool-definition' | 'tool-result' | 'tool-request' | 'attachment'
export interface ContextUsageEntry {
  id: string
  conversationId: string | null
  turnId: string | null
  sourceMessageId: string | null
  category: ContextUsageCategory
  state: 'sent' | 'unknown'
  estimatedTokens: number
  characters: number
  images: number
  files: number
  createdAt: number
}
export interface ContextUsageTotals { estimatedTokens: number; characters: number }
export interface ContextUsageSummary {
  injections: ContextUsageTotals
  toolDefinitions: ContextUsageTotals
  toolResults: ContextUsageTotals
  toolRequests: ContextUsageTotals
  uncertain: ContextUsageTotals
  uncertainCount: number
  images: number
  files: number
  requestSourceIds: string[]
  observedSince: number | null
}
export function emptyContextUsage(): ContextUsageSummary {
  return { injections: { estimatedTokens: 0, characters: 0 }, toolDefinitions: { estimatedTokens: 0, characters: 0 }, toolResults: { estimatedTokens: 0, characters: 0 },
    toolRequests: { estimatedTokens: 0, characters: 0 }, uncertain: { estimatedTokens: 0, characters: 0 },
    uncertainCount: 0, images: 0, files: 0, requestSourceIds: [], observedSince: null }
}
