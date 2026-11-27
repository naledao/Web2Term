import { useEffect, useMemo, useRef } from 'react'
import type { TerminalLine } from '@shared/types'
import { OUTPUT_WINDOW_CHARS } from '@shared/output-window'
import OutputText from './OutputText'

const EMPTY_LINES: readonly TerminalLine[] = []

interface Block {
  command: TerminalLine | null
  lines: TerminalLine[]
}

function formatCommand(text: string, posix: boolean): string {
  if (!posix) return `> ${text}`
  return /(?:^|\s)[$#]\s+\S/.test(text) ? text : `$ ${text}`
}

export default function TerminalTranscript({ lines = EMPTY_LINES, visible, posix, emptyMessage }: {
  lines?: readonly TerminalLine[]
  visible: boolean
  posix: boolean
  emptyMessage: string
}) {
  const outputRef = useRef<HTMLDivElement>(null)
  const blocks = useMemo(() => {
    const result: Block[] = []
    for (const line of lines) {
      if (line.kind === 'command') result.push({ command: line, lines: [] })
      else if (result.length === 0) result.push({ command: null, lines: [line] })
      else result[result.length - 1].lines.push(line)
    }
    return result
  }, [lines])

  useEffect(() => {
    const output = outputRef.current
    if (visible && output) output.scrollTop = output.scrollHeight
  }, [lines, visible])

  return (
    <div className="terminal-pane__output" ref={outputRef}>
      {blocks.length === 0 ? <p className="terminal-pane__empty">{emptyMessage}</p> : blocks.map((block, index) => (
        <div
          key={`${index}-${block.command?.text ?? 'system'}`}
          className={block.command ? 'terminal-entry' : 'terminal-entry terminal-entry--system'}
        >
          {block.command ? <pre className="line line--command">{formatCommand(block.command.text, posix)}</pre> : null}
          {block.lines.length > 0 ? (
            <div className="terminal-entry__body">
              {block.lines.map((line, lineIndex) => (
                line.kind === 'output' && line.text.length > OUTPUT_WINDOW_CHARS
                  ? <OutputText key={`${lineIndex}-${line.kind}`} className="line line--output" text={line.text} />
                  : <pre key={`${lineIndex}-${line.kind}`} className={`line line--${line.kind}`}>{line.text}</pre>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
