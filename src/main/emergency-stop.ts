import { EMERGENCY_STOP_SHORTCUT } from '../shared/emergency-stop'
import type { EmergencyStopResetResult, EmergencyStopState, InputReleaseStatus } from '../shared/emergency-stop'

export interface EmergencyStopDependencies {
  desktop: { setEmergencyStopped(active: boolean): void; getState(): { executing: number; nativeBlocked: boolean } }
  helper: { emergencyStop(): void; resetEmergencyStop(): boolean; getState(): { pid: number | null }; inputReleaseStatus(): InputReleaseStatus }
  sessions(): Iterable<{ emergencyStop(): Promise<unknown>; isAutomationDraining(): boolean; releaseEmergencyStop(): void }>
  changed(state: EmergencyStopState): void
}
/** A synchronous, application-wide latch. No renderer, page or UIA work is awaited to close admission. */
export class EmergencyStopController {
  private revision = 0
  private active = false
  private epoch = 0
  private triggeredAt: number | null = null
  private source: EmergencyStopState['source'] = null
  private registered = false
  private pending = 0
  private failures = 0
  constructor(private readonly deps: EmergencyStopDependencies) {}
  isActive(): boolean { return this.active }
  shortcutStatus(registered: boolean): void { this.registered = registered; this.refresh() }
  getState(): EmergencyStopState {
    const desktop = this.deps.desktop.getState(), helperRunning = this.deps.helper.getState().pid !== null
    const draining = [...this.deps.sessions()].some(session => session.isAutomationDraining())
    const canReset = this.active && !this.pending && !desktop.executing && !desktop.nativeBlocked && !helperRunning && !draining
    const inputRelease = this.deps.helper.inputReleaseStatus()
    const message = !this.active ? '全局急停可停止所有会话的自动操作；结束任务仅停止当前会话。'
      : !canReset ? '已阻止所有新动作与自动回传，正在取消页面生成、工具和输入；等待实际执行器退场。后台进程保持独立运行。'
        : inputRelease === 'unconfirmed' ? '自动操作已停止，helper 已退出；本次键鼠释放结果未确认。解除急停只允许新的用户任务，不会恢复旧任务。'
          : '自动操作已停止；后台进程保持独立运行。解除急停后，旧任务仍保持停止，需重新提交或显式恢复。'
    return { active: this.active, revision: this.revision, epoch: this.epoch, triggeredAt: this.triggeredAt, source: this.source, shortcut: EMERGENCY_STOP_SHORTCUT,
      shortcutRegistered: this.registered, pendingSessions: this.pending, failedSessions: this.failures, executing: desktop.executing,
      helperRunning, inputRelease, canReset, message }
  }
  refresh(): void { this.revision++; try { this.deps.changed(this.getState()) } catch { /* A view cannot disable cancellation. */ } }
  trigger(source: 'button' | 'shortcut'): EmergencyStopState {
    if (this.active) return this.getState()
    this.active = true; this.epoch++; this.triggeredAt = Date.now(); this.source = source; this.failures = 0
    // Close admission before cancellation can synchronously publish state and wake a queue.
    try { this.deps.desktop.setEmergencyStopped(true) } catch { this.failures++ }
    try { this.deps.helper.emergencyStop() } catch { this.failures++ }
    const sessions = [...this.deps.sessions()]
    this.pending = sessions.length
    for (const session of sessions) {
      try { void Promise.resolve(session.emergencyStop()).catch(() => { this.failures++ }).finally(() => { this.pending--; this.refresh() }) }
      catch { this.failures++; this.pending-- }
    }
    this.refresh()
    return this.getState()
  }
  sessionAdded(session: ReturnType<EmergencyStopDependencies['sessions']> extends Iterable<infer S> ? S : never): void {
    if (!this.active) return
    this.pending++
    try { void Promise.resolve(session.emergencyStop()).catch(() => { this.failures++ }).finally(() => { this.pending--; this.refresh() }) }
    catch { this.failures++; this.pending-- }
    this.refresh()
  }
  reset(): EmergencyStopResetResult {
    if (!this.active) return { ok: true, state: this.getState(), message: '' }
    if (!this.getState().canReset) return { ok: false, state: this.getState(), message: '执行器尚未确认退场，暂时不能解除急停。' }
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
