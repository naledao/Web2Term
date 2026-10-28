import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppTheme } from '../../../shared/types'
import type { ReleaseNoteDetail, ReleaseNoteSummary } from '../../../shared/release-notes'
import AppPopover from './AppPopover'
import { releaseNotesDocument } from './release-notes-document'
import './ReleaseNotes.css'

interface Catalog { items: ReleaseNoteSummary[]; total: number; offset: number; source: string }
interface Detail { note: ReleaseNoteDetail; source: string }
const EMPTY: Catalog = { items: [], total: 0, offset: 0, source: '' }
const published = (value: number): string => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })

export default function ReleaseNotes({ open, onOpen, onClose, theme, appVersion }: {
  open: boolean; onOpen(): void; onClose(): void; theme: AppTheme; appVersion: string
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const alive = useRef(false)
  const visible = useRef(open)
  visible.current = open
  const epoch = useRef(0)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const badgeRequest = useRef(0)
  const readAttempts = useRef(new Set<string>())
  const inFlightReads = useRef(new Set<string>())
  const confirmedReads = useRef(new Map<string, number>())
  const readRevision = useRef(0)
  const [unread, setUnread] = useState<number | null>(null)
  const [catalog, setCatalog] = useState<Catalog>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [selected, setSelected] = useState<ReleaseNoteSummary | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [readError, setReadError] = useState<{ id: string; message: string } | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [frameError, setFrameError] = useState(false)

  const refreshBadge = useCallback(async (): Promise<void> => {
    const revision = ++badgeRequest.current, generation = epoch.current
    try {
      const result = await window.api.listReleaseNotes({ limit: 1 })
      if (alive.current && revision === badgeRequest.current && generation === epoch.current) setUnread(result.ok ? result.value.unreadCount : null)
    } catch { if (alive.current && revision === badgeRequest.current && generation === epoch.current) setUnread(null) }
  }, [])

  const select = useCallback(async (note: ReleaseNoteSummary, source: string): Promise<void> => {
    const revision = ++detailRequest.current, generation = epoch.current
    const key = `${generation}:${source}:${note.id}`
    if (!inFlightReads.current.has(key)) readAttempts.current.delete(key)
    setSelected(note); setDetail(null); setDetailError(''); setReadError(null); setDetailLoading(true); setFrameError(false)
    try {
      const result = await window.api.getReleaseNote({ id: note.id, source })
      if (!alive.current || !visible.current || revision !== detailRequest.current || generation !== epoch.current) return
      if (result.ok) {
        setDetail({ note: result.value, source: result.source })
        if (result.value.isRead) {
          confirmedReads.current.set(`${source}:${note.id}`, result.value.readAt!)
          readRevision.current++
          setCatalog(previous => previous.source === source ? { ...previous, items: previous.items.map(item => item.id === note.id ? result.value : item) } : previous)
          void refreshBadge()
        }
      } else setDetailError(result.message)
    } catch { if (alive.current && revision === detailRequest.current && generation === epoch.current) setDetailError('读取更新说明失败，请重试。') }
    finally { if (alive.current && revision === detailRequest.current && generation === epoch.current) setDetailLoading(false) }
  }, [refreshBadge])

  const loadPage = useCallback(async (append?: { offset: number; source: string }): Promise<void> => {
    const revision = ++listRequest.current, generation = epoch.current, reads = readRevision.current
    setLoading(true); setListError('')
    if (!append) {
      ++detailRequest.current
      setCatalog(EMPTY); setSelected(null); setDetail(null); setDetailError(''); setDetailLoading(false)
    }
    try {
      const result = await window.api.listReleaseNotes({ limit: 20, offset: append?.offset ?? 0 })
      if (!alive.current || !visible.current || revision !== listRequest.current || generation !== epoch.current) return
      if (!result.ok) { setListError(result.message); return }
      if (append && result.source !== append.source) { setListError('后端地址已切换，请刷新列表。'); return }
      const page = result.value
      if (reads === readRevision.current) setUnread(page.unreadCount)
      else void refreshBadge()
      const items = page.items.map(item => {
        const readAt = confirmedReads.current.get(`${result.source}:${item.id}`)
        return readAt === undefined ? item : { ...item, isRead: true, readAt }
      })
      setCatalog(previous => ({ items: append && previous.source === result.source
        ? [...previous.items, ...items.filter(item => !previous.items.some(old => old.id === item.id))] : items,
        total: page.total, offset: page.offset + page.items.length, source: result.source }))
      if (!append && items[0]) void select(items[0], result.source)
    } catch { if (alive.current && revision === listRequest.current && generation === epoch.current) setListError('读取版本列表失败，请重试。') }
    finally { if (alive.current && revision === listRequest.current && generation === epoch.current) setLoading(false) }
  }, [select, refreshBadge])

  useEffect(() => {
    alive.current = true
    void refreshBadge()
    const refresh = (): void => { if (document.visibilityState === 'visible') void refreshBadge() }
    const timer = window.setInterval(refresh, 5 * 60_000)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    const off = window.api.onReleaseNotesChanged(() => {
      epoch.current++; listRequest.current++; detailRequest.current++; badgeRequest.current++
      readAttempts.current.clear()
      confirmedReads.current.clear(); readRevision.current++
      setUnread(null); setCatalog(EMPTY); setSelected(null); setDetail(null); setDetailError(''); setReadError(null); setReading(null)
      if (visible.current) void loadPage()
      else void refreshBadge()
    })
    return () => { alive.current = false; epoch.current++; off(); window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh) }
  }, [loadPage, refreshBadge])

  useEffect(() => {
    readAttempts.current.clear()
    if (open) { void loadPage(); heading.current?.focus() }
    else { listRequest.current++; detailRequest.current++; setLoading(false); setDetailLoading(false); setDetail(null) }
  }, [open, loadPage])

  const markRead = async (target: Detail, retry = false): Promise<void> => {
    if (!visible.current || target.note.isRead) return
    const key = `${epoch.current}:${target.source}:${target.note.id}`
    if (inFlightReads.current.has(key) || !retry && readAttempts.current.has(key)) return
    readAttempts.current.add(key)
    inFlightReads.current.add(key)
    const generation = epoch.current
    setReading(key); setReadError(null)
    try {
      const result = await window.api.markReleaseNoteRead({ id: target.note.id, source: target.source })
      if (!alive.current || generation !== epoch.current) return
      if (result.ok) {
        confirmedReads.current.set(`${result.source}:${target.note.id}`, result.value.readAt)
        readRevision.current++
        setCatalog(previous => previous.source === result.source ? { ...previous, items: previous.items.map(item => item.id === target.note.id ? { ...item, isRead: true, readAt: result.value.readAt } : item) } : previous)
        setDetail(previous => previous?.source === result.source && previous.note.id === target.note.id ? { ...previous, note: { ...previous.note, isRead: true, readAt: result.value.readAt } } : previous)
        void refreshBadge()
      } else setReadError({ id: target.note.id, message: result.message })
    } catch { if (alive.current && generation === epoch.current) setReadError({ id: target.note.id, message: '已读状态保存失败，请重试。' }) }
    finally {
      inFlightReads.current.delete(key)
      if (alive.current && generation === epoch.current) setReading(previous => previous === key ? null : previous)
    }
  }

  const html = useMemo(() => detail ? releaseNotesDocument(detail.note.contentHtml, theme === 'dark') : '', [detail?.note.contentHtml, theme])
  const currentVersion = (appVersion || '').replace(/^v/, '')
  return <>
    <button ref={trigger} type="button" className="workspace__release-notes-button" onClick={open ? onClose : onOpen}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? 'release-notes-panel' : undefined}
      aria-label={`版本更新说明${unread ? `，${unread} 条未读` : ''}`} title="查看版本更新说明">
      版本更新说明{unread !== null && unread > 0 ? <span className="release-notes-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span> : null}
    </button>
    {open ? <AppPopover id="release-notes-panel" className="release-notes-panel" anchor={trigger.current} onClose={onClose}
      aria-labelledby="release-notes-title" initialFocus={heading} dismissOnOutside={false}>
      <header className="release-notes__header"><div><h2 id="release-notes-title" tabIndex={-1} ref={heading}>版本更新说明</h2>
        <p>{appVersion ? `当前客户端 v${currentVersion}` : '查看功能变化与修复记录'}{unread !== null ? ` · ${unread} 条未读` : ''}</p></div>
        <button type="button" disabled={loading} onClick={() => void loadPage()}>{loading ? '加载中…' : '刷新'}</button>
        <button type="button" className="release-notes__close" aria-label="关闭更新说明" onClick={onClose}>×</button></header>
      <div className="release-notes__layout">
        <aside className="release-notes__versions" aria-label="版本列表" aria-busy={loading}>
          {listError ? <div className="release-notes__feedback" role="alert"><p>{listError}</p><button type="button" disabled={loading} onClick={() => void loadPage()}>重新加载</button></div> : null}
          {!catalog.items.length && !listError ? <p className="release-notes__empty" role="status">{loading ? '正在加载版本列表…' : '暂无已发布的更新说明'}</p> : null}
          <ul>{catalog.items.map(item => <li key={item.id}><button type="button" className={selected?.id === item.id ? 'is-selected' : ''}
            aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => void select(item, catalog.source)}>
            <span className="release-notes__version"><strong>v{item.version}</strong>{!item.isRead ? <i aria-label="未读" /> : null}{item.version === currentVersion ? <small>当前版本</small> : null}</span>
            <span className="release-notes__note-title">{item.title}</span><time dateTime={new Date(item.publishedAt).toISOString()}>{published(item.publishedAt)}</time>
          </button></li>)}</ul>
          {catalog.offset < catalog.total ? <button type="button" className="release-notes__more" disabled={loading} onClick={() => void loadPage({ offset: catalog.offset, source: catalog.source })}>{loading ? '加载中…' : '加载更多'}</button> : null}
        </aside>
        <section className="release-notes__detail" aria-label="更新说明正文" aria-busy={detailLoading}>
          {selected ? <div className="release-notes__detail-heading"><h3>{selected.title}</h3><p>v{selected.version} · {published(selected.publishedAt)}</p></div> : null}
          {detailLoading ? <p className="release-notes__empty" role="status">正在读取正文…</p> : detailError ? <div className="release-notes__feedback" role="alert"><p>{detailError}</p><button type="button" onClick={() => { if (selected) void select(selected, catalog.source) }}>重试</button></div> : detail ? <>
            {readError?.id === detail.note.id ? <div className="release-notes__read-error" role="alert">正文已加载，{readError.message}<button type="button" disabled={reading !== null} onClick={() => void markRead(detail, true)}>重试保存已读</button></div> : null}
            {frameError ? <p className="release-notes__feedback" role="alert">正文显示失败，请重新选择此版本。</p> : <iframe key={`${detail.source}:${detail.note.id}`} className="release-notes__frame" title={`${detail.note.title} 正文`} sandbox="" referrerPolicy="no-referrer" srcDoc={html}
              onLoad={() => { if (visible.current) void markRead(detail) }} onError={() => setFrameError(true)} />}
          </> : !detailError ? <p className="release-notes__empty">{loading ? '正在加载…' : '选择一个版本查看更新内容'}</p> : null}
        </section>
      </div>
    </AppPopover> : null}
  </>
}
