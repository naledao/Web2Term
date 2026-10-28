export interface ReleaseNoteSummary {
  id: string
  version: string
  title: string
  publishedAt: number
  isRead: boolean
  readAt: number | null
}

export interface ReleaseNoteDetail extends ReleaseNoteSummary { contentHtml: string }
export interface ReleaseNotesPage {
  items: ReleaseNoteSummary[]
  total: number
  unreadCount: number
  limit: number
  offset: number
}
export interface ReleaseNotesPageRequest { limit?: number; offset?: number }
export interface ReleaseNoteRequest { id: string; source: string }
export interface ReleaseNoteRead { id: string; readAt: number }
export type ReleaseNotesResult<T> = { ok: true; source: string; value: T } | { ok: false; source: string; message: string }
