import { useCallback, useEffect, useRef, useState } from 'react'
import { ADMIN_QUERY_MAX_CHARS } from '../../../../shared/admin'
import type { AdminRole, AdminUser, AdminUserDetail } from '../../../../shared/admin'
import { FEEDBACK_CATEGORY_LABELS, FEEDBACK_STATUS_LABELS } from '../../../../shared/feedback'

const PAGE_SIZE = 20
const time = (value: number | null): string => value === null ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const ACTION_LABELS: Record<string, string> = { 'user.update': '修改账号', 'user.revoke_sessions': '强制退出所有设备' }

function auditText(action: string, detail: string): string {
  if (action !== 'user.update') return ACTION_LABELS[action] ?? action
  try {
    const data = JSON.parse(detail) as { enabled?: { to: boolean }; role?: { to: string } }
    const parts: string[] = []
    if (data.enabled) parts.push(data.enabled.to ? '启用账号' : '禁用账号')
    if (data.role) parts.push(data.role.to === 'ADMIN' ? '设为管理员' : '取消管理员')
    return parts.join('，') || ACTION_LABELS[action]
  } catch { return ACTION_LABELS[action] }
}

interface Page { items: AdminUser[]; total: number; offset: number }
export interface UsersPreset { enabled?: boolean | null; q?: string; nonce: number }

export default function AdminUsers({ selfEmail, preset, onShowFeedback }: {
  selfEmail: string; preset: UsersPreset | null; onShowFeedback(email: string): void
}) {
  const alive = useRef(true)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<AdminRole | ''>('')
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Page>({ items: [], total: 0, offset: 0 })
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [blocked, setBlocked] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const fail = (result: { loginRequired?: boolean; forbidden?: boolean; message: string }, set: (message: string) => void): void => {
    if (result.loginRequired || result.forbidden) setBlocked(result.message)
    else set(result.message)
  }

  const load = useCallback(async (): Promise<void> => {
    const revision = ++listRequest.current
    setLoading(true); setListError('')
    try {
      const result = await window.api.listAdminUsers({ q: query, role, enabled, limit: PAGE_SIZE, offset })
      if (!alive.current || revision !== listRequest.current) return
      if (!result.ok) { fail(result, setListError); return }
      setBlocked('')
      setPage({ items: result.value.items, total: result.value.total, offset: result.value.offset })
    } catch { if (alive.current && revision === listRequest.current) setListError('读取用户列表失败，请重试。') }
    finally { if (alive.current && revision === listRequest.current) setLoading(false) }
  }, [query, role, enabled, offset])

  const loadDetail = useCallback(async (publicId: string): Promise<void> => {
    const revision = ++detailRequest.current
    setDetailLoading(true); setActionError('')
    try {
      const result = await window.api.getAdminUser(publicId)
      if (!alive.current || revision !== detailRequest.current) return
      if (!result.ok) { fail(result, setActionError); setDetail(null); return }
      setDetail(result.value)
    } catch { if (alive.current && revision === detailRequest.current) setActionError('读取用户详情失败，请重试。') }
    finally { if (alive.current && revision === detailRequest.current) setDetailLoading(false) }
  }, [])

  // StrictMode remounts in development: set the flag on every mount, not only at creation.
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = window.setTimeout(() => { if (queryDraft.trim() !== query) { setOffset(0); setQuery(queryDraft.trim()) } }, 350)
    return () => window.clearTimeout(timer)
  }, [queryDraft, query])
  useEffect(() => {
    if (!preset) return
    if (preset.enabled !== undefined) setEnabled(preset.enabled)
    if (preset.q !== undefined) { setQueryDraft(preset.q); setQuery(preset.q) }
    setRole(''); setOffset(0)
  }, [preset?.nonce])
  useEffect(() => { setNotice(''); setActionError(''); if (selected) void loadDetail(selected); else setDetail(null) }, [selected, loadDetail])

  const isSelf = detail !== null && detail.email.toLowerCase() === selfEmail.toLowerCase()

  const applyUser = (user: AdminUser): void => {
    setPage(previous => ({ ...previous, items: previous.items.map(item => item.publicId === user.publicId ? user : item) }))
    setDetail(previous => previous && previous.publicId === user.publicId ? { ...previous, ...user } : previous)
  }

  const change = async (patch: { enabled?: boolean; role?: AdminRole }, confirmText: string, done: string): Promise<void> => {
    if (!detail || busy || !window.confirm(confirmText)) return
    setBusy(true); setActionError(''); setNotice('')
    try {
      const result = await window.api.updateAdminUser({ publicId: detail.publicId, ...patch })
      if (!alive.current) return
      if (!result.ok) { fail(result, setActionError); return }
      applyUser(result.value); setNotice(done)
      void loadDetail(detail.publicId)
    } catch { if (alive.current) setActionError('操作失败，请重试。') }
    finally { if (alive.current) setBusy(false) }
  }

  const revoke = async (): Promise<void> => {
    if (!detail || busy) return
    const text = isSelf
      ? '确定要让你自己的所有登录失效吗？\n\n包括当前这台电脑，管理后台会立即关闭，需要重新登录。'
      : `确定要让 ${detail.email} 的所有登录失效吗？\n\n该账号在所有电脑上都需要重新登录，已连接的设备会立即断开。`
    if (!window.confirm(text)) return
    setBusy(true); setActionError(''); setNotice('')
    try {
      const result = await window.api.revokeAdminUserSessions(detail.publicId)
      if (!alive.current) return
      if (!result.ok) { fail(result, setActionError); return }
      applyUser(result.value.user)
      setNotice(`已让所有登录失效${result.value.disconnectedConnections ? `，断开了 ${result.value.disconnectedConnections} 个连接` : ''}`)
      void loadDetail(detail.publicId)
    } catch { if (alive.current) setActionError('操作失败，请重试。') }
    finally { if (alive.current) setBusy(false) }
  }

  if (blocked) {
    return <section className="admin-page admin-page--blocked" role="alert">
      <h1>无法管理用户</h1><p>{blocked}</p>
      <button type="button" className="admin-btn" onClick={() => { setBlocked(''); void load() }}>重试</button>
    </section>
  }

  const from = page.total ? page.offset + 1 : 0
  const to = page.offset + page.items.length

  return <section className="admin-page admin-users">
    <header className="admin-page__header">
      <div><h1>用户</h1><p className="admin-muted">查看账号，启用或禁用、设置管理员，或让某个账号的所有登录失效。</p></div>
      <button type="button" className="admin-btn" disabled={loading} onClick={() => { void load(); if (selected) void loadDetail(selected) }}>{loading ? '加载中…' : '刷新'}</button>
    </header>
    <div className="admin-toolbar">
      <div className="admin-tabs" role="tablist" aria-label="按状态筛选">
        {([[null, '全部'], [true, '已启用'], [false, '已禁用']] as const).map(([value, label]) => <button key={label} type="button" role="tab"
          aria-selected={enabled === value} className={enabled === value ? 'is-selected' : ''} onClick={() => { setEnabled(value); setOffset(0) }}>{label}</button>)}
      </div>
      <div className="admin-filters">
        <select aria-label="按角色筛选" value={role} onChange={event => { setRole(event.target.value as AdminRole | ''); setOffset(0) }}>
          <option value="">全部角色</option><option value="ADMIN">管理员</option><option value="USER">普通用户</option>
        </select>
        <input type="search" aria-label="搜索用户" placeholder="搜索邮箱或昵称" maxLength={ADMIN_QUERY_MAX_CHARS} value={queryDraft} onChange={event => setQueryDraft(event.target.value)} />
      </div>
    </div>
    <div className="admin-feedback__body">
      <div className="admin-feedback__list" aria-busy={loading}>
        {listError ? <div className="admin-error" role="alert">{listError}<button type="button" className="admin-btn admin-btn--small" onClick={() => void load()}>重试</button></div> : null}
        {!page.items.length && !listError ? <p className="admin-empty" role="status">{loading ? '正在加载…' : '没有符合条件的用户'}</p> : null}
        <ul>{page.items.map(user => <li key={user.publicId}>
          <button type="button" className={user.publicId === selected ? 'is-selected' : ''} aria-current={user.publicId === selected ? 'true' : undefined} onClick={() => setSelected(user.publicId)}>
            <span className="admin-row__meta">
              {user.role === 'ADMIN' ? <span className="admin-tag">管理员</span> : null}
              {!user.enabled ? <span className="admin-user-disabled">已禁用</span> : null}
              <time>{user.lastLoginAt ? `最后登录 ${time(user.lastLoginAt)}` : '从未记录登录'}</time>
            </span>
            <span className="admin-row__content">{user.email}</span>
            <span className="admin-row__user">{user.deviceCount} 台设备 · {user.feedbackCount} 条反馈 · 注册于 {time(user.createdAt)}</span>
          </button>
        </li>)}</ul>
        {page.total > PAGE_SIZE ? <div className="admin-pager">
          <span>第 {from}–{to} 条，共 {page.total} 条</span>
          <button type="button" className="admin-btn admin-btn--small" disabled={loading || page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}>上一页</button>
          <button type="button" className="admin-btn admin-btn--small" disabled={loading || to >= page.total} onClick={() => setOffset(page.offset + PAGE_SIZE)}>下一页</button>
        </div> : page.total ? <div className="admin-pager"><span>共 {page.total} 个用户</span></div> : null}
      </div>
      <article className="admin-feedback__detail" aria-label="用户详情" aria-busy={detailLoading}>
        {!selected ? <p className="admin-empty">在左侧选择一个用户</p> : !detail ? (actionError ? <p className="admin-error" role="alert">{actionError}</p> : <p className="admin-empty">正在读取…</p>) : <>
          <div className="admin-detail__head">
            {detail.role === 'ADMIN' ? <span className="admin-tag">管理员</span> : <span className="admin-status">普通用户</span>}
            {detail.enabled ? <span className="admin-status admin-status--2">已启用</span> : <span className="admin-user-disabled">已禁用</span>}
            {isSelf ? <span className="admin-muted">（你自己）</span> : null}
          </div>
          <h2 className="admin-user__email">{detail.email}</h2>
          <dl className="admin-detail__meta">
            <dt>昵称</dt><dd>{detail.nickname}</dd>
            <dt>用户 ID</dt><dd className="admin-mono">{detail.publicId}</dd>
            <dt>注册时间</dt><dd>{time(detail.createdAt)}</dd>
            <dt>最后登录</dt><dd>{detail.lastLoginAt ? time(detail.lastLoginAt) : '未记录（此功能上线前登录的账号）'}</dd>
            <dt>最后修改</dt><dd>{time(detail.updatedAt)}</dd>
          </dl>
          <div className="admin-user__actions">
            {detail.enabled
              ? <button type="button" className="admin-btn" disabled={busy || isSelf} title={isSelf ? '不能禁用自己' : undefined}
                onClick={() => void change({ enabled: false }, `确定要禁用 ${detail.email} 吗？\n\n该账号会立即无法使用，所有登录失效，已连接的设备会断开。重新启用后也需要重新登录。`, '已禁用')}>禁用账号</button>
              : <button type="button" className="admin-btn" disabled={busy}
                onClick={() => void change({ enabled: true }, `确定要重新启用 ${detail.email} 吗？`, '已启用')}>启用账号</button>}
            {detail.role === 'ADMIN'
              ? <button type="button" className="admin-btn" disabled={busy || isSelf} title={isSelf ? '不能取消自己的管理员身份' : undefined}
                onClick={() => void change({ role: 'USER' }, `确定要取消 ${detail.email} 的管理员身份吗？`, '已取消管理员')}>取消管理员</button>
              : <button type="button" className="admin-btn" disabled={busy || !detail.enabled}
                onClick={() => void change({ role: 'ADMIN' }, `确定要把 ${detail.email} 设为管理员吗？\n\n管理员可以处理反馈、发布更新说明、管理所有用户。`, '已设为管理员')}>设为管理员</button>}
            <button type="button" className="admin-btn admin-btn--danger-outline" disabled={busy} onClick={() => void revoke()}>强制退出所有设备</button>
          </div>
          {actionError ? <p className="admin-error" role="alert">{actionError}</p> : null}
          {notice ? <p className="admin-saved" role="status">{notice}</p> : null}

          <h3 className="admin-user__section">设备（{detail.devices.length}）</h3>
          {detail.devices.length ? <table className="admin-mini-table"><thead><tr><th>名称</th><th>状态</th><th>最后连接</th></tr></thead>
            <tbody>{detail.devices.map(device => <tr key={device.deviceId}>
              <td title={device.deviceId}>{device.deviceName}{!device.enabled ? <span className="admin-muted">（已停用）</span> : null}</td>
              <td>{device.online ? <span className="admin-status admin-status--2">在线</span> : <span className="admin-status">离线</span>}</td>
              <td>{time(device.lastConnectedAt)}</td>
            </tr>)}</tbody></table> : <p className="admin-muted">没有设备</p>}

          <h3 className="admin-user__section">最近的反馈（共 {detail.feedbackCount} 条）
            {detail.feedbackCount ? <button type="button" className="admin-btn admin-btn--small" onClick={() => onShowFeedback(detail.email)}>在反馈管理中查看</button> : null}</h3>
          {detail.recentFeedback.length ? <ul className="admin-user__feedback">{detail.recentFeedback.map(item => <li key={item.id}>
            <span className="admin-row__meta"><span className="admin-tag">{FEEDBACK_CATEGORY_LABELS[item.category]}</span>
              <span className={`admin-status admin-status--${item.status}`}>{FEEDBACK_STATUS_LABELS[item.status] ?? '未知'}</span><time>{time(item.createdAt)}</time></span>
            <span className="admin-row__content">{item.content}</span>
          </li>)}</ul> : <p className="admin-muted">没有反馈</p>}

          <h3 className="admin-user__section">操作记录</h3>
          {detail.audit.length ? <ul className="admin-user__audit">{detail.audit.map(entry => <li key={entry.id}>
            <time>{time(entry.createdAt)}</time><span>{entry.actorEmail || '未知管理员'}</span><strong>{auditText(entry.action, entry.detail)}</strong>
          </li>)}</ul> : <p className="admin-muted">没有操作记录</p>}
        </>}
      </article>
    </div>
  </section>
}
