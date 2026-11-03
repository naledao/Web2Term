import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, hostname, release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { normalizeBackendUrl } from '../shared/backend-url'
import { EMPTY_WINDOWS_AGENT } from '../shared/windows-agent'
import type { WindowsAgentState } from '../shared/windows-agent'
import { resolvePowerShell } from './shell'
import { withRipgrepPath } from './bundled-ripgrep'
import { WindowsAgentTerminals } from './windows-agent-terminals'
import type { AgentPty } from './windows-agent-terminals'
import type { BackendAuthService } from './backend-auth'
import type { ConversationStore } from './db'
import type { Web2termTerminalSize } from '../shared/types'

const ENABLED_KEY = 'windowsAgentEnabledFor'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const TIMER_MAX = 2_147_483_647
interface AgentLog { path: string | null; write(record: Record<string, string | number>): void }
interface Dependencies {
  changed(state: WindowsAgentState): void
  createSocket(url: string, options: ClientOptions): WebSocket
  spawn?(size: Web2termTerminalSize): { pty: AgentPty; shell: string }
  supported?: boolean
  now?(): number
  log?: AgentLog
  schedule?: typeof setTimeout
  unschedule?: typeof clearTimeout
  random?(): number
}

export function agentWebSocketUrl(value: string): string {
  const normalized = normalizeBackendUrl(value)
  if (!normalized) throw new Error('Invalid backend')
  const url = new URL(normalized)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/+$/u, '') + '/ws/agent'
  return url.toString()
}

function createLog(): AgentLog {
  const log: AgentLog = { path: null, write(record) {
    try {
      if (!log.path) {
        const directory = join(tmpdir(), 'gpt-login-diag')
        mkdirSync(directory, { recursive: true })
        const path = join(directory, `web2term-windows-agent-${Date.now()}-${randomUUID()}.log`)
        writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); log.path = path
      }
      appendFileSync(log.path, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n')
    } catch { /* A log failure must not stop a user's terminal. */ }
  } }
  return log
}

function spawnPowerShell(size: Web2termTerminalSize): { pty: AgentPty; shell: string } {
  // Load the Windows native addon only when an authorized terminal is requested.
  const nodeRequire = createRequire(__filename)
  const directory = dirname(nodeRequire.resolve('node-pty/package.json')).replace(/([\\/])app\.asar(?=[\\/])/u, '$1app.asar.unpacked')
  const pty = nodeRequire(directory) as typeof import('node-pty')
  const shell = resolvePowerShell()
  return { shell, pty: pty.spawn(shell, ['-NoLogo', '-NoProfile'], {
    ...size, name: 'xterm-256color', cwd: homedir(), env: withRipgrepPath({ ...process.env, TERM: 'xterm-256color' }),
    useConpty: true, useConptyDll: false, conptyInheritCursor: false
  }) }
}

/** App-owned device transport. Its opt-in is bound to the backend/account that enabled it. */
export class WindowsAgent {
  private state: WindowsAgentState
  private owner: string
  private socket: WebSocket | null = null
  private readonly terminals: WindowsAgentTerminals
  private readonly log: AgentLog
  private readonly now: () => number
  private readonly schedule: typeof setTimeout
  private readonly unschedule: typeof clearTimeout
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingWrites = new Map<object, number>()
  private backoff = 1000
  private acknowledged = false
  private awaitingHeartbeat = false
  private disposed = false

  constructor(private readonly store: Pick<ConversationStore, 'getSetting' | 'setSettings'>,
    private readonly auth: Pick<BackendAuthService, 'getState' | 'getConnectionCredentials'>,
    private readonly dependencies: Dependencies) {
    const supported = dependencies.supported ?? (process.platform === 'win32' && Number(release().split('.')[2]) >= 17763)
    this.owner = store.getSetting(ENABLED_KEY) ?? ''
    this.state = { ...EMPTY_WINDOWS_AGENT, supported, enabled: Boolean(this.owner) }
    this.log = dependencies.log ?? createLog(); this.now = dependencies.now ?? Date.now
    this.schedule = dependencies.schedule ?? setTimeout; this.unschedule = dependencies.unschedule ?? clearTimeout
    this.terminals = new WindowsAgentTerminals({
      spawn: dependencies.spawn ?? spawnPowerShell,
      send: message => this.send(message), changed: () => this.publish(), log: record => this.log.write(record)
    })
  }

  getState(): WindowsAgentState { return { ...this.state, terminalCount: this.terminals.count, logPath: this.log.path } }
  start(): void { if (this.state.enabled && !this.disposed) this.connect() }

  setEnabled(enabled: boolean): WindowsAgentState {
    if (this.disposed) return this.getState()
    if (typeof enabled !== 'boolean') return this.getState()
    if (enabled && !this.state.supported) { this.update('error', '此功能需要 Windows 10 1809 或更新版本。'); return this.getState() }
    const auth = this.auth.getState()
    if (enabled && (auth.status !== 'signed-in' || !auth.user)) {
      this.update('waiting-login', '请先登录后端，再开启本机远程终端。'); return this.getState()
    }
    const owner = enabled ? JSON.stringify([auth.backendUrl, auth.user!.publicId]) : ''
    if (enabled && this.state.enabled && this.owner === owner && ['connecting', 'online', 'reconnecting'].includes(this.state.status)) return this.getState()
    try { this.store.setSettings({ [ENABLED_KEY]: owner }) }
    catch { this.update('error', '无法保存本机设备设置，请检查本地存储后重试。'); return this.getState() }
    this.owner = owner; this.state.enabled = enabled; this.backoff = 1000
    this.release()
    if (enabled) this.connect()
    else this.update('disabled', '本机远程终端已关闭。')
    return this.getState()
  }

  credentialsChanged(): void {
    this.release(); this.backoff = 1000
    if (this.state.enabled) this.connect()
    else this.publish()
  }
  dispose(): void { this.disposed = true; this.release() }

  private connect(): void {
    if (this.disposed || !this.state.enabled || !this.state.supported || this.socket) return
    const auth = this.auth.getState(), credentials = this.auth.getConnectionCredentials()
    if (!credentials || credentials.expiresAt <= this.now() || !auth.user || this.owner !== JSON.stringify([auth.backendUrl, auth.user.publicId])) {
      this.update('waiting-login', auth.status === 'expired' ? '登录已过期，请重新登录以恢复本机设备。' : '请登录开启此功能时的后端和账号；切换账号后可重新开启。'); return
    }
    let url: string
    try {
      url = agentWebSocketUrl(credentials.backendUrl)
      const key = 'windowsAgentIdentity:' + createHash('sha256').update(this.owner).digest('hex')
      const value = this.store.getSetting(key)
      const hasIdentity = value !== null && value !== undefined
      const saved: unknown = hasIdentity ? JSON.parse(value) : null
      if (hasIdentity && (!saved || typeof saved !== 'object' || !('deviceId' in saved) || typeof saved.deviceId !== 'string' || !UUID.test(saved.deviceId))) throw new Error('Invalid identity')
      const deviceId = hasIdentity ? (saved as { deviceId: string }).deviceId : randomUUID()
      const machine = hostname()
      const deviceName = /^[\x20-\x7e]{1,100}$/u.test(machine) ? machine : 'windows-' + deviceId.slice(0, 8)
      if (!hasIdentity) this.store.setSettings({ [key]: JSON.stringify({ deviceId }) })
      this.state.deviceId = deviceId; this.state.deviceName = deviceName
    } catch { this.update('error', '无法读取或保存本机设备身份，请检查本地配置。'); return }
    this.log.write({ event: 'connect_started', deviceId: this.state.deviceId, url })
    this.update('connecting', '正在连接后端，等待心跳确认…')
    try {
      const socket = this.dependencies.createSocket(url, {
        headers: { Authorization: `Bearer ${credentials.accessToken}`, 'X-Device-Id': this.state.deviceId, 'X-Device-Name': this.state.deviceName },
        followRedirects: false, handshakeTimeout: 10_000, maxPayload: 64 * 1024, perMessageDeflate: false
      })
      this.socket = socket; this.acknowledged = false; this.awaitingHeartbeat = false
      this.terminals.attach()
      const current = (): boolean => this.socket === socket && !this.disposed
      socket.on('open', () => { if (current()) { this.clearTimer('handshake'); this.heartbeat() } })
      socket.on('message', (data, binary) => {
        if (!current()) return
        if (binary) { this.stopWithError('后端发送了不支持的二进制消息。'); return }
        let message: Record<string, unknown>
        try {
          const value: unknown = JSON.parse(data.toString())
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid frame')
          message = value as Record<string, unknown>
        } catch { this.stopWithError('后端终端消息格式无效。'); return }
        if (message.type === 'heartbeat_ack') {
          if (!this.awaitingHeartbeat) return
          this.awaitingHeartbeat = false; this.clearTimer('ack'); this.backoff = 1000
          if (!this.acknowledged) {
            this.acknowledged = true
            if (!this.send({ version: 1, type: 'agent_hello', payload: { protocol: 'web2term-terminal', max_terminals: 3,
              capabilities: ['pty', 'terminal_input', 'terminal_resize', 'terminal_close'] } })) return
            this.log.write({ event: 'online' }); this.update('online', '本机已在线，可从同一账号的客户端连接 PowerShell。')
          }
          this.timer('heartbeat', 20_000, () => this.heartbeat())
        } else {
          // The authenticated relay can deliver requests before the first heartbeat ack.
          // Only the online status waits for that ack; terminal requests retain their order.
          this.terminals.receive(message)
        }
      })
      socket.on('unexpected-response', (request, response) => {
        const status = response.statusCode ?? 0
        if (current()) {
          this.log.write({ event: 'handshake_rejected', status })
          if (status >= 500 || status === 429) this.retry('后端暂时不可用。')
          else this.stopWithError(status === 401 ? '登录凭据被拒绝，请重新登录。' : status === 403 ? '本机设备被禁用或不属于当前账号，请检查设备权限。' : '后端拒绝设备连接，请检查地址、部署路径和服务配置。')
        }
        response.destroy(); request.destroy()
      })
      socket.on('error', () => { if (current()) this.retry('设备网络连接异常。') })
      socket.on('close', code => {
        if (!current()) return
        this.log.write({ event: 'connection_closed', code })
        if ([1000, 1002, 1003, 1007, 1008, 1009].includes(code)) this.stopWithError(code === 1000 ? '设备连接已被后端关闭，可能有另一实例上线。可关闭后重新开启。' : '后端拒绝设备或终端协议，请检查权限和服务配置。')
        else this.retry('设备连接已断开。')
      })
      this.timer('handshake', 10_000, () => this.retry('设备连接握手超时。'))
      const expiry = (): void => {
        const remaining = credentials.expiresAt - this.now()
        if (remaining <= 0) { this.release(); this.update('waiting-login', '登录已过期，请重新登录以恢复本机设备。') }
        else this.timer('expiry', Math.min(remaining, TIMER_MAX), expiry)
      }
      expiry()
    } catch { this.retry('无法建立设备连接。') }
  }
  private heartbeat(): void {
    this.awaitingHeartbeat = true
    if (!this.send({ type: 'heartbeat' })) return
    this.timer('ack', 10_000, () => this.retry('等待后端心跳确认超时。'))
  }
  private send(message: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    if (socket.bufferedAmount > 1024 * 1024) { this.retry('终端输出积压，正在回收会话。'); return false }
    try {
      const write = {}
      this.pendingWrites.set(write, this.now() + 10_000)
      if (this.pendingWrites.size === 1) this.watchWrite(socket)
      socket.send(JSON.stringify(message), error => {
        if (this.socket !== socket) return
        if (error) { this.retry('设备消息发送失败。'); return }
        const oldest = this.pendingWrites.keys().next().value
        if (this.pendingWrites.delete(write) && oldest === write) this.watchWrite(socket)
      })
      return this.socket === socket
    } catch { this.retry('设备消息发送失败。'); return false }
  }
  private watchWrite(socket: WebSocket): void {
    this.clearTimer('write')
    // Store only deadlines, never terminal content. New writes cannot inherit an old timeout.
    const oldest = this.pendingWrites.entries().next().value
    if (!oldest) return
    this.timer('write', Math.max(1, oldest[1] - this.now()), () => {
      if (this.socket === socket && this.pendingWrites.has(oldest[0])) this.retry('设备消息发送超时。')
    })
  }
  private retry(message: string): void {
    this.log.write({ event: 'reconnect', delayMs: this.backoff })
    this.release()
    if (this.disposed || !this.state.enabled) return
    const delay = Math.round(this.backoff * (1 - (this.dependencies.random ?? Math.random)() * 0.2))
    this.backoff = Math.min(30_000, this.backoff * 2)
    this.update('reconnecting', message + ' 正在等待自动重连，原终端会话已关闭。')
    this.timer('reconnect', delay, () => this.connect())
  }
  private stopWithError(message: string): void { this.release(); this.update('error', message) }
  private release(): void {
    for (const timer of this.timers.values()) this.unschedule(timer)
    this.timers.clear()
    this.pendingWrites.clear()
    const socket = this.socket; this.socket = null; this.acknowledged = false; this.awaitingHeartbeat = false
    this.terminals.disconnect()
    if (socket) { try { socket.terminate() } catch { /* Already closed. */ } }
  }
  private timer(key: string, milliseconds: number, callback: () => void): void {
    this.clearTimer(key)
    const timer = this.schedule(() => { this.timers.delete(key); callback() }, milliseconds)
    timer.unref?.(); this.timers.set(key, timer)
  }
  private clearTimer(key: string): void { const timer = this.timers.get(key); if (timer) this.unschedule(timer); this.timers.delete(key) }
  private update(status: WindowsAgentState['status'], message: string): void { this.state.status = status; this.state.message = message; this.publish() }
  private publish(): void { if (!this.disposed) { this.state.revision++; this.dependencies.changed(this.getState()) } }
}
