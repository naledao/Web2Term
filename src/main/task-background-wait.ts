import { performance } from 'node:perf_hooks'
import { parseTaskToolContext } from '../shared/autonomous-task'
import type { TaskLease, TaskMachine, TaskBackgroundDependency, TaskToolContext } from '../shared/autonomous-task'
import type { BackgroundTask, BackgroundCommandOptions, BackgroundTaskNotificationKind } from '../shared/background-tasks'
import { isBackgroundWait, validateWaitParameters } from '../shared/windows-wait'
import { ComputerUseActionError } from './computer-use-tool'
import type { TaskCoordinator } from './task-coordinator'

/** Task ownership outlives the startup step, but never a goal, machine or generation change. */
export function backgroundBelongsTo(task: BackgroundTask, lease: TaskLease, machine: TaskMachine): boolean {
  const c = parseTaskToolContext(task.taskContext)
  return !!c && c.tool === 'command' && c.taskId === lease.taskId && c.generation === lease.generation &&
    c.sessionId === lease.sessionId && c.platformId === lease.platformId && c.conversationId === lease.conversationId &&
    task.conversationId === lease.conversationId && task.transport === 'local' && c.machine.connection === 'local' &&
    c.machine.id === machine.id && c.machine.platform === machine.platform && c.machine.arch === machine.arch
}

/** Exact command/options in the same launch directory and goal; no inference from names or PIDs. */
export function reusableBackgroundTask(tasks: BackgroundTask[], context: TaskToolContext, command: string, options?: BackgroundCommandOptions): BackgroundTask | undefined {
  return tasks.find(task => backgroundBelongsTo(task, context, context.machine) && task.command === command &&
    task.taskContext?.machine.workingDirectory === context.machine.workingDirectory &&
    JSON.stringify(Object.hasOwn(task, 'launchOptions') ? task.launchOptions : task.backgroundOptions ?? null) === JSON.stringify(options ?? null) &&
    (task.stopRequestedAt !== undefined || task.stopInProgress || task.status === 'stopped' || !task.resultSettled))
}

interface WaitContext {
  lease: TaskLease
  step: { id: string; token: string | null; sourceMessageId: string }
  signal: AbortSignal
  isCurrent(): boolean
}
interface WaitOutput { message: string; data: unknown }
interface PendingWait {
  context: WaitContext
  dependency: TaskBackgroundDependency
  started: number
  timer: ReturnType<typeof setTimeout> | null
  abort(): void
  resolve(value: WaitOutput): void
  reject(error: unknown): void
}
interface WaitDeps {
  coordinator: TaskCoordinator
  tasks(): BackgroundTask[]
  consume(id: string, kinds: BackgroundTaskNotificationKind[]): void
  now?(): number
}

/** Subscribes to BackgroundTasks' existing state publications; no shell, process or polling loop. */
export class TaskBackgroundWait {
  private pending: PendingWait | null = null
  private disposed = false
  constructor(private readonly deps: WaitDeps) {}

  wait(parameters: Record<string, unknown>, context: WaitContext): Promise<WaitOutput> {
    const invalid = validateWaitParameters(parameters)
    if (invalid || !isBackgroundWait(parameters)) return Promise.reject(new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: invalid ?? '不是后台等待条件。' }))
    const task = this.deps.coordinator.current(context.lease.platformId), step = task?.progress?.currentStep
    const background = this.deps.tasks().find(t => t.id === parameters.background_id)
    if (this.disposed || this.pending || !this.active(context) || !step?.machine || !background || !backgroundBelongsTo(background, context.lease, step.machine))
      return Promise.reject(new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '后台任务不存在、不属于当前目标或机器，或等待步骤来源已失效；未启动或操作进程。' }))
    if (parameters.condition === 'background_ready' && background.backgroundOptions?.kind !== 'service')
      return Promise.reject(new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: '该后台任务没有服务就绪监控；一次性任务应使用 background_finished。' }))
    const now = Date.now()
    const dependency: TaskBackgroundDependency = { backgroundId: background.id, startupStepId: background.taskContext!.stepId,
      waitingStepId: step.id, machineId: step.machine.id, condition: parameters.condition as TaskBackgroundDependency['condition'], state: 'waiting', createdAt: now, updatedAt: now }
    try {
      if (!this.deps.coordinator.recordBackgroundDependency(context.lease, dependency))
        return Promise.reject(new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '依赖记录未保存，等待未开始。' }))
    } catch {
      this.deps.coordinator.fail(context.lease.platformId, context.lease.conversationId)
      return Promise.reject(new ComputerUseActionError({ code: 'invalid_result', execution: 'not_executed', message: '依赖记录保存失败，自动推进已停止，等待未开始。' }))
    }
    return new Promise((resolve, reject) => {
      const op: PendingWait = { context, dependency, started: this.now(), timer: null, resolve, reject, abort: () => this.cancel(op) }
      this.pending = op
      context.signal.addEventListener('abort', op.abort, { once: true })
      op.timer = setTimeout(() => this.check(op, true), Number(parameters.timeout_ms ?? 600000))
      op.timer.unref?.()
      this.check(op)
    })
  }

  /** Call on monitor publications and task/scope changes. */
  reconcile(): void { if (this.pending) this.check(this.pending) }
  dispose(): void { this.disposed = true; if (this.pending) this.cancel(this.pending) }
  private now(): number { return this.deps.now?.() ?? performance.now() }
  private active(c: WaitContext): boolean {
    const step = this.deps.coordinator.current(c.lease.platformId)?.progress?.currentStep
    return !this.disposed && !c.signal.aborted && c.isCurrent() && this.deps.coordinator.owns(c.lease) &&
      step?.id === c.step.id && step.sourceMessageId === c.step.sourceMessageId && step.stepToken === c.step.token &&
      step.tool === 'computer' && step.action === 'wait_for' && step.status === 'executing'
  }
  private release(op: PendingWait): void {
    if (this.pending === op) this.pending = null
    if (op.timer) clearTimeout(op.timer)
    op.context.signal.removeEventListener('abort', op.abort)
  }
  private cancel(op: PendingWait): void {
    if (this.pending !== op) return
    this.release(op)
    try { this.deps.coordinator.recordBackgroundDependency(op.context.lease, { ...op.dependency, state: 'cancelled', updatedAt: Date.now() }) }
    catch { this.deps.coordinator.fail(op.context.lease.platformId, op.context.lease.conversationId) }
    op.reject(new ComputerUseActionError({ code: 'cancelled', execution: 'executed', message: '原任务或等待已中断，停止等待及回传；没有重启或终止后台进程。' }))
  }
  private check(op: PendingWait, deadline = false): void {
    if (this.pending !== op) return
    if (!this.active(op.context)) { this.cancel(op); return }
    const task = this.deps.tasks().find(t => t.id === op.dependency.backgroundId)
    const machine = this.deps.coordinator.current(op.context.lease.platformId)?.progress?.currentStep?.machine
    if (!task || !machine || !backgroundBelongsTo(task, op.context.lease, machine)) { this.cancel(op); return }
    const state: TaskBackgroundDependency['state'] = task.stopRequestedAt !== undefined || task.stopInProgress || task.status === 'stopped' ? 'cancelled'
      : task.resultSettled ? op.dependency.condition === 'background_finished' && task.status === 'completed' && task.exitCode === 0 ? 'satisfied'
        : task.exitCode !== null && task.exitCode !== 0 ? 'failed' : 'unconfirmed'
      : op.dependency.condition === 'background_ready' && task.status === 'running' && task.startup?.state === 'ready' && task.startup.readyAt !== undefined ? 'satisfied'
      : op.dependency.condition === 'background_ready' && task.startup?.state === 'timeout' ? 'unconfirmed'
      : deadline ? 'timed-out' : 'waiting'
    if (state === 'waiting') return
    // Detach before publishing a dependency/result: publication itself can synchronously re-enter.
    this.release(op)
    try {
      if (!this.deps.coordinator.recordBackgroundDependency(op.context.lease, { ...op.dependency, state, updatedAt: Date.now() })) throw new Error('dependency-not-current')
      const kinds: BackgroundTaskNotificationKind[] = task.resultSettled ? ['created', 'ready', 'startup-timeout', 'finished']
        : state === 'satisfied' ? ['created', 'ready', 'startup-timeout'] : task.startup?.state === 'timeout' ? ['created', 'startup-timeout'] : []
      this.deps.consume(task.id, kinds)
      const data = { background_id: task.id, condition: op.dependency.condition, condition_met: state === 'satisfied', wait_status: state,
        elapsed_ms: Math.max(0, Math.floor(this.now() - op.started)), goal_verified: false,
        startup_step_id: op.dependency.startupStepId, waiting_step_id: op.dependency.waitingStepId, machine_id: machine.id,
        status: task.status, result_settled: task.resultSettled === true, exit_code: task.exitCode, checked_at: task.checkedAt,
        service_state: task.startup?.state ?? null, ready_at: task.startup?.readyAt ?? null,
        evidence: task.startup?.evidence ?? null, url: task.startup?.url ?? null, message: task.message,
        output: task.output.slice(-12000), error_output: task.errorOutput.slice(-12000), log_path: task.logPath,
        output_truncated: task.outputTruncated || task.output.length > 12000, error_output_truncated: task.errorOutputTruncated || task.errorOutput.length > 12000 }
      const message = state === 'satisfied' ? '后台依赖条件已由原监控确认；请基于结果继续后续工作，整体业务目标仍需验证。'
        : state === 'cancelled' ? '后台任务已请求停止或正在停止；依赖未满足，不得自动重启。'
        : state === 'timed-out' ? '等待期限已到，依赖尚未确认；原监控继续运行，请依据现有状态诊断，不要重复启动。'
        : '后台依赖未满足；请依据实际退出码、服务状态与日志诊断，不把等待结束视为成功。'
      if (state === 'satisfied') op.resolve({ message, data })
      else op.reject(new ComputerUseActionError({ code: state === 'timed-out' ? 'wait_timeout' : 'wait_failed', execution: 'executed', message, data }))
    } catch (error) {
      this.deps.coordinator.fail(op.context.lease.platformId, op.context.lease.conversationId)
      op.reject(error)
    }
  }
}
