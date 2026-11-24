import { FEEDBACK_CATEGORIES, FEEDBACK_MAX_CHARS, isFeedbackEmail } from '../shared/feedback'
import type { FeedbackCategory, FeedbackItem, FeedbackPage, FeedbackPageRequest, FeedbackResult } from '../shared/feedback'
import type { BackendAuthState } from '../shared/types'
import type { BackendConnectionCredentials } from './backend-auth'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const API = '/api/v1/feedback'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MIN_INTERVAL_MS = 5_000

class FeedbackError extends Error {
  constructor(message: string, readonly loginRequired = false) { super(message) }
}

interface FeedbackContext {
  auth: BackendAuthState
  credentials: BackendConnectionCredentials | null
  machineId: string
  appVersion: string
  platform: string
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const invalid = (): never => { throw new FeedbackError('反馈服务响应格式异常，请稍后重试。') }

function item(value: unknown): FeedbackItem {
  const row = object(value)
  const id = typeof row.id === 'number' && integer(row.id) && row.id > 0 ? String(row.id) : typeof row.id === 'string' && /^[1-9]\d{0,18}$/.test(row.id) ? row.id : invalid()
  if (typeof row.category !== 'string' || !(FEEDBACK_CATEGORIES as readonly string[]).includes(row.category) ||
    typeof row.content !== 'string' || [...row.content].length > FEEDBACK_MAX_CHARS || typeof row.email !== 'string' || row.email.length > 254 ||
    typeof row.appVersion !== 'string' || row.appVersion.length > 64 || typeof row.platform !== 'string' || row.platform.length > 128 ||
    !integer(row.status) || row.status > 9 || !integer(row.createdAt) || !integer(row.updatedAt)) return invalid()
  return { id, category: row.category as FeedbackCategory, content: row.content, email: row.email, appVersion: row.appVersion,
    platform: row.platform, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

/**
 * Signed-in feedback API. The access token stays in the main process.
 *   POST {backend}/api/v1/feedback   { machineId, category, content, email, appVersion, platform } → 201 item
 *   GET  {backend}/api/v1/feedback?limit&offset                                                  → 200 page
 */
export class FeedbackService {
  private sending = false
  private lastSentAt = 0
  constructor(private readonly context: () => FeedbackContext, private readonly request: typeof fetch = fetch) {}

  private signedIn(): { state: FeedbackContext; credentials: BackendConnectionCredentials } {
    const state = this.context()
    if (!state.credentials) {
      throw new FeedbackError(state.auth.status === 'expired' ? '登录已过期，请重新登录。' : '请先登录后再使用反馈。', true)
    }
    return { state, credentials: state.credentials }
  }

  private async send(credentials: BackendConnectionCredentials, path: string, init: { method: 'GET' | 'POST'; body?: string }, expected: number): Promise<unknown> {
    let response: Response
    try {
      response = await this.request(credentials.backendUrl.replace(/\/$/u, '') + API + path, {
        method: init.method, redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', Authorization: `Bearer ${credentials.accessToken}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(20_000)
      })
    } catch { throw new FeedbackError('无法连接反馈服务或请求超时，请稍后重试。') }
    const text = await this.read(response)
    if (response.status !== expected) {
      let message = ''
      try { const body = object(JSON.parse(text)); if (typeof body.message === 'string' && body.message.length <= 200) message = body.message } catch { /* status text below */ }
      if (response.status === 401) throw new FeedbackError('登录已失效，请重新登录。', true)
      throw new FeedbackError(
        response.status >= 300 && response.status < 400 ? '后端返回了重定向，请在设置中填写最终服务地址。' :
          response.status === 404 || response.status === 405 ? '后端尚未提供反馈接口，请更新后端服务。' :
            response.status === 403 ? (message || '当前账号无法提交反馈。') :
              response.status === 413 ? '反馈内容过长，请精简后重试。' :
                response.status === 429 ? (message || '提交太频繁了，请稍后再试。') :
                  response.status === 400 ? (message || '反馈内容未通过校验，请检查后重试。') : '反馈服务暂时不可用，请稍后重试。')
    }
    try { return JSON.parse(text) as unknown } catch { return invalid() }
  }

  private async read(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return invalid() }
        chunks.push(part.value)
      }
    } catch (error) {
      if (error instanceof FeedbackError) throw error
      throw new FeedbackError('反馈服务响应读取失败，请重试。')
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }

  private fail(error: unknown, fallback: string): { ok: false; message: string; loginRequired?: boolean } {
    if (error instanceof FeedbackError) return { ok: false, message: error.message, ...(error.loginRequired ? { loginRequired: true } : {}) }
    return { ok: false, message: fallback }
  }

  async submit(input: unknown): Promise<FeedbackResult<FeedbackItem>> {
    try {
      const draft = object(input)
      const category = draft.category
      if (typeof category !== 'string' || !(FEEDBACK_CATEGORIES as readonly string[]).includes(category)) throw new FeedbackError('请选择反馈类型。')
      if (typeof draft.content !== 'string') throw new FeedbackError('请填写反馈内容。')
      const content = draft.content.replace(/\r\n?/g, '\n').trim()
      if (!content) throw new FeedbackError('请填写反馈内容。')
      if ([...content].length > FEEDBACK_MAX_CHARS) throw new FeedbackError(`反馈内容不能超过 ${FEEDBACK_MAX_CHARS} 字。`)
      if (draft.email !== undefined && typeof draft.email !== 'string') throw new FeedbackError('邮箱格式不正确。')
      const email = ((draft.email as string | undefined) ?? '').trim()
      if (email && !isFeedbackEmail(email)) throw new FeedbackError('邮箱格式不正确。')

      const { state, credentials } = this.signedIn()
      if (this.sending) throw new FeedbackError('反馈正在提交，请稍候。')
      if (Date.now() - this.lastSentAt < MIN_INTERVAL_MS) throw new FeedbackError('提交太频繁了，请稍后再试。')
      const machineId = UUID.test(state.machineId) ? state.machineId.toLowerCase() : ''
      this.sending = true
      try {
        const body = JSON.stringify({ machineId, category, content, email, appVersion: state.appVersion, platform: state.platform })
        const created = item(await this.send(credentials, '', { method: 'POST', body }, 201))
        this.lastSentAt = Date.now()
        return { ok: true, value: created }
      } finally { this.sending = false }
    } catch (error) { return this.fail(error, '提交反馈失败，请重试。') }
  }

  async list(input: FeedbackPageRequest = {}): Promise<FeedbackResult<FeedbackPage>> {
    try {
      const limit = input?.limit ?? 20, offset = input?.offset ?? 0
      if (!integer(limit) || limit < 1 || limit > 100 || !integer(offset) || offset > 1_000_000) throw new FeedbackError('分页参数无效。')
      const { credentials } = this.signedIn()
      const page = object(await this.send(credentials, `?limit=${limit}&offset=${offset}`, { method: 'GET' }, 200))
      if (!Array.isArray(page.items) || page.items.length > limit || !integer(page.total) || page.limit !== limit || page.offset !== offset) return invalid()
      return { ok: true, value: { items: page.items.map(item), total: page.total, limit, offset } }
    } catch (error) { return this.fail(error, '读取反馈记录失败，请重试。') }
  }
}
