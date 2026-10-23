import type { BackgroundTask, BackgroundTaskDeliveryStatus, BackgroundTaskNotificationKind } from '../shared/background-tasks'

export interface BackgroundTaskResultOwner {
  platformId: string
  conversationId: string
}

type SendOutcome = 'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed'
interface PendingResult {
  task: BackgroundTask
  owner: BackgroundTaskResultOwner
  ready: () => boolean
  kind: BackgroundTaskNotificationKind
}
interface ResultDeliveryDeps {
  canSend: (owner: BackgroundTaskResultOwner) => boolean
  send: (text: string, owner: BackgroundTaskResultOwner) => Promise<SendOutcome>
  onStatus: (id: string, status: BackgroundTaskDeliveryStatus, message: string, kind: BackgroundTaskNotificationKind) => void
}

const ownerKey = (owner: BackgroundTaskResultOwner): string => JSON.stringify([owner.platformId, owner.conversationId])
const logExcerpt = (text: string): string => text.length <= 6000 ? text
  : `${text.slice(0, 2000)}\n…[中间日志省略，完整内容见日志文件]…\n${text.slice(-4000)}`

export function buildBackgroundTaskResult(task: BackgroundTask): string {
  const status = task.status === 'completed' ? '成功' : task.status === 'failed' ? '失败' : '进程已结束，退出码未知'
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
    '以上是软件监控得到的最终结果。请据此继续必要的验证、修复或总结；此任务已结束，无需再轮询。'
  ].join('\n')
}

export function buildBackgroundTaskCreated(task: BackgroundTask): string {
  return [
    '【后台任务已创建】', `任务: ${task.name}`, `PID: ${task.pid}`, `日志: ${task.logPath}`,
    ...(task.stderrPath ? [`错误日志: ${task.stderrPath}`] : []),
    ...(task.exitCodePath ? [`退出码文件: ${task.exitCodePath}`] : []), '',
    ...(task.output ? ['启动标准输出:', logExcerpt(task.output), ''] : []),
    ...(task.errorOutput ? ['启动错误输出（stderr，有内容不代表任务失败）:', logExcerpt(task.errorOutput), ''] : []),
    '软件已登记此任务并接管监控。这条消息仅确认创建成功，不代表任务已完成。',
    '请简短确认后等待软件自动发送【后台任务执行结果】；不要发命令轮询、重复启动或报告【任务完成】。'
  ].join('\n')
}

/** Queue creation confirmations and final results for their original conversation. */
export class BackgroundTaskResults {
  private readonly pending = new Map<string, PendingResult>()
  private readonly known = new Set<string>()
  private readonly generations = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private sending = false
  private disposed = false

  constructor(private readonly deps: ResultDeliveryDeps) {}

  /** Freeze the route and cancellation generation before the startup command runs. */
  capture(owner: BackgroundTaskResultOwner, ready: () => boolean = () => true,
    kind: BackgroundTaskNotificationKind = 'finished'): (task: BackgroundTask) => void {
    const route = { ...owner }
    const key = ownerKey(route)
    const generation = this.generations.get(key) ?? 0
    return task => {
      const notificationId = `${kind}:${task.id}`
      if (this.disposed || this.known.has(notificationId)) return
      this.known.add(notificationId)
      if (generation !== (this.generations.get(key) ?? 0)) {
        this.report(task.id, kind, 'cancelled')
        return
      }
      this.pending.set(notificationId, { task: { ...task }, owner: route, ready, kind })
      this.report(task.id, kind, 'pending')
      this.schedule(0)
    }
  }

  cancel(owner: BackgroundTaskResultOwner): void {
    const key = ownerKey(owner)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
    for (const [id, entry] of this.pending) {
      if (ownerKey(entry.owner) !== key) continue
      this.pending.delete(id)
      this.report(entry.task.id, entry.kind, 'cancelled')
    }
    if (!this.pending.size && this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  private schedule(delay = 4000): void {
    if (this.disposed || this.timer || !this.pending.size) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, delay)
  }

  private report(id: string, kind: BackgroundTaskNotificationKind, status: BackgroundTaskDeliveryStatus): void {
    const subject = kind === 'created' ? '创建确认' : '结束结果'
    const message = status === 'pending' ? `${subject}等待发回原对话；页面忙碌、存在草稿、暂停或终端模式关闭时会继续等待。`
      : status === 'sent' ? `后台任务${subject}已发送给 AI。`
      : status === 'cancelled' ? `任务已手动结束，${subject}自动回传已取消；日志仍保留。`
      : `${subject}自动回传未确认，请检查原对话的输入框并手动发送；软件不会重复提交。`
    this.deps.onStatus(id, status, message, kind)
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.sending) return
    this.sending = true
    try {
      for (const [id, entry] of this.pending) {
        if (this.disposed) return
        let eligible = false
        try { eligible = entry.ready() && this.deps.canSend(entry.owner) } catch { /* A view may be navigating. */ }
        if (!eligible) continue
        let outcome: SendOutcome
        try { outcome = await this.deps.send(entry.kind === 'created'
          ? buildBackgroundTaskCreated(entry.task) : buildBackgroundTaskResult(entry.task), entry.owner) }
        catch { outcome = 'no-composer' }
        if (this.disposed || this.pending.get(id) !== entry) return
        if (outcome === 'ok' || outcome === 'stuck' || outcome === 'insert-failed') {
          this.pending.delete(id)
          this.report(entry.task.id, entry.kind, outcome === 'ok' ? 'sent' : 'needs-attention')
        }
        // Allow the page to acknowledge/generate before attempting another result.
        break
      }
    } finally {
      this.sending = false
      this.schedule()
    }
  }
}
