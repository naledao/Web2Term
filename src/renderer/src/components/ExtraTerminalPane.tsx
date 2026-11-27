import { useMemo, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { ExtraTerminal } from '@shared/types'
import { terminalCommandHistory } from '../terminal-command-history'
import TerminalCommandInput from './TerminalCommandInput'
import TerminalTranscript from './TerminalTranscript'

/**
 * Command transcript for a local or web2term device terminal opened from the panel's + menu.
 */
export default function ExtraTerminalPane({ sessionId, terminal, visible }: {
  sessionId: string
  terminal: ExtraTerminal
  visible: boolean
}): JSX.Element {
  const [cwdDraft, setCwdDraft] = useState<string | null>(null)
  const history = useMemo(() => terminalCommandHistory(sessionId, `extra:${terminal.id}`), [sessionId, terminal.id])
  const remote = terminal.transport !== 'local'
  const posix = remote || terminal.shellKind === 'posix'
  // A web2term device PTY has to be up before it can take input.
  const inputDisabled = terminal.transport === 'web2term' && !terminal.alive

  const submitCwd = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const target = (cwdDraft ?? '').trim()
    // Closed before sending: the input's blur handler must not race with it.
    setCwdDraft(null)
    if (target !== '') void window.api.setExtraTerminalCwd(terminal.id, target).catch(() => { /* ignore */ })
  }

  return <section className="terminal-pane panel__view" hidden={!visible} aria-label={terminal.title}>
    <div className="terminal-pane__meta">
      <div className="terminal-pane__location">
        <span className="terminal-pane__id" title={terminal.message || undefined}>{terminal.label}</span>
        {cwdDraft !== null ? (
          <form className="terminal-pane__cwd-form" onSubmit={submitCwd}>
            <input
              className="terminal-pane__cwd-input"
              value={cwdDraft}
              spellCheck={false}
              autoFocus
              aria-label="终端目录"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setCwdDraft(event.target.value)}
              onBlur={() => setCwdDraft(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCwdDraft(null)
              }}
            />
          </form>
        ) : (
          <span className="terminal-pane__directory terminal-pane__directory--editable"
            title={[terminal.cwd, '双击编辑目录'].filter(Boolean).join('\n')}
            onDoubleClick={() => setCwdDraft(terminal.cwd)}>
            {terminal.cwd || '等待确定工作目录…'}
          </span>
        )}
      </div>
      {/* The picker browses this PC, so it only makes sense for a local terminal. */}
      {remote ? null : <button type="button" className="panel__sync" title="打开文件夹选择框，切换这个终端的目录"
        onClick={() => {
          void window.api.selectDirectory().then((path) => {
            // Cancelling the picker leaves the directory untouched.
            if (path) return window.api.setExtraTerminalCwd(terminal.id, path)
          }).catch(() => { /* ignore */ })
        }}>选择目录</button>}
      <button type="button" className="panel__sync" title="中断当前命令（Ctrl+C）"
        onClick={() => void window.api.interruptExtraTerminal(terminal.id)}>中断</button>
    </div>

    <TerminalTranscript
      lines={terminal.lines}
      visible={visible}
      posix={posix}
      emptyMessage={terminal.message || '还没有输出。在下面输入命令；这个终端只给你自己用，模型不会在这里执行。'}
    />

    <TerminalCommandInput
      history={history}
      historyLines={terminal.lines}
      remote={remote}
      posix={posix}
      label={terminal.title + ' 命令'}
      placeholder={inputDisabled ? terminal.message || '正在连接设备…' : '输入或粘贴命令，回车执行，Shift+回车换行'}
      disabled={inputDisabled}
      onSubmit={(text) => void window.api.sendExtraTerminalInput(terminal.id, text).catch(() => { /* ignore */ })}
      onInterrupt={() => void window.api.interruptExtraTerminal(terminal.id)}
    />
  </section>
}
