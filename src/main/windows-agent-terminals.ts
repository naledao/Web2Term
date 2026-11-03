import { StringDecoder } from 'node:string_decoder'
import type { Web2termTerminalSize } from '../shared/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MAX_DATA = 16 * 1024
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export interface AgentPty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
}
interface Entry {
  generation: number
  pty: AgentPty | null
  closing: boolean
  reason: string
  decoder: StringDecoder
  listeners: { dispose(): void }[]
}
interface Dependencies {
  spawn(size: Web2termTerminalSize): { pty: AgentPty; shell: string }
  send(message: Record<string, unknown>): boolean
  changed(): void
  log(record: Record<string, string | number>): void
}

/** One device-wide limit, including shells awaiting a confirmed exit. No terminal content is logged. */
export class WindowsAgentTerminals {
  private readonly entries = new Map<string, Entry>()
  private readonly retired = new Set<string>()
  private connected = true
  private generation = 0
  constructor(private readonly dependencies: Dependencies) {}
  get count(): number { return this.entries.size }
  attach(): void { this.generation++; this.connected = true }

  receive(message: Record<string, unknown>): void {
    const type = message.type
    if (typeof type !== 'string' || !type.startsWith('terminal_')) return
    const id = typeof message.session_id === 'string' && UUID.test(message.session_id) ? message.session_id : ''
    if (!id) { this.error('', 'INVALID_SESSION_ID', '终端会话 ID 无效。'); return }
    if (message.version !== 1) { this.error(id, 'UNSUPPORTED_VERSION', '终端协议版本不支持。'); return }
    if (!['terminal_open', 'terminal_input', 'terminal_resize', 'terminal_close'].includes(type)) {
      this.error(id, 'UNSUPPORTED_MESSAGE', '终端消息类型不支持。'); return
    }
    const payload = message.payload ?? (type === 'terminal_close' ? {} : null)
    const fields = type === 'terminal_input' ? ['data'] : type === 'terminal_close' ? [] : ['cols', 'rows']
    if (!object(payload) || Object.keys(payload).some(key => !fields.includes(key))) {
      this.error(id, 'INVALID_PAYLOAD', '终端消息参数无效。'); return
    }
    if (type === 'terminal_open') {
      if (this.entries.has(id)) { this.error(id, 'SESSION_EXISTS', '终端已存在。'); return }
      if (this.retired.has(id)) { this.error(id, 'SESSION_CLOSED', '终端已关闭，请使用新的会话。'); return }
      const size = this.size(payload, true)
      if (!size) { this.error(id, 'INVALID_SIZE', '终端尺寸需为 1–1000 的整数。'); return }
      this.open(id, size); return
    }
    const entry = this.entries.get(id)
    if (!entry) { this.error(id, this.retired.has(id) ? 'SESSION_CLOSED' : 'SESSION_NOT_FOUND', '终端不存在或已经关闭。'); return }
    if (type === 'terminal_close') { this.close(id, entry, 'closed'); return }
    if (entry.closing) { this.error(id, 'SESSION_CLOSING', '终端正在关闭。'); return }
    if (type === 'terminal_resize') {
      const size = this.size(payload, false)
      if (!size) { this.error(id, 'INVALID_SIZE', '终端尺寸需为 1–1000 的整数。'); return }
      try { entry.pty!.resize(size.cols, size.rows); this.send('terminal_resized', id, size) }
      catch { this.error(id, 'TERMINAL_INPUT_FAILED', '终端尺寸调整失败。'); this.close(id, entry, 'input_error') }
      return
    }
    const data = payload.data
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_DATA / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
      this.error(id, 'INVALID_INPUT', '终端输入必须为不超过 16 KiB 的 Base64。'); return
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > MAX_DATA || bytes.toString('base64') !== data) { this.error(id, 'INVALID_INPUT', '终端输入无效。'); return }
    try { const text = entry.decoder.write(bytes); if (text) entry.pty!.write(text) }
    catch { this.error(id, 'TERMINAL_INPUT_FAILED', '终端输入失败。'); this.close(id, entry, 'input_error') }
  }

  disconnect(): void {
    this.connected = false
    for (const [id, entry] of this.entries) this.close(id, entry, 'connection_lost')
  }

  private size(payload: Record<string, unknown>, defaults: boolean): Web2termTerminalSize | null {
    const cols = defaults && (payload.cols === undefined || payload.cols === 0) ? 120 : payload.cols
    const rows = defaults && (payload.rows === undefined || payload.rows === 0) ? 30 : payload.rows
    return typeof cols === 'number' && Number.isInteger(cols) && cols >= 1 && cols <= 1000
      && typeof rows === 'number' && Number.isInteger(rows) && rows >= 1 && rows <= 1000 ? { cols, rows } : null
  }
  private open(id: string, size: Web2termTerminalSize): void {
    if (!this.connected) return
    if (this.entries.size >= 3) { this.error(id, 'TERMINAL_LIMIT_REACHED', '最多同时运行 3 个终端，请先关闭一个。'); return }
    const entry: Entry = { generation: this.generation, pty: null, closing: false, reason: 'shell_exit', decoder: new StringDecoder('utf8'), listeners: [] }
    this.entries.set(id, entry)
    this.dependencies.changed()
    try {
      const { pty, shell } = this.dependencies.spawn(size)
      entry.pty = pty
      entry.listeners.push(pty.onExit(({ exitCode }) => this.finish(id, entry, exitCode)))
      entry.listeners.push(pty.onData(data => {
        if (!this.connected || entry.closing) return
        const bytes = Buffer.from(data, 'utf8')
        for (let offset = 0; offset < bytes.length; offset += MAX_DATA) {
          if (!this.send('terminal_output', id, { data: bytes.subarray(offset, offset + MAX_DATA).toString('base64') })) {
            this.close(id, entry, 'output_error'); break
          }
        }
      }))
      if (!this.send('terminal_ready', id, { ...size, shell })) this.close(id, entry, 'connection_lost')
      this.dependencies.log({ event: 'terminal_started', sessionId: id })
    } catch {
      this.error(id, 'TERMINAL_START_FAILED', '无法创建 PowerShell / ConPTY，请检查系统版本和客户端安装。')
      if (entry.pty) this.close(id, entry, 'output_error')
      else this.finish(id, entry, -1, false)
    }
  }
  private close(id: string, entry: Entry, reason: string): void {
    if (entry.closing) return
    entry.closing = true; entry.reason = reason
    this.dependencies.log({ event: 'terminal_closing', sessionId: id, reason })
    try { entry.pty?.kill() }
    catch { this.dependencies.log({ event: 'terminal_kill_failed', sessionId: id }) }
    // Keep its slot until node-pty confirms exit. A failed kill must never create a fourth shell.
  }
  private finish(id: string, entry: Entry, exitCode: number, notify = true): void {
    if (this.entries.get(id) !== entry) return
    for (const listener of entry.listeners) listener.dispose()
    this.entries.delete(id); this.retired.add(id)
    if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!)
    this.dependencies.log({ event: 'terminal_exit', sessionId: id, exitCode, reason: entry.reason })
    if (notify && this.connected && entry.generation === this.generation) this.send('terminal_exit', id, { exit_code: exitCode, reason: entry.reason })
    this.dependencies.changed()
  }
  private error(id: string, code: string, message: string): void {
    this.dependencies.log({ event: 'terminal_error', sessionId: id, code })
    this.send('terminal_error', id, { code, message })
  }
  private send(type: string, id: string, payload: object): boolean {
    return this.connected && this.dependencies.send({ version: 1, type, ...(id ? { session_id: id } : {}), payload })
  }
}
