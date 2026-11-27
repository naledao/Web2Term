import type { TerminalLine } from '../shared/types'

const ANSI_RE = /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const SHELL_COMMAND_RE = /(?:^|[~./\w:[\]@()-]+)\s*[$#]\s+\S/
const MAX_LINES = 500

/** Line-based display and manual input for one SSH shell channel. */
export class SshPtyTranscript {
  private lines: TerminalLine[] = []
  private buffer = ''
  private partial: TerminalLine | null = null
  private manualInputPending = false
  private bracketedPaste = false
  private pasteModeTail = ''

  constructor(
    private readonly homeDir: () => string,
    private readonly onPromptCwd: (cwd: string) => void
  ) {}

  snapshot(): TerminalLine[] {
    return this.lines.map((line) => ({ ...line }))
  }

  resetStream(clearOutput = false): void {
    if (clearOutput) this.lines = []
    this.buffer = ''
    this.partial = null
    this.manualInputPending = false
    this.bracketedPaste = false
    this.pasteModeTail = ''
  }

  append(kind: TerminalLine['kind'], text: string): void {
    this.push({ kind, text })
  }

  appendModelLine(line: TerminalLine): void {
    this.partial = null
    this.append(line.kind, line.text)
  }

  appendModelOutput(chunk: string): boolean {
    const text = chunk.replace(/\r/g, '')
    if (text === '') return false
    const last = this.lines.at(-1)
    if (!this.partial && last?.kind === 'output') last.text += text
    else this.append('output', text)
    this.partial = null
    return true
  }

  send(text: string, write: (payload: string) => void): void {
    const normalized = text.replace(/\r\n?/g, '\n')
    // Match the shell's paste mode so multiline commands stay together.
    const payload = this.bracketedPaste && normalized.includes('\n')
      ? `\x1b[200~${normalized}\x1b[201~\r`
      : normalized.replace(/\n/g, '\r')
    this.manualInputPending = payload.trim() !== ''
    try {
      write(payload.endsWith('\r') ? payload : `${payload}\r`)
    } catch (error) {
      this.manualInputPending = false
      throw error
    }
  }

  interrupt(write: (payload: string) => void): void {
    this.manualInputPending = false
    this.partial = null
    write('\x03')
  }

  consume(text: string): void {
    // A bracketed-paste control sequence can span SSH packets.
    const modeText = this.pasteModeTail + text
    for (const match of modeText.matchAll(/\x1b\[\?2004([hl])/g)) {
      this.bracketedPaste = match[1] === 'h'
    }
    this.pasteModeTail = modeText.slice(-7)
    this.buffer += text

    // A bare carriage return also ends a displayed line.
    for (;;) {
      const index = this.buffer.search(/[\r\n]/)
      if (index === -1) break
      const line = this.buffer.slice(0, index)
      const crlf = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n'
      this.buffer = this.buffer.slice(index + (crlf ? 2 : 1))
      this.complete(line)
    }

    // Show password prompts before a newline. Only the remote echo is displayed.
    const partialText = this.clean(this.buffer)
    if (partialText === '') return
    if (!this.partial) {
      this.partial = { kind: 'output', text: partialText }
      this.push(this.partial)
    } else {
      this.partial.text = partialText
    }
  }

  private push(line: TerminalLine): void {
    this.lines.push(line)
    if (this.lines.length <= MAX_LINES) return
    const removed = this.lines.splice(0, this.lines.length - MAX_LINES)
    if (this.partial && removed.includes(this.partial)) this.partial = null
  }

  private complete(raw: string): void {
    const text = this.clean(raw)
    const line = this.partial
    this.partial = null
    if (text.trim() === '') return
    const echo = this.manualInputPending && SHELL_COMMAND_RE.test(text)
    if (echo || !line) this.manualInputPending = false
    const complete: TerminalLine = echo ? { kind: 'command', text, inputEcho: true } : { kind: 'output', text }
    if (line) Object.assign(line, complete)
    else this.push(complete)
  }

  private clean(raw: string): string {
    const text = raw.replace(ANSI_RE, '').replace(/\r/g, '')
    const match = /:([~][^\s$#]*|[^\s:$#][^\s$#]*)[$#]\s*$/.exec(text.trim())
    if (match) {
      const path = match[1]
      if (path.startsWith('~')) {
        const home = this.homeDir()
        if (home) this.onPromptCwd(home + path.slice(1))
      } else {
        this.onPromptCwd(path)
      }
    }
    return text
  }
}
