import { FEEDBACK_CATEGORIES, FEEDBACK_MAX_CHARS } from '../shared/feedback'
import type { FeedbackCategory } from '../shared/feedback'
import { ADMIN_NOTE_MAX_CHARS, ADMIN_QUERY_MAX_CHARS, RELEASE_NOTE_HTML_MAX_BYTES, releaseNoteInputProblem } from '../shared/admin'
import type {
  AdminAuditEntry, AdminFeedbackItem, AdminFeedbackPage, AdminFeedbackPatch, AdminFeedbackQuery, AdminMachine, AdminMachinesPage,
  AdminMachinesQuery, AdminReleaseNote, AdminReleaseNoteInput, AdminReleaseNotesPage, AdminReleaseNotesQuery, AdminReleaseNoteUpdate,
  AdminResult, AdminRevokeResult, AdminStats, AdminUser, AdminUserDetail, AdminUserDevice, AdminUserPatch, AdminUsersPage, AdminUsersQuery
} from '../shared/admin'
import type { FeedbackItem } from '../shared/feedback'
import type { BackendConnectionCredentials } from './backend-auth'

const FEEDBACK_API = '/api/v1/admin/feedback'
const RELEASE_NOTES_API = '/api/v1/admin/release-notes'
const USERS_API = '/api/v1/admin/users'
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

type ErrorKind = 'login' | 'forbidden' | 'conflict' | 'other'
class AdminError extends Error {
  constructor(message: string, readonly kind: ErrorKind = 'other') { super(message) }
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum
const invalid = (): never => { throw new AdminError('管理接口响应格式异常，请确认后端已更新。') }
const isCategory = (value: unknown): value is FeedbackCategory => typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value)
const validId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
const positiveId = (value: unknown): string => typeof value === 'number' && integer(value) && value > 0 ? String(value) : invalid()

function adminItem(value: unknown): AdminFeedbackItem {
  const row = object(value)
  const user = object(row.user)
  const id = positiveId(row.id)
  if (!isCategory(row.category) || typeof row.content !== 'string' || [...row.content].length > FEEDBACK_MAX_CHARS ||
    !text(row.email, 254) || !text(row.appVersion, 64) || !text(row.platform, 128) || !integer(row.status) || row.status > 9 ||
    !integer(row.createdAt) || !integer(row.updatedAt) || (row.machineId !== null && !text(row.machineId, 64)) ||
    (row.adminNote !== null && !text(row.adminNote, ADMIN_NOTE_MAX_CHARS * 2)) ||
    !text(user.publicId, 256) || !text(user.email, 254) || !text(user.nickname, 1024)) return invalid()
  return {
    id, category: row.category, content: row.content, email: row.email, appVersion: row.appVersion, platform: row.platform,
    status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
    machineId: row.machineId as string | null, adminNote: row.adminNote as string | null,
    user: { publicId: user.publicId, email: user.email, nickname: user.nickname }
  }
}

function releaseNote(value: unknown, withContent: boolean): AdminReleaseNote {
  const row = object(value)
  const id = positiveId(row.id)
  if (!text(row.version, 64) || !row.version || !text(row.title, 400) || !integer(row.status) || row.status > 2 ||
    (row.publishedAt !== null && !integer(row.publishedAt)) || !integer(row.createdAt) || !integer(row.updatedAt)) return invalid()
  // The list omits contentHtml (omitempty); the detail must carry it, possibly empty for drafts.
  const contentHtml = row.contentHtml === undefined ? '' : row.contentHtml
  if (typeof contentHtml !== 'string' || Buffer.byteLength(contentHtml, 'utf8') > RELEASE_NOTE_HTML_MAX_BYTES) return invalid()
  if (row.readCount !== undefined && !integer(row.readCount)) return invalid()
  return {
    id, version: row.version, title: row.title, status: row.status, publishedAt: row.publishedAt as number | null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, ...(withContent ? { contentHtml } : {}),
    ...(integer(row.readCount) ? { readCount: row.readCount } : {})
  }
}

const optionalTime = (value: unknown): number | null => value === null || value === undefined ? null : integer(value) ? value : invalid()
const validPublicId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)

function adminUser(value: unknown): AdminUser {
  const row = object(value)
  if (!validPublicId(row.publicId) || !text(row.email, 254) || !text(row.nickname, 1024) || (row.role !== 'USER' && row.role !== 'ADMIN') ||
    typeof row.enabled !== 'boolean' || !integer(row.createdAt) || !integer(row.updatedAt) || !integer(row.deviceCount) || !integer(row.feedbackCount)) return invalid()
  return {
    publicId: row.publicId, email: row.email, nickname: row.nickname, role: row.role, enabled: row.enabled, createdAt: row.createdAt,
    updatedAt: row.updatedAt, lastLoginAt: optionalTime(row.lastLoginAt), deviceCount: row.deviceCount, feedbackCount: row.feedbackCount
  }
}

function userFeedback(value: unknown): FeedbackItem {
  const row = object(value)
  if (!isCategory(row.category) || typeof row.content !== 'string' || !integer(row.status) || !integer(row.createdAt) || !integer(row.updatedAt) ||
    !text(row.email, 254) || !text(row.appVersion, 64) || !text(row.platform, 128)) return invalid()
  return { id: positiveId(row.id), category: row.category, content: row.content, email: row.email, appVersion: row.appVersion,
    platform: row.platform, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

function adminUserDetail(value: unknown): AdminUserDetail {
  const body = object(value)
  const row = object(body.user)
  const online = new Set(Array.isArray(body.onlineDeviceIds) ? body.onlineDeviceIds.filter((id): id is string => typeof id === 'string') : [])
  if (!Array.isArray(row.devices) || !Array.isArray(row.recentFeedback) || !Array.isArray(row.audit)) return invalid()
  const devices: AdminUserDevice[] = row.devices.map(item => {
    const device = object(item)
    if (!text(device.deviceId, 64) || !text(device.deviceName, 200) || typeof device.enabled !== 'boolean') return invalid()
    return { deviceId: device.deviceId, deviceName: device.deviceName, enabled: device.enabled, lastConnectedAt: optionalTime(device.lastConnectedAt),
      lastDisconnectedAt: optionalTime(device.lastDisconnectedAt), online: online.has(device.deviceId) }
  })
  const audit: AdminAuditEntry[] = row.audit.map(item => {
    const entry = object(item)
    if (!text(entry.action, 64) || !text(entry.actorEmail, 254) || !integer(entry.createdAt)) return invalid()
    return { id: positiveId(entry.id), action: entry.action, detail: JSON.stringify(entry.detail ?? {}), actorEmail: entry.actorEmail, createdAt: entry.createdAt }
  })
  return { ...adminUser(row), devices, recentFeedback: row.recentFeedback.map(userFeedback), audit }
}

const count = (value: unknown): number => integer(value) ? value : invalid()

function adminStats(value: unknown): AdminStats {
  const row = object(value)
  const users = object(row.users), feedback = object(row.feedback), notes = object(row.releaseNotes), machines = object(row.machines)
  if (!Array.isArray(machines.dailyNew) || !Array.isArray(machines.noteReach)) return invalid()
  return {
    users: { total: count(users.total), new7d: count(users.new7d), active7d: count(users.active7d), disabled: count(users.disabled), admins: count(users.admins) },
    feedback: { pending: count(feedback.pending), inProgress: count(feedback.inProgress), new7d: count(feedback.new7d), total: count(feedback.total) },
    releaseNotes: { published: count(notes.published), scheduled: count(notes.scheduled), drafts: count(notes.drafts), offline: count(notes.offline) },
    machines: {
      total: count(machines.total), read7d: count(machines.read7d), read30d: count(machines.read30d),
      dailyNew: machines.dailyNew.map(item => {
        const day = object(item)
        if (typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return invalid()
        return { date: day.date, count: count(day.count) }
      }),
      noteReach: machines.noteReach.map(item => {
        const reach = object(item)
        if (!text(reach.version, 64) || !text(reach.title, 400)) return invalid()
        return { id: positiveId(reach.id), version: reach.version, title: reach.title, publishedAt: count(reach.publishedAt), readCount: count(reach.readCount) }
      })
    },
    onlineDevices: count(row.onlineDevices)
  }
}

function machine(value: unknown): AdminMachine {
  const row = object(value)
  if (!text(row.machineId, 64)) return invalid()
  return { machineId: row.machineId, firstReadAt: count(row.firstReadAt), lastReadAt: count(row.lastReadAt), readCount: count(row.readCount), feedbackCount: count(row.feedbackCount) }
}

/** Accepts both error shapes: feedback `{code, message}` and release notes `{error: {code, message}}`. */
function errorMessage(body: string): string {
  try {
    const data = object(JSON.parse(body))
    const message = typeof data.message === 'string' ? data.message : object(data.error).message
    return typeof message === 'string' && message.length <= 300 ? message : ''
  } catch { return '' }
}

/**
 * Role-based administration API. Requests use the signed-in account's token,
 * which never leaves the main process; the backend decides whether it is an administrator.
 */
export class AdminService {
  constructor(
    private readonly credentials: () => BackendConnectionCredentials | null,
    private readonly request: typeof fetch = fetch,
    /** Called after a release note is created, replaced or deleted so the main window can refresh. */
    private readonly onReleaseNotesChanged: () => void = () => {},
    /** Called when the administrator revoked their own logins, so the saved login can be re-checked. */
    private readonly onOwnLoginRevoked: () => void = () => {}
  ) {}

  private async send(path: string, init: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: string }, expected: number): Promise<unknown> {
    const credentials = this.credentials()
    if (!credentials) throw new AdminError('登录已失效，请在主窗口重新登录。', 'login')
    let response: Response
    try {
      response = await this.request(credentials.backendUrl.replace(/\/$/u, '') + path, {
        method: init.method, redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', Authorization: `Bearer ${credentials.accessToken}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(30_000)
      })
    } catch { throw new AdminError('无法连接后端或请求超时，请稍后重试。') }
    const body = await this.read(response)
    if (response.status !== expected) {
      const message = errorMessage(body)
      if (response.status === 401) throw new AdminError('登录已失效，请在主窗口重新登录。', 'login')
      if (response.status === 403) throw new AdminError('当前账号没有管理员权限。', 'forbidden')
      if (response.status === 409) throw new AdminError(message || '数据冲突，请刷新后重试。', 'conflict')
      throw new AdminError(
        response.status >= 300 && response.status < 400 ? '后端返回了重定向，请在设置中填写最终服务地址。' :
          response.status === 404 ? (message || '内容不存在，或后端尚未提供该管理接口。') :
            response.status === 405 ? '后端尚未提供该管理接口，请更新后端服务。' :
              response.status === 413 ? '内容过大，请精简后重试。' :
                response.status === 400 ? (message || '请求参数不正确。') :
                  response.status === 429 ? '操作过于频繁，请稍后再试。' : (message || '后端服务暂时不可用，请稍后重试。'))
    }
    if (expected === 204) return null
    try { return JSON.parse(body) as unknown } catch { return invalid() }
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
      if (error instanceof AdminError) throw error
      throw new AdminError('后端响应读取失败，请重试。')
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async run<T>(action: () => Promise<T>, fallback: string): Promise<AdminResult<T>> {
    try { return { ok: true, value: await action() } } catch (error) {
      if (!(error instanceof AdminError)) return { ok: false, message: fallback }
      const flags = error.kind === 'login' ? { loginRequired: true } : error.kind === 'forbidden' ? { forbidden: true } : error.kind === 'conflict' ? { conflict: true } : {}
      return { ok: false, message: error.message, ...flags }
    }
  }

  private pagination(limit: unknown, offset: unknown): URLSearchParams {
    if (!integer(limit) || limit < 1 || limit > 100 || !integer(offset) || offset > 1_000_000) throw new AdminError('分页参数无效。')
    return new URLSearchParams({ limit: String(limit), offset: String(offset) })
  }

  /* ---------------- Feedback ---------------- */

  listFeedback(input: AdminFeedbackQuery = {}): Promise<AdminResult<AdminFeedbackPage>> {
    return this.run(async () => {
      const limit = input?.limit ?? 20, offset = input?.offset ?? 0
      const params = this.pagination(limit, offset)
      if (input?.status !== undefined && input.status !== null) {
        if (!integer(input.status) || input.status > 3) throw new AdminError('反馈状态无效。')
        params.set('status', String(input.status))
      }
      if (input?.category) {
        if (!isCategory(input.category)) throw new AdminError('反馈类型无效。')
        params.set('category', input.category)
      }
      const q = typeof input?.q === 'string' ? input.q.trim() : ''
      if ([...q].length > ADMIN_QUERY_MAX_CHARS) throw new AdminError(`搜索内容不能超过 ${ADMIN_QUERY_MAX_CHARS} 字。`)
      if (q) params.set('q', q)
      const page = object(await this.send(`${FEEDBACK_API}?${params}`, { method: 'GET' }, 200))
      const counts = object(page.statusCounts)
      if (!Array.isArray(page.items) || page.items.length > limit || !integer(page.total) || page.limit !== limit || page.offset !== offset) return invalid()
      const statusCounts: Record<number, number> = {}
      for (const status of [0, 1, 2, 3]) statusCounts[status] = integer(counts[String(status)]) ? counts[String(status)] as number : 0
      return { items: page.items.map(adminItem), total: page.total, limit, offset, statusCounts }
    }, '读取反馈列表失败，请重试。')
  }

  getFeedback(id: unknown): Promise<AdminResult<AdminFeedbackItem>> {
    return this.run(async () => {
      if (!validId(id)) throw new AdminError('反馈 ID 无效。')
      return adminItem(await this.send(`${FEEDBACK_API}/${id}`, { method: 'GET' }, 200))
    }, '读取反馈详情失败，请重试。')
  }

  updateFeedback(input: AdminFeedbackPatch): Promise<AdminResult<AdminFeedbackItem>> {
    return this.run(async () => {
      if (!validId(input?.id)) throw new AdminError('反馈 ID 无效。')
      const body: Record<string, unknown> = {}
      if (input.status !== undefined) {
        if (!integer(input.status) || input.status > 3) throw new AdminError('反馈状态无效。')
        body.status = input.status
      }
      if (input.adminNote !== undefined) {
        if (typeof input.adminNote !== 'string' || [...input.adminNote.trim()].length > ADMIN_NOTE_MAX_CHARS) throw new AdminError(`内部备注不能超过 ${ADMIN_NOTE_MAX_CHARS} 字。`)
        body.adminNote = input.adminNote.replace(/\r\n?/g, '\n').trim()
      }
      if (!Object.keys(body).length) throw new AdminError('没有需要保存的修改。')
      return adminItem(await this.send(`${FEEDBACK_API}/${input.id}`, { method: 'PATCH', body: JSON.stringify(body) }, 200))
    }, '保存失败，请重试。')
  }

  /* ---------------- Release notes ---------------- */

  listReleaseNotes(input: AdminReleaseNotesQuery = {}): Promise<AdminResult<AdminReleaseNotesPage>> {
    return this.run(async () => {
      const limit = input?.limit ?? 20, offset = input?.offset ?? 0
      const params = this.pagination(limit, offset)
      if (input?.status !== undefined && input.status !== null) {
        if (!integer(input.status) || input.status > 2) throw new AdminError('更新说明状态无效。')
        params.set('status', String(input.status))
      }
      const page = object(await this.send(`${RELEASE_NOTES_API}?${params}`, { method: 'GET' }, 200))
      if (!Array.isArray(page.items) || page.items.length > limit || !integer(page.total) || page.limit !== limit || page.offset !== offset) return invalid()
      return { items: page.items.map(item => releaseNote(item, false)), total: page.total, limit, offset, machineCount: integer(page.machineCount) ? page.machineCount : 0 }
    }, '读取更新说明列表失败，请重试。')
  }

  getReleaseNote(id: unknown): Promise<AdminResult<AdminReleaseNote>> {
    return this.run(async () => {
      if (!validId(id)) throw new AdminError('更新说明 ID 无效。')
      return releaseNote(await this.send(`${RELEASE_NOTES_API}/${id}`, { method: 'GET' }, 200), true)
    }, '读取更新说明失败，请重试。')
  }

  private body(input: AdminReleaseNoteInput): string {
    const draft: AdminReleaseNoteInput = {
      version: typeof input?.version === 'string' ? input.version.trim() : '',
      title: typeof input?.title === 'string' ? input.title.trim() : '',
      contentHtml: typeof input?.contentHtml === 'string' ? input.contentHtml : '',
      status: typeof input?.status === 'number' ? input.status : -1,
      publishedAt: input?.publishedAt ?? null
    }
    const problem = releaseNoteInputProblem(draft)
    if (problem) throw new AdminError(problem)
    return JSON.stringify(draft)
  }

  createReleaseNote(input: AdminReleaseNoteInput): Promise<AdminResult<AdminReleaseNote>> {
    return this.run(async () => {
      const created = releaseNote(await this.send(RELEASE_NOTES_API, { method: 'POST', body: this.body(input) }, 201), true)
      this.onReleaseNotesChanged()
      return created
    }, '新建更新说明失败，请重试。')
  }

  updateReleaseNote(input: AdminReleaseNoteUpdate): Promise<AdminResult<AdminReleaseNote>> {
    return this.run(async () => {
      if (!validId(input?.id)) throw new AdminError('更新说明 ID 无效。')
      const updated = releaseNote(await this.send(`${RELEASE_NOTES_API}/${input.id}`, { method: 'PUT', body: this.body(input) }, 200), true)
      this.onReleaseNotesChanged()
      return updated
    }, '保存更新说明失败，请重试。')
  }

  deleteReleaseNote(id: unknown): Promise<AdminResult<null>> {
    return this.run(async () => {
      if (!validId(id)) throw new AdminError('更新说明 ID 无效。')
      await this.send(`${RELEASE_NOTES_API}/${id}`, { method: 'DELETE' }, 204)
      this.onReleaseNotesChanged()
      return null
    }, '删除更新说明失败，请重试。')
  }

  /* ---------------- Users ---------------- */

  listUsers(input: AdminUsersQuery = {}): Promise<AdminResult<AdminUsersPage>> {
    return this.run(async () => {
      const limit = input?.limit ?? 20, offset = input?.offset ?? 0
      const params = this.pagination(limit, offset)
      const q = typeof input?.q === 'string' ? input.q.trim() : ''
      if ([...q].length > ADMIN_QUERY_MAX_CHARS) throw new AdminError(`搜索内容不能超过 ${ADMIN_QUERY_MAX_CHARS} 字。`)
      if (q) params.set('q', q)
      if (input?.role) {
        if (input.role !== 'USER' && input.role !== 'ADMIN') throw new AdminError('角色无效。')
        params.set('role', input.role)
      }
      if (typeof input?.enabled === 'boolean') params.set('enabled', input.enabled ? '1' : '0')
      const page = object(await this.send(`${USERS_API}?${params}`, { method: 'GET' }, 200))
      if (!Array.isArray(page.items) || page.items.length > limit || !integer(page.total) || page.limit !== limit || page.offset !== offset) return invalid()
      return { items: page.items.map(adminUser), total: page.total, limit, offset }
    }, '读取用户列表失败，请重试。')
  }

  getUser(publicId: unknown): Promise<AdminResult<AdminUserDetail>> {
    return this.run(async () => {
      if (!validPublicId(publicId)) throw new AdminError('用户 ID 无效。')
      return adminUserDetail(await this.send(`${USERS_API}/${publicId}`, { method: 'GET' }, 200))
    }, '读取用户详情失败，请重试。')
  }

  updateUser(input: AdminUserPatch): Promise<AdminResult<AdminUser>> {
    return this.run(async () => {
      if (!validPublicId(input?.publicId)) throw new AdminError('用户 ID 无效。')
      const body: Record<string, unknown> = {}
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') throw new AdminError('状态无效。')
        body.enabled = input.enabled
      }
      if (input.role !== undefined) {
        if (input.role !== 'USER' && input.role !== 'ADMIN') throw new AdminError('角色无效。')
        body.role = input.role
      }
      if (!Object.keys(body).length) throw new AdminError('没有需要保存的修改。')
      return adminUser(await this.send(`${USERS_API}/${input.publicId}`, { method: 'PATCH', body: JSON.stringify(body) }, 200))
    }, '保存失败，请重试。')
  }

  revokeUserSessions(publicId: unknown): Promise<AdminResult<AdminRevokeResult>> {
    return this.run(async () => {
      if (!validPublicId(publicId)) throw new AdminError('用户 ID 无效。')
      const body = object(await this.send(`${USERS_API}/${publicId}/revoke-sessions`, { method: 'POST', body: '{}' }, 200))
      const result = { user: adminUser(body.user), disconnectedConnections: count(body.disconnectedConnections), self: body.self === true }
      if (result.self) this.onOwnLoginRevoked()
      return result
    }, '操作失败，请重试。')
  }

  /* ---------------- Overview and machines ---------------- */

  getStats(): Promise<AdminResult<AdminStats>> {
    return this.run(async () => adminStats(await this.send('/api/v1/admin/stats', { method: 'GET' }, 200)), '读取统计失败，请重试。')
  }

  listMachines(input: AdminMachinesQuery = {}): Promise<AdminResult<AdminMachinesPage>> {
    return this.run(async () => {
      const limit = input?.limit ?? 20, offset = input?.offset ?? 0
      const params = this.pagination(limit, offset)
      const q = typeof input?.q === 'string' ? input.q.trim().toLowerCase() : ''
      if (q.length > 36 || !/^[0-9a-f-]*$/.test(q)) throw new AdminError('机器 ID 只能包含十六进制字符和连字符。')
      if (q) params.set('q', q)
      const page = object(await this.send(`/api/v1/admin/machines?${params}`, { method: 'GET' }, 200))
      if (!Array.isArray(page.items) || page.items.length > limit || !integer(page.total) || page.limit !== limit || page.offset !== offset) return invalid()
      return { items: page.items.map(machine), total: page.total, limit, offset }
    }, '读取机器列表失败，请重试。')
  }
}
