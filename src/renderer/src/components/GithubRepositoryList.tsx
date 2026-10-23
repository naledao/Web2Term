import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Popover } from '@base-ui/react/popover'
import { GITHUB_CLONE_STAGES, initialGithubCloneProgress } from '@shared/github'
import type { GithubCloneProgress, GithubLogoutResult, GithubRepository } from '@shared/github'
import { githubRepositoryUpdated, selectGithubRepositories } from '../github-repositories'
import type { GithubRepositoryFilters, GithubRepositorySnapshot } from '../github-repositories'
import GitHubIcon from './GitHubIcon'
import { NotificationRegion, useNotification } from './Notification'
import './GithubRepositoryList.css'

interface Props {
  sessionId: string
  account: string
  visible: boolean
  snapshot: GithubRepositorySnapshot
  loading: boolean
  error: string
  loggingOut: boolean
  accountMessage: GithubLogoutResult | null
  filters: GithubRepositoryFilters
  onFiltersChange(filters: GithubRepositoryFilters): void
  onRefresh(): void
  onLogout(): void
}
const VISIBILITY = { public: '公开', private: '私有', internal: '内部' }

export default function GithubRepositoryList(props: Props): JSX.Element {
  return <NotificationRegion key={props.sessionId + ':' + props.account}>
    <RepositoryList {...props} />
  </NotificationRegion>
}

function RepositoryList({ sessionId, account, visible, snapshot, loading, error, loggingOut, accountMessage, filters, onFiltersChange, onRefresh, onLogout }: Props): JSX.Element {
  const [limit, setLimit] = useState(50)
  const [logoutAccount, setLogoutAccount] = useState<string | null>(null)
  const [cloning, setCloning] = useState<string | null>(null)
  const [cloneProgress, setCloneProgress] = useState<GithubCloneProgress | null>(null)
  const stopCloneProgress = useRef<(() => void) | null>(null)
  const notify = useNotification()
  const clonePending = useRef(false)
  const mounted = useRef(false)
  const cloneOwner = sessionId + ':' + account
  const currentOwner = useRef(cloneOwner)
  currentOwner.current = cloneOwner
  const container = useRef<HTMLDivElement>(null)
  const cancelLogout = useRef<HTMLButtonElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const showLogout = visible && !loggingOut && !cloning && logoutAccount === account
  const repositories = useMemo(() => selectGithubRepositories(snapshot.repositories, filters, account), [snapshot.repositories, filters, account])
  const filtered = !!filters.query.trim() || filters.ownership !== 'all' || filters.visibility !== 'all'
  useEffect(() => {
    setLimit(50)
    if (viewport.current) viewport.current.scrollTop = 0
  }, [filters.query, filters.ownership, filters.visibility, filters.sort])
  useEffect(() => { setLogoutAccount(null) }, [account, visible])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stopCloneProgress.current?.(); stopCloneProgress.current = null }
  }, [])
  const cloneRepository = async (repository: GithubRepository): Promise<void> => {
    if (clonePending.current || loggingOut) return
    clonePending.current = true
    const source = cloneOwner
    setCloning(repository.fullName)
    setCloneProgress(initialGithubCloneProgress('selecting'))
    setLogoutAccount(null)
    try {
      const request = { requestId: crypto.randomUUID(), sessionId, account, fullName: repository.fullName }
      // Subscribe before invoking: even a small repository may finish within one IPC round-trip.
      stopCloneProgress.current = window.api.onGithubCloneProgress(event => {
        if (mounted.current && currentOwner.current === source && event.requestId === request.requestId &&
          event.sessionId === sessionId && event.account === account && event.fullName === repository.fullName) {
          setCloneProgress(event.progress)
        }
      })
      const result = await window.api.cloneGithubRepository(request)
      if (mounted.current && currentOwner.current === source && result.status !== 'cancelled') {
        notify({ type: result.status === 'cloned' ? 'success' : 'error',
          title: result.status === 'cloned' ? '已克隆到本地' : '克隆未完成',
          description: [repository.fullName, result.status === 'error' ? result.message : '', result.directory].filter(Boolean).join('\n') })
      }
    } catch {
      if (mounted.current && currentOwner.current === source) notify({ type: 'error', title: '克隆结果待确认',
        description: `${repository.fullName}\n克隆结果尚未确认，请先检查所选目录，避免重复操作。` })
    } finally {
      stopCloneProgress.current?.()
      stopCloneProgress.current = null
      clonePending.current = false
      if (mounted.current) { setCloning(null); setCloneProgress(null) }
    }
  }
  useEffect(() => {
    if (!showLogout) return
    // Match the sidebar's existing popovers: focus after positioning without scrolling the pane.
    const frame = requestAnimationFrame(() => cancelLogout.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [showLogout])
  return <div className="github-repository-list" ref={container}>
    <header className="github-repository-list__header">
      <GitHubIcon size={26} />
      <div><h2>GitHub 仓库</h2><span title={`当前账号：${account}`}>@{account}</span></div>
      <button type="button" className="github-repository-list__refresh" disabled={loading || loggingOut || !!cloning} title="重新检测账号并刷新仓库" aria-label="刷新仓库列表" onClick={onRefresh}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" /></svg>
      </button>
      <Popover.Root open={showLogout} onOpenChange={next => setLogoutAccount(next ? account : null)}>
        <Popover.Trigger className="github-repository-list__logout" disabled={loggingOut || !!cloning} title={`退出 GitHub CLI 账号 @${account}`}>
          {loggingOut ? '退出中…' : '退出登录'}
        </Popover.Trigger>
        <Popover.Portal container={container} className="github-logout__portal">
          <Popover.Positioner positionMethod="fixed" side="bottom" align="end" sideOffset={8} collisionPadding={8}
            collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
            collisionBoundary={container.current ?? undefined} className="github-logout__positioner">
            <Popover.Popup className="github-logout__popup" initialFocus={false} finalFocus={() => visible && !loggingOut}>
              <Popover.Title className="github-logout__title">退出登录？</Popover.Title>
              <Popover.Description className="github-logout__description">将退出本机 GitHub CLI 账号 <strong>@{account}</strong>。</Popover.Description>
              <div className="github-logout__actions">
                <Popover.Close ref={cancelLogout}>取消</Popover.Close>
                <button type="button" className="github-logout__confirm" onClick={() => {
                  if (!showLogout || loggingOut) return
                  setLogoutAccount(null)
                  onLogout()
                }}>确认退出</button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </header>
    {accountMessage ? <div className="github-repository-list__account-message" data-error={!accountMessage.ok} role={accountMessage.ok ? 'status' : 'alert'}>{accountMessage.message}</div> : null}
    <div className="github-repository-list__controls">
      <div className="github-repository-list__search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
        <input type="search" aria-label="搜索仓库" placeholder="搜索仓库名称或描述…" disabled={loggingOut} value={filters.query} onChange={event => onFiltersChange({ ...filters, query: event.target.value })} />
      </div>
      <div className="github-repository-list__filters">
        <label>归属<select disabled={loggingOut} value={filters.ownership} onChange={event => onFiltersChange({ ...filters, ownership: event.target.value as GithubRepositoryFilters['ownership'] })}>
          <option value="all">全部仓库</option><option value="owned">我的仓库</option><option value="shared">组织与协作</option>
        </select></label>
        <label>可见性<select disabled={loggingOut} value={filters.visibility} onChange={event => onFiltersChange({ ...filters, visibility: event.target.value as GithubRepositoryFilters['visibility'] })}>
          <option value="all">全部</option><option value="public">公开</option><option value="private">私有</option><option value="internal">内部</option>
        </select></label>
        <label>排序<select disabled={loggingOut} value={filters.sort} onChange={event => onFiltersChange({ ...filters, sort: event.target.value as GithubRepositoryFilters['sort'] })}>
          <option value="updated">最近更新</option><option value="name">名称</option><option value="stars">星标最多</option>
        </select></label>
      </div>
      <div className="github-repository-list__count" role="status">
        {cloning ? `正在克隆 ${cloning} · ${cloneProgress ? GITHUB_CLONE_STAGES[cloneProgress.stage] : '准备中'}…` : loggingOut ? '正在退出当前 GitHub 账号…' : loading ? `已加载 ${snapshot.repositories.length}${snapshot.totalCount === null ? '' : ' / ' + snapshot.totalCount} 个仓库…`
          : snapshot.complete ? filtered ? `找到 ${repositories.length} 个 · 共 ${snapshot.repositories.length} 个仓库` : `共 ${snapshot.repositories.length} 个仓库`
            : `已加载 ${snapshot.repositories.length} 个，列表尚未完整`}
      </div>
    </div>
    <div className="github-repository-list__viewport" ref={viewport}>
      {error ? <div className="github-repository-list__error" role="alert"><p>{error}</p><button type="button" onClick={onRefresh} disabled={loading || loggingOut}>重新加载</button></div> : null}
      {loading && snapshot.repositories.length === 0 ? <div className="github-repository-list__skeleton" aria-hidden="true">{[0, 1, 2, 3].map(index => <div key={index}><span /><span /><span /></div>)}</div> : null}
      <ul className="github-repository-list__items" aria-label="仓库列表">
        {repositories.slice(0, limit).map(repository => <li className="github-repository-list__item" key={repository.id}>
          <div className="github-repository-list__title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19.5V5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 1 0-4h14M8 7h8M8 11h5" /></svg>
            <a href={repository.url} target="_blank" rel="noreferrer" title={`在浏览器中打开 ${repository.fullName}`}>{repository.fullName}</a>
            <span className="github-repository-list__visibility">{VISIBILITY[repository.visibility]}</span>
            <button type="button" className="github-repository-list__clone" disabled={!!cloning || loggingOut}
              data-cloning={cloning === repository.fullName}
              title={cloning === repository.fullName && cloneProgress ? `${GITHUB_CLONE_STAGES[cloneProgress.stage]}${cloneProgress.percent === null ? '…' : ' ' + cloneProgress.percent + '%'}` : `克隆 ${repository.fullName} 到本地`}
              aria-label={`克隆 ${repository.fullName} 到本地`}
              aria-busy={cloning === repository.fullName} onClick={() => void cloneRepository(repository)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {cloning === repository.fullName ? <path d="M21 12a9 9 0 1 1-9-9" /> : <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />}
              </svg>
              {cloning === repository.fullName ? cloneProgress?.percent != null ? `${cloneProgress.percent}%` : '克隆中…' : '克隆'}
            </button>
          </div>
          {cloning === repository.fullName && cloneProgress ? <CloneProgress progress={cloneProgress} /> : null}
          {repository.description ? <p className="github-repository-list__description" title={repository.description}>{repository.description}</p> : null}
          <div className="github-repository-list__meta">
            {repository.language ? <span><i style={{ background: repository.languageColor ?? 'var(--text-muted)' }} />{repository.language}</span> : null}
            {repository.stars > 0 ? <span title={`${repository.stars} 个星标`}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z" /></svg>{repository.stars.toLocaleString()}</span> : null}
            {repository.fork ? <span>Fork</span> : null}
            {repository.archived ? <span className="github-repository-list__archived">已归档</span> : null}
            <time dateTime={repository.updatedAt} title={new Date(repository.updatedAt).toLocaleString('zh-CN')}>{githubRepositoryUpdated(repository.updatedAt)}</time>
          </div>
        </li>)}
      </ul>
      {!loading && !error && repositories.length === 0 ? <div className="github-repository-list__empty">
        <strong>{filtered ? '没有匹配的仓库' : '还没有可显示的仓库'}</strong>
        <p>{filtered ? '试试其他关键词，或调整筛选条件。' : '当前授权下没有可访问的仓库。'}</p>
        {filtered ? <button type="button" onClick={() => onFiltersChange({ ...filters, query: '', ownership: 'all', visibility: 'all' })}>清除筛选</button> : null}
      </div> : null}
      {repositories.length > limit ? <button type="button" className="github-repository-list__more" onClick={() => setLimit(value => value + 50)}>显示更多 · 还有 {repositories.length - limit} 个</button> : null}
      {snapshot.complete && snapshot.totalCount !== snapshot.repositories.length ? <p className="github-repository-list__note">仓库列表在加载期间发生了变化，可刷新获取最新结果。</p> : null}
    </div>
  </div>
}

function CloneProgress({ progress }: { progress: GithubCloneProgress }): JSX.Element {
  const stage = GITHUB_CLONE_STAGES[progress.stage]
  const details = [progress.total !== null ? `${progress.completed?.toLocaleString()} / ${progress.total.toLocaleString()}` : null,
    progress.transferred, progress.speed].filter(Boolean)
  return <div className="github-clone-progress">
    <div className="github-clone-progress__heading"><span>{stage}</span><span>{progress.percent === null ? '进行中…' : `${progress.percent}%`}</span></div>
    <div className="github-clone-progress__track" role="progressbar" aria-label={`${stage}进度`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined}
      aria-valuetext={progress.percent === null ? stage : `${stage} ${progress.percent}%`}
      data-indeterminate={progress.percent === null}>
      <span style={progress.percent === null ? undefined : { width: `${progress.percent}%` }} />
    </div>
    {details.length ? <div className="github-clone-progress__details">{details.join(' · ')}</div> : null}
  </div>
}
