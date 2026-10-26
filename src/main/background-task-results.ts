import type { BackgroundTask, BackgroundTaskDeliveryStatus, BackgroundTaskNotificationKind } from '../shared/background-tasks'

export interface BackgroundTaskResultOwner {
  platformId: string
  conversationId: string
}

type SendOutcome = 'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed' | 'unknown' | 'stale'
interface PendingResult {
  task: BackgroundTask
  owner: BackgroundTaskResultOwner
  ready: () => boolean
  kind: BackgroundTaskNotificationKind
}
interface ResultDeliveryDeps {
  canSend: (owner: BackgroundTaskResultOwner, task: BackgroundTask) => boolean
  send: (text: string, owner: BackgroundTaskResultOwner, task: BackgroundTask, signal: AbortSignal) => Promise<SendOutcome>
  onStatus: (id: string, status: BackgroundTaskDeliveryStatus, message: string, kind: BackgroundTaskNotificationKind) => void
  latest?: (id: string) => BackgroundTask | undefined
  current?: (task: BackgroundTask, owner: BackgroundTaskResultOwner) => boolean
  onOutcome?: (task: BackgroundTask, outcome: SendOutcome) => void
  onIdle?: () => void
}

const ownerKey = (owner: BackgroundTaskResultOwner): string => JSON.stringify([owner.platformId, owner.conversationId])
const logExcerpt = (text: string): string => text.length <= 6000 ? text
  : `${text.slice(0, 2000)}\n…[中间日志省略，完整内容见日志文件]…\n${text.slice(-4000)}`

/** Only additional tool result metadata; existing terminal/system instructions stay intact. */
export function backgroundDependencyContext(task: BackgroundTask): string {
  const c = task.taskContext
  if (!c) return ''
  return '\n\n后台依赖上下文：\n' + JSON.stringify({ background_id: task.id, task_context: {
    session_id: c.sessionId, platform_id: c.platformId, conversation_id: c.conversationId, task_id: c.taskId, task_generation: c.generation,
    step_id: c.stepId, source_message_id: c.sourceMessageId, tool: c.tool,
    machine: { id: c.machine.id, label: c.machine.label, platform: c.machine.platform, arch: c.machine.arch, connection: c.machine.connection, working_directory: c.machine.workingDirectory }
  } }) + '\n后续步骤依赖此任务时，可用 computer.wait_for 的 background_ready（服务就绪）或 background_finished（最终退出结果）条件和此 background_id 等待；无依赖的工作可继续。登记不等于完成，不要重复启动或用高频请求轮询；产物和业务目标仍需后续验证。'
}

export function buildBackgroundTaskResult(task: BackgroundTask): string {
  const service = task.backgroundOptions?.kind === 'service'
  const status = task.status === 'stopped' ? '用户已手动停止' : service ? task.startup?.readyAt ? '服务已退出' : '服务启动未成功，进程已退出' : task.status === 'completed' ? '成功' : task.status === 'failed' ? '失败' : '进程已结束，退出码未知'
  return [
    '【后台任务执行结果】', `任务: ${task.name}`, `PID: ${task.pid}`,
    `结果: ${status}`, `退出码: ${task.exitCode === null ? '未知' : task.exitCode}`,
    `日志: ${task.logPath}`,
    ...(task.stderrPath ? [`错误日志: ${task.stderrPath}`] : []),
    ...(task.exitCodePath ? [`退出码文件: ${task.exitCodePath}`] : []),
    ...(task.message ? [`说明: ${task.message}`] : []), '',
    `标准输出${task.outputTruncated ? '（日志末尾，已截断）' : ''}:`,
    logExcerpt(task.output) || '（无输出）', '',
    `错误输出${task.errorOutputTruncated ? '（日志末尾，已截断）' : ''}:`,
    logExcerpt(task.errorOutput) || '（无错误输出）', '',
    task.status === 'stopped'
      ? '用户已手动停止此后台任务。请确认停止结果，不要自动重启、重试或修复此任务；只有用户再次要求时才能重新启动。'
      : '以上是软件监控得到的最终结果。请据此继续必要的验证、修复或总结；此任务已结束，无需再轮询。'
  ].join('\n') + backgroundDependencyContext(task)
}

export function buildBackgroundTaskCreated(task: BackgroundTask): string {
  return [
    '【后台任务已创建】', `任务: ${task.name}`, `PID: ${task.pid}`, `日志: ${task.logPath}`,
    ...(task.stderrPath ? [`错误日志: ${task.stderrPath}`] : []),
    ...(task.exitCodePath ? [`退出码文件: ${task.exitCodePath}`] : []), '',
    ...(task.output ? ['启动标准输出:', logExcerpt(task.output), ''] : []),
    ...(task.errorOutput ? ['启动错误输出（stderr，有内容不代表任务失败）:', logExcerpt(task.errorOutput), ''] : []),
    '软件已登记此任务并接管监控。这条消息仅确认创建成功，不代表任务已完成。',
    task.backgroundOptions?.kind === 'service'
      ? '软件将确认服务就绪后发送【后台服务已就绪】；收到后继续原任务后续工作。等待期间不要轮询或重复启动。'
      : '软件会继续识别服务启动信息；常驻服务就绪后回传启动结果，一次性任务结束后回传【后台任务执行结果】。不要轮询或重复启动。'
  ].join('\n') + backgroundDependencyContext(task)
}

export function buildBackgroundTaskReady(task: BackgroundTask): string {
  return ['【后台服务已就绪】', `任务: ${task.name}`, `PID: ${task.pid}`, `目标: ${task.targetLabel}`,
    ...(task.startup?.url ? [`地址: ${task.startup.url}`] : []),
    ...(task.backgroundOptions?.readiness?.type === 'tcp' ? [`监听端口: ${task.backgroundOptions.readiness.port}`] : []),
    `确认依据: ${task.startup?.evidence || '已配置的就绪条件通过'}`, `日志: ${task.logPath}`, '',
    '启动步骤已成功，进程继续在后台运行，软件继续监控。',
    '请继续原任务的后续验证或开发工作，无需等待服务退出，不要重复启动或轮询。',
    '服务启动成功只表示这一步完成；是否报告【任务完成】应依据用户原始目标。'].join('\n') + backgroundDependencyContext(task)
}

export function buildBackgroundStartupTimeout(task: BackgroundTask): string {
  return ['【后台服务就绪未确认】', `任务: ${task.name}`, `PID: ${task.pid}`, `目标: ${task.targetLabel}`, `日志: ${task.logPath}`,
    '进程仍在运行，但在规定时间内未确认就绪。软件保留原进程，没有自动重启。',
    '启动标准输出:', logExcerpt(task.output) || '（无输出）', '启动错误输出:', logExcerpt(task.errorOutput) || '（无错误输出）',
    '请根据现有进程和日志诊断，不要直接重复启动；此通知不代表进程已退出。'].join('\n') + backgroundDependencyContext(task)
}

/** Queue creation confirmations and final results for their original conversation. */
export class BackgroundTaskResults {
  private readonly pending = new Map<string, PendingResult>()
  private readonly known = new Set<string>()
  private readonly generations = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private sending = false
  private sendingId: string | null = null
  private sendAbort: AbortController | null = null
  private cancellationEpoch = 0
  private disposed = false

  constructor(private readonly deps: ResultDeliveryDeps) {}
  get isSending(): boolean { return this.sendingId !== null }

  /** Milestones returned by wait_for use its ordinary result delivery, never a second notification. */
  consume(taskId: string, kinds: BackgroundTaskNotificationKind[]): void {
    for (const kind of kinds) {
      const id = `${kind}:${taskId}`
      if (this.sendingId === id) continue
      this.known.add(id)
      this.pending.delete(id)
      const latest = this.deps.latest?.(taskId)
      const delivery = kind === 'created' ? latest?.creationDeliveryStatus : kind === 'ready' ? latest?.readinessDeliveryStatus : kind === 'startup-timeout' ? latest?.timeoutDeliveryStatus : latest?.deliveryStatus
      if (!delivery || delivery === 'pending') this.report(taskId, kind, 'superseded')
    }
  }

  reconcile(): void {
    for (const [id, entry] of this.pending) if (this.deps.current && !this.deps.current(entry.task, entry.owner)) {
      if (this.sendingId === id) this.sendAbort?.abort()
      this.pending.delete(id); this.report(entry.task.id, entry.kind, 'cancelled')
    }
  }

  /** Freeze the route and cancellation generation before the startup command runs. */
  capture(owner: BackgroundTaskResultOwner, ready: () => boolean = () => true,
    kind: BackgroundTaskNotificationKind = 'finished'): (task: BackgroundTask) => void {
    const route = { ...owner }
    const key = ownerKey(route)
    const generation = this.generations.get(key) ?? 0
    const cancellationEpoch = this.cancellationEpoch
    return task => {
      const delivery = kind === 'created' ? task.creationDeliveryStatus : kind === 'ready' ? task.readinessDeliveryStatus : kind === 'startup-timeout' ? task.timeoutDeliveryStatus : task.deliveryStatus
      if (delivery && ['sent', 'superseded', 'needs-attention', 'cancelled'].includes(delivery)) return
      const notificationId = `${kind}:${task.id}`
      if (this.disposed || this.known.has(notificationId)) return
      this.known.add(notificationId)
      if (cancellationEpoch !== this.cancellationEpoch || generation !== (this.generations.get(key) ?? 0) || this.deps.current && !this.deps.current(task, route)) {
        this.report(task.id, kind, 'cancelled')
        return
      }
      if (kind === 'created' && (task.startup?.state === 'ready' || task.startup?.state === 'timeout')) {
        this.report(task.id, kind, 'superseded'); return
      }
      if (kind !== 'created') {
        const obsolete = kind === 'finished' ? task.taskContext || task.backgroundOptions?.kind === 'service' || task.status === 'stopped' ? ['created', 'ready', 'startup-timeout'] : [] : kind === 'ready' ? ['created', 'startup-timeout'] : ['created']
        for (const previous of obsolete) {
          const previousId = previous + ':' + task.id
          if (this.sendingId !== previousId && this.pending.delete(previousId)) this.report(task.id, previous as BackgroundTaskNotificationKind, 'superseded')
        }
      }
      this.pending.set(notificationId, { task: { ...task, ...(task.startup ? { startup: { ...task.startup } } : {}) }, owner: route, ready, kind })
      this.report(task.id, kind, 'pending')
      this.schedule(0)
    }
  }

  cancel(owner: BackgroundTaskResultOwner): void {
    const key = ownerKey(owner)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    const entries = [...this.pending].filter(([, entry]) => ownerKey(entry.owner) === key)
    for (const [id] of entries) this.pending.delete(id)
    if (entries.some(([id]) => id === this.sendingId)) this.sendAbort?.abort()
    if (!this.pending.size && this.timer) { clearTimeout(this.timer); this.timer = null }
    let failure: unknown
    for (const [id, entry] of entries) try { this.report(entry.task.id, entry.kind, this.sendingId === id ? 'needs-attention' : 'cancelled') } catch (error) { failure ??= error }
    if (failure) throw failure
  }

  cancelAll(): void {
    this.cancellationEpoch++
    const entries = [...this.pending]
    this.pending.clear()
    this.sendAbort?.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let failure: unknown
    for (const [id, entry] of entries) try { this.report(entry.task.id, entry.kind, id === this.sendingId ? 'needs-attention' : 'cancelled') } catch (error) { failure ??= error }
    if (failure) throw failure
  }

  dispose(): void {
    this.disposed = true
    this.sendAbort?.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private schedule(delay = 4000): void {
    if (this.disposed || this.timer || !this.pending.size) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, delay)
  }

  private report(id: string, kind: BackgroundTaskNotificationKind, status: BackgroundTaskDeliveryStatus): void {
    const subject = kind === 'created' ? '创建确认' : kind === 'ready' ? '就绪结果' : kind === 'startup-timeout' ? '就绪未确认通知' : '结束结果'
    const message = status === 'pending' ? `${subject}等待发回原对话；页面忙碌、存在草稿、暂停或终端模式关闭时会继续等待。`
      : status === 'sent' ? `后台任务${subject}已发送给 AI。`
      : status === 'cancelled' ? `任务已手动结束，${subject}自动回传已取消；日志仍保留。`
      : status === 'superseded' ? `${subject}已由更新的任务状态接替。`
      : status === 'sending' ? `${subject}正在发送给原对话。`
      : `${subject}自动回传未确认，请检查原对话的输入框并手动发送；软件不会重复提交。`
    this.deps.onStatus(id, status, message, kind)
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.sending) return
    this.reconcile()
    this.sending = true
    try {
      for (const [id, entry] of this.pending) {
        if (this.disposed) return
        const latest = this.deps.latest?.(entry.task.id) ?? entry.task
        if (entry.kind !== 'finished') {
          if (latest.stopInProgress) continue
          const ended = ['completed', 'failed', 'exited', 'stopped'].includes(latest.status)
          const stale = (ended && (entry.kind !== 'created' || !!latest.taskContext || latest.backgroundOptions?.kind === 'service' || latest.status === 'stopped')) || latest.stopRequestedAt !== undefined ||
            (entry.kind === 'created' && latest.backgroundOptions?.kind === 'service' && ['ready', 'timeout'].includes(latest.startup?.state ?? '')) ||
            (entry.kind === 'ready' && latest.startup?.state !== 'ready') ||
            (entry.kind === 'startup-timeout' && latest.startup?.state !== 'timeout')
          if (stale) { this.pending.delete(id); this.report(entry.task.id, entry.kind, 'superseded'); continue }
          if (latest.status !== 'running' && entry.kind !== 'created') continue
        }
        let eligible = false
        try { eligible = entry.ready() && this.deps.canSend(entry.owner, latest) } catch { /* A view may be navigating. */ }
        if (!eligible) continue
        this.sendingId = id
        this.sendAbort = new AbortController()
        this.report(entry.task.id, entry.kind, 'sending')
        let outcome: SendOutcome
        try { outcome = await this.deps.send(entry.kind === 'created'
          ? buildBackgroundTaskCreated(entry.task) : entry.kind === 'ready' ? buildBackgroundTaskReady(entry.task)
            : entry.kind === 'startup-timeout' ? buildBackgroundStartupTimeout(entry.task) : buildBackgroundTaskResult(entry.task), entry.owner, entry.task, this.sendAbort.signal) }
        catch { outcome = 'unknown' }
        if (this.disposed) return
        if (this.pending.get(id) !== entry) {
          if (outcome === 'ok') this.report(entry.task.id, entry.kind, 'sent') // Positive late acknowledgement updates history only.
          return
        }
        if (outcome === 'ok' || outcome === 'stuck' || outcome === 'insert-failed' || outcome === 'unknown' || outcome === 'stale') {
          this.pending.delete(id)
          this.report(entry.task.id, entry.kind, outcome === 'ok' ? 'sent' : 'needs-attention')
        }
        else this.report(entry.task.id, entry.kind, 'pending')
        this.deps.onOutcome?.(entry.task, outcome)
        // Allow the page to acknowledge/generate before attempting another result.
        break
      }
    } finally {
      this.sending = false
      this.sendingId = null
      this.sendAbort = null
      this.deps.onIdle?.()
      this.schedule()
    }
  }
}
