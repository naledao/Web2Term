export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'improvement', 'other'] as const
export type FeedbackCategory = typeof FEEDBACK_CATEGORIES[number]
export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: 'Bug / 问题',
  feature: '新功能建议',
  improvement: '体验优化',
  other: '其他'
}
/** Counted in Unicode code points, the same way the backend counts. */
export const FEEDBACK_MAX_CHARS = 5000

export const FEEDBACK_EMAIL_MAX_CHARS = 254
/** Deliberately loose: one @, no spaces, a dot in the domain. The backend applies the same rule. */
export const FEEDBACK_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const isFeedbackEmail = (value: string): boolean => value.length <= FEEDBACK_EMAIL_MAX_CHARS && FEEDBACK_EMAIL_PATTERN.test(value)

/** Backend status codes: 0 pending, 1 in progress, 2 resolved, 3 closed. */
export const FEEDBACK_STATUS_LABELS: Record<number, string> = { 0: '待处理', 1: '处理中', 2: '已解决', 3: '已关闭' }

/** `email` is optional; empty means "use my login email". */
export interface FeedbackDraft { category: FeedbackCategory; content: string; email?: string }
export interface FeedbackItem {
  id: string
  category: FeedbackCategory
  content: string
  email: string
  appVersion: string
  platform: string
  status: number
  createdAt: number
  updatedAt: number
}
export interface FeedbackPageRequest { limit?: number; offset?: number }
export interface FeedbackPage { items: FeedbackItem[]; total: number; limit: number; offset: number }
/** `loginRequired` tells the panel to switch to the sign-in form instead of showing a plain error. */
export type FeedbackResult<T> = { ok: true; value: T } | { ok: false; message: string; loginRequired?: boolean }
