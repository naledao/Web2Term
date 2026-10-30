import { randomUUID } from 'node:crypto'
import { parseScheduledTaskRequest, scheduleLabel } from '../shared/scheduled-tasks'
import type { ScheduledTask, ScheduledTaskAction, ScheduledTaskDraft, ScheduledTaskManagementRequest, ScheduledTaskRequest, ScheduledTaskRun, ScheduledTaskTarget } from '../shared/scheduled-tasks'
import type { ConversationToolsOwner } from '../shared/conversation-tools'
import { dueScheduledTime, nextScheduledTime } from './scheduled-task-time'
import { ScheduledTaskStore } from './scheduled-task-store'

export interface ScheduledDelivery {
  outcome: 'ok' | 'busy' | 'no-composer' | 'unavailable' | 'invalid' | 'helper-not-ready' | 'stuck' | 'insert-failed' | 'unknown' | 'cancelled' | 'stale'
  autonomousTaskId?: string | null
  message?: string
}
export interface ScheduledTasksDeps {
  ready(task: ScheduledTask, run: ScheduledTaskRun): string | null
  send(task: ScheduledTask, run: ScheduledTaskRun, signal: AbortSignal): Promise<ScheduledDelivery>
  changed(sessionId: string): void
  now?(): number
  schedule?(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  cancel?(timer: ReturnType<typeof setTimeout>): void
}

export class ScheduledTasks {
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private pumping = false
  private wakeAgain = false
  private readonly sending = new Map<string, AbortController>()
  constructor(readonly store: ScheduledTaskStore, private readonly deps: ScheduledTasksDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now() }

  start(): void {
    if (this.started) return
    // A process exit during web submission cannot prove that the remote site rejected it.
    for (;;) {
      const runs = this.store.runs('sending')
      if (!runs.length) break
      for (const run of runs) this.updateRun(run, 'needs-attention', '软件在投递期间退出，是否已发送需要核对原对话；不会自动重发。')
    }
    this.started = true
    this.wake()
  }
  dispose(): void {
    this.started = false
    this.clearTimer()
    for (const controller of this.sending.values()) controller.abort()
  }
  wake(): void {
    if (!this.started) return
    if (this.pumping) { this.wakeAgain = true; return }
    this.arm(0)
  }
  private clearTimer(): void {
    if (this.timer !== null) (this.deps.cancel ?? clearTimeout)(this.timer)
    this.timer = null
  }
  private arm(delay: number): void {
    this.clearTimer()
    this.timer = (this.deps.schedule ?? setTimeout)(() => { this.timer = null; void this.tick() }, Math.max(1, delay))
    this.timer.unref?.()
  }
  private planNext(): void {
    if (!this.started) return
    const next = this.store.nextTime()
    const pending = this.store.runs('pending').length > 0
    this.arm(this.wakeAgain ? 1 : Math.min(60_000, pending ? 10_000 : 60_000, next === null ? 60_000 : Math.max(1, next - this.now())))
    this.wakeAgain = false
  }
  create(owner: ConversationToolsOwner, target: ScheduledTaskTarget, input: ScheduledTaskRequest, sourceKey: string, receipt = false, receiptSubmissionId?: string): ScheduledTask {
    const request = parseScheduledTaskRequest(input)
    if (!request) throw new Error('周期或任务描述无效；间隔至少 1 分钟，任务描述最多 16000 字。')
    if (!owner.conversationId) throw new Error('请先在当前 AI 对话发送一条消息，再创建定时任务。')
    const now = this.now(), nextRunAt = nextScheduledTime(request.schedule, now)
    const task = this.store.transaction(() => {
      const existing = this.store.bySource(sourceKey)
      if (existing) return existing
      const task: ScheduledTask = { ...request, id: randomUUID(), owner: { ...owner, conversationId: owner.conversationId! },
        target: { ...target }, sourceKey, receiptSubmissionId, enabled: true, deleted: false, revision: 1, nextRunAt, createdAt: now, updatedAt: now }
      this.store.save(task)
      if (receipt) this.store.insertRun(task, now, now, 'receipt', 'receipt', [
        '【定时任务已创建】', `任务编号：${task.id}`, `版本：${task.revision}`, `周期：${scheduleLabel(task.schedule)}`,
        `下次触发：${new Date(task.nextRunAt).toISOString()}`, `任务：${task.prompt}`,
        '计划已保存，本次不立即执行。请简短确认并按原任务流程结束本次创建任务，等待软件到期提交新任务，不要重复创建。'
      ].join('\n'))
      return task
    })
    this.deps.changed(owner.sessionId); this.wake()
    return task
  }
  /** Apply a model operation and its replay marker atomically; receipts do not depend on a live plan. */
  manage(owner: ConversationToolsOwner, request: ScheduledTaskManagementRequest, sourceKey: string): string | null {
    if (this.store.toolResult(sourceKey) !== undefined) return null
    const now = this.now()
    let changedId: string | null = null
    const details = (task: ScheduledTask) => ({ id: task.id, revision: task.revision, enabled: task.enabled,
      schedule: task.schedule, prompt: task.prompt, nextRunAt: new Date(task.nextRunAt).toISOString() })
    let text: string
    try {
      text = this.store.transaction(() => {
        let result: string
        if (!owner.conversationId) throw new Error('请先在当前 AI 对话发送一条消息。')
        if (request.action === 'list') {
          const tasks = this.store.tasks(owner.sessionId).filter(task => task.owner.platformId === owner.platformId && task.owner.conversationId === owner.conversationId)
          const page = tasks.slice(request.offset, request.offset + 10)
          result = '【定时任务列表】\n' + JSON.stringify({ total: tasks.length,
            tasks: page.map(task => ({ ...details(task), prompt: task.prompt.slice(0, 1000), promptTruncated: task.prompt.length > 1000 })),
            nextOffset: request.offset + page.length < tasks.length ? request.offset + page.length : null })
        } else {
          const task = this.owned(owner.sessionId, request.id)
          if (task.owner.platformId !== owner.platformId || task.owner.conversationId !== owner.conversationId) throw new Error('只能管理当前 AI 平台和对话的定时任务。')
          if (request.action === 'get') result = '【定时任务详情】\n' + JSON.stringify(details(task))
          else {
            if (request.revision !== task.revision) throw new Error('计划已被修改，请重新查询最新 id 和 revision 后再操作。')
            if (request.action === 'update') {
              const input = parseScheduledTaskRequest({ type: 'scheduled_task', schedule: request.schedule ?? task.schedule, prompt: request.prompt ?? task.prompt })
              if (!input) throw new Error('周期或任务描述无效。')
              const next = { ...task, ...input, revision: task.revision + 1, nextRunAt: nextScheduledTime(input.schedule, now), updatedAt: now }
              this.store.cancelPending(task.id, '计划已修改，旧投递已取消。')
              this.store.save(next)
              result = '【定时任务已修改】\n' + JSON.stringify(details(next)) + '\n原任务编号、执行主机与目录保留，没有创建新计划。请简短确认。'
            } else {
              this.store.cancelPending(task.id, '计划已删除。')
              this.store.save({ ...task, enabled: false, deleted: true, updatedAt: now })
              result = `【定时任务已删除】\n任务编号：${task.id}\n已停止后续周期投递；已经发出的消息或正在执行的工作不会自动撤销。请简短确认。`
            }
            changedId = task.id
          }
        }
        this.store.saveToolResult(sourceKey, owner.sessionId, now, result)
        return result
      })
    } catch (error) {
      changedId = null
      text = '【定时任务操作未完成】\n' + (error instanceof Error ? error.message : '参数无效。') + '\n没有修改或删除计划；请查询当前状态后重试。'
      this.store.saveToolResult(sourceKey, owner.sessionId, now, text)
    }
    if (changedId) { this.abort(changedId); this.deps.changed(owner.sessionId); this.wake() }
    return text
  }
  edit(sessionId: string, draft: ScheduledTaskDraft): ScheduledTask {
    const task = this.owned(sessionId, draft.id!)
    if (draft.revision !== task.revision) throw new Error('计划已被修改，请刷新后重试。')
    const request = parseScheduledTaskRequest({ type: 'scheduled_task', schedule: draft.schedule, prompt: draft.prompt })
    if (!request) throw new Error('周期或任务描述无效。')
    const now = this.now(), nextRunAt = nextScheduledTime(request.schedule, now)
    this.abort(task.id)
    const next = { ...task, ...request, revision: task.revision + 1, nextRunAt, updatedAt: now }
    this.store.transaction(() => { this.store.cancelPending(task.id, '计划已修改，旧投递已取消。'); this.store.save(next) })
    this.deps.changed(sessionId); this.wake()
    return next
  }
  act(sessionId: string, id: string, action: ScheduledTaskAction, runId?: string): void {
    const task = this.owned(sessionId, id), now = this.now()
    if (action === 'skip' || action === 'confirm-sent') {
      const run = runId ? this.store.run(runId) : undefined
      if (!run || run.taskId !== id || run.status !== 'needs-attention') throw new Error('这次运行已变化，请刷新后重试。')
      this.updateRun(run, action === 'skip' ? 'skipped' : 'sent', action === 'skip' ? '用户已跳过，不再重发。' : '用户核对原对话后确认已投递。')
    } else if (action === 'run') {
      if (!task.enabled) throw new Error('请先恢复此计划，再立即运行。')
      if (this.store.hasOutstanding(id)) throw new Error('已有待投递或需要核对的运行，请先处理。')
      this.store.insertRun(task, now, now, 'manual:' + randomUUID())
    } else if (action === 'pause' || action === 'delete') {
      this.abort(id)
      this.store.transaction(() => {
        this.store.cancelPending(id, action === 'delete' ? '计划已删除。' : '计划已暂停。')
        this.store.save({ ...task, enabled: false, deleted: action === 'delete', updatedAt: now })
      })
    } else if (action === 'resume') {
      if (!task.enabled) this.store.save({ ...task, enabled: true, nextRunAt: nextScheduledTime(task.schedule, now), updatedAt: now })
    } else throw new Error('定时任务操作无效。')
    this.deps.changed(sessionId); this.wake()
  }
  private owned(sessionId: string, id: string): ScheduledTask {
    const task = typeof id === 'string' && id.length <= 128 ? this.store.get(id) : undefined
    if (!task || task.deleted || task.owner.sessionId !== sessionId) throw new Error('定时任务不属于当前工作区，或已删除。')
    return task
  }
  private abort(taskId: string): void {
    for (const [id, controller] of this.sending) if (this.store.run(id)?.taskId === taskId) controller.abort()
  }
  private updateRun(run: ScheduledTaskRun, status: ScheduledTaskRun['status'], message: string, autonomousTaskId?: string | null): void {
    if (run.status === status && run.message === message) return
    this.store.saveRun({ ...run, status, message, sentAt: status === 'sent' ? this.now() : run.sentAt,
      autonomousTaskId: autonomousTaskId ?? run.autonomousTaskId })
    if (status === 'sent' || status === 'cancelled' || status === 'skipped') this.store.prune(run.taskId)
    const task = this.store.get(run.taskId)
    if (task) this.deps.changed(task.owner.sessionId)
  }
  async tick(): Promise<void> {
    if (!this.started || this.pumping) return
    this.clearTimer(); this.pumping = true
    try {
      const now = this.now()
      for (const task of this.store.due(now)) {
        try {
          const due = dueScheduledTime(task.schedule, task.nextRunAt, now)
          this.store.transaction(() => {
            const waiting = this.store.taskRuns(task.id).find(run => run.kind === 'task' && run.revision === task.revision && run.status === 'pending' && !run.occurrenceKey.startsWith('manual:'))
            if (waiting) this.store.saveRun({ ...waiting, plannedAt: due.plannedAt, missedSince: waiting.missedSince ?? waiting.plannedAt })
            else if (!this.store.hasOutstanding(task.id)) this.store.insertRun(task, due.plannedAt, now, String(due.plannedAt), 'task', '',
              due.plannedAt > task.nextRunAt ? task.nextRunAt : null)
            this.store.save({ ...task, nextRunAt: due.nextRunAt })
            this.store.prune(task.id)
          })
        } catch (error) {
          this.store.save({ ...task, enabled: false })
          const run = this.store.insertRun(task, task.nextRunAt, now, 'invalid:' + randomUUID())
          this.updateRun(run, 'needs-attention', error instanceof Error ? error.message : '无法计算下次触发时间，计划已暂停。')
        }
        this.deps.changed(task.owner.sessionId)
      }
      const pending = this.store.runs('pending').sort((a, b) => Number(b.kind === 'receipt') - Number(a.kind === 'receipt') || a.createdAt - b.createdAt)
      const sentSessions = new Set<string>()
      for (const run of pending) {
        if (!this.started) break
        const task = this.store.get(run.taskId)
        if (!task || task.deleted || !task.enabled || task.revision !== run.revision) {
          this.updateRun(run, 'cancelled', '原计划已暂停、修改或删除。'); continue
        }
        if (sentSessions.has(task.owner.sessionId)) continue
        const reason = this.deps.ready(task, run)
        if (reason) { this.updateRun(run, reason.startsWith('cancel:') ? 'cancelled' : 'pending', reason.replace(/^cancel:/, '')); continue }
        const controller = new AbortController()
        this.sending.set(run.id, controller)
        this.updateRun(run, 'sending', '正在向原 AI 对话投递')
        let result: ScheduledDelivery
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          const timedOut = new Promise<ScheduledDelivery>(resolve => {
            deadline = (this.deps.schedule ?? setTimeout)(() => { controller.abort(); resolve({ outcome: 'unknown' }) }, 20_000)
            deadline.unref?.()
          })
          result = await Promise.race([this.deps.send(task, run, controller.signal), timedOut])
        }
        catch { result = { outcome: 'unknown' } }
        finally {
          if (deadline !== undefined) (this.deps.cancel ?? clearTimeout)(deadline)
          this.sending.delete(run.id)
        }
        // dispose may close SQLite immediately after signalling cancellation.
        if (!this.started) return
        const latest = this.store.run(run.id)
        if (!latest) continue
        if (result.outcome === 'ok') {
          this.updateRun(latest, 'sent', run.kind === 'receipt' ? '创建确认已发送' : '已投递；AI 执行结果请查看原对话。', result.autonomousTaskId)
          sentSessions.add(task.owner.sessionId)
        } else if (['busy', 'no-composer', 'unavailable', 'helper-not-ready'].includes(result.outcome) && !controller.signal.aborted) {
          this.updateRun(latest, 'pending', result.message || '原对话暂不可发送，等待恢复。')
        } else if (result.outcome === 'cancelled') this.updateRun(latest, 'cancelled', '投递前已取消。')
        else this.updateRun(latest, 'needs-attention', '发送是否成功无法确认，请核对原对话后选择「确认已投递」或「跳过本次」；不会自动重发。')
      }
    } catch (error) { console.error('[scheduled-tasks] 调度失败：', error instanceof Error ? error.message : 'unknown') }
    finally { this.pumping = false; this.planNext() }
  }
}
