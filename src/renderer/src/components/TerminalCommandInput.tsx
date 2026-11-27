import { useEffect, useRef, useState } from 'react'
import type { TerminalLine } from '@shared/types'
import { canNavigateCommandHistory, navigateCommandHistory } from '../terminal-command-history'
import type { CommandHistoryCursor, TerminalCommandHistory } from '../terminal-command-history'

interface TerminalCommandInputProps {
  history: TerminalCommandHistory
  historyLines?: readonly TerminalLine[]
  posix: boolean
  remote: boolean
  disabled?: boolean
  label: string
  placeholder: string
  onSubmit: (text: string) => void
  onInterrupt: () => void
}

const NO_LINES: readonly TerminalLine[] = []

export default function TerminalCommandInput({
  history, historyLines = NO_LINES, posix, remote, disabled, label, placeholder, onSubmit, onInterrupt
}: TerminalCommandInputProps) {
  const [draft, setDraft] = useState('')
  const cursor = useRef<CommandHistoryCursor | null>(null)

  useEffect(() => {
    if (cursor.current) setDraft(cursor.current.draft)
    cursor.current = null
  }, [history])
  useEffect(() => { history.observe(historyLines) }, [history, historyLines])

  return (
    <form
      className={remote ? 'terminal-pane__input terminal-pane__input--ssh' : 'terminal-pane__input'}
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled) return
        history.observe(historyLines)
        history.remember(draft)
        cursor.current = null
        setDraft('')
        onSubmit(draft)
      }}
    >
      <span className={remote ? 'terminal-pane__prompt terminal-pane__prompt--ssh' : 'terminal-pane__prompt'} aria-hidden="true">
        {posix ? '$' : <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>}
      </span>
      <textarea
        className="address__input terminal-pane__command-input"
        value={draft}
        rows={Math.min(8, draft.split('\n').length)}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        title="↑/↓ 选择历史命令；多行输入时在第一行/最后一行切换历史"
        onChange={(event) => {
          cursor.current = null
          setDraft(event.currentTarget.value)
        }}
        onPaste={(event) => {
          const editor = event.currentTarget
          const pasted = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
          if (editor.selectionEnd !== editor.value.length || !pasted.endsWith('\n')) return
          const text = pasted.slice(0, -1)
          // Code-block copying adds one terminal newline. Keep intentional blank lines.
          if (!text.trim() || text.endsWith('\n')) return
          event.preventDefault()
          const next = editor.value.slice(0, editor.selectionStart) + text
          cursor.current = null
          setDraft(next)
          requestAnimationFrame(() => {
            if (editor.isConnected && editor.value === next) editor.setSelectionRange(next.length, next.length)
          })
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          const editor = event.currentTarget
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            const direction = event.key === 'ArrowUp' ? 'up' : 'down'
            if (canNavigateCommandHistory(editor.value, editor.selectionStart, editor.selectionEnd, direction)) {
              history.observe(historyLines)
              const recalled = navigateCommandHistory(cursor.current, history.snapshot(), editor.value, direction)
              if (recalled) {
                event.preventDefault()
                cursor.current = recalled.cursor
                setDraft(recalled.value)
                requestAnimationFrame(() => {
                  if (editor.isConnected && editor.value === recalled.value) editor.setSelectionRange(recalled.value.length, recalled.value.length)
                })
                return
              }
            }
          }
          if (event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'c'
            && editor.selectionStart === editor.selectionEnd) {
            event.preventDefault()
            onInterrupt()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            editor.form?.requestSubmit()
          }
        }}
      />
    </form>
  )
}
