import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { ExtraTerminal, TerminalLine } from '@shared/types'
import { canNavigateCommandHistory, navigateCommandHistory, terminalCommandHistory } from '../terminal-command-history'
import type { CommandHistoryCursor } from '../terminal-command-history'
import OutputText from './OutputText'

interface Block {
  command: TerminalLine | null
  lines: TerminalLine[]
}

function formatCommand(text: string, posix: boolean): string {
  if (!posix) return `> ${text}`
  return /(?:^|\s)[$#]\s+\S/.test(text) ? text : `$ ${text}`
}

/**
 * One terminal opened from the panel's + menu.
 *
 * The same transcript and input as the model's terminal pane, minus everything
 * that belongs to the model: no executions, no SSH, no hand-back.
 */
export default function ExtraTerminalPane({ sessionId, terminal, visible }: {
  sessionId: string
  terminal: ExtraTerminal
  visible: boolean
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [cwdDraft, setCwdDraft] = useState<string | null>(null)
  const outputRef = useRef<HTMLDivElement>(null)
  const historyCursor = useRef<CommandHistoryCursor | null>(null)
  const history = useMemo(() => terminalCommandHistory(sessionId, `extra:${terminal.id}`), [sessionId, terminal.id])
  const remote = terminal.transport !== 'local'
  const posix = remote || terminal.shellKind === 'posix'
  // A web2term PTY has to be up before it can take input; SSH reopens on the next command.
  const inputDisabled = terminal.transport === 'web2term' && !terminal.alive

  const blocks = useMemo<Block[]>(() => {
    const result: Block[] = []
    for (const line of terminal.lines) {
      if (line.kind === 'command' || result.length === 0) {
        result.push(line.kind === 'command' ? { command: line, lines: [] } : { command: null, lines: [line] })
      } else {
        result[result.length - 1].lines.push(line)
      }
    }
    return result
  }, [terminal.lines])

  useEffect(() => {
    const element = outputRef.current
    if (element && visible) element.scrollTop = element.scrollHeight
  }, [terminal.lines, visible])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = draft
    history.remember(text)
    historyCursor.current = null
    setDraft('')
    void window.api.sendExtraTerminalInput(terminal.id, text).catch(() => { /* ignore */ })
  }

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

    <div className="terminal-pane__output" ref={outputRef}>
      {blocks.length === 0 ? (
        <p className="terminal-pane__empty">{terminal.message || '还没有输出。在下面输入命令；这个终端只给你自己用，模型不会在这里执行。'}</p>
      ) : blocks.map((block, blockIndex) => (
        <div key={`${blockIndex}-${block.command?.text ?? 'system'}`}
          className={block.command ? 'terminal-entry' : 'terminal-entry terminal-entry--system'}>
          {block.command ? <pre className="line line--command">{formatCommand(block.command.text, posix)}</pre> : null}
          {block.lines.length > 0 ? (
            <div className="terminal-entry__body">
              {block.lines.map((line, lineIndex) => (
                line.kind === 'output' ? <OutputText key={`${blockIndex}-${lineIndex}-${line.kind}`} className="line line--output" text={line.text} /> :
                  <pre key={`${blockIndex}-${lineIndex}-${line.kind}`} className={`line line--${line.kind}`}>{line.text}</pre>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>

    <form className={remote ? 'terminal-pane__input terminal-pane__input--ssh' : 'terminal-pane__input'} onSubmit={submit}>
      <span className={remote ? 'terminal-pane__prompt terminal-pane__prompt--ssh' : 'terminal-pane__prompt'} aria-hidden="true">
        {posix ? '$' : <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>}
      </span>
      <textarea
        className="address__input terminal-pane__command-input"
        value={draft}
        rows={Math.min(8, draft.split('\n').length)}
        spellCheck={false}
        placeholder={inputDisabled ? terminal.message || '正在连接设备…' : '输入或粘贴命令，回车执行，Shift+回车换行'}
        aria-label={`${terminal.title} 命令`}
        disabled={inputDisabled}
        title="↑/↓ 选择历史命令；多行输入时在第一行/最后一行切换历史"
        onChange={(event) => {
          historyCursor.current = null
          setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            const direction = event.key === 'ArrowUp' ? 'up' : 'down'
            const editor = event.currentTarget
            if (canNavigateCommandHistory(editor.value, editor.selectionStart, editor.selectionEnd, direction)) {
              const recalled = navigateCommandHistory(historyCursor.current, history.snapshot(), editor.value, direction)
              if (recalled) {
                event.preventDefault()
                historyCursor.current = recalled.cursor
                setDraft(recalled.value)
                requestAnimationFrame(() => {
                  if (editor.isConnected && editor.value === recalled.value) editor.setSelectionRange(recalled.value.length, recalled.value.length)
                })
                return
              }
            }
          }
          if (event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c'
            && event.currentTarget.selectionStart === event.currentTarget.selectionEnd) {
            event.preventDefault()
            void window.api.interruptExtraTerminal(terminal.id)
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
    </form>
  </section>
}
