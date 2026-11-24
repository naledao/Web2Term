import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ADMIN_FEEDBACK_STATUSES, ADMIN_NOTE_MAX_CHARS, ADMIN_QUERY_MAX_CHARS } from '../../../../shared/admin'
import type { AdminFeedbackItem, AdminFeedbackQuery } from '../../../../shared/admin'
import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_LABELS, FEEDBACK_STATUS_LABELS } from '../../../../shared/feedback'
import type { FeedbackCategory } from '../../../../shared/feedback'

const PAGE_SIZE = 20
const time = (value: number): string => new Date(value).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

interface Page { items: AdminFeedbackItem[]; total: number; offset: number; statusCounts: Record<number, number> }
const EMPTY_PAGE: Page = { items: [], total: 0, offset: 0, statusCounts: { 0: 0, 1: 0, 2: 0, 3: 0 } }
type Blocked = { kind: 'login' | 'forbidden'; message: string } | null
/** A jump from another page: apply these filters once per nonce. */
export interface FeedbackPreset { status?: number | null; q?: string; nonce: number }

export default function AdminFeedback({ preset }: { preset?: FeedbackPreset | null }) {
  const alive = useRef(true)
  const listRequest = useRef(0)
  const [status, setStatus] = useState<number | null>(0)
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [queryDraft, setQueryDraft] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Page>(EMPTY_PAGE)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [listNotice, setListNotice] = useState('')
  const [blocked, setBlocked] = useState<Blocked>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusDraft, setStatusDraft] = useState(0)
  const [noteDraft, setNoteDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')

  const selected = useMemo(() => page.items.find(item => item.id === selectedId) ?? null, [page.items, selectedId])
  const dirty = selected !== null && (statusDraft !== selected.status || noteDraft.trim() !== (selected.adminNote ?? ''))
  const noteTooLong = [...noteDraft.trim()].length > ADMIN_NOTE_MAX_CHARS
  const allCount = ADMIN_FEEDBACK_STATUSES.reduce<number>((sum, value) => sum + (page.statusCounts[value] ?? 0), 0)

  const handleBlocked = (result: { loginRequired?: boolean; forbidden?: boolean; message: string }): boolean => {
    if (result.loginRequired) { setBlocked({ kind: 'login', message: result.message }); return true }
    if (result.forbidden) { setBlocked({ kind: 'forbidden', message: result.message }); return true }
    return false
  }

  const load = useCallback(async (request: AdminFeedbackQuery & { offset: number }): Promise<void> => {
    const revision = ++listRequest.current
    setLoading(true); setListError('')
    try {
      const result = await window.api.listAdminFeedback({ ...request, limit: PAGE_SIZE })
      if (!alive.current || revision !== listRequest.current) return
      if (!result.ok) { if (!handleBlocked(result)) setListError(result.message); return }
      setBlocked(null)
      setPage({ items: result.value.items, total: result.value.total, offset: result.value.offset, statusCounts: result.value.statusCounts })
    } catch { if (alive.current && revision === listRequest.current) setListError('读取反馈列表失败，请重试。') }
    finally { if (alive.current && revision === listRequest.current) setLoading(false) }
  }, [])

  // StrictMode remounts in development: set the flag on every mount, not only at creation.
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { void load({ status, category, q: query, offset }) }, [status, category, query, offset, load])
  // Debounce typing in the search box.
  useEffect(() => {
    const timer = window.setTimeout(() => { if (queryDraft.trim() !== query) { setOffset(0); setQuery(queryDraft.trim()) } }, 350)
    return () => window.clearTimeout(timer)
  }, [queryDraft, query])
  // Reset the editor whenever another item is selected (or the selected one is reloaded with new values).
  useEffect(() => { setStatusDraft(selected?.status ?? 0); setNoteDraft(selected?.adminNote ?? '') }, [selected?.id, selected?.status, selected?.adminNote])
  useEffect(() => { setSaveError(''); setSaveNotice('') }, [selected?.id])

  const confirmDiscard = (): boolean => !dirty || window.confirm('当前反馈有未保存的修改，确定要放弃吗？')
  useEffect(() => {
    if (!preset || !confirmDiscard()) return
    if (preset.status !== undefined) setStatus(preset.status)
    const q = preset.q ?? ''
    setQueryDraft(q); setQuery(q); setCategory(''); setOffset(0); setSelectedId(null); setListNotice('')
  }, [preset?.nonce])
  const changeFilter = (apply: () => void): void => { if (!confirmDiscard()) return; apply(); setOffset(0); setSelectedId(null); setListNotice('') }

  const save = async (): Promise<void> => {
    if (!selected || !dirty || saving || noteTooLong) return
    setSaving(true); setSaveError(''); setSaveNotice('')
    const patch = { id: selected.id, ...(statusDraft !== selected.status ? { status: statusDraft } : {}),
      ...(noteDraft.trim() !== (selected.adminNote ?? '') ? { adminNote: noteDraft } : {}) }
    try {
      const result = await window.api.updateAdminFeedback(patch)
      if (!alive.current) return
      if (!result.ok) { if (!handleBlocked(result)) setSaveError(result.message); return }
      const updated = result.value
      setPage(previous => {
        const counts = { ...previous.statusCounts }
        if (updated.status !== selected.status) {
          counts[selected.status] = Math.max(0, (counts[selected.status] ?? 0) - 1)
          counts[updated.status] = (counts[updated.status] ?? 0) + 1
        }
        // An item whose new status no longer matches the status tab leaves the list right away.
        if (status !== null && updated.status !== status) {
          return { ...previous, statusCounts: counts, total: Math.max(0, previous.total - 1), items: previous.items.filter(item => item.id !== updated.id) }
        }
        return { ...previous, statusCounts: counts, items: previous.items.map(item => item.id === updated.id ? updated : item) }
      })
      if (status !== null && updated.status !== status) {
        setSelectedId(null)
        setListNotice(`#${updated.id} 已保存为“${FEEDBACK_STATUS_LABELS[updated.status] ?? '未知'}”，已移出当前列表`)
      } else setSaveNotice('已保存')
    } catch { if (alive.current) setSaveError('保存失败，请重试。') }
    finally { if (alive.current) setSaving(false) }
  }

  if (blocked) {
    return <section className="admin-page admin-page--blocked" role="alert">
      <h1>{blocked.kind === 'login' ? '需要重新登录' : '没有管理员权限'}</h1>
      <p>{blocked.message}</p>
      <p className="admin-muted">{blocked.kind === 'login' ? '请回到主窗口，在“设置 → 后端服务”中登录管理员账号后再打开管理后台。' : '请确认当前登录的账号已被设置为管理员（user_account.role = ADMIN）。'}</p>
      <button type="button" className="admin-btn" onClick={() => { setBlocked(null); void load({ status, category, q: query, offset }) }}>重试</button>
    </section>
  }

  const from = page.total ? page.offset + 1 : 0
  const to = page.offset + page.items.length

  return <section className="admin-page admin-feedback">
    <header className="admin-page__header">
      <div><h1>反馈管理</h1><p className="admin-muted">查看用户提交的反馈，更新处理状态并记录内部备注。备注仅管理员可见。</p></div>
      <button type="button" className="admin-btn" disabled={loading} onClick={() => void load({ status, category, q: query, offset })}>{loading ? '加载中…' : '刷新'}</button>
    </header>

    <div className="admin-toolbar">
      <div className="admin-tabs" role="tablist" aria-label="按状态筛选">
        <button type="button" role="tab" aria-selected={status === null} className={status === null ? 'is-selected' : ''}
          onClick={() => changeFilter(() => setStatus(null))}>全部<span>{allCount}</span></button>
        {ADMIN_FEEDBACK_STATUSES.map(value => <button key={value} type="button" role="tab" aria-selected={status === value}
          className={status === value ? 'is-selected' : ''} onClick={() => changeFilter(() => setStatus(value))}>
          {FEEDBACK_STATUS_LABELS[value]}<span>{page.statusCounts[value] ?? 0}</span></button>)}
      </div>
      <div className="admin-filters">
        <select aria-label="按类型筛选" value={category} onChange={event => { const next = event.target.value as FeedbackCategory | ''; changeFilter(() => setCategory(next)) }}>
          <option value="">全部类型</option>
          {FEEDBACK_CATEGORIES.map(item => <option key={item} value={item}>{FEEDBACK_CATEGORY_LABELS[item]}</option>)}
        </select>
        <input type="search" aria-label="搜索反馈" placeholder="搜索内容或邮箱" maxLength={ADMIN_QUERY_MAX_CHARS} value={queryDraft}
          onChange={event => setQueryDraft(event.target.value)} />
      </div>
    </div>

    <div className="admin-feedback__body">
      <div className="admin-feedback__list" aria-busy={loading}>
        {listError ? <div className="admin-error" role="alert">{listError}
          <button type="button" className="admin-btn admin-btn--small" onClick={() => void load({ status, category, q: query, offset })}>重试</button></div> : null}
        {listNotice ? <p className="admin-notice" role="status">{listNotice}</p> : null}
        {!page.items.length && !listError ? <p className="admin-empty" role="status">{loading ? '正在加载…' : '没有符合条件的反馈'}</p> : null}
        <ul>{page.items.map(item => <li key={item.id}>
          <button type="button" className={item.id === selectedId ? 'is-selected' : ''} aria-current={item.id === selectedId ? 'true' : undefined}
            onClick={() => { if (item.id !== selectedId && confirmDiscard()) setSelectedId(item.id) }}>
            <span className="admin-row__meta">
              <span className="admin-tag">{FEEDBACK_CATEGORY_LABELS[item.category]}</span>
              <span className={`admin-status admin-status--${item.status}`}>{FEEDBACK_STATUS_LABELS[item.status] ?? '未知'}</span>
              {item.adminNote ? <span className="admin-row__noted" title="有内部备注">备注</span> : null}
              <time dateTime={new Date(item.createdAt).toISOString()}>{time(item.createdAt)}</time>
            </span>
            <span className="admin-row__content">{item.content}</span>
            <span className="admin-row__user">{item.user.email}</span>
          </button>
        </li>)}</ul>
        {page.total > PAGE_SIZE ? <div className="admin-pager">
          <span>第 {from}–{to} 条，共 {page.total} 条</span>
          <button type="button" className="admin-btn admin-btn--small" disabled={loading || page.offset === 0}
            onClick={() => { if (confirmDiscard()) { setSelectedId(null); setOffset(Math.max(0, page.offset - PAGE_SIZE)) } }}>上一页</button>
          <button type="button" className="admin-btn admin-btn--small" disabled={loading || to >= page.total}
            onClick={() => { if (confirmDiscard()) { setSelectedId(null); setOffset(page.offset + PAGE_SIZE) } }}>下一页</button>
        </div> : page.total ? <div className="admin-pager"><span>共 {page.total} 条</span></div> : null}
      </div>

      <article className="admin-feedback__detail" aria-label="反馈详情">
        {selected ? <>
          <div className="admin-detail__head">
            <span className="admin-tag">{FEEDBACK_CATEGORY_LABELS[selected.category]}</span>
            <span className="admin-muted">#{selected.id}</span>
            <time className="admin-muted" dateTime={new Date(selected.createdAt).toISOString()}>{time(selected.createdAt)}</time>
          </div>
          <p className="admin-detail__content">{selected.content}</p>
          <dl className="admin-detail__meta">
            <dt>提交账号</dt><dd>{selected.user.email}{selected.user.nickname && selected.user.nickname !== selected.user.email ? `（${selected.user.nickname}）` : ''}</dd>
            <dt>联系邮箱</dt><dd>{selected.email}</dd>
            <dt>客户端版本</dt><dd>{selected.appVersion ? `v${selected.appVersion.replace(/^v/, '')}` : '—'}</dd>
            <dt>系统</dt><dd>{selected.platform || '—'}</dd>
            <dt>本机标识</dt><dd className="admin-mono">{selected.machineId ?? '—'}</dd>
            <dt>最后更新</dt><dd>{time(selected.updatedAt)}</dd>
          </dl>
          <form className="admin-detail__editor" onSubmit={event => { event.preventDefault(); void save() }}>
            <fieldset disabled={saving}>
              <legend>处理状态</legend>
              <div className="admin-segment">{ADMIN_FEEDBACK_STATUSES.map(value => <label key={value} className={statusDraft === value ? 'is-selected' : ''}>
                <input type="radio" name="admin-feedback-status" value={value} checked={statusDraft === value} onChange={() => { setStatusDraft(value); setSaveNotice('') }} />
                {FEEDBACK_STATUS_LABELS[value]}</label>)}</div>
            </fieldset>
            <label className="admin-detail__note">
              <span>内部备注<small>（用户看不到）</small></span>
              <textarea value={noteDraft} disabled={saving} rows={5} placeholder="例如：已在 0.1.243 修复；需要更多复现信息……"
                aria-invalid={noteTooLong || undefined} onChange={event => { setNoteDraft(event.target.value); setSaveNotice('') }}
                onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() } }} />
              <small className={noteTooLong ? 'is-over' : ''}>{[...noteDraft.trim()].length} / {ADMIN_NOTE_MAX_CHARS}</small>
            </label>
            {saveError ? <p className="admin-error" role="alert">{saveError}</p> : null}
            <div className="admin-detail__actions">
              {saveNotice ? <span className="admin-saved" role="status">{saveNotice}</span> : null}
              <button type="button" className="admin-btn" disabled={!dirty || saving}
                onClick={() => { setStatusDraft(selected.status); setNoteDraft(selected.adminNote ?? ''); setSaveError('') }}>撤销修改</button>
              <button type="submit" className="admin-btn admin-btn--primary" disabled={!dirty || saving || noteTooLong} title="Ctrl + Enter 保存">{saving ? '保存中…' : '保存'}</button>
            </div>
          </form>
        </> : <p className="admin-empty">在左侧选择一条反馈查看详情</p>}
      </article>
    </div>
  </section>
}
