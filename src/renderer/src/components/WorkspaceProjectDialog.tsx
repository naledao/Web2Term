import AppPopover from './AppPopover'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { WorkspaceProject } from '@shared/types'
import './WorkspaceProjectDialog.css'

export default function WorkspaceProjectDialog({ project, onClose, onSaved }: {
  project: WorkspaceProject | null; onClose(): void; onSaved(project: WorkspaceProject): void
}): ReactElement {
  const [name, setName] = useState(project?.name ?? '')
  const [directory, setDirectory] = useState(project?.directory ?? '')
  const [saving, setSaving] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const choose = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setChoosing(true)
    setError('')
    try { const selected = await window.api.selectDirectory(); if (mounted.current && selected !== null) setDirectory(selected) }
    catch { if (mounted.current) setError('无法打开目录选择窗口，请重试。') }
    finally { busy.current = false; if (mounted.current) setChoosing(false) }
  }
  const save = async (): Promise<void> => {
    if (busy.current || !name.trim()) return
    busy.current = true
    setSaving(true)
    setError('')
    try {
      const next = await window.api.saveWorkspaceProject({ id: project?.id, name, directory })
      if (mounted.current) onSaved(next)
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : '保存项目失败，请重试。') }
    finally { busy.current = false; if (mounted.current) setSaving(false) }
  }
  return <AppPopover className="modal workspace-project-dialog" aria-labelledby="workspace-project-heading" onClose={onClose} busy={saving || choosing}>
    <form className="workspace-project-dialog__box" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="workspace-project-dialog__heading"><h2 id="workspace-project-heading">{project ? '编辑项目' : '新建项目'}</h2>
        <button type="button" aria-label="关闭" disabled={saving || choosing} onClick={onClose}>×</button></div>
      <label>项目名称<input autoFocus required maxLength={120} value={name} disabled={saving || choosing} placeholder="例如：设备管理"
        onChange={event => setName(event.target.value)} /></label>
      <label htmlFor="workspace-project-directory">本机目录 <span className="workspace-project-dialog__optional">可选</span></label>
      <div className="workspace-project-dialog__directory"><input id="workspace-project-directory" readOnly value={directory} placeholder="默认目录" title={directory || '使用默认目录'} />
        <button type="button" disabled={saving || choosing} onClick={() => void choose()}>{choosing ? '选择中…' : '选择目录'}</button>
        {directory ? <button type="button" disabled={saving || choosing} aria-label="恢复默认目录" title="恢复默认目录" onClick={() => setDirectory('')}>×</button> : null}</div>
      <p className="workspace-project-dialog__hint">项目中新建的本机会话将使用此目录，留空则使用默认目录。</p>
      {error ? <p className="workspace-project-dialog__error" role="alert">{error}</p> : null}
      <div className="workspace-project-dialog__footer"><button type="button" disabled={saving || choosing} onClick={onClose}>取消</button>
        <button type="submit" className="is-primary" disabled={!name.trim() || saving || choosing}>{saving ? '保存中…' : project ? '保存' : '创建项目'}</button></div>
    </form>
  </AppPopover>
}
