import type { InputReleaseStatus } from '../shared/emergency-stop'
import type { DesktopOwner } from './desktop-coordinator'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WINDOWS_HELPER_MAX_FRAME_BYTES, WINDOWS_HELPER_MAX_REQUEST_BYTES, WINDOWS_HELPER_PROTOCOL_VERSION } from '../shared/windows-helper'
import type { WindowsHelperActionResult, WindowsHelperCode, WindowsHelperState } from '../shared/windows-helper'

export interface WindowsHelperOptions {
  executablePath: string
  platform?: string
  arch?: string
  /** Tests supply synthetic streams and a clock; production always uses spawn without a shell. */
  spawn?: typeof spawn
  exists?: (path: string) => Promise<boolean>
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
  activityCause: 'human_takeover' | 'external_input' | 'input_monitor_unavailable' | null
}

export interface DesktopActivityEvent {
  kind: 'human-input' | 'external-input' | 'focus-changed' | 'monitor-unavailable'
  /** Which kind of input stopped the run; null for focus and monitor events. Never a key or a position. */
  input: 'keyboard' | 'click' | 'wheel' | null
  owner: DesktopOwner
  generation: number
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
    while (this.attempts.length && now - this.attempts[0] >= 60_000) this.attempts.shift()
    if (this.attempts.length >= 3) { this.update('restart_limit', 'error'); return false }
    this.attempts.push(now)
    this.update('starting', 'starting', { actions: [], pid: null, protocolVersion: null })
    let exists = false
    try { exists = isAbsolute(this.options.executablePath) && await (this.options.exists?.(this.options.executablePath) ??
      stat(this.options.executablePath).then(value => value.isFile())) } catch { /* missing is an ordinary unavailable state */ }
    if (this.disposed || this.emergency || !this.owners.size) { this.update(this.disposed ? 'disposed' : this.emergency ? 'emergency_stopped' : 'not_started', 'stopped'); return false }
    if (!exists) { this.update('executable_missing', 'error'); return false }
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
      cancelStartup: () => {}, cancelHeartbeat: () => {}, cancelKill: () => {}, ping: null, action: null, cancelledIds: new Set(), emergencyId: null, cancelEmergency: () => {}, activityStopped: false, activityCause: null }
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
      this.retire(run, record(value) && value.version !== WINDOWS_HELPER_PROTOCOL_VERSION ? 'protocol_mismatch' : 'invalid_frame', false); return false
    }
    const invalid = (): false => { this.retire(run, 'invalid_frame', false); return false }
    if (!run.handshaken) {
      if (value.type !== 'ready' || value.id !== run.helloId || value.nonce !== run.nonce || value.pid !== run.child.pid ||
        value.arch !== 'x64' || value.apartment !== 'MTA' || typeof value.elevated !== 'boolean' || !Array.isArray(value.actions) ||
        value.actions.length > 32 || value.actions.some(action => !actionName(action)) || new Set(value.actions).size !== value.actions.length) return invalid()
      if (this.emergency) { this.inputRelease = 'unconfirmed'; this.retire(run, 'emergency_stopped', false); return false }
      run.handshaken = true
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
      if (Object.keys(value).length !== 6 || !['human-input', 'external-input', 'focus-changed', 'monitor-unavailable'].includes(value.kind as string) ||
        (inputKind ? !['keyboard', 'click', 'wheel'].includes(value.input as string) : value.input !== null) ||
        typeof value.watch_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.watch_id) || value.epoch !== run.generation) return invalid()
      const watch = this.desktopWatch
      const matches = watch?.id === value.watch_id
      if (value.kind !== 'focus-changed') {
        run.activityStopped = true
        run.activityCause = value.kind === 'monitor-unavailable' ? 'input_monitor_unavailable' : matches && value.kind === 'human-input' ? 'human_takeover' : 'external_input'
      }
      if (watch && (matches || value.kind !== 'focus-changed')) for (const listener of this.activityListeners) {
        // An old watch can retire a latched native process, but cannot label a new goal as human takeover.
        try { listener({ kind: matches || value.kind === 'monitor-unavailable' ? value.kind as DesktopActivityEvent['kind'] : 'external-input',
          input: value.input as DesktopActivityEvent['input'], owner: structuredClone(watch.owner), generation: run.generation }) }
        catch { /* Native input is already latched off; one observer cannot suppress retirement. */ }
      }
      if (value.kind !== 'focus-changed') this.interruptDesktopRun(run)
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
      message: run.activityCause === 'human_takeover' ? '检测到人工接管，已暂停原任务并保留实际执行回执。' : run.activityCause === 'input_monitor_unavailable' ? '桌面接管监测已不可用，本轮控制已停止；请核对实际状态。' : '其他来源输入已中断本轮控制，请重新观察真实界面后继续判断；不重放原动作。' }
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

  private retire(run: HelperProcess, code: WindowsHelperCode, restart: boolean): void {
    if (this.run !== run || run.closing) return
    // Controls bypass the MTA action queue. Never wait for UIA before cancelling or stopping.
    run.closing = true
    try { run.child.stdin.write(JSON.stringify({ type: 'shutdown', version: WINDOWS_HELPER_PROTOCOL_VERSION, id: randomUUID() }) + '\n') }
    catch { /* a broken pipe must not recursively enter retirement */ }
    run.cancelEmergency(); run.cancelStartup(); run.cancelHeartbeat(); run.ping?.cancel(); run.ping = null
    run.settle(false)
    this.complete(run, failure(code, run.action?.dispatched ? 'unknown' : 'not_executed'))
    this.update(code, code === 'stopping' || code === 'disposed' || code === 'emergency_stopped' ? 'stopping' : 'error', { actions: [], protocolVersion: null })
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
    else this.update(this.state.code, 'error', { pid: null })
    if (run.restartWhenClosed) this.restartLater()
  }

  private restartLater(): void {
    if (this.disposed || this.emergency || !this.owners.size || this.cancelRestart) return
    if (this.attempts.length >= 3) return // Keep the concrete failure visible after the third failure.
    this.cancelRestart = this.schedule(() => { this.cancelRestart = null; void this.ensureStarted() }, 1000 * this.attempts.length)
  }
}
