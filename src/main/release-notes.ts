import { normalizeBackendUrl } from '../shared/backend-url'
import type { ReleaseNoteDetail, ReleaseNoteRead, ReleaseNoteRequest, ReleaseNoteSummary, ReleaseNotesPage, ReleaseNotesPageRequest, ReleaseNotesResult } from '../shared/release-notes'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const API = '/api/v1/release-notes'
const MAX_BYTES = 8 * 1024 * 1024
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const timestamp = (value: unknown): value is number => integer(value) && value <= 8_640_000_000_000_000
const invalid = (): never => { throw new Error('更新说明响应格式异常，请稍后重试。') }

function idOf(value: unknown): string {
  if (typeof value === 'number' && integer(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n) return value
  return invalid()
}

function summary(value: unknown): ReleaseNoteSummary {
  const row = object(value)
  if (typeof row.version !== 'string' || row.version.length < 1 || row.version.length > 32 ||
    typeof row.title !== 'string' || !row.title.trim() || [...row.title].length > 200 ||
    !timestamp(row.publishedAt) || typeof row.isRead !== 'boolean' ||
    (row.readAt !== null && !timestamp(row.readAt)) || row.isRead !== (row.readAt !== null)) return invalid()
  return { id: idOf(row.id), version: row.version, title: row.title, publishedAt: row.publishedAt, isRead: row.isRead, readAt: row.readAt as number | null }
}

/** Public API only: no login token, admin token, or renderer-supplied URL. */
export class ReleaseNotesService {
  private revision = 0
  private active = new Set<AbortController>()
  constructor(private readonly context: () => { backendUrl: string; machineId: string }, private readonly request: typeof fetch = fetch) {}

  invalidate(): void {
    this.revision++
    for (const controller of this.active) controller.abort()
  }

  private snapshot(): { backendUrl: string; machineId: string; source: string } {
    const state = this.context()
    const backendUrl = normalizeBackendUrl(state.backendUrl)
    return { backendUrl, machineId: state.machineId.toLowerCase(), source: `${this.revision}:${backendUrl}` }
  }

  private async operation<T>(action: (send: (path: string, method?: 'GET' | 'POST') => Promise<unknown>, source: string, machineId: string) => Promise<T>, expectedSource?: string): Promise<ReleaseNotesResult<T>> {
    let source = ''
    const controller = new AbortController()
    try {
      const state = this.snapshot()
      source = state.source
      if (!state.backendUrl) throw new Error('请先在“设置 → 后端服务”中填写后端地址。')
      if (!UUID.test(state.machineId)) throw new Error('本机标识尚未就绪，请重新打开应用。')
      if (expectedSource !== undefined && expectedSource !== source) throw new Error('后端地址已切换，请刷新更新说明。')
      if (this.active.size >= 8) throw new Error('更新说明正在加载，请稍候。')
      this.active.add(controller)
      const current = (): boolean => this.snapshot().source === source && this.context().machineId.toLowerCase() === state.machineId
      const send = async (path: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> => {
        if (!current()) throw new Error('后端地址已切换，请刷新更新说明。')
        let response: Response
        try {
          response = await this.request(state.backendUrl.replace(/\/$/u, '') + API + path, {
            method, redirect: 'manual', credentials: 'omit', cache: 'no-store',
            headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            ...(method === 'POST' ? { body: JSON.stringify({ machineId: state.machineId }) } : {}),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
          })
        } catch { throw new Error(current() ? '无法连接更新说明服务或请求超时，请稍后重试。' : '后端地址已切换，请刷新更新说明。') }
        if (response.status !== 200) {
          await response.body?.cancel()
          throw new Error(response.status >= 300 && response.status < 400 ? '后端返回了重定向，请在设置中填写最终服务地址。' :
            response.status === 404 ? '更新说明不存在、已下线，或后端尚未提供更新说明接口。' :
              response.status === 429 ? '请求过于频繁，请稍后重试。' : '更新说明服务暂时不可用，请稍后重试。')
        }
        const reader = response.body?.getReader()
        if (!reader) return invalid()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_BYTES) { await reader.cancel(); return invalid() }
            chunks.push(part.value)
          }
        } catch { throw new Error('更新说明响应读取失败，请重试。') }
        finally { reader.releaseLock() }
        if (!current()) throw new Error('后端地址已切换，请刷新更新说明。')
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { return invalid() }
      }
      const value = await action(send, source, state.machineId)
      if (!current()) throw new Error('后端地址已切换，请刷新更新说明。')
      return { ok: true, source, value }
    } catch (error) {
      return { ok: false, source, message: error instanceof Error ? error.message : '读取更新说明失败，请重试。' }
    } finally { this.active.delete(controller) }
  }

  list(input: ReleaseNotesPageRequest = {}): Promise<ReleaseNotesResult<ReleaseNotesPage>> {
    return this.operation(async (send, _source, machineId) => {
      const limit = input?.limit ?? 20, offset = input?.offset ?? 0
      if (!integer(limit) || limit < 1 || limit > 100 || !integer(offset) || offset > 1_000_000) throw new Error('更新说明分页参数无效。')
      const page = object(await send(`?machineId=${encodeURIComponent(machineId)}&limit=${limit}&offset=${offset}`))
      if (!Array.isArray(page.items) || page.items.length > limit || !integer(page.total) || !integer(page.unreadCount) ||
        page.unreadCount > page.total || page.limit !== limit || page.offset !== offset) return invalid()
      const items = page.items.map(summary)
      if (new Set(items.map(item => item.id)).size !== items.length) return invalid()
      return { items, total: page.total, unreadCount: page.unreadCount, limit, offset }
    })
  }

  detail(input: ReleaseNoteRequest): Promise<ReleaseNotesResult<ReleaseNoteDetail>> {
    return this.operation(async (send, _source, machineId) => {
      const id = idOf(input?.id)
      const raw = object(await send(`/${id}?machineId=${encodeURIComponent(machineId)}`))
      const item = summary(raw)
      if (item.id !== id || typeof raw.contentHtml !== 'string' || Buffer.byteLength(raw.contentHtml, 'utf8') > 1024 * 1024) return invalid()
      return { ...item, contentHtml: raw.contentHtml }
    }, typeof input?.source === 'string' ? input.source : '')
  }

  markRead(input: ReleaseNoteRequest): Promise<ReleaseNotesResult<ReleaseNoteRead>> {
    return this.operation(async (send, _source, machineId) => {
      const id = idOf(input?.id)
      const raw = object(await send(`/${id}/read`, 'POST'))
      if (idOf(raw.id) !== id || raw.machineId !== machineId || raw.isRead !== true || !timestamp(raw.readAt)) return invalid()
      return { id, readAt: raw.readAt }
    }, typeof input?.source === 'string' ? input.source : '')
  }
}
