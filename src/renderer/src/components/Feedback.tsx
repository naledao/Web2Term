import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { BackendAuthState } from '../../../shared/types'
import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_LABELS, FEEDBACK_MAX_CHARS, FEEDBACK_STATUS_LABELS } from '../../../shared/feedback'
import type { FeedbackCategory, FeedbackItem } from '../../../shared/feedback'
import AppPopover from './AppPopover'
import BackendLoginForm from './BackendLoginForm'
import './Feedback.css'

const PLACEHOLDERS: Record<FeedbackCategory, string> = {
  bug: '遇到了什么问题？请尽量写清楚操作步骤、期望结果和实际结果。',
  feature: '希望增加什么功能？想用它解决什么场景下的问题？',
  improvement: '哪里用起来不顺手？希望怎样改进？',
  other: '想对我们说的任何话。'
}
const PAGE_SIZE = 20
const submittedAt = (value: number): string => new Date(value).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

interface History { items: FeedbackItem[]; total: number; loaded: boolean }
const EMPTY_HISTORY: History = { items: [], total: 0, loaded: false }

/** Text-only feedback entry in the title bar. Requires a backend login; the draft survives closing the panel until it is sent. */
export default function Feedback({ open, onOpen, onClose, onSignedIn }: { open: boolean; onOpen(): void; onClose(): void; onSignedIn?(): void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const alive = useRef(true)
  const historyRequest = useRef(0)
  const [auth, setAuth] = useState<BackendAuthState | null>(null)
  const [authError, setAuthError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  /** The backend rejected the saved token; stay on the login form until a new login, even if the local copy has not expired. */
  const [forceLogin, setForceLogin] = useState(false)
  const [view, setView] = useState<'submit' | 'history'>('submit')
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [history, setHistory] = useState<History>(EMPTY_HISTORY)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')

  const signedIn = auth?.status === 'signed-in' && !forceLogin
  const accountKey = signedIn ? `${auth?.backendUrl ?? ''}|${auth?.user?.publicId ?? ''}` : ''

  const refreshAuth = useCallback(async (): Promise<void> => {
    setAuthError('')
    try {
      const state = await window.api.getBackendAuthState()
      if (alive.current) setAuth(state)
    } catch { if (alive.current) { setAuth(null); setAuthError('读取登录状态失败，请重试。') } }
  }, [])

  const loginExpired = useCallback((message: string): void => {
    setForceLogin(true)
    setAuthError(message)
  }, [])

  const loadHistory = useCallback(async (offset = 0): Promise<void> => {
    const revision = ++historyRequest.current
    setHistoryLoading(true); setHistoryError('')
    try {
      const result = await window.api.listFeedback({ limit: PAGE_SIZE, offset })
      if (!alive.current || revision !== historyRequest.current) return
      if (!result.ok) {
        if (result.loginRequired) loginExpired(result.message)
        else setHistoryError(result.message)
        return
      }
      setHistory(previous => ({
        items: offset ? [...previous.items, ...result.value.items.filter(item => !previous.items.some(old => old.id === item.id))] : result.value.items,
        total: result.value.total, loaded: true
      }))
    } catch { if (alive.current && revision === historyRequest.current) setHistoryError('读取反馈记录失败，请重试。') }
    finally { if (alive.current && revision === historyRequest.current) setHistoryLoading(false) }
  }, [loginExpired])

  // StrictMode remounts in development: set the flag on every mount, not only at creation.
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (open) void refreshAuth()
    else { setError(''); setSent(false); setAuthError(''); setForceLogin(false); historyRequest.current++; setHistoryLoading(false) }
  }, [open, refreshAuth])
  // Another account must never see the previous account's list.
  useEffect(() => { historyRequest.current++; setHistory(EMPTY_HISTORY); setHistoryError(''); setHistoryLoading(false) }, [accountKey])
  useEffect(() => { if (open && signedIn && view === 'history' && !history.loaded && !historyLoading && !historyError) void loadHistory() },
    [open, signedIn, view, history.loaded, historyLoading, historyError, loadHistory])

  const length = [...content.trim()].length
  const tooLong = length > FEEDBACK_MAX_CHARS
  const canSubmit = signedIn && !sending && length > 0 && !tooLong

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSending(true); setError('')
    try {
      // No contact email is sent: the backend records the signed-in account's email.
      const result = await window.api.submitFeedback({ category, content })
      if (!alive.current) return
      if (result.ok) {
        setSent(true); setContent(''); setCategory('bug')
        setHistory(previous => previous.loaded ? { ...previous, items: [result.value, ...previous.items], total: previous.total + 1 } : previous)
      } else if (result.loginRequired) loginExpired(result.message)
      else setError(result.message)
    } catch { if (alive.current) setError('提交反馈失败，请重试。') }
    finally { if (alive.current) setSending(false) }
  }

  const showView = (next: 'submit' | 'history'): void => {
    setView(next)
    if (next === 'history' && historyError) { setHistoryError(''); setHistory(EMPTY_HISTORY) }
  }

  const loginPanel = (): ReactElement => {
    if (!auth) {
      return <div className="feedback__gate" role={authError ? 'alert' : 'status'}>
        <p>{authError || '正在读取登录状态…'}</p>
        {authError ? <div className="feedback__actions"><button type="button" onClick={() => void refreshAuth()}>重试</button></div> : null}
      </div>
    }
    if (!auth.backendUrl) {
      return <div className="feedback__gate" role="status"><p>请先在“设置 → 后端服务”中填写后端地址并登录，然后再提交反馈。</p></div>
    }
    return <div className="feedback__gate">
      <p className="feedback__gate-title">{forceLogin || auth.status === 'expired' ? '登录已失效，请重新登录' : '登录后即可提交反馈、查看自己的反馈记录'}</p>
      {authError ? <p className="feedback__error" role="alert">{authError}</p> : null}
      <BackendLoginForm backendUrl={auth.backendUrl} open disabled={false} hideAccountStatus onCancel={onClose} onBusyChange={setLoginBusy}
        onSignedIn={state => { setAuth(state); setAuthError(''); setForceLogin(false); onSignedIn?.(); window.setTimeout(() => textarea.current?.focus(), 0) }} />
    </div>
  }

  const submitPanel = (): ReactElement => sent ? <div className="feedback__done" role="status">
    <strong>感谢你的反馈！</strong>
    <p>我们已经收到，会认真阅读每一条意见。处理进度可以在“我的反馈”里查看。</p>
    <div className="feedback__actions">
      <button type="button" onClick={() => { setSent(false); window.setTimeout(() => textarea.current?.focus(), 0) }}>再写一条</button>
      <button type="button" onClick={() => { setSent(false); showView('history') }}>查看我的反馈</button>
      <button type="button" className="is-primary" onClick={onClose}>完成</button>
    </div>
  </div> : <form className="feedback__form" onSubmit={event => { event.preventDefault(); void submit() }}>
    <fieldset className="feedback__categories" disabled={sending}>
      <legend>反馈类型</legend>
      {FEEDBACK_CATEGORIES.map(item => <label key={item} className={category === item ? 'is-selected' : ''}>
        <input type="radio" name="feedback-category" value={item} checked={category === item} onChange={() => setCategory(item)} />
        {FEEDBACK_CATEGORY_LABELS[item]}
      </label>)}
    </fieldset>
    <label className="feedback__content">
      <span>反馈内容</span>
      <textarea ref={textarea} value={content} disabled={sending} placeholder={PLACEHOLDERS[category]} rows={8}
        aria-invalid={tooLong || undefined} aria-describedby="feedback-count"
        onChange={event => { setContent(event.target.value); if (error) setError('') }}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit() } }} />
    </label>
    <div className="feedback__meta">
      <span id="feedback-count" className={tooLong ? 'is-over' : ''}>{length} / {FEEDBACK_MAX_CHARS}</span>
    </div>
    {error ? <p className="feedback__error" role="alert">{error}</p> : null}
    <div className="feedback__actions">
      <button type="button" disabled={sending} onClick={onClose}>取消</button>
      <button type="submit" className="is-primary" disabled={!canSubmit} title="Ctrl + Enter 提交">{sending ? '提交中…' : '提交反馈'}</button>
    </div>
  </form>

  const historyPanel = (): ReactElement => <div className="feedback__history" aria-busy={historyLoading}>
    {historyError ? <div className="feedback__error" role="alert">{historyError}
      <button type="button" className="feedback__inline-btn" disabled={historyLoading} onClick={() => void loadHistory(history.loaded ? history.items.length : 0)}>重试</button></div> : null}
    {!history.items.length && !historyError ? <p className="feedback__empty" role="status">{historyLoading || !history.loaded ? '正在加载反馈记录…' : '还没有提交过反馈'}</p> : null}
    {history.items.length ? <ul>{history.items.map(item => <li key={item.id} className="feedback__record">
      <div className="feedback__record-meta">
        <span className="feedback__tag">{FEEDBACK_CATEGORY_LABELS[item.category]}</span>
        <span className={`feedback__status feedback__status--${item.status}`}>{FEEDBACK_STATUS_LABELS[item.status] ?? '未知状态'}</span>
        <time dateTime={new Date(item.createdAt).toISOString()}>{submittedAt(item.createdAt)}</time>
      </div>
      <p className="feedback__record-content">{item.content}</p>
      {item.appVersion ? <small className="feedback__record-foot">v{item.appVersion.replace(/^v/, '')}</small> : null}
    </li>)}</ul> : null}
    {history.loaded && history.items.length < history.total ? <button type="button" className="feedback__more" disabled={historyLoading}
      onClick={() => void loadHistory(history.items.length)}>{historyLoading ? '加载中…' : '加载更多'}</button> : null}
  </div>

  return <>
    <button ref={trigger} type="button" className="workspace__release-notes-button workspace__feedback-button" onClick={open ? onClose : onOpen}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? 'feedback-panel' : undefined} title="提交 Bug、功能建议或优化意见">
      反馈
    </button>
    {open ? <AppPopover id="feedback-panel" className="feedback-panel" anchor={trigger.current} onClose={onClose} busy={sending || loginBusy}
      aria-labelledby="feedback-title" initialFocus={heading} dismissOnOutside={false}>
      <header className="feedback__header"><div><h2 id="feedback-title" tabIndex={-1} ref={heading}>意见反馈</h2>
        <p>{signedIn && auth?.user ? `当前账号：${auth.user.email}` : '告诉我们遇到的问题、想要的功能或需要优化的地方'}</p></div>
        {signedIn && view === 'history' ? <button type="button" className="feedback__refresh" disabled={historyLoading} onClick={() => void loadHistory()}>{historyLoading ? '加载中…' : '刷新'}</button> : null}
        <button type="button" className="feedback__close" aria-label="关闭反馈" disabled={sending || loginBusy} onClick={onClose}>×</button></header>
      {signedIn ? <>
        <div className="feedback__tabs" role="tablist" aria-label="反馈">
          <button type="button" role="tab" id="feedback-tab-submit" aria-selected={view === 'submit'} aria-controls="feedback-tabpanel"
            className={view === 'submit' ? 'is-selected' : ''} onClick={() => showView('submit')}>提交反馈</button>
          <button type="button" role="tab" id="feedback-tab-history" aria-selected={view === 'history'} aria-controls="feedback-tabpanel"
            className={view === 'history' ? 'is-selected' : ''} onClick={() => showView('history')}>
            我的反馈{history.loaded ? <span className="feedback__count">{history.total}</span> : null}</button>
        </div>
        <div id="feedback-tabpanel" role="tabpanel" aria-labelledby={view === 'submit' ? 'feedback-tab-submit' : 'feedback-tab-history'}>
          {view === 'submit' ? submitPanel() : historyPanel()}
        </div>
      </> : loginPanel()}
    </AppPopover> : null}
  </>
}
