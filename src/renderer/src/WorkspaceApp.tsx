import AppPopover from './components/AppPopover'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { AppTheme, ManagedSessionSummary, SshTransferTask, UpdateStatus, WorkspaceState, WorkspaceProject } from '../../shared/types'
import brandIcon from './assets/brand-icon.png'
import WorkspaceNavigation from './components/WorkspaceNavigation'
import WorkspaceProjectDialog from './components/WorkspaceProjectDialog'
import App from './App'
import { ToolWindowsProvider, ToolWindowsHost } from './components/ToolWindows'
import Web2termDeviceDialog from './components/Web2termDeviceDialog'
import ConfirmDialog from './components/ConfirmDialog'
import NewSessionPopover from './components/NewSessionPopover'
import Web2termWordmark from './components/Web2termWordmark'
import ReleaseNotes from './components/ReleaseNotes'
import './assets/workspace-empty.css'
import './assets/workspace-brand.css'
import './assets/workspace-updates.css'
import './assets/workspace-titlebar.css'

const INITIAL_WORKSPACE: WorkspaceState = {
  view: 'manager',
  sessionId: null,
  openSshDialog: false
}

const NAV_MIN_WIDTH = 240
const NAV_MAX_WIDTH = 420

function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes)
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value
  let index = -1
  do {
    size /= 1024
    index += 1
  } while (size >= 1024 && index < units.length - 1)
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[index]}`
}

function transferStatus(item: SshTransferTask, percent: number): string {
  if (item.status === 'completed') return '已完成'
  if (item.status === 'cancelled') return '已取消'
  if (item.status === 'failed') return '失败'
  return item.total > 0 ? `${percent}%` : '准备中…'
}

function formatTransferDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const rounded = Math.ceil(seconds)
  if (rounded < 60) return `${rounded} 秒`
  const minutes = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
}


export default function WorkspaceApp(): ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceState>(INITIAL_WORKSPACE)
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([])
  const [projects, setProjects] = useState<WorkspaceProject[]>([])
  const [projectEditor, setProjectEditor] = useState<{ project: WorkspaceProject | null } | null>(null)
  const [pendingProjectDelete, setPendingProjectDelete] = useState<WorkspaceProject | null>(null)
  const removeProjectTrigger = useRef<HTMLButtonElement | null>(null)
  const [movingSession, setMovingSession] = useState<ManagedSessionSummary | null>(null)
  const [moveTarget, setMoveTarget] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const [navigationError, setNavigationError] = useState('')
  const [transfers, setTransfers] = useState<SshTransferTask[]>([])
  const [transfersOpen, setTransfersOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null)
  const newSessionTrigger = useRef<HTMLElement | null>(null)
  const [web2termDeviceDialogOpen, setWeb2termDeviceDialogOpen] = useState(false)
  const [web2termChatCreation, setWeb2termChatCreation] = useState<{ projectId: string | null } | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ManagedSessionSummary | null>(null)
  const deleteSessionTrigger = useRef<HTMLButtonElement | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  const [updateNotice, setUpdateNotice] = useState<{ version: string } | null>(null)
  const updateNoticeAnchor = useRef<HTMLSpanElement>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [updateLive, setUpdateLive] = useState<{ phase: UpdateStatus['phase']; percent: number }>({ phase: 'idle', percent: 0 })
  const [theme, setTheme] = useState<AppTheme>('light')
  const navigationRef = useRef<HTMLElement>(null)
  const newSessionButton = useRef<HTMLButtonElement>(null)
  const web2termDeviceDialogTrigger = useRef<HTMLButtonElement | null>(null)
  const noticedVersion = useRef('')
  const [navWidth, setNavWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem('layout.navWidth')
      const value = raw === null ? NaN : Number(raw)
      return Number.isFinite(value) ? Math.min(NAV_MAX_WIDTH, Math.max(NAV_MIN_WIDTH, value)) : NAV_MIN_WIDTH
    } catch {
      return NAV_MIN_WIDTH
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem('layout.navWidth', String(navWidth))
    } catch {
      /* storage unavailable; the width just will not persist */
    }
  }, [navWidth])

  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('layout.navCollapsed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem('layout.navCollapsed', navCollapsed ? '1' : '0')
    } catch {
      /* storage unavailable; the state just will not persist */
    }
  }, [navCollapsed])

  /** Drag the sidebar's right edge to resize it. */
  const startNavResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = navWidth
      const onMove = (moveEvent: PointerEvent): void => {
        const next = startWidth + (moveEvent.clientX - startX)
        const max = Math.max(NAV_MIN_WIDTH, Math.min(NAV_MAX_WIDTH, window.innerWidth - 520))
        setNavWidth(Math.min(Math.max(next, NAV_MIN_WIDTH), max))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [navWidth]
  )

  useEffect(() => {
    let navigationCurrent = true
    let sessionsPushed = false
    let projectsPushed = false
    const offSessions = window.api.onManagedSessionsChanged(items => { sessionsPushed = true; if (navigationCurrent) setSessions(items) })
    const offProjects = window.api.onWorkspaceProjectsChanged(items => { projectsPushed = true; if (navigationCurrent) setProjects(items) })
    void window.api.getWorkspaceState().then(setWorkspace)
    void window.api.getSettings().then((value) => setTheme(value.theme)).catch(() => {
      /* Light is the safe fallback when settings are unavailable during startup. */
    })
    void window.api.listManagedSessions().then(items => { if (navigationCurrent && !sessionsPushed) setSessions(items) })
      .catch(() => { if (navigationCurrent) setNavigationError('读取对话失败，请重新打开应用。') })
    void window.api.listWorkspaceProjects().then(items => { if (navigationCurrent && !projectsPushed) setProjects(items) })
      .catch(() => { if (navigationCurrent) setNavigationError('读取项目失败，请重新打开应用。') })
    void window.api.getSshTransfers().then(setTransfers)
    void window.api.getAppInfo().then((info) => setAppVersion(info.version))
    const offWorkspace = window.api.onWorkspaceChanged(setWorkspace)
    const offTransfers = window.api.onSshTransfersChanged(setTransfers)
    return () => {
      navigationCurrent = false
      offWorkspace()
      offSessions()
      offProjects()
      offTransfers()
    }
  }, [])


  useEffect(() => {
    const notice = (status: UpdateStatus): void => {
      setUpdateLive({ phase: status.phase, percent: status.percent })
      if (status.phase !== 'available' || !status.version) return
      if (noticedVersion.current === status.version) return
      noticedVersion.current = status.version
      setUpdateNotice({ version: status.version })
      /* Hide the native chat view at once: it paints above the DOM, so the
       * dialog would otherwise be covered the moment the session view shows. */
      window.api.setEmbedVisible(false)
    }
    void window.api.getUpdateStatus().then(notice)
    const off = window.api.onUpdateChanged(notice)
    return off
  }, [])

  const deleteSession = async (item: ManagedSessionSummary): Promise<void> => {
    if (deletingId !== null) return
    setDeletingId(item.id)
    try {
      await window.api.destroyManagedSession(item.id)
      setPendingDelete(null)
    } finally {
      setDeletingId(null)
    }
  }

  const cancelTransfer = async (item: SshTransferTask): Promise<void> => {
    try {
      await window.api.cancelSshTransfer(item.sessionId, item.direction, item.id)
    } catch {
      /* pushed global transfer state remains authoritative */
    }
  }

  const requestNewChat = (projectId: string | null): void => {
    if (creatingRef.current) return
    newSessionTrigger.current = document.activeElement as HTMLElement | null
    setNewSessionProjectId(projectId)
    setNavigationError('')
    window.api.setEmbedVisible(false)
    setNewSessionOpen(true)
  }

  const closeNewSessionDialog = (): void => {
    if (creatingRef.current) return
    setNewSessionOpen(false)
    requestAnimationFrame(() => {
      if (newSessionTrigger.current?.isConnected) newSessionTrigger.current.focus({ preventScroll: true })
      else newSessionButton.current?.focus({ preventScroll: true })
    })
  }

  const createManagedSession = async (kind: 'local' | 'ssh'): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setNavigationError('')
    // For SSH the main process opens the connect dialog for us (createSession passes
    // openSshDialog = kind === 'ssh'), so there is nothing else to do here.
    try {
      if (!await window.api.createManagedSession(kind, newSessionProjectId)) throw new Error('无法创建对话，请重试。')
      setNewSessionOpen(false)
    } catch (cause) {
      setNavigationError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '创建对话失败，请重试。')
    } finally { creatingRef.current = false; setCreating(false) }
  }

  const openWeb2termConnection = async (): Promise<void> => {
    const opened = await window.api.showWeb2termConnection(web2termChatCreation ? { newChat: true, projectId: web2termChatCreation.projectId } : undefined)
    if (!opened) throw new Error('无法打开设备会话，请重新选择设备连接。')
    setWeb2termDeviceDialogOpen(false)
    setWeb2termChatCreation(null)
  }

  const openWeb2termDeviceDialog = (trigger?: HTMLButtonElement | null, creation?: { projectId: string | null }): void => {
    web2termDeviceDialogTrigger.current = trigger ?? newSessionButton.current
    setWeb2termChatCreation(creation ?? null)
    setNewSessionOpen(false)
    setWeb2termDeviceDialogOpen(true)
    // Native embedded pages paint above DOM dialogs; hide them before rendering.
    window.api.setEmbedVisible(false)
  }

  const closeWeb2termDeviceDialog = (): void => {
    const trigger = web2termDeviceDialogTrigger.current
    setWeb2termDeviceDialogOpen(false)
    setWeb2termChatCreation(null)
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus()
      else if (newSessionTrigger.current?.isConnected) newSessionTrigger.current.focus()
      else newSessionButton.current?.focus()
    })
  }

  const activeTransfers = transfers.filter(
    (item) => item.status === 'uploading' || item.status === 'downloading'
  )
  const activeTotal = activeTransfers.reduce((sum, item) => sum + item.total, 0)
  const activeTransferred = activeTransfers.reduce((sum, item) => sum + item.transferred, 0)
  const activePercent = activeTotal > 0
    ? Math.min(100, Math.round((activeTransferred / activeTotal) * 100))
    : 0

  const editProject = (project: WorkspaceProject | null): void => {
    setNavigationError('')
    window.api.setEmbedVisible(false)
    setProjectEditor({ project })
  }

  const moveSession = async (): Promise<void> => {
    if (!movingSession || projectBusy) return
    setProjectBusy(true)
    setNavigationError('')
    try {
      if (!await window.api.moveManagedSession(movingSession.id, moveTarget || null)) throw new Error('对话已关闭。')
      setMovingSession(null)
    } catch (cause) { setNavigationError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '移动对话失败。') }
    finally { setProjectBusy(false) }
  }

  const removeProject = async (): Promise<void> => {
    if (!pendingProjectDelete || projectBusy) return
    setProjectBusy(true)
    setNavigationError('')
    try { await window.api.removeWorkspaceProject(pendingProjectDelete.id); setPendingProjectDelete(null) }
    catch { setNavigationError('移除项目失败，请重试。') }
    finally { setProjectBusy(false) }
  }

  const downloadUpdate = async (): Promise<void> => {
    if (updateDownloading) return
    setUpdateDownloading(true)
    try {
      await window.api.downloadUpdate()
    } finally {
      setUpdateDownloading(false)
    }
  }

  const installUpdate = (): void => {
    void window.api.installUpdate()
  }

  // Sidebar confirmations stay within the navigation and leave the native chat view visible.
  const workspaceModalOpen = transfersOpen || newSessionOpen || web2termDeviceDialogOpen || updateNotice !== null
    || projectEditor !== null || movingSession !== null || releaseNotesOpen
  const newSessionProject = projects.find(project => project.id === newSessionProjectId)

  return (
    <ToolWindowsProvider sessionIds={sessions.map((item) => item.id)}>
    <div className={'workspace workspace--titlebar' + (navCollapsed ? ' workspace--nav-collapsed' : '')} data-theme={theme} style={{ '--nav-width': `${navWidth}px` } as CSSProperties}>
      <header className="workspace__titlebar">
        <div className="workspace__titlebar-content">
          <span className="workspace__window-title"><img src={brandIcon} alt="" aria-hidden="true" />Web2Term</span>
          <ReleaseNotes open={releaseNotesOpen} theme={theme} appVersion={appVersion}
            onOpen={() => { window.api.setEmbedVisible(false); setReleaseNotesOpen(true) }} onClose={() => setReleaseNotesOpen(false)} />
        </div>
      </header>
      <nav ref={navigationRef} className="workspace__nav">
        <div className="workspace__brand">
          <span className="workspace__brand-mark" aria-hidden="true"><img src={brandIcon} alt="" /></span>
          <span className="workspace__brand-text workspace__brand-wordmark"><Web2termWordmark /></span>
          <button
            type="button"
            className="workspace__nav-collapse"
            title={navCollapsed ? '展开左侧栏' : '折叠左侧栏'}
            aria-label={navCollapsed ? '展开左侧栏' : '折叠左侧栏'}
            onClick={() => setNavCollapsed((value) => !value)}
          >
            {navCollapsed ? '»' : '«'}
          </button>
        </div>
        <WorkspaceNavigation sessions={sessions} projects={projects} activeId={workspace.sessionId} theme={theme} creating={creating}
          newChatButton={newSessionButton} status={navigationError}
          onNewChat={requestNewChat} onNewProject={() => editProject(null)} onEditProject={editProject}
          onRemoveProject={(project, anchor) => { removeProjectTrigger.current = anchor; setNavigationError(''); setPendingProjectDelete(project) }}
          onMoveSession={item => { setNavigationError(''); window.api.setEmbedVisible(false); setMoveTarget(item.projectId ?? ''); setMovingSession(item) }}
          onDeleteSession={(item, anchor) => { deleteSessionTrigger.current = anchor; setPendingDelete(item) }} />
        <div
          className="workspace__nav-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          onPointerDown={startNavResize}
        />
      </nav>

      <section className="workspace__content">
        {workspace.sessionId ? (
          <App
            key={workspace.sessionId}
            sessionId={workspace.sessionId}
            sessionKind={sessions.find(item => item.id === workspace.sessionId)?.kind}
            theme={theme}
            onThemeChange={setTheme}
            onOpenWeb2termConnection={openWeb2termDeviceDialog}
            initialSshDialogOpen={workspace.openSshDialog}
            globalModalOpen={workspaceModalOpen}
            /*
             * Read from the session list rather than held as its own state: the main process
             * republishes the list whenever a session changes, including on a platform switch,
             * so this stays right without a second copy to keep in sync.
             */
            platformId={
              sessions.find((item) => item.id === workspace.sessionId)?.platformId ?? ''
            }
          />
        ) : <div className="workspace-empty-state" role="region" aria-label="空白工作区">
          <img className="workspace-empty-state__mark" src={brandIcon} alt="" aria-hidden="true" />
          <h1>暂无对话</h1>
          <p>新建聊天，或在项目中开始一个对话。</p>
          <div className="workspace-empty-state__actions">
            <button type="button" disabled={creating} onClick={() => requestNewChat(null)}>新建聊天</button>
            <button type="button" onClick={() => editProject(null)}>新建项目</button>
          </div>
        </div>}
      </section>

      <footer className="workspace__transferbar">
        <button
          type="button"
          className="workspace__transfer-button"
          onClick={() => setTransfersOpen(true)}
          title="查看所有会话的上传和下载任务"
        >
          <span className={activeTransfers.length > 0 ? 'dot dot--busy' : 'dot'} />
          <span className="workspace__transfer-title">传输任务</span>
          <span className="workspace__transfer-summary">
            {activeTransfers.length > 0
              ? `${activeTransfers.length} 个进行中${activeTotal > 0 ? ` · ${activePercent}%` : ''}`
              : transfers.length > 0
                ? `${transfers.length} 个任务`
                : '暂无任务'}
          </span>
        </button>
        {appVersion ? <span className="workspace__version" title="应用版本号">v{appVersion}</span> : null}
      </footer>

      {transfersOpen ? (
        <AppPopover
          className="modal transfer-modal"
          aria-label="传输任务"
         onClose={() => setTransfersOpen(false)}>
          <div className="transfer-modal__box">
            <div className="transfer-modal__head">
              <div className="transfer-modal__title">传输任务</div>
              {activeTransfers.length > 0 ? (
                <span className="transfer-modal__active-count">{activeTransfers.length} 个进行中</span>
              ) : null}
              <span className="panel__spacer" />
              <button type="button" className="transfer-modal__close" aria-label="关闭" onClick={() => setTransfersOpen(false)}>×</button>
            </div>

            <div className="transfer-modal__body">
              {transfers.length === 0 ? (
                <div className="transfer-modal__empty">
                  <div className="transfer-modal__empty-icon">⇅</div>
                  <strong>暂无传输任务</strong>
                  <span>上传和下载任务会显示在这里</span>
                </div>
              ) : (
                <div className="transfer-list">
                  {transfers.map((item) => {
                    const percent = item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0
                    const active = item.status === 'uploading' || item.status === 'downloading'
                    const session = sessions.find((candidate) => candidate.id === item.sessionId)
                    const sessionLabel = session?.title || session?.target || item.sessionId.slice(0, 8)
                    const elapsedSeconds = Math.max(0, (Date.now() - item.startedAt) / 1000)
                    const speed = elapsedSeconds > 0 ? item.transferred / elapsedSeconds : 0
                    const remainingSeconds = active && item.total > item.transferred && speed > 0 ? (item.total - item.transferred) / speed : 0
                    const statusLabel = active ? (item.direction === 'upload' ? '正在上传' : '正在下载') : transferStatus(item, percent)
                    return (
                      <div className={`transfer-card transfer-card--${item.status}`} key={`${item.sessionId}:${item.direction}:${item.id}`} title={item.error || (item.direction === 'upload' ? item.remotePath : item.localPath)}>
                        <div className={`transfer-card__icon transfer-card__icon--${item.direction}`}>{item.direction === 'upload' ? '↑' : '↓'}</div>
                        <div className="transfer-card__content">
                          <div className="transfer-card__top">
                            <span className={`transfer-card__direction transfer-card__direction--${item.direction}`}>{item.direction === 'upload' ? '上传' : '下载'}</span>
                            <span className="transfer-card__name">{item.name}</span>
                            {item.total > 0 ? <strong className="transfer-card__percent">{percent}%</strong> : null}
                            {active ? <button type="button" className="transfer-card__cancel" onClick={() => void cancelTransfer(item)}>取消</button> : null}
                          </div>
                          <div className="transfer-card__session">{sessionLabel}</div>
                          <div className="transfer-card__progress" aria-label={`${item.name} ${statusLabel} ${percent}%`}>
                            <span style={{ width: `${item.total > 0 ? percent : active ? 12 : 100}%` }} />
                          </div>
                          <div className="transfer-card__meta">
                            <span>{item.direction === 'upload' ? '已上传' : '已下载'} {formatBytes(item.transferred)}{item.total > 0 ? ` / ${formatBytes(item.total)}` : ''}</span>
                            {active && speed > 0 ? <><i /><span>{formatBytes(speed)}/s</span></> : null}
                            {active && remainingSeconds > 0 ? <><i /><span>预计还需 {formatTransferDuration(remainingSeconds)}</span></> : null}
                            <span className={`transfer-card__status transfer-card__status--${item.status}`}><b />{statusLabel}</span>
                          </div>
                          {item.error ? <div className="transfer-card__error">{item.error}</div> : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </AppPopover>
      ) : null}

      {projectEditor ? <WorkspaceProjectDialog project={projectEditor.project} onClose={() => setProjectEditor(null)}
        onSaved={project => {
          setProjects(current => current.some(item => item.id === project.id) ? current.map(item => item.id === project.id ? project : item) : [...current, project])
          setProjectEditor(null)
        }} /> : null}
      {movingSession ? <AppPopover className="modal workspace-project-dialog" aria-labelledby="workspace-move-heading" onClose={() => setMovingSession(null)} busy={projectBusy}>
        <form className="workspace-project-dialog__box" onSubmit={event => { event.preventDefault(); void moveSession() }}>
          <div className="workspace-project-dialog__heading"><h2 id="workspace-move-heading">移动对话</h2>
            <button type="button" disabled={projectBusy} aria-label="关闭" onClick={() => setMovingSession(null)}>×</button></div>
          <label>归属项目<select autoFocus value={moveTarget} disabled={projectBusy} onChange={event => setMoveTarget(event.target.value)}>
            <option value="">本电脑（无项目）</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          {navigationError ? <p className="workspace-project-dialog__error" role="alert">{navigationError}</p> : null}
          <div className="workspace-project-dialog__footer"><button type="button" disabled={projectBusy} onClick={() => setMovingSession(null)}>取消</button>
            <button type="submit" className="is-primary" disabled={projectBusy}>{projectBusy ? '移动中…' : '移动'}</button></div>
        </form>
      </AppPopover> : null}
      <ConfirmDialog open={pendingProjectDelete !== null} title={`移除项目“${pendingProjectDelete?.name ?? ''}”？`}
        anchor={removeProjectTrigger.current} containerRef={navigationRef}
        description={navigationError || '项目中的对话会保留，并移到“本电脑”列表。'} icon="!" busy={projectBusy} confirmLabel="移除项目"
        onCancel={() => setPendingProjectDelete(null)} onConfirm={() => void removeProject()} />

      {newSessionOpen ? (
        <NewSessionPopover project={newSessionProject} anchor={newSessionTrigger.current} busy={creating} error={navigationError}
          onClose={closeNewSessionDialog} onCreate={kind => void createManagedSession(kind)}
          onWeb2term={trigger => openWeb2termDeviceDialog(trigger, { projectId: newSessionProjectId })} />
      ) : null}
      {web2termDeviceDialogOpen ? <Web2termDeviceDialog onClose={closeWeb2termDeviceDialog} onConnected={openWeb2termConnection} /> : null}
      <span ref={updateNoticeAnchor} className="workspace__update-anchor" aria-hidden="true" />
      <ConfirmDialog
        open={updateNotice !== null}
        anchor={updateNoticeAnchor.current}
        title={updateLive.phase === 'downloaded' ? `新版本 v${updateNotice?.version ?? ''} 已下载` : `发现新版本 v${updateNotice?.version ?? ''}`}
        description={updateLive.phase === 'downloading' ? `正在下载更新… ${updateLive.percent}%` : updateLive.phase === 'downloaded' ? '下载完成，点击“重启并安装”即可升级，不会丢失当前会话。' : '新版本已可下载。下载完成后重启即可安装，不会打断当前任务。'}
        icon="⬆"
        confirmLabel={updateLive.phase === 'downloaded' ? '重启并安装' : updateLive.phase === 'downloading' ? '下载中…' : '下载更新'}
        cancelLabel="稍后"
        busy={updateDownloading || updateLive.phase === 'downloading'}
        dismissOnBackdrop={false}
        dismissOnEscape={false}
        onConfirm={() => { if (updateLive.phase === 'downloaded') installUpdate(); else void downloadUpdate() }}
        onCancel={() => setUpdateNotice(null)}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        anchor={deleteSessionTrigger.current}
        containerRef={navigationRef}
        title={`删除“${pendingDelete?.title || '对话'}”？`}
        description="将结束终端和 SSH 连接，网页对话保留。"
        danger
        busy={deletingId !== null}
        confirmLabel="删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) void deleteSession(pendingDelete) }}
      />
      <ToolWindowsHost sessionId={workspace.sessionId} theme={theme} blocked={workspaceModalOpen} />
    </div>
    </ToolWindowsProvider>
  )
}
