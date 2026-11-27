import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExtraTerminal } from '@shared/types'
import { terminalCommandHistory } from '../terminal-command-history'
import SshTerminalLocation from './SshTerminalLocation'
import TerminalActionsMenu from './TerminalActionsMenu'
import type { TerminalActionId } from './TerminalActionsMenu'
import TerminalCommandInput from './TerminalCommandInput'
import TerminalTranscript from './TerminalTranscript'

export default function ExtraSshTerminalPane({ sessionId, terminal, visible, actionsVisible, directoryAvailable, target, onClose }: {
  sessionId: string
  terminal: ExtraTerminal
  visible: boolean
  actionsVisible: boolean
  directoryAvailable: boolean
  target?: string
  onClose: () => void
}) {
  const { id, alive, cwd, label, lines, message, opening, title } = terminal
  const pane = useRef<HTMLElement>(null)
  const [cwdEditing, setCwdEditing] = useState(false)
  const [actionError, setActionError] = useState('')
  const history = useMemo(() => terminalCommandHistory(sessionId, `extra:${id}`), [sessionId, id])
  const canPickDirectory = alive && directoryAvailable

  useEffect(() => {
    if (!actionsVisible || !canPickDirectory) setCwdEditing(false)
  }, [actionsVisible, canPickDirectory])

  function handleAction(action: TerminalActionId): void {
    setActionError('')
    switch (action) {
      case 'interrupt':
        void window.api.interruptExtraTerminal(id).catch(() => setActionError('中断终端失败，请重试。'))
        break
      case 'reconnect':
      case 'reset':
        setCwdEditing(false)
        void window.api.openExtraTerminalPty(id, action).catch(() => setActionError('无法重新连接终端，请重试。'))
        break
      case 'close': onClose(); break
      case 'directory': setCwdEditing(true); break
    }
  }

  return (
    <section ref={pane} className="terminal-pane panel__view" aria-label={title} hidden={!visible}>
      <div className="terminal-pane__meta">
        <div className="terminal-pane__location">
          <SshTerminalLocation
            name={label}
            target={target}
            cwd={cwd}
            message={message}
            connected={alive}
            canEdit={canPickDirectory}
            editing={cwdEditing}
            onEdit={setCwdEditing}
            onPick={(path) => {
              setActionError('')
              void window.api.setExtraTerminalCwd(id, path).catch(() => setActionError('无法更改终端目录，请重试。'))
            }}
          />
        </div>
        <TerminalActionsMenu
          containerRef={pane}
          visible={actionsVisible}
          mode="ssh"
          tabScoped
          connected={alive}
          directoryDisabled={!canPickDirectory}
          reconnecting={Boolean(opening)}
          resetDisabled={Boolean(opening)}
          closeDisabled={false}
          closing={false}
          uploading={false}
          onAction={handleAction}
        />
      </div>
      {actionError ? <p className="terminal-actions__error" role="alert">{actionError}</p> : null}
      <TerminalTranscript lines={lines} visible={visible} posix emptyMessage={message || '正在连接…'} />
      <TerminalCommandInput
        history={history}
        historyLines={lines}
        remote
        posix
        label="SSH 命令"
        placeholder={alive ? '输入或粘贴命令，回车发送，Shift+回车换行' : '尚未连接'}
        disabled={!alive}
        onSubmit={(text) => void window.api.sendExtraTerminalInput(id, text).catch(() => setActionError('发送命令失败，请重试。'))}
        onInterrupt={() => handleAction('interrupt')}
      />
    </section>
  )
}
