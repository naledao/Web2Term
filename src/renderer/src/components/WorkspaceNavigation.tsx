import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactElement, ReactNode, RefObject } from 'react'
import { Menu } from '@base-ui/react/menu'
import type { ManagedSessionSummary, WorkspaceProject } from '@shared/types'
import { platformById } from '@shared/platforms'
import './WorkspaceNavigation.css'

function Icon({ kind }: { kind: 'folder' | 'open' | 'plus' | 'more' }): ReactElement {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'folder' || kind === 'open' ? <><path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2" />{kind === 'open' ? <path d="M3 9h17a1 1 0 0 1 1 1.3l-2 8a2 2 0 0 1-2 1.7H5a2 2 0 0 1-2-2z" /> : <path d="M3 8h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}</> : null}
    {kind === 'plus' ? <path d="M12 5v14M5 12h14" /> : null}
    {kind === 'more' ? <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></> : null}
  </svg>
}

function Actions({ label, theme, children }: { label: string; theme: string; children: ReactNode }): ReactElement {
  const actionSelected = useRef(false)
  return <Menu.Root modal={false} onOpenChange={open => { if (open) actionSelected.current = false }}>
    <Menu.Trigger className="workspace-navigation__icon workspace-navigation__more" aria-label={label} title={label}><Icon kind="more" /></Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner side="bottom" align="end" positionMethod="fixed" sideOffset={4} collisionPadding={6} className="workspace-navigation-menu-positioner">
        <Menu.Popup className="workspace-navigation-menu" data-theme={theme} onClickCapture={() => { actionSelected.current = true }}
          finalFocus={() => !actionSelected.current}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
}

export default function WorkspaceNavigation({ sessions, projects, activeId, theme, creating, newChatButton, status, onNewChat, onNewProject, onEditProject, onRemoveProject, onMoveSession, onDeleteSession }: {
  sessions: ManagedSessionSummary[]
  projects: WorkspaceProject[]
  activeId: string | null
  theme: string
  creating: boolean
  newChatButton: RefObject<HTMLButtonElement | null>
  status: string
  onNewChat(projectId: string | null): void
  onNewProject(): void
  onEditProject(project: WorkspaceProject): void
  onRemoveProject(project: WorkspaceProject): void
  onMoveSession(session: ManagedSessionSummary): void
  onDeleteSession(session: ManagedSessionSummary): void
}): ReactElement {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('layout.workspaceProjectsCollapsed') || '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const saving = useRef(false)
  const activeProject = sessions.find(item => item.id === activeId)?.projectId
  useEffect(() => {
    if (activeProject) setCollapsed(current => current[activeProject] ? { ...current, [activeProject]: false } : current)
  }, [activeId, activeProject])
  useEffect(() => {
    try { localStorage.setItem('layout.workspaceProjectsCollapsed', JSON.stringify(collapsed)) } catch { /* Optional layout preference. */ }
  }, [collapsed])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError('')
    try { await action() } catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '操作失败，请重试。')
    }
  }
  const rename = (item: ManagedSessionSummary): void => {
    saving.current = false
    setDraft(item.title)
    setRenaming(item.id)
  }
  const saveRename = async (id: string): Promise<void> => {
    if (saving.current) return
    saving.current = true
    setRenaming(null)
    await run(async () => {
      if (!draft.trim()) throw new Error('对话名称不能为空。')
      if (!await window.api.renameManagedSession(id, draft)) throw new Error('对话已关闭。')
    })
  }
  const row = (item: ManagedSessionSummary): ReactElement => <div key={item.id}
    className={'workspace-navigation__chat' + (item.id === activeId ? ' is-active' : '')}
    draggable={renaming !== item.id}
    onDragStart={event => { event.dataTransfer.setData('application/x-workspace-session', item.id); event.dataTransfer.effectAllowed = 'move' }}>
    {renaming === item.id ? <input className="workspace-navigation__rename" autoFocus value={draft} aria-label="对话名称" maxLength={120}
      onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} onBlur={() => void saveRename(item.id)}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void saveRename(item.id) }
        if (event.key === 'Escape') { saving.current = true; setRenaming(null) }
      }} /> : <>
      <button type="button" className="workspace-navigation__chat-link" aria-current={item.id === activeId ? 'page' : undefined}
        title={`${item.title}\n${platformById(item.platformId)?.label ?? item.platformId} · ${item.target}${item.taskRunning ? ' · 执行中' : ''}`}
        onClick={() => void run(async () => { if (!await window.api.openManagedSession(item.id)) throw new Error('对话已关闭，请重新选择。') })}
        onDoubleClick={() => rename(item)}>
        <span className="workspace-navigation__title">{item.title || '本地'}</span>
        {item.taskRunning ? <span className="workspace-navigation__running" role="img" aria-label="执行中" title="执行中" /> : null}
        {item.unseenCompletedCount ? <span className="workspace-navigation__unseen" aria-label={`${item.unseenCompletedCount} 个任务已完成`}>{item.unseenCompletedCount}</span> : null}
      </button>
      <Actions label={`${item.title}的操作`} theme={theme}>
        <Menu.Item onClick={() => rename(item)}>重命名</Menu.Item>
        <Menu.Item onClick={() => onMoveSession(item)}>移动到项目…</Menu.Item>
        <Menu.Item className="is-danger" onClick={() => onDeleteSession(item)}>删除对话…</Menu.Item>
      </Actions>
    </>}
  </div>
  const drop = (event: DragEvent, projectId: string | null): void => {
    event.preventDefault()
    const id = event.dataTransfer.getData('application/x-workspace-session')
    if (!sessions.some(item => item.id === id)) return
    if (projectId) setCollapsed(current => ({ ...current, [projectId]: false }))
    void run(async () => { if (!await window.api.moveManagedSession(id, projectId)) throw new Error('移动失败，对话可能已关闭。') })
  }
  const dragOver = (event: DragEvent): void => {
    if (event.dataTransfer.types.includes('application/x-workspace-session')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }
  }
  const ungrouped = sessions.filter(item => !item.projectId || !projects.some(project => project.id === item.projectId))
  return <div className="workspace-navigation">
    <div className="workspace-navigation__list">
      <div className="workspace-navigation__section-head">
        <h2>项目</h2>
        <button type="button" className="workspace-navigation__icon" aria-label="新建项目" title="新建项目"
          onClick={onNewProject}><Icon kind="plus" /></button>
      </div>
      {projects.map(project => <section className="workspace-navigation__project" key={project.id} onDragOver={dragOver} onDrop={event => drop(event, project.id)}>
        <div className="workspace-navigation__project-head">
          <button type="button" className="workspace-navigation__folder" title={project.directory ? `${project.name}\n${project.directory}` : `${project.name}\n默认目录`}
            aria-expanded={!collapsed[project.id]} aria-controls={`workspace-project-${project.id}`}
            onClick={() => setCollapsed(current => ({ ...current, [project.id]: !current[project.id] }))}>
            <Icon kind={collapsed[project.id] ? 'folder' : 'open'} /><span className="workspace-navigation__title">{project.name}</span>
          </button>
          <button type="button" className="workspace-navigation__icon workspace-navigation__add" disabled={creating} aria-label={`在${project.name}中新建对话`} title="新建对话"
            onClick={() => { setCollapsed(current => ({ ...current, [project.id]: false })); onNewChat(project.id) }}><Icon kind="plus" /></button>
          <Actions label={`${project.name}的项目操作`} theme={theme}>
            <Menu.Item disabled={creating} onClick={() => onNewChat(project.id)}>新建对话</Menu.Item>
            <Menu.Item onClick={() => onEditProject(project)}>编辑项目…</Menu.Item>
            <Menu.Item className="is-danger" onClick={() => onRemoveProject(project)}>移除项目…</Menu.Item>
          </Actions>
        </div>
        <div id={`workspace-project-${project.id}`} className="workspace-navigation__children" hidden={!!collapsed[project.id]}>
          {sessions.filter(item => item.projectId === project.id).map(row)}
        </div>
      </section>)}
      <section className="workspace-navigation__ungrouped" aria-labelledby="workspace-local-chats-heading" onDragOver={dragOver} onDrop={event => drop(event, null)}>
        <div className="workspace-navigation__section-head">
          <h2 id="workspace-local-chats-heading">本电脑</h2>
          <button type="button" ref={newChatButton} className="workspace-navigation__icon" disabled={creating} aria-label="在本电脑中新建聊天" title="新建聊天"
            onClick={() => onNewChat(null)}><Icon kind="plus" /></button>
        </div>
        {ungrouped.map(row)}
      </section>
    </div>
    {error || status ? <p className="workspace-navigation__error" role="alert">{error || status}</p> : null}
  </div>
}
