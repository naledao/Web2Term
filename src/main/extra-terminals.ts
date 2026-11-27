import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel } from 'ssh2'
import { posixQuote, summariseResult } from './commands'
import { ConversationShell } from './shell'
import type { ExecutionShell, ShellResult } from './shell'
import type { Web2termShell } from './web2term-shell'
import { SshPtyTranscript } from './ssh-pty-transcript'
import type { ExtraTerminal, ExtraTerminalPtyRestart, ExtraTerminalPtySize, ExtraTerminalsState, TerminalLine } from '../shared/types'

const MAX_TERMINAL_LINES = 400
const PUSH_INTERVAL_MS = 150
const PTY_INPUT_LIMIT = 1024 * 1024

/** What the session terminal is connected to when the user adds a terminal. */
export type ExtraTerminalTarget =
  | { transport: 'local'; cwd: string }
  | { transport: 'ssh'; label: string; hostId: string; cwd: string }
  | { transport: 'web2term'; label: string; create: () => Web2termShell }

export interface ExtraTerminalsOptions {
  target: () => ExtraTerminalTarget
  openSsh: (hostId: string, cwd: string, size: ExtraTerminalPtySize) => Promise<ClientChannel>
  onChanged: (state: ExtraTerminalsState) => void
  sshHome: (hostId: string) => string
}

interface SshPty {
  hostId: string
  channel: ClientChannel | null
  opening: boolean
  cwd: string
  transcript: SshPtyTranscript
}

interface Entry {
  id: string
  title: string
  transport: ExtraTerminal['transport']
  label: string
  shell: ExecutionShell | null
  ssh: SshPty | null
  message: string
  lines: TerminalLine[]
}

/**
 * The terminals opened from the right panel's + menu.
 *
 * Deliberately separate from CommandRunner: these are the user's own shells, so
 * nothing here hands output to the model or honours automation. Each one takes
 * the session terminal's transport at the moment it is created — a local shell,
 * an interactive channel on the same SSH connection, or another PTY on the same
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
      message: '', ssh: null, lines: []
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
      entry.ssh = {
        hostId: target.hostId, channel: null, opening: false, cwd: target.cwd,
        transcript: new SshPtyTranscript(
          () => this.options.sshHome(target.hostId),
          (cwd) => { if (entry.ssh) entry.ssh.cwd = cwd }
        )
      }
      void this.openPty(id)
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
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.ssh) {
      const { transcript, channel } = entry.ssh
      if (!channel) {
        this.appendLine(id, { kind: 'error', text: '交互式终端尚未连接，稍后再试。' })
        return
      }
      try {
        transcript.send(text, (payload) => {
          if (channel.writableLength + Buffer.byteLength(payload) > PTY_INPUT_LIMIT) {
            throw new Error('终端输入过大或远端接收过慢，未发送这段输入。')
          }
          channel.write(payload)
        })
      } catch (error) {
        this.appendLine(id, { kind: 'error', text: '写入交互式终端失败：' + (error as Error).message })
      }
      return
    }
    const command = text.trim()
    if (command === '') return
    const result = await this.runCommand(entry, command)
    if (result) this.appendLine(id, summariseResult(result))
  }

  /** Move one terminal to another directory, the way the session terminal's 双击编辑目录 does. */
  async setCwd(id: string, path: string): Promise<void> {
    const entry = this.entries.get(id)
    const target = path.trim()
    if (!entry || target === '') return
    if (entry.ssh) {
      if (entry.ssh.cwd !== target) await this.input(id, 'cd ' + posixQuote(target))
      return
    }
    const posix = entry.shell?.kind === 'posix'
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
    if (entry.ssh) {
      const { transcript, channel } = entry.ssh
      if (!channel) {
        this.appendLine(id, { kind: 'error', text: '交互式终端尚未连接，无法发送 Ctrl+C。' })
        return
      }
      try {
        transcript.interrupt((payload) => channel.write(payload))
        this.appendLine(id, { kind: 'notice', text: '已向远程交互终端发送 Ctrl+C' })
      } catch (error) {
        this.appendLine(id, { kind: 'error', text: '发送 Ctrl+C 失败：' + (error as Error).message })
      }
      return
    }
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

  async openPty(id: string, restart?: ExtraTerminalPtyRestart): Promise<void> {
    const entry = this.entries.get(id), ssh = entry?.ssh
    if (!entry || !ssh || ssh.opening || (ssh.channel && !restart)) return
    const previous = ssh.channel
    ssh.channel = null
    ssh.opening = true
    ssh.transcript.resetStream(restart === 'reset')
    const opening = restart === 'reset' ? '终端已重置，正在重新建立 SSH 会话'
      : restart === 'reconnect' ? '正在重新连接 SSH…' : '正在连接 SSH…'
    entry.message = opening
    this.appendLine(id, { kind: 'notice', text: opening })
    try {
      previous?.close()
      const channel = await this.options.openSsh(ssh.hostId, ssh.cwd, { cols: 120, rows: 32 })
      if (this.entries.get(id) !== entry) {
        channel.close()
        return
      }
      ssh.channel = channel
      entry.message = ''
      ssh.transcript.append('notice', '已连接 ' + entry.label)
      const output = new StringDecoder('utf8'), stderr = new StringDecoder('utf8')
      const consume = (decoder: StringDecoder) => (chunk: Buffer): void => {
        if (ssh.channel !== channel) return
        ssh.transcript.consume(decoder.write(chunk))
        this.schedulePush()
      }
      const finish = (kind: 'notice' | 'error', message: string): void => {
        if (ssh.channel !== channel) return
        ssh.channel = null
        ssh.transcript.consume(output.end() + stderr.end())
        ssh.transcript.resetStream()
        entry.message = message
        this.appendLine(id, { kind, text: message })
      }
      channel.once('close', () => finish('notice', '远程会话已关闭'))
      channel.on('error', (error: Error) => {
        finish('error', 'SSH 交互终端出错：' + error.message)
        channel.close()
      })
      channel.on('data', consume(output))
      channel.stderr.on('data', consume(stderr))
    } catch (error) {
      entry.message = (error as Error).message
      ssh.transcript.append('error', entry.message)
    } finally {
      ssh.opening = false
      if (this.entries.get(id) === entry) this.flush()
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
    const shell = entry.shell
    if (!shell) {
      this.appendLine(entry.id, { kind: 'error', text: entry.message || '终端未就绪，命令没有执行。' })
      return null
    }
    const result = await shell.run(command)
    return this.entries.get(entry.id) === entry ? result : null
  }

  private appendLine(id: string, line: TerminalLine): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.ssh) entry.ssh.transcript.append(line.kind, line.text)
    else {
      entry.lines.push(line)
      trim(entry.lines)
    }
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
    this.schedulePush()
  }

  private schedulePush(): void {
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
  const channel = entry.ssh?.channel
  if (entry.ssh) entry.ssh.channel = null
  channel?.close()
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
    alive: entry.ssh ? Boolean(entry.ssh.channel) : entry.shell?.alive ?? false,
    ...(entry.ssh ? { opening: entry.ssh.opening, sshHostId: entry.ssh.hostId } : {}),
    running: entry.shell?.running ?? false,
    cwd: entry.ssh?.cwd || entry.shell?.cwd || '',
    // Copied: the trailing output line is mutated in place while streaming.
    lines: entry.ssh?.transcript.snapshot() ?? entry.lines.map((line) => ({ ...line }))
  }
}
