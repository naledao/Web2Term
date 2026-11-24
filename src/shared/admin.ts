import type { FeedbackCategory, FeedbackItem } from './feedback'

export const ADMIN_NOTE_MAX_CHARS = 2000
export const ADMIN_QUERY_MAX_CHARS = 100
export const ADMIN_FEEDBACK_STATUSES = [0, 1, 2, 3] as const

export interface AdminFeedbackSubmitter { publicId: string; email: string; nickname: string }
export interface AdminFeedbackItem extends FeedbackItem {
  machineId: string | null
  adminNote: string | null
  user: AdminFeedbackSubmitter
}
export interface AdminFeedbackQuery {
  /** null or undefined means every status. */
  status?: number | null
  category?: FeedbackCategory | ''
  q?: string
  limit?: number
  offset?: number
}
export interface AdminFeedbackPage {
  items: AdminFeedbackItem[]
  total: number
  limit: number
  offset: number
  /** Counts per status that honour the category and search filters but not the status filter. */
  statusCounts: Record<number, number>
}
/** Omitted fields are unchanged; an empty adminNote clears it. */
export interface AdminFeedbackPatch { id: string; status?: number; adminNote?: string }
export interface AdminAccount { email: string; nickname: string; backendUrl: string }

/** `loginRequired`: token missing/rejected. `forbidden`: signed in but not an administrator. */
export type AdminResult<T> = { ok: true; value: T } | { ok: false; message: string; loginRequired?: boolean; forbidden?: boolean; conflict?: boolean }

/* ---------------- Release notes administration ---------------- */

export const RELEASE_NOTE_STATUS_LABELS: Record<number, string> = { 0: '草稿', 1: '已发布', 2: '已下线' }
export const RELEASE_NOTE_STATUSES = [0, 1, 2] as const
export const RELEASE_NOTE_TITLE_MAX_CHARS = 200
export const RELEASE_NOTE_VERSION_MAX_CHARS = 32
export const RELEASE_NOTE_HTML_MAX_BYTES = 1024 * 1024
/** Same rule as the backend after a leading "v" is removed: 0.1.189, 1.2.3-beta.1, 1.2.3+build. */
export const RELEASE_NOTE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export interface AdminReleaseNote {
  id: string
  version: string
  title: string
  status: number
  /** Null until first published. A future value means the note is scheduled. */
  publishedAt: number | null
  createdAt: number
  updatedAt: number
  /** Only present in the detail response. */
  contentHtml?: string
  /** Only present in the list: machines that have read this note. */
  readCount?: number
}
export interface AdminReleaseNotesQuery { status?: number | null; limit?: number; offset?: number }
/** machineCount: distinct machines with any read record, the base for reach percentages. */
export interface AdminReleaseNotesPage { items: AdminReleaseNote[]; total: number; limit: number; offset: number; machineCount: number }
/** A full replacement: PUT always sends every field. A null publishedAt lets the backend choose (now, or keep the existing time). */
export interface AdminReleaseNoteInput { version: string; title: string; contentHtml: string; status: number; publishedAt: number | null }
export interface AdminReleaseNoteUpdate extends AdminReleaseNoteInput { id: string }

/** Client-side validation that mirrors the backend; returns the first problem or ''. */
export function releaseNoteInputProblem(input: AdminReleaseNoteInput): string {
  const version = input.version.trim().replace(/^v/, '')
  if (!version || version.length > RELEASE_NOTE_VERSION_MAX_CHARS || !RELEASE_NOTE_VERSION_PATTERN.test(version)) return '版本号格式应类似 0.1.189，最长 32 个字符。'
  const titleLength = [...input.title.trim()].length
  if (titleLength < 1 || titleLength > RELEASE_NOTE_TITLE_MAX_CHARS) return '标题需为 1～200 个字符。'
  if (new TextEncoder().encode(input.contentHtml).length > RELEASE_NOTE_HTML_MAX_BYTES) return 'HTML 正文不能超过 1 MiB。'
  if (!(RELEASE_NOTE_STATUSES as readonly number[]).includes(input.status)) return '请选择状态。'
  if (input.status === 1 && !input.contentHtml.trim()) return '发布时 HTML 正文不能为空。'
  if (input.publishedAt !== null && (!Number.isSafeInteger(input.publishedAt) || input.publishedAt < 0)) return '发布时间无效。'
  return ''
}

/* ---------------- Users ---------------- */

export type AdminRole = 'USER' | 'ADMIN'
export interface AdminUser {
  publicId: string
  email: string
  nickname: string
  role: AdminRole
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastLoginAt: number | null
  deviceCount: number
  feedbackCount: number
}
export interface AdminUserDevice { deviceId: string; deviceName: string; enabled: boolean; lastConnectedAt: number | null; lastDisconnectedAt: number | null; online: boolean }
export interface AdminAuditEntry { id: string; action: string; detail: string; actorEmail: string; createdAt: number }
export interface AdminUserDetail extends AdminUser {
  devices: AdminUserDevice[]
  recentFeedback: import('./feedback').FeedbackItem[]
  audit: AdminAuditEntry[]
}
export interface AdminUsersQuery { q?: string; role?: AdminRole | ''; enabled?: boolean | null; limit?: number; offset?: number }
export interface AdminUsersPage { items: AdminUser[]; total: number; limit: number; offset: number }
export interface AdminUserPatch { publicId: string; enabled?: boolean; role?: AdminRole }
/** self: the administrator revoked their own logins and must sign in again. */
export interface AdminRevokeResult { user: AdminUser; disconnectedConnections: number; self: boolean }

/* ---------------- Overview and machines ---------------- */

export interface AdminDailyCount { date: string; count: number }
export interface AdminNoteReach { id: string; version: string; title: string; publishedAt: number; readCount: number }
export interface AdminStats {
  users: { total: number; new7d: number; active7d: number; disabled: number; admins: number }
  feedback: { pending: number; inProgress: number; new7d: number; total: number }
  releaseNotes: { published: number; scheduled: number; drafts: number; offline: number }
  /** Derived only from release-note read records: machines that opened the release notes. */
  machines: { total: number; read7d: number; read30d: number; dailyNew: AdminDailyCount[]; noteReach: AdminNoteReach[] }
  onlineDevices: number
}
export interface AdminMachine { machineId: string; firstReadAt: number; lastReadAt: number; readCount: number; feedbackCount: number }
export interface AdminMachinesQuery { q?: string; limit?: number; offset?: number }
export interface AdminMachinesPage { items: AdminMachine[]; total: number; limit: number; offset: number }
