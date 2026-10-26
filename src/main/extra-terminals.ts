import { randomUUID } from 'node:crypto'
import { posixQuote, summariseResult } from './commands'
import { ConversationShell } from './shell'
import type { ExecutionShell, ShellResult } from './shell'
import type { RemoteShell } from './remote-shell'
import type { Web2termShell } from './web2term-shell'
import type { ExtraTerminal, ExtraTerminalsState, TerminalLine } from '../shared/types'

const MAX_TERMINAL_LINES = 400
const PUSH_INTERVAL_MS = 150

/** What the session terminal is connected to when the user adds a terminal. */
export type ExtraTerminalTarget =
  | { transport: 'local'; cwd: string }
  | { transport: 'ssh'; label: string; hostId: string; cwd: string }
  | { transport: 'web2term'; label: string; create: () => Web2termShell }

export interface SshShellHandlers {
  onOutput: (chunk: string) => void
  onClosed: (interrupted: boolean) => void
}

export interface ExtraTerminalsOptions {
  target: () => ExtraTerminalTarget
  /** Open a command shell on the session's SSH connection; rejects when it is no longer that host. */
  openSsh: (hostId: string, cwd: string, handlers: SshShellHandlers) => Promise<RemoteShell>
  onChanged: (state: ExtraTerminalsState) => void
}

interface Entry {
  id: string
  title: string
  transport: ExtraTerminal['transport']
  label: string
  /** Null for SSH until its channel is open, and again after the channel drops. */
  shell: ExecutionShell | null
  message: string
  /** SSH only: the host this terminal belongs to; it never follows a switch to another. */
  hostId: string
  lastCwd: string
  opening: Promise<ExecutionShell | null> | null
  lines: TerminalLine[]
}

/**
 * The terminals opened from the right panel's + menu.
 *
 * Deliberately separate from CommandRunner: these are the user's own shells, so
 * nothing here hands output to the model or honours automation. Each one takes
 * the session terminal's transport at the moment it is created — a local shell,
 * another command channel on the same SSH connection, or another PTY on the same
 * web2term device — and keeps it.
 */
export class ExtraTerminals {
  private readonly entries = new Map<string, Entry>()
  private nextNumber = 2
  private pushTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly options: ExtraTerminalsOptions) {}

  getState(): ExtraTerminalsState {
    return { terminals: [...this.entries.values()].map(snapshot) }
  }

  create(): { state: ExtraTerminalsState; id: string } {
    const id = randomUUID()
    const target = this.options.target()
    const entry: Entry = {
      id, title: `终端 ${this.nextNumber}`, transport: target.transport, label: '', shell: null,
      message: '', hostId: '', lastCwd: '', opening: null, lines: []
    }
    this.nextNumber += 1
    this.entries.set(id, entry)

    if (target.transport === 'local') {
      const shell: ConversationShell = new ConversationShell({
        initialCwd: target.cwd,
        onOutput: (chunk) => this.appendOutput(id, chunk),
        onExit: () => {
          if (this.entries.get(id)?.shell !== shell) return
          this.appendLine(id, { kind: 'notice', text: `${shell.label} 会话已结束，下一条命令会自动重开` })
        }
      })
      entry.shell = shell
      entry.label = `本机 · ${shell.label}`
    } else if (target.transport === 'ssh') {
      entry.label = target.label
      entry.hostId = target.hostId
      entry.lastCwd = target.cwd
      void this.openSsh(entry)
    } else {
      const shell = target.create()
      entry.shell = shell
      entry.label = target.label
      entry.message = '正在打开设备终端…'
      shell.onOutput = (chunk) => this.appendOutput(id, chunk)
      shell.onChanged = () => {
        if (this.entries.get(id) !== entry) return
        entry.message = shell.alive ? '' : shell.transport.message
        this.flush()
      }
      shell.activate()
    }

    this.flush()
    return { state: this.getState(), id }
  }

  async input(id: string, text: string): Promise<void> {
    const command = text.trim()
    const entry = this.entries.get(id)
    if (!entry || command === '') return
    const result = await this.runCommand(entry, command)
    if (result) this.appendLine(id, summariseResult(result))
  }

  /** Move one terminal to another directory, the way the session terminal's 双击编辑目录 does. */
  async setCwd(id: string, path: string): Promise<void> {
    const entry = this.entries.get(id)
    const target = path.trim()
    if (!entry || target === '') return
    const posix = entry.transport !== 'local' || entry.shell?.kind === 'posix'
    const command = posix
      ? `cd ${posixQuote(target)}`
      : `Set-Location -LiteralPath '${target.replace(/'/g, "''")}'`
    const result = await this.runCommand(entry, command)
    if (!result) return
    this.appendLine(id, result.exitCode === 0 && !result.rejected && !result.sessionLost
      ? { kind: 'notice', text: `目录已切换到 ${result.cwd || target}` }
      : summariseResult(result))
  }

  async interrupt(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    const shell = entry.shell
    if (!shell?.running) {
      this.appendLine(id, { kind: 'notice', text: '当前没有正在执行的命令' })
      return
    }
    this.appendLine(id, { kind: 'notice', text: '正在中断当前命令…' })
    try { await shell.interrupt() }
    catch (error) {
      this.appendLine(id, { kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  close(id: string): ExtraTerminalsState {
    const entry = this.entries.get(id)
    if (entry) {
      // Removed first so the dying shell's exit and close handlers find nothing to report into.
      this.entries.delete(id)
      release(entry)
      this.flush()
    }
    return this.getState()
  }

  disposeAll(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) release(entry)
  }

  /** Echo the command, run it, and return the result — or null when it never got to run. */
  private async runCommand(entry: Entry, command: string): Promise<ShellResult | null> {
    this.appendLine(entry.id, { kind: 'command', text: command })
    const shell = await this.ensureShell(entry)
    if (this.entries.get(entry.id) !== entry) return null
    if (!shell) {
      this.appendLine(entry.id, { kind: 'error', text: entry.message || '终端未就绪，命令没有执行。' })
      return null
    }
    const result = await shell.run(command)
    return this.entries.get(entry.id) === entry ? result : null
  }

  /** SSH channels reopen on demand: after an interrupt, or once the user types into a dropped one. */
  private async ensureShell(entry: Entry): Promise<ExecutionShell | null> {
    if (entry.transport !== 'ssh' || entry.shell?.alive) return entry.shell
    return entry.opening ?? this.openSsh(entry)
  }

  private openSsh(entry: Entry): Promise<ExecutionShell | null> {
    let opened: RemoteShell | null = null
    entry.message = '正在打开 SSH 终端…'
    this.flush()
    entry.opening = this.options.openSsh(entry.hostId, entry.lastCwd, {
      onOutput: (chunk) => this.appendOutput(entry.id, chunk),
      onClosed: (interrupted) => {
        if (!opened || entry.shell !== opened) return
        entry.lastCwd = opened.cwd || entry.lastCwd
        entry.shell = null
        if (this.entries.get(entry.id) !== entry) return
        // An interrupt kills the channel on purpose; reopen it where it was.
        if (interrupted) {
          void this.openSsh(entry)
          return
        }
        entry.message = 'SSH 终端已断开，输入命令会尝试重新打开。'
        this.appendLine(entry.id, { kind: 'notice', text: entry.message })
      }
    }).then(async (shell) => {
      opened = shell
      if (this.entries.get(entry.id) !== entry) {
        shell.dispose()
        return null
      }
      // Learn the starting directory so the header has something to show.
      if (entry.lastCwd === '') await shell.run(':', 10_000, true)
      entry.shell = shell
      entry.message = ''
      this.flush()
      return shell
    }, (error: Error) => {
      entry.message = error.message
      this.flush()
      return null
    }).finally(() => {
      entry.opening = null
    })
    return entry.opening
  }

  private appendLine(id: string, line: TerminalLine): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.lines.push(line)
    trim(entry.lines)
    this.flush()
  }

  /** Streaming output lands in the trailing output line instead of a new one. */
  private appendOutput(id: string, chunk: string): void {
    const entry = this.entries.get(id)
    const text = chunk.replace(/\r/g, '')
    if (!entry || text === '') return
    const last = entry.lines[entry.lines.length - 1]
    if (last && last.kind === 'output') last.text += text
    else entry.lines.push({ kind: 'output', text })
    trim(entry.lines)
    if (this.pushTimer || this.disposed) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.options.onChanged(this.getState())
    }, PUSH_INTERVAL_MS)
  }

  private flush(): void {
    if (this.disposed) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.options.onChanged(this.getState())
  }
}

function release(entry: Entry): void {
  const shell = entry.shell
  entry.shell = null
  // A web2term PTY is closed on the device, not just dropped: the device allows only three.
  if (entry.transport === 'web2term') (shell as Web2termShell | null)?.close()
  shell?.dispose()
}

function trim(lines: TerminalLine[]): void {
  if (lines.length > MAX_TERMINAL_LINES) lines.splice(0, lines.length - MAX_TERMINAL_LINES)
}

function snapshot(entry: Entry): ExtraTerminal {
  return {
    id: entry.id,
    title: entry.title,
    transport: entry.transport,
    label: entry.label,
    message: entry.message,
    shellKind: entry.shell?.kind ?? 'posix',
    alive: entry.shell?.alive ?? false,
    running: entry.shell?.running ?? false,
    cwd: entry.shell?.cwd || entry.lastCwd,
    // Copied: the trailing output line is mutated in place while streaming.
    lines: entry.lines.map((line) => ({ ...line }))
  }
}
