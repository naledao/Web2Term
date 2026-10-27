import type { InputReleaseStatus } from '../shared/emergency-stop'
import type { DesktopOwner } from './desktop-coordinator'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WINDOWS_HELPER_MANIFEST, WINDOWS_HELPER_MAX_FRAME_BYTES, WINDOWS_HELPER_MAX_REQUEST_BYTES, WINDOWS_HELPER_PROTOCOL_VERSION } from '../shared/windows-helper'
import type { WindowsHelperActionResult, WindowsHelperCode, WindowsHelperState } from '../shared/windows-helper'

export interface WindowsHelperOptions {
  executablePath: string
  /** Installed app: a missing helper is a damaged install, not a missing local build. */
  packaged?: boolean
  platform?: string
  arch?: string
  /** Tests supply synthetic streams and a clock; production always uses spawn without a shell. */
  spawn?: typeof spawn
  exists?: (path: string) => Promise<boolean>
  readText?: (path: string) => Promise<string>
  now?: () => number
  schedule?: (callback: () => void, milliseconds: number) => () => void
}

interface PendingAction {
  id: string
  dispatched: boolean
  resolve: (result: WindowsHelperActionResult) => void
  cancelTimer: () => void
  detachAbort: () => void
  cancelled: boolean
}

interface HelperProcess {
  child: ChildProcessWithoutNullStreams
  generation: number
  helloId: string
  nonce: string
  buffer: Buffer
  ready: Promise<boolean>
  settle: (ready: boolean) => void
  closing: boolean
  restartWhenClosed: boolean
  handshaken: boolean
  cancelStartup: () => void
  cancelHeartbeat: () => void
  cancelKill: () => void
  ping: { id: string; cancel: () => void } | null
  action: PendingAction | null
  cancelledIds: Set<string>
  emergencyId: string | null
  cancelEmergency: () => void
  activityStopped: boolean
  activityCause: 'emergency_stopped' | 'human_paused' | 'human_input' | 'external_input' | 'input_monitor_unavailable' | null
  /** Which consecutive physical input stopped this run (1..HUMAN_PAUSE_STRIKES); null for other causes. */
  activityStrike: number | null
}

export const HUMAN_PAUSE_STRIKES = 3
export const HUMAN_STRIKE_WINDOW_MS = 120_000
/** Input within this long of the previous one belongs to the same burst and the same strike. */
export const HUMAN_STRIKE_BURST_MS = 5_000

export interface DesktopActivityEvent {
  kind: 'human-input' | 'external-input' | 'focus-changed' | 'monitor-unavailable' | 'human-stop'
  /** Input category only. Move is reserved for the explicit mouse-shake stop gesture. */
  input: 'keyboard' | 'click' | 'wheel' | 'move' | null
  /** Ordinary physical input strikes; the explicit shake gesture has no strike count. */
  strike: number | null
  owner: DesktopOwner
  generation: number
}

/** Ordinary physical input bursts pause computer use; the shake gesture goes to global emergency stop. */
export function desktopActivityRequestsPause(event: DesktopActivityEvent): boolean {
  return event.kind === 'human-input' && (event.strike ?? 0) >= HUMAN_PAUSE_STRIKES
}

const messages: Record<WindowsHelperCode, string> = {
  unsupported_host: 'Windows helper 仅支持 Windows x64 本机环境。', not_started: 'Windows helper 尚未启动。',
  starting: 'Windows helper 正在启动并核对协议。', ready: 'Windows helper 已就绪。', stopping: 'Windows helper 正在停止。',
  executable_missing: '未找到 Windows helper 构建产物，请先完成本机 helper 构建。',
  spawn_failed: 'Windows helper 启动失败。', handshake_timeout: 'Windows helper 握手超时，已停止本次进程。',
  protocol_mismatch: 'Windows helper 协议版本不兼容，请使用配套版本。', invalid_frame: 'Windows helper 通信格式异常，已停止本次进程。',
  pipe_closed: 'Windows helper 通信管道已关闭。', process_exited: 'Windows helper 已退出。',
  heartbeat_timeout: 'Windows helper 未响应心跳，已停止本次进程。', action_timeout: 'Windows helper 动作超时，操作是否生效需要重新观察。',
  emergency_stopped: '全局急停已锁定 Windows helper，等待用户明确解除。',
  cancelled: 'Windows helper 请求已取消。', busy: 'Windows helper 正在处理其他请求，本次未派发。',
  unknown_action: 'Windows helper 未提供此动作。', invalid_request: 'Windows helper 请求不符合内部协议。',
  restart_limit: 'Windows helper 连续启动失败，已停止自动重启；请检查状态后重新启用或稍后重试。', disposed: 'Windows helper 管理器已关闭。'
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const actionName = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) &&
  !['command', 'read_files', 'questions', 'background_task', 'hello', 'ping', 'cancel', 'shutdown', 'emergency_stop', 'emergency_stopped', 'watch_desktop', 'desktop_activity'].includes(value)
const failure = (code: WindowsHelperCode, execution: WindowsHelperActionResult['execution'] = 'not_executed'): WindowsHelperActionResult =>
  ({ ok: false, code, execution, message: messages[code] })
const packagedMissing = 'Windows helper 安装资源缺失或不完整，请重新安装 Web2Term。'
/** Names both versions when the helper reported one, so a stale build is distinguishable from a corrupt frame. */
const mismatch = (found: unknown): string => Number.isSafeInteger(found)
  ? `Windows helper 协议版本不兼容（helper v${found}，客户端需要 v${WINDOWS_HELPER_PROTOCOL_VERSION}），请使用配套版本或重新构建。`
  : messages.protocol_mismatch

/** One supervised helper per application. No HTTP endpoint, shell, automatic action retry, or page IPC. */
export class WindowsHelperManager {
  private readonly listeners = new Set<() => void>()
  private readonly activityListeners = new Set<(event: DesktopActivityEvent) => void>()
  private desktopWatch: { id: string; owner: DesktopOwner } | null = null
  private readonly owners = new Set<string>()
  private readonly attempts: number[] = []
  private readonly schedule: NonNullable<WindowsHelperOptions['schedule']>
  private readonly now: () => number
  private readonly supported: boolean
  private state: WindowsHelperState
  private run: HelperProcess | null = null
  private launching: Promise<boolean> | null = null
  private cancelRestart: (() => void) | null = null
  private emergency = false
  private inputRelease: InputReleaseStatus = 'not-needed'
  private disposed = false

  constructor(private readonly options: WindowsHelperOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref()
      return () => clearTimeout(timer)
    })
    this.supported = (options.platform ?? process.platform) === 'win32' && (options.arch ?? process.arch) === 'x64'
    this.state = { phase: this.supported ? 'stopped' : 'unsupported', code: this.supported ? 'not_started' : 'unsupported_host',
      message: messages[this.supported ? 'not_started' : 'unsupported_host'], generation: 0, pid: null, protocolVersion: null, actions: [] }
  }

  getState(): WindowsHelperState { return structuredClone(this.state) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeDesktopActivity(listener: (event: DesktopActivityEvent) => void): () => void {
    this.activityListeners.add(listener); return () => this.activityListeners.delete(listener)
  }
  /** The coordinator supplies the owner. Neither page JSON nor an HWND may arm this watch. */
  setDesktopOwner(owner: DesktopOwner | null): void {
    if (JSON.stringify(this.desktopWatch?.owner ?? null) === JSON.stringify(owner)) return
    this.desktopWatch = owner ? { id: randomUUID(), owner: structuredClone(owner) } : null
    if (this.run?.handshaken && !this.run.closing) this.sendDesktopWatch(this.run)
  }
  private sendDesktopWatch(run: HelperProcess): void {
    this.send(run, { type: 'watch_desktop', id: randomUUID(), epoch: run.generation, watch_id: this.desktopWatch?.id ?? null })
  }

  /*
   * A stray touch or accidental click should not stop a task. Physical input under the live watch interrupts
   * the current step every time, but only the HUMAN_PAUSE_STRIKES-th burst in a row pauses computer use.
   * "In a row": the same watch (same goal) with no more than HUMAN_STRIKE_WINDOW_MS between bursts.
   *
   * A burst is one strike. Each strike retires the helper, and the restarted helper re-arms its watch within
   * a second, so the same typing used to be counted again: three strikes in 0.8 s (2026-10-27 activity log).
   */
  private humanStrikes: { watchId: string; count: number; at: number } | null = null
  private humanStrike(watchId: string): number {
    const now = this.now(), previous = this.humanStrikes?.watchId === watchId ? this.humanStrikes : null
    if (previous && now - previous.at <= HUMAN_STRIKE_BURST_MS) { previous.at = now; return previous.count }
    const count = previous && previous.count < HUMAN_PAUSE_STRIKES && now - previous.at <= HUMAN_STRIKE_WINDOW_MS ? previous.count + 1 : 1
    this.humanStrikes = { watchId, count, at: now }
    return count
  }
  inputReleaseStatus(): InputReleaseStatus { return this.inputRelease }
  emergencyStop(): void {
    if (this.emergency) return
    this.emergency = true
    this.cancelRestart?.(); this.cancelRestart = null
    const run = this.run
    this.inputRelease = run ? 'pending' : 'not-needed'
    if (!run) { this.update('emergency_stopped', 'stopped'); return }
    if (run.closing || !run.handshaken) { this.inputRelease = 'unconfirmed'; this.retire(run, 'emergency_stopped', false); return }
    run.emergencyId = randomUUID()
    // This control goes directly to the pipe reader, never the MTA/UIA queue.
    this.send(run, { type: 'emergency_stop', id: run.emergencyId, epoch: run.generation })
    run.cancelEmergency = this.schedule(() => {
      if (this.inputRelease === 'pending') this.inputRelease = 'unconfirmed'
      this.retire(run, 'emergency_stopped', false)
    }, 250)
    this.update('emergency_stopped', 'stopping', { actions: [], protocolVersion: null })
  }
  resetEmergencyStop(): boolean {
    if (this.run || this.launching) return false
    this.emergency = false
    this.update('not_started', 'stopped', { pid: null, actions: [], protocolVersion: null })
    // Demand refresh after the user clears the global latch may start a fresh process; no old request is restored.
    return true
  }

  /** Idempotent demand; state broadcasts must not create restart loops. */
  setDemand(owner: string, needed: boolean): void {
    if (this.disposed) return
    if (needed) {
      if (this.owners.has(owner)) return
      this.owners.add(owner)
      void this.ensureStarted()
    } else {
      if (!this.owners.delete(owner)) return
      if (this.emergency) return // Emergency acknowledgement/grace owns retirement, not demand churn.
      // Switching sessions releases one owner and acquires another in the same event-loop turn.
      // Let that handover finish before shutting down the application-wide helper.
      if (!this.owners.size) void Promise.resolve().then(() => {
        if (!this.disposed && !this.owners.size) this.stop()
      })
    }
  }

  ensureStarted(): Promise<boolean> {
    if (this.disposed || this.emergency || !this.supported || !this.owners.size) return Promise.resolve(false)
    if (this.run) {
      if (this.run.closing) {
        // Failed termination must not leave a caller awaiting an unbounded process exit.
        this.run.restartWhenClosed = this.owners.size > 0
        return Promise.resolve(false)
      }
      return this.run.ready
    }
    if (this.launching) return this.launching
    this.cancelRestart?.(); this.cancelRestart = null
    const launch = this.launch()
    this.launching = launch
    void launch.finally(() => { if (this.launching === launch) this.launching = null })
    return launch
  }

  async request(action: string, parameters: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number; expectedGeneration?: number } = {}): Promise<WindowsHelperActionResult> {
    if (this.emergency) return failure('emergency_stopped')
    if (options.signal?.aborted) return failure('cancelled')
    if (!actionName(action) || !record(parameters)) return failure('invalid_request')
    if (!this.owners.size || this.disposed) return failure(this.disposed ? 'disposed' : 'not_started')
    if (!await this.ensureStarted()) return failure(this.state.code)
    const run = this.run
    if (!run || run.closing || !run.handshaken) return failure('pipe_closed')
    if (run.activityStopped) return failure('cancelled')
    if (options.expectedGeneration !== undefined && run.generation !== options.expectedGeneration) return failure('not_started')
    if (options.signal?.aborted) return failure('cancelled')
    if (!this.state.actions.includes(action)) return failure('unknown_action')
    if (run.action) return failure('busy')
    const timeout = options.timeoutMs ?? 15_000
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) return failure('invalid_request')
    const id = randomUUID()
    let frame: string
    try {
      frame = JSON.stringify({ type: 'request', version: WINDOWS_HELPER_PROTOCOL_VERSION, id, epoch: run.generation, watch_id: this.desktopWatch?.id ?? null, action, parameters, timeout_ms: timeout }) + '\n'
      if (Buffer.byteLength(frame) > WINDOWS_HELPER_MAX_REQUEST_BYTES) return failure('invalid_request')
    } catch { return failure('invalid_request') }
    return new Promise(resolve => {
      const pending: PendingAction = { id, dispatched: false, resolve, cancelled: false, cancelTimer: () => {}, detachAbort: () => {} }
      run.action = pending
      pending.cancelTimer = this.schedule(() => {
        this.send(run, { type: 'cancel', id, epoch: run.generation })
        this.retire(run, 'action_timeout', true)
      }, timeout)
      const abort = (): void => {
        if (run.action !== pending || pending.cancelled) return
        pending.cancelled = true
        pending.cancelTimer()
        run.cancelledIds.add(id)
        if (run.cancelledIds.size > 32) run.cancelledIds.delete(run.cancelledIds.values().next().value!)
        this.send(run, { type: 'cancel', id, epoch: run.generation })
        // Cancellation acknowledgement alone cannot prove a blocked native input has stopped.
        if (run.action === pending && !run.closing) pending.cancelTimer = this.schedule(() => this.retire(run, 'cancelled', true), 500)
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      pending.detachAbort = () => options.signal?.removeEventListener('abort', abort)
      pending.dispatched = true // A write error cannot prove that the peer saw no bytes.
      this.write(run, frame)
    })
  }

  stop(): void {
    this.cancelRestart?.(); this.cancelRestart = null
    if (this.run) this.retire(this.run, 'stopping', false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.owners.clear()
    this.cancelRestart?.(); this.cancelRestart = null
    const run = this.run
    if (run) {
      this.retire(run, 'disposed', false)
      run.cancelKill()
      // App quit cannot rely on the event loop staying alive for a grace-period timer.
      try { run.child.kill('SIGKILL') } catch { /* pipe EOF and parent watch remain active */ }
    }
    this.update('disposed', 'stopped', { actions: [], protocolVersion: null, pid: this.run?.child.pid ?? null })
    this.listeners.clear()
    this.activityListeners.clear(); this.desktopWatch = null
  }

  private update(code: WindowsHelperCode, phase: WindowsHelperState['phase'], extra: Partial<WindowsHelperState> = {}): void {
    this.state = { ...this.state, code, phase, message: messages[code], ...extra }
    for (const listener of this.listeners) { try { listener() } catch { /* one view cannot disable supervision */ } }
  }

  private async launch(): Promise<boolean> {
    const now = this.now()
    this.pruneAttempts(now)
    if (this.attempts.length >= 3) { this.update('restart_limit', 'error'); return false }
    this.attempts.push(now)
    this.update('starting', 'starting', { actions: [], pid: null, protocolVersion: null })
    let exists = false
    try { exists = isAbsolute(this.options.executablePath) && await (this.options.exists?.(this.options.executablePath) ??
      stat(this.options.executablePath).then(value => value.isFile())) } catch { /* missing is an ordinary unavailable state */ }
    const manifest = exists ? await this.readManifest() : null
    if (this.disposed || this.emergency || !this.owners.size) { this.update(this.disposed ? 'disposed' : this.emergency ? 'emergency_stopped' : 'not_started', 'stopped'); return false }
    if (!exists) { this.update('executable_missing', 'error', this.options.packaged ? { message: packagedMissing } : {}); return false }
    // A stale or foreign build is reported without spawning it; no restart, the files will not change by retrying.
    if (manifest && (manifest.protocolVersion !== WINDOWS_HELPER_PROTOCOL_VERSION || manifest.arch !== 'x64')) {
      this.update('protocol_mismatch', 'error', { message: mismatch(manifest.protocolVersion === WINDOWS_HELPER_PROTOCOL_VERSION ? null : manifest.protocolVersion) })
      return false
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = (this.options.spawn ?? spawn)(this.options.executablePath, ['--parent-pid', String(process.pid)], {
        windowsHide: true, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: dirname(this.options.executablePath)
      }) as ChildProcessWithoutNullStreams
    } catch { this.update('spawn_failed', 'error'); this.restartLater(); return false }
    let settle!: (ready: boolean) => void
    const run: HelperProcess = { child, generation: this.state.generation + 1, helloId: randomUUID(), nonce: randomUUID(), buffer: Buffer.alloc(0),
      ready: new Promise(resolve => { settle = resolve }), settle: value => settle(value),
      closing: false, restartWhenClosed: false, handshaken: false,
      cancelStartup: () => {}, cancelHeartbeat: () => {}, cancelKill: () => {}, ping: null, action: null, cancelledIds: new Set(), emergencyId: null, cancelEmergency: () => {}, activityStopped: false, activityCause: null, activityStrike: null }
    this.run = run
    this.update('starting', 'starting', { generation: run.generation, pid: child.pid ?? null })
    child.once('error', () => this.retire(run, run.handshaken ? 'pipe_closed' : 'spawn_failed', true))
    // 'exit' may precede the final stdout bytes. 'close'/EOF settle after those bytes drain.
    child.once('close', () => this.closed(run))
    child.stdout.on('data', (chunk: Buffer) => this.receive(run, chunk))
    child.stdout.once('end', () => { if (!run.closing) this.retire(run, 'pipe_closed', true) })
    child.stdout.on('error', () => this.retire(run, 'pipe_closed', true))
    child.stdin.on('error', () => this.retire(run, 'pipe_closed', true))
    // Drain diagnostics without forwarding native text, paths, or UI content into renderer/logs.
    child.stderr.on('data', () => {})
    child.stderr.on('error', () => {})
    run.cancelStartup = this.schedule(() => this.retire(run, 'handshake_timeout', true), 5000)
    this.send(run, { type: 'hello', id: run.helloId, nonce: run.nonce, parent_pid: process.pid })
    return run.ready
  }

  /** Null when absent or unreadable: older local builds carry no manifest, and the handshake still decides. */
  private async readManifest(): Promise<Record<string, unknown> | null> {
    try {
      const path = join(dirname(this.options.executablePath), WINDOWS_HELPER_MANIFEST)
      const value: unknown = JSON.parse(await (this.options.readText ?? (file => readFile(file, 'utf8')))(path))
      return record(value) ? value : null
    } catch { return null }
  }

  private send(run: HelperProcess, value: Record<string, unknown>): void {
    this.write(run, JSON.stringify({ ...value, version: WINDOWS_HELPER_PROTOCOL_VERSION }) + '\n')
  }

  private write(run: HelperProcess, frame: string): void {
    if (this.run !== run || run.closing) return
    try { run.child.stdin.write(frame, error => { if (error) this.retire(run, 'pipe_closed', true) }) }
    catch { this.retire(run, 'pipe_closed', true) }
  }

  private receive(run: HelperProcess, chunk: Buffer): void {
    if (this.run !== run || run.closing) return
    // Split before concatenating so a large batch of individually bounded frames is allowed.
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      if (run.buffer.length + end - offset > WINDOWS_HELPER_MAX_FRAME_BYTES) { this.retire(run, 'invalid_frame', false); return }
      run.buffer = Buffer.concat([run.buffer, chunk.subarray(offset, end)])
      if (newline < 0) return
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(run.buffer)) }
      catch { this.retire(run, 'invalid_frame', false); return }
      run.buffer = Buffer.alloc(0)
      if (!this.frame(run, value)) return
      offset = newline + 1
    }
  }

  private frame(run: HelperProcess, value: unknown): boolean {
    if (!record(value) || value.version !== WINDOWS_HELPER_PROTOCOL_VERSION) {
      // A current helper answers a mismatched hello with `incompatible` carrying its own version before exiting.
      if (record(value)) this.retire(run, 'protocol_mismatch', false, mismatch(value.version))
      else this.retire(run, 'invalid_frame', false)
      return false
    }
    const invalid = (): false => { this.retire(run, 'invalid_frame', false); return false }
    if (!run.handshaken) {
      if (value.type !== 'ready' || value.id !== run.helloId || value.nonce !== run.nonce || value.pid !== run.child.pid ||
        value.arch !== 'x64' || value.apartment !== 'MTA' || typeof value.elevated !== 'boolean' || !Array.isArray(value.actions) ||
        value.actions.length > 32 || value.actions.some(action => !actionName(action)) || new Set(value.actions).size !== value.actions.length) return invalid()
      if (this.emergency) { this.inputRelease = 'unconfirmed'; this.retire(run, 'emergency_stopped', false); return false }
      run.handshaken = true
      // The limit is for consecutive failed starts. A helper retired after a desktop interruption
      // restarted fine; counting it would strand the task with only complete_task after three stops.
      this.attempts.length = 0
      run.cancelStartup()
      // Pipe ordering arms the hook before any later request can be dispatched.
      this.sendDesktopWatch(run)
      this.update('ready', 'ready', { pid: run.child.pid ?? null, protocolVersion: WINDOWS_HELPER_PROTOCOL_VERSION, actions: value.actions as string[] })
      run.settle(true)
      this.heartbeatLater(run)
      return true
    }
    if (value.type === 'desktop_activity') {
      const inputKind = ['human-input', 'external-input'].includes(value.kind as string)
      const notification = value.kind === 'focus-changed'
      if (Object.keys(value).length !== 6 || !['human-input', 'external-input', 'focus-changed', 'monitor-unavailable', 'human-stop'].includes(value.kind as string) ||
        (value.kind === 'human-stop' ? value.input !== 'move' : inputKind ? !['keyboard', 'click', 'wheel'].includes(value.input as string) : value.input !== null) ||
        typeof value.watch_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.watch_id) || value.epoch !== run.generation) return invalid()
      const watch = this.desktopWatch
      const matches = watch?.id === value.watch_id
      const strike = matches && value.kind === 'human-input' ? this.humanStrike(watch!.id) : null
      if (!notification) {
        run.activityStopped = true
        run.activityCause = value.kind === 'monitor-unavailable' ? 'input_monitor_unavailable'
          : matches && value.kind === 'human-stop' ? 'emergency_stopped'
            : strike === null ? 'external_input' : strike >= HUMAN_PAUSE_STRIKES ? 'human_paused' : 'human_input'
        run.activityStrike = strike
      }
      if (watch && (matches || !notification)) for (const listener of this.activityListeners) {
        // An old watch can retire a latched native process, but cannot pause a new goal.
        try { listener({ kind: matches || value.kind === 'monitor-unavailable' ? value.kind as DesktopActivityEvent['kind'] : 'external-input',
          input: value.input as DesktopActivityEvent['input'], strike, owner: structuredClone(watch.owner), generation: run.generation }) }
        catch { /* Native input is already latched off; one observer cannot suppress retirement. */ }
      }
      if (!notification) this.interruptDesktopRun(run)
      return !run.closing
    }
    if (value.type === 'emergency_stopped' && this.emergency && value.id === run.emergencyId && value.epoch === run.generation) {
      if (![value.attempted, value.released, value.remaining].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 8192) ||
        Number(value.released) > Number(value.attempted) || Number(value.remaining) !== Number(value.attempted) - Number(value.released)) return invalid()
      this.inputRelease = value.remaining === 0 ? 'released' : 'unconfirmed'
      run.cancelEmergency(); this.retire(run, 'emergency_stopped', false); return true
    }
    if (value.type === 'pong' && run.ping && value.id === run.ping.id) {
      run.ping.cancel(); run.ping = null; this.heartbeatLater(run); return true
    }
    if (value.type === 'cancelled' && typeof value.id === 'string' && value.epoch === run.generation && run.cancelledIds.delete(value.id)) return true
    const pending = run.action
    if (!pending || value.id !== pending.id || value.epoch !== run.generation) return invalid()
    if (value.type !== 'result' || typeof value.ok !== 'boolean' ||
      !['not_executed', 'executed', 'unknown'].includes(value.execution as string) || typeof value.code !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(value.code) || typeof value.message !== 'string' || value.message.length > 4000 ||
      (value.ok && (value.code !== 'ok' || value.execution !== 'executed'))) return invalid()
    this.complete(run, { ok: value.ok, execution: value.execution as WindowsHelperActionResult['execution'], code: value.code,
      message: value.message, ...(value.data === undefined ? {} : { data: value.data }) })
    return true
  }

  private complete(run: HelperProcess, result: WindowsHelperActionResult): void {
    const pending = run.action
    if (!pending) return
    if (run.activityCause) result = { ...result, ok: false, code: run.activityCause,
      message: run.activityCause === 'emergency_stopped' ? '用户连续晃动鼠标，已触发全局急停；实际执行回执已保留。停止所有自动操作与回传，等待用户解除急停并重新提交或恢复任务。'
        : run.activityCause === 'human_paused' ? 'computer use 已因用户键鼠操作暂停，本步实际执行回执已保留；不要再发起 computer 请求，等待用户发送新消息后继续同一任务，继续时先重新观察。'
        : run.activityCause === 'human_input' ? `检测到用户键鼠操作（第 ${run.activityStrike}/${HUMAN_PAUSE_STRIKES} 次），本步已中断；动作是否生效须重新观察核对，不重放原动作。请继续原任务，连续 ${HUMAN_PAUSE_STRIKES} 次将暂停 computer use，直到用户发送新消息。`
        : run.activityCause === 'input_monitor_unavailable' ? '桌面输入监测已不可用，本轮控制已停止；请核对实际状态。' : '其他来源输入已中断本轮控制，请重新观察真实界面后继续判断；不重放原动作。' }
    run.action = null; pending.cancelTimer(); pending.detachAbort(); pending.resolve(result)
    if (pending.cancelled && !run.closing && !this.emergency) this.retire(run, 'cancelled', true)
  }

  private interruptDesktopRun(run: HelperProcess): void {
    if (run.closing || this.emergency) return
    const pending = run.action
    if (!pending) { this.retire(run, 'cancelled', true); return }
    if (!pending.cancelled) {
      pending.cancelled = true; pending.cancelTimer()
      run.cancelledIds.add(pending.id)
      this.send(run, { type: 'cancel', id: pending.id, epoch: run.generation })
      // Preserve the real final receipt where available; otherwise record unknown on retirement.
      pending.cancelTimer = this.schedule(() => this.retire(run, 'cancelled', true), 500)
    }
    this.update('cancelled', 'stopping', { actions: [] })
  }

  private heartbeatLater(run: HelperProcess): void {
    run.cancelHeartbeat = this.schedule(() => {
      if (this.run !== run || run.closing) return
      const id = randomUUID()
      run.ping = { id, cancel: this.schedule(() => this.retire(run, 'heartbeat_timeout', true), 2000) }
      this.send(run, { type: 'ping', id })
    }, 3000)
  }

  private retire(run: HelperProcess, code: WindowsHelperCode, restart: boolean, message = messages[code]): void {
    if (this.run !== run || run.closing) return
    // Controls bypass the MTA action queue. Never wait for UIA before cancelling or stopping.
    run.closing = true
    try { run.child.stdin.write(JSON.stringify({ type: 'shutdown', version: WINDOWS_HELPER_PROTOCOL_VERSION, id: randomUUID() }) + '\n') }
    catch { /* a broken pipe must not recursively enter retirement */ }
    run.cancelEmergency(); run.cancelStartup(); run.cancelHeartbeat(); run.ping?.cancel(); run.ping = null
    run.settle(false)
    this.complete(run, failure(code, run.action?.dispatched ? 'unknown' : 'not_executed'))
    this.update(code, code === 'stopping' || code === 'disposed' || code === 'emergency_stopped' ? 'stopping' : 'error', { actions: [], protocolVersion: null, message })
    try { run.child.stdin.end() } catch { /* force termination below */ }
    run.cancelKill = this.schedule(() => { try { run.child.kill('SIGKILL') } catch { /* remain unavailable until confirmed exit */ } }, 500)
    if (restart) this.restartLater()
  }

  private closed(run: HelperProcess): void {
    if (this.run !== run) return
    if (!run.closing) this.retire(run, 'process_exited', true)
    if (this.emergency && this.inputRelease === 'pending') this.inputRelease = 'unconfirmed'
    run.cancelEmergency(); run.cancelKill(); run.buffer = Buffer.alloc(0); this.run = null
    if (this.emergency) this.update('emergency_stopped', 'stopped', { pid: null, actions: [], protocolVersion: null })
    else if (this.state.code === 'stopping' || this.state.code === 'disposed') this.update(this.disposed ? 'disposed' : 'not_started', 'stopped', { pid: null })
    else this.update(this.state.code, 'error', { pid: null, message: this.state.message }) // keep any version detail
    if (run.restartWhenClosed) this.restartLater()
  }

  private pruneAttempts(now: number): void {
    while (this.attempts.length && now - this.attempts[0] >= 60_000) this.attempts.shift()
  }

  private restartLater(): void {
    if (this.disposed || this.emergency || !this.owners.size || this.cancelRestart) return
    // Stale entries must not block forever: only launch() used to expire them, and it is never reached from here.
    this.pruneAttempts(this.now())
    if (this.attempts.length >= 3) return // Keep the concrete failure visible after the third failure.
    this.cancelRestart = this.schedule(() => { this.cancelRestart = null; void this.ensureStarted() }, 1000 * this.attempts.length)
  }
}
