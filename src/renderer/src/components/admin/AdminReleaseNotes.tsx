import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RELEASE_NOTE_HTML_MAX_BYTES, RELEASE_NOTE_STATUS_LABELS, RELEASE_NOTE_STATUSES, RELEASE_NOTE_TITLE_MAX_CHARS,
  RELEASE_NOTE_VERSION_MAX_CHARS, releaseNoteInputProblem
} from '../../../../shared/admin'
import type { AdminReleaseNote, AdminReleaseNoteInput } from '../../../../shared/admin'
import { releaseNotesDocument } from '../release-notes-document'

const PAGE_SIZE = 20
const TEMPLATE = `<article>
  <h3>新增</h3>
  <ul>
    <li></li>
  </ul>
  <h3>修复</h3>
  <ul>
    <li></li>
  </ul>
  <h3>优化</h3>
  <ul>
    <li></li>
  </ul>
</article>
`
const time = (value: number): string => new Date(value).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const pad = (value: number): string => String(value).padStart(2, '0')
/** <input type="datetime-local"> works in local time without seconds. */
const toLocalInput = (value: number | null): string => {
  if (value === null) return ''
  const date = new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const fromLocalInput = (value: string): number | null => {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
const scheduled = (note: Pick<AdminReleaseNote, 'status' | 'publishedAt'>): boolean => note.status === 1 && note.publishedAt !== null && note.publishedAt > Date.now()
const statusLabel = (note: Pick<AdminReleaseNote, 'status' | 'publishedAt'>): string => scheduled(note) ? '预约中' : RELEASE_NOTE_STATUS_LABELS[note.status] ?? '未知'
const statusClass = (note: Pick<AdminReleaseNote, 'status' | 'publishedAt'>): string => scheduled(note) ? 'is-scheduled' : `is-${note.status}`

interface Page { items: AdminReleaseNote[]; total: number; offset: number; machineCount: number }
export interface ReleaseNotesPreset { status?: number | null; nonce: number }
interface Draft { version: string; title: string; status: number; publishedAt: string; contentHtml: string }
type Editing = { mode: 'new' } | { mode: 'edit'; note: AdminReleaseNote }
type Blocked = { kind: 'login' | 'forbidden'; message: string } | null

const draftOf = (note: AdminReleaseNote): Draft => ({ version: note.version, title: note.title, status: note.status, publishedAt: toLocalInput(note.publishedAt), contentHtml: note.contentHtml ?? '' })
const sameDraft = (left: Draft, right: Draft): boolean => left.version.trim() === right.version.trim() && left.title.trim() === right.title.trim() &&
  left.status === right.status && left.publishedAt === right.publishedAt && left.contentHtml === right.contentHtml

export default function AdminReleaseNotes({ theme, preset }: { theme: 'light' | 'dark'; preset?: ReleaseNotesPreset | null }) {
  const alive = useRef(true)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const [status, setStatus] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Page>({ items: [], total: 0, offset: 0, machineCount: 0 })
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [listNotice, setListNotice] = useState('')
  const [blocked, setBlocked] = useState<Blocked>(null)
  const [appVersion, setAppVersion] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [baseline, setBaseline] = useState<Draft | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState<'save' | 'delete' | 'quick' | null>(null)
  const [formError, setFormError] = useState('')
  const [versionError, setVersionError] = useState('')
  const [notice, setNotice] = useState('')
  const [previewHtml, setPreviewHtml] = useState('')

  const dirty = draft !== null && baseline !== null && !sameDraft(draft, baseline)
  const htmlBytes = useMemo(() => draft ? new TextEncoder().encode(draft.contentHtml).length : 0, [draft?.contentHtml])

  const handleBlocked = (result: { loginRequired?: boolean; forbidden?: boolean; message: string }): boolean => {
    if (result.loginRequired) { setBlocked({ kind: 'login', message: result.message }); return true }
    if (result.forbidden) { setBlocked({ kind: 'forbidden', message: result.message }); return true }
    return false
  }

  const load = useCallback(async (nextStatus: number | null, nextOffset: number): Promise<void> => {
    const revision = ++listRequest.current
    setLoading(true); setListError('')
    try {
      const result = await window.api.listAdminReleaseNotes({ status: nextStatus, limit: PAGE_SIZE, offset: nextOffset })
      if (!alive.current || revision !== listRequest.current) return
      if (!result.ok) { if (!handleBlocked(result)) setListError(result.message); return }
      setBlocked(null)
      setPage({ items: result.value.items, total: result.value.total, offset: result.value.offset, machineCount: result.value.machineCount })
    } catch { if (alive.current && revision === listRequest.current) setListError('读取更新说明列表失败，请重试。') }
    finally { if (alive.current && revision === listRequest.current) setLoading(false) }
  }, [])

  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => { void load(status, offset) }, [status, offset, load])
  useEffect(() => { void window.api.getAppInfo().then(info => { if (alive.current) setAppVersion(info.version) }).catch(() => {}) }, [])
  // Debounce the sandboxed preview so typing stays smooth on long documents.
  useEffect(() => {
    const html = draft?.contentHtml ?? ''
    const timer = window.setTimeout(() => setPreviewHtml(releaseNotesDocument(html, theme === 'dark')), 250)
    return () => window.clearTimeout(timer)
  }, [draft?.contentHtml, theme])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const confirmDiscard = (): boolean => !dirty || window.confirm('当前更新说明有未保存的修改，确定要放弃吗？')
  useEffect(() => {
    if (!preset || preset.status === undefined) return
    setStatus(preset.status); setOffset(0); setListNotice('')
  }, [preset?.nonce])
  const resetMessages = (): void => { setFormError(''); setVersionError(''); setNotice('') }

  const openNote = async (note: AdminReleaseNote): Promise<void> => {
    if (!confirmDiscard()) return
    const revision = ++detailRequest.current
    setEditing({ mode: 'edit', note }); setDraft(null); setBaseline(null); resetMessages(); setDetailLoading(true)
    try {
      const result = await window.api.getAdminReleaseNote(note.id)
      if (!alive.current || revision !== detailRequest.current) return
      if (!result.ok) { if (!handleBlocked(result)) setFormError(result.message); return }
      setEditing({ mode: 'edit', note: result.value })
      const loaded = draftOf(result.value)
      setDraft(loaded); setBaseline(loaded)
    } catch { if (alive.current && revision === detailRequest.current) setFormError('读取更新说明失败，请重试。') }
    finally { if (alive.current && revision === detailRequest.current) setDetailLoading(false) }
  }

  const openNew = (): void => {
    if (!confirmDiscard()) return
    ++detailRequest.current
    const version = appVersion.replace(/^v/, '')
    const fresh: Draft = { version, title: version ? `Web2Term ${version} 更新说明` : '', status: 0, publishedAt: '', contentHtml: TEMPLATE }
    setEditing({ mode: 'new' }); setDraft(fresh); setBaseline(fresh); resetMessages(); setDetailLoading(false)
  }

  const inputOf = (value: Draft): AdminReleaseNoteInput => ({
    version: value.version.trim(), title: value.title.trim(), contentHtml: value.contentHtml, status: value.status, publishedAt: fromLocalInput(value.publishedAt)
  })

  const applySaved = (saved: AdminReleaseNote, created: boolean): void => {
    setEditing({ mode: 'edit', note: saved })
    const loaded = draftOf(saved)
    setDraft(loaded); setBaseline(loaded)
    const summary = { ...saved }; delete summary.contentHtml
    setPage(previous => {
      if (created) return status === null || status === saved.status ? { ...previous, items: [summary, ...previous.items], total: previous.total + 1 } : previous
      if (status !== null && saved.status !== status) return { ...previous, items: previous.items.filter(item => item.id !== saved.id), total: Math.max(0, previous.total - 1) }
      return { ...previous, items: previous.items.map(item => item.id === saved.id ? { ...summary, readCount: item.readCount } : item) }
    })
  }

  const save = async (): Promise<void> => {
    if (!draft || !editing || busy) return
    resetMessages()
    const input = inputOf(draft)
    const problem = releaseNoteInputProblem(input)
    if (problem) { setFormError(problem); return }
    setBusy('save')
    try {
      const result = editing.mode === 'new'
        ? await window.api.createAdminReleaseNote(input)
        : await window.api.updateAdminReleaseNote({ id: editing.note.id, ...input })
      if (!alive.current) return
      if (!result.ok) {
        if (handleBlocked(result)) return
        if (result.conflict) setVersionError(result.message || '该版本的更新说明已存在。')
        else setFormError(result.message)
        return
      }
      applySaved(result.value, editing.mode === 'new')
      setNotice(editing.mode === 'new' ? '已创建' : '已保存')
    } catch { if (alive.current) setFormError('保存失败，请重试。') }
    finally { if (alive.current) setBusy(null) }
  }

  /** Publish or take offline straight from the list. PUT is a full replacement, so the full note is fetched first. */
  const quickStatus = async (note: AdminReleaseNote, nextStatus: number): Promise<void> => {
    if (busy) return
    const editingThis = editing?.mode === 'edit' && editing.note.id === note.id
    if (editingThis && dirty) { setListNotice('请先保存或撤销编辑器中的修改。'); return }
    setBusy('quick'); setListNotice(''); setListError('')
    try {
      const detail = await window.api.getAdminReleaseNote(note.id)
      if (!alive.current) return
      if (!detail.ok) { if (!handleBlocked(detail)) setListError(detail.message); return }
      const full = detail.value
      const result = await window.api.updateAdminReleaseNote({ id: full.id, version: full.version, title: full.title, contentHtml: full.contentHtml ?? '', status: nextStatus, publishedAt: full.publishedAt })
      if (!alive.current) return
      if (!result.ok) { if (!handleBlocked(result)) setListError(result.message); return }
      if (editingThis) applySaved(result.value, false)
      else {
        const summary = { ...result.value }; delete summary.contentHtml
        setPage(previous => status !== null && summary.status !== status
          ? { ...previous, items: previous.items.filter(item => item.id !== summary.id), total: Math.max(0, previous.total - 1) }
          : { ...previous, items: previous.items.map(item => item.id === summary.id ? { ...summary, readCount: item.readCount } : item) })
      }
      setListNotice(`v${full.version} 已${nextStatus === 1 ? '发布' : '下线'}`)
    } catch { if (alive.current) setListError('操作失败，请重试。') }
    finally { if (alive.current) setBusy(null) }
  }

  const remove = async (): Promise<void> => {
    if (!editing || editing.mode !== 'edit' || busy) return
    const note = editing.note
    if (!window.confirm(`确定要永久删除 v${note.version}「${note.title}」吗？\n\n删除后无法恢复，所有用户的已读记录也会一起删除。\n如果只是不想再展示，建议改为“已下线”。`)) return
    setBusy('delete'); resetMessages()
    try {
      const result = await window.api.deleteAdminReleaseNote(note.id)
      if (!alive.current) return
      if (!result.ok) { if (!handleBlocked(result)) setFormError(result.message); return }
      setEditing(null); setDraft(null); setBaseline(null)
      setPage(previous => ({ ...previous, items: previous.items.filter(item => item.id !== note.id), total: Math.max(0, previous.total - 1) }))
      setListNotice(`v${note.version} 已删除`)
    } catch { if (alive.current) setFormError('删除失败，请重试。') }
    finally { if (alive.current) setBusy(null) }
  }

  const update = (patch: Partial<Draft>): void => { setDraft(previous => previous ? { ...previous, ...patch } : previous); setNotice('') }

  if (blocked) {
    return <section className="admin-page admin-page--blocked" role="alert">
      <h1>{blocked.kind === 'login' ? '需要重新登录' : '没有管理员权限'}</h1>
      <p>{blocked.message}</p>
      <p className="admin-muted">{blocked.kind === 'login' ? '请回到主窗口，在“设置 → 后端服务”中登录管理员账号后再打开管理后台。' : '请确认当前登录的账号已被设置为管理员（user_account.role = ADMIN），且后端已更新到支持账号管理更新说明的版本。'}</p>
      <button type="button" className="admin-btn" onClick={() => { setBlocked(null); void load(status, offset) }}>重试</button>
    </section>
  }

  const from = page.total ? page.offset + 1 : 0
  const to = page.offset + page.items.length
  const selectedId = editing?.mode === 'edit' ? editing.note.id : null
  const locked = busy !== null || detailLoading

  return <section className="admin-page admin-notes">
    <header className="admin-page__header">
      <div><h1>更新说明</h1><p className="admin-muted">编写和发布客户端“版本更新说明”。发布后主窗口会立即刷新；设置将来的发布时间即可预约展示。</p></div>
      <button type="button" className="admin-btn" disabled={loading} onClick={() => void load(status, offset)}>{loading ? '加载中…' : '刷新'}</button>
      <button type="button" className="admin-btn admin-btn--primary" disabled={busy !== null} onClick={openNew}>新建</button>
    </header>

    <div className="admin-toolbar">
      <div className="admin-tabs" role="tablist" aria-label="按状态筛选">
        <button type="button" role="tab" aria-selected={status === null} className={status === null ? 'is-selected' : ''}
          onClick={() => { setStatus(null); setOffset(0); setListNotice('') }}>全部</button>
        {RELEASE_NOTE_STATUSES.map(value => <button key={value} type="button" role="tab" aria-selected={status === value}
          className={status === value ? 'is-selected' : ''} onClick={() => { setStatus(value); setOffset(0); setListNotice('') }}>{RELEASE_NOTE_STATUS_LABELS[value]}</button>)}
      </div>
    </div>

    <div className="admin-notes__body">
      <div className="admin-feedback__list" aria-busy={loading}>
        {listError ? <div className="admin-error" role="alert">{listError}
          <button type="button" className="admin-btn admin-btn--small" onClick={() => void load(status, offset)}>重试</button></div> : null}
        {listNotice ? <p className="admin-notice" role="status">{listNotice}</p> : null}
        {!page.items.length && !listError ? <p className="admin-empty" role="status">{loading ? '正在加载…' : '没有更新说明'}</p> : null}
        <ul>{page.items.map(note => <li key={note.id} className="admin-note-row">
          <button type="button" className={note.id === selectedId ? 'is-selected' : ''} aria-current={note.id === selectedId ? 'true' : undefined}
            onClick={() => { if (note.id !== selectedId) void openNote(note) }}>
            <span className="admin-row__meta">
              <strong className="admin-note-row__version">v{note.version}</strong>
              <span className={`admin-note-status ${statusClass(note)}`}>{statusLabel(note)}</span>
              <time>{note.publishedAt !== null ? time(note.publishedAt) : `创建于 ${time(note.createdAt)}`}</time>
            </span>
            <span className="admin-row__content">{note.title}</span>
            {note.status === 1 && note.readCount !== undefined ? <span className="admin-row__user">
              已读 {note.readCount.toLocaleString('zh-CN')} 台{page.machineCount ? `（${Math.round((note.readCount / page.machineCount) * 1000) / 10}%）` : ''}</span> : null}
          </button>
          <span className="admin-note-row__actions">
            {note.status !== 1 ? <button type="button" className="admin-btn admin-btn--small" disabled={busy !== null} onClick={() => void quickStatus(note, 1)}>发布</button> : null}
            {note.status === 1 ? <button type="button" className="admin-btn admin-btn--small" disabled={busy !== null} onClick={() => void quickStatus(note, 2)}>下线</button> : null}
          </span>
        </li>)}</ul>
        {page.total > PAGE_SIZE ? <div className="admin-pager">
          <span>第 {from}–{to} 条，共 {page.total} 条</span>
          <button type="button" className="admin-btn admin-btn--small" disabled={loading || page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - PAGE_SIZE))}>上一页</button>
          <button type="button" className="admin-btn admin-btn--small" disabled={loading || to >= page.total} onClick={() => setOffset(page.offset + PAGE_SIZE)}>下一页</button>
        </div> : page.total ? <div className="admin-pager"><span>共 {page.total} 条</span></div> : null}
      </div>

      <article className="admin-notes__editor" aria-label="更新说明编辑器" aria-busy={detailLoading}>
        {!editing ? <p className="admin-empty">在左侧选择一条更新说明，或点击“新建”。</p>
          : detailLoading || !draft ? <div>{formError ? <p className="admin-error" role="alert">{formError}</p> : <p className="admin-empty">正在读取…</p>}</div>
          : <form className="admin-notes__form" onSubmit={event => { event.preventDefault(); void save() }}>
            <div className="admin-notes__title-row">
              <h2>{editing.mode === 'new' ? '新建更新说明' : `编辑 v${editing.note.version}`}</h2>
              {editing.mode === 'edit' ? <span className="admin-muted">创建于 {time(editing.note.createdAt)} · 更新于 {time(editing.note.updatedAt)}</span> : null}
            </div>
            <div className="admin-notes__fields">
              <label className="admin-field">
                <span>版本号</span>
                <input value={draft.version} disabled={locked} maxLength={RELEASE_NOTE_VERSION_MAX_CHARS + 1} spellCheck={false} placeholder="0.1.243"
                  aria-invalid={versionError ? true : undefined} onChange={event => { update({ version: event.target.value }); setVersionError('') }} />
                {versionError ? <small className="admin-field__error" role="alert">{versionError}</small> : null}
              </label>
              <label className="admin-field admin-field--grow">
                <span>标题</span>
                <input value={draft.title} disabled={locked} maxLength={RELEASE_NOTE_TITLE_MAX_CHARS} onChange={event => update({ title: event.target.value })} />
              </label>
            </div>
            <div className="admin-notes__fields">
              <fieldset className="admin-field" disabled={locked}>
                <legend>状态</legend>
                <div className="admin-segment">{RELEASE_NOTE_STATUSES.map(value => <label key={value} className={draft.status === value ? 'is-selected' : ''}>
                  <input type="radio" name="admin-note-status" value={value} checked={draft.status === value} onChange={() => update({ status: value })} />
                  {RELEASE_NOTE_STATUS_LABELS[value]}</label>)}</div>
              </fieldset>
              <label className="admin-field">
                <span>发布时间</span>
                <span className="admin-field__inline">
                  <input type="datetime-local" value={draft.publishedAt} disabled={locked} onChange={event => update({ publishedAt: event.target.value })} />
                  {draft.publishedAt ? <button type="button" className="admin-btn admin-btn--small" disabled={locked} onClick={() => update({ publishedAt: '' })}>清空</button> : null}
                </span>
                <small className="admin-muted">{draft.publishedAt
                  ? (fromLocalInput(draft.publishedAt) ?? 0) > Date.now() ? '将来的时间：发布后到点才会展示（预约）。' : '按此时间展示和排序。'
                  : editing.mode === 'new' ? '留空：发布时使用当前时间。' : '留空：保留原发布时间；从未发布过则使用当前时间。'}</small>
              </label>
            </div>
            <div className="admin-notes__split">
              <label className="admin-notes__source">
                <span>HTML 正文<small className={htmlBytes > RELEASE_NOTE_HTML_MAX_BYTES ? 'is-over' : ''}>{(htmlBytes / 1024).toFixed(1)} KB / 1024 KB</small></span>
                <textarea value={draft.contentHtml} disabled={locked} spellCheck={false} wrap="off"
                  onChange={event => update({ contentHtml: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save() }
                    else if (event.key === 'Tab' && !event.shiftKey) {
                      event.preventDefault()
                      const target = event.currentTarget, start = target.selectionStart, end = target.selectionEnd
                      update({ contentHtml: target.value.slice(0, start) + '  ' + target.value.slice(end) })
                      window.requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2 })
                    }
                  }} />
              </label>
              <div className="admin-notes__preview">
                <span>预览<small>与客户端展示一致；脚本、样式属性和外部图片会被移除</small></span>
                <iframe title="更新说明预览" sandbox="" referrerPolicy="no-referrer" srcDoc={previewHtml} />
              </div>
            </div>
            {formError ? <p className="admin-error" role="alert">{formError}</p> : null}
            <div className="admin-detail__actions">
              {notice ? <span className="admin-saved" role="status">{notice}</span> : null}
              {editing.mode === 'edit' ? <button type="button" className="admin-btn admin-btn--danger" disabled={busy !== null} onClick={() => void remove()}>{busy === 'delete' ? '删除中…' : '删除'}</button> : null}
              <button type="button" className="admin-btn" disabled={!dirty || busy !== null} onClick={() => { if (baseline) setDraft(baseline); resetMessages() }}>撤销修改</button>
              <button type="submit" className="admin-btn admin-btn--primary" disabled={busy !== null || (editing.mode === 'edit' && !dirty)} title="Ctrl + Enter 保存">
                {busy === 'save' ? '保存中…' : editing.mode === 'new' ? '创建' : '保存'}</button>
            </div>
          </form>}
      </article>
    </div>
  </section>
}
