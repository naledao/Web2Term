import { useId, useRef } from 'react'
import type { ReactElement } from 'react'
import { Popover } from '@base-ui/react/popover'
import type { WorkspaceProject } from '@shared/types'
import AppPopover from './AppPopover'
import './NewSessionPopover.css'

interface Props {
  project?: Pick<WorkspaceProject, 'directory'>
  anchor: HTMLElement | null
  busy: boolean
  error: string
  onClose(): void
  onCreate(kind: 'local' | 'ssh'): void
  onWeb2term(trigger: HTMLButtonElement): void
}

function TerminalIcon({ kind }: { kind: 'local' | 'ssh' | 'web2term' }): ReactElement {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'local' ? <><rect x="5" y="4" width="14" height="11" rx="1.5" /><path d="M3.5 18h17" /></> : null}
    {kind === 'ssh' ? <><rect x="5" y="4" width="14" height="6" rx="1.5" /><rect x="5" y="14" width="14" height="6" rx="1.5" /><path d="M9 7h.01M9 17h.01M12 7h3M12 17h3" /></> : null}
    {kind === 'web2term' ? <><rect x="4" y="3" width="16" height="6" rx="1.5" /><path d="M12 9v5M6 14h12M6 14v3M18 14v3" /><rect x="3" y="17" width="6" height="4" rx="1" /><rect x="15" y="17" width="6" height="4" rx="1" /></> : null}
  </svg>
}

function NextIcon(): ReactElement {
  return <svg className="new-chat-picker__next" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
}

export default function NewSessionPopover({ project, anchor, busy, error, onClose, onCreate, onWeb2term }: Props): ReactElement {
  const headingId = useId()
  const localButton = useRef<HTMLButtonElement>(null)
  return <AppPopover className="new-chat-picker" anchor={anchor} aria-labelledby={headingId}
    initialFocus={localButton} onClose={onClose} busy={busy}>
    <div className="new-chat-picker__body" aria-busy={busy}>
      <div className="new-chat-picker__header">
        <Popover.Title id={headingId} className="new-chat-picker__title">新建对话</Popover.Title>
        <button type="button" className="new-chat-picker__close" disabled={busy} aria-label="关闭" onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <div className="new-chat-picker__options">
        <button type="button" ref={localButton} disabled={busy} className="new-chat-picker__option" title={project?.directory || '使用默认目录'} onClick={() => onCreate('local')}>
          <TerminalIcon kind="local" />
          <span className="new-chat-picker__label"><strong>本地终端</strong><small>{project?.directory ? '使用项目目录' : '使用默认目录'}</small></span>
        </button>
        <button type="button" disabled={busy} className="new-chat-picker__option" onClick={() => onCreate('ssh')}>
          <TerminalIcon kind="ssh" />
          <span className="new-chat-picker__label"><strong>SSH 连接</strong><small>连接远程主机</small></span>
          <NextIcon />
        </button>
        <button type="button" disabled={busy} className="new-chat-picker__option" onClick={event => onWeb2term(event.currentTarget)}>
          <TerminalIcon kind="web2term" />
          <span className="new-chat-picker__label"><strong>web2term</strong><small>选择账号下的设备</small></span>
          <NextIcon />
        </button>
      </div>
      {busy ? <p className="new-chat-picker__status" role="status">正在创建对话…</p> : null}
      {error ? <p className="new-chat-picker__error" role="alert">{error}</p> : null}
    </div>
  </AppPopover>
}
