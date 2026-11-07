import type { EmergencyStopResetResult, EmergencyStopState, InputReleaseStatus } from '../shared/emergency-stop'

export interface EmergencyStopDependencies {
  desktop: { setEmergencyStopped(active: boolean): void; getState(): { desktopExecuting: number; nativeBlocked: boolean } }
  helper: { emergencyStop(): void; resetEmergencyStop(): boolean; getState(): { pid: number | null }; inputReleaseStatus(): InputReleaseStatus }
  sessions(): Iterable<{ interruptComputerUse(): Promise<unknown>; isComputerUseDraining(): boolean; releaseEmergencyStop(): void }>
  gestureAvailable(): boolean
  changed(state: EmergencyStopState): void
}
/** A synchronous, application-wide latch. No renderer, page or UIA work is awaited to close admission. */
export class EmergencyStopController {
  private revision = 0
  private active = false
  private epoch = 0
  private triggeredAt: number | null = null
  private source: EmergencyStopState['source'] = null
  private pending = 0
  private failures = 0
  constructor(private readonly deps: EmergencyStopDependencies) {}
  isActive(): boolean { return this.active }
  getState(): EmergencyStopState {
    const desktop = this.deps.desktop.getState(), helperRunning = this.deps.helper.getState().pid !== null
    const draining = [...this.deps.sessions()].some(session => session.isComputerUseDraining())
    const canReset = this.active && !this.pending && !desktop.desktopExecuting && !desktop.nativeBlocked && !helperRunning && !draining
    const inputRelease = this.deps.helper.inputReleaseStatus()
    const message = !this.active ? '全局急停只中断 Computer Use 的桌面操作；其他会话和后台工作继续运行。'
      : !canReset ? '已阻止新的 Computer Use 桌面操作，正在释放键鼠并等待相关执行器退场；其他工作不受影响。'
        : inputRelease === 'unconfirmed' ? 'Computer Use 已停止，helper 已退出；本次键鼠释放结果未确认。解除急停不会恢复已中断的 Computer Use 操作。'
          : 'Computer Use 桌面操作已停止。解除急停后可开始新的操作；已中断的操作不会自动恢复。'
    return { active: this.active, revision: this.revision, epoch: this.epoch, triggeredAt: this.triggeredAt, source: this.source,
      gestureAvailable: !this.active && this.deps.gestureAvailable(), pendingSessions: this.pending, failedSessions: this.failures, executing: desktop.desktopExecuting,
      helperRunning, inputRelease, canReset, message }
  }
  refresh(): void { this.revision++; try { this.deps.changed(this.getState()) } catch { /* A view cannot disable cancellation. */ } }
  trigger(source: 'button' | 'mouse-gesture'): EmergencyStopState {
    if (this.active) return this.getState()
    this.active = true; this.epoch++; this.triggeredAt = Date.now(); this.source = source; this.failures = 0
    // Close desktop admission before releasing held input or interrupting active Computer Use tasks.
    try { this.deps.desktop.setEmergencyStopped(true) } catch { this.failures++ }
    try { this.deps.helper.emergencyStop() } catch { this.failures++ }
    const sessions = [...this.deps.sessions()]
    this.pending = sessions.length
    for (const session of sessions) {
      try { void Promise.resolve(session.interruptComputerUse()).catch(() => { this.failures++ }).finally(() => { this.pending--; this.refresh() }) }
      catch { this.failures++; this.pending-- }
    }
    this.refresh()
    return this.getState()
  }
  sessionAdded(session: ReturnType<EmergencyStopDependencies['sessions']> extends Iterable<infer S> ? S : never): void {
    if (!this.active) return
    this.pending++
    try { void Promise.resolve(session.interruptComputerUse()).catch(() => { this.failures++ }).finally(() => { this.pending--; this.refresh() }) }
    catch { this.failures++; this.pending-- }
    this.refresh()
  }
  reset(): EmergencyStopResetResult {
    if (!this.active) return { ok: true, state: this.getState(), message: '' }
    if (!this.getState().canReset) return { ok: false, state: this.getState(), message: 'Computer Use 执行器尚未确认退场，暂时不能解除急停。' }
    if (!this.deps.helper.resetEmergencyStop()) return { ok: false, state: this.getState(), message: '旧 helper 尚未退出，暂时不能解除急停。' }
    // Releasing admission does not wake old tasks, commands, result buffers or grants.
    this.active = false
    try {
      for (const session of this.deps.sessions()) session.releaseEmergencyStop()
      this.deps.desktop.setEmergencyStopped(false)
    } catch {
      // A partial release must close again, rather than leave some sessions able to dispatch.
      this.active = false
      this.trigger(this.source ?? 'button')
      return { ok: false, state: this.getState(), message: '解除过程中状态变化，已重新急停，请核对执行器状态。' }
    }
    this.refresh()
    return { ok: true, state: this.getState(), message: '' }
  }
}
