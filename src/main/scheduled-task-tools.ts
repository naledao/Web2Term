import type { ScheduledToolCall } from '../shared/scheduled-tasks'
import type { TaskResultSendOutcome } from './task-progression'
import type { FocusToolObserver } from '../shared/focus-chat'

interface Dependencies {
  current(call: ScheduledToolCall): boolean
  send(text: string, call: ScheduledToolCall, signal: AbortSignal, current: () => boolean): Promise<TaskResultSendOutcome>
  note(message: string): void
  observe?(call: ScheduledToolCall): FocusToolObserver | undefined
  schedule?(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  cancel?(timer: ReturnType<typeof setTimeout>): void
}

/** Management receipts must still be delivered after their plan is deleted or paused. */
export class ScheduledTaskTools {
  private operation: { call: ScheduledToolCall; text: string; abort: AbortController; attempts: number; sending: boolean;
    observe?: FocusToolObserver;
    timer?: ReturnType<typeof setTimeout> } | null = null
  constructor(private readonly deps: Dependencies) {}
  get busy(): boolean { return this.operation !== null }

  receive(call: ScheduledToolCall, execute: () => string | null): void {
    if (this.operation || !this.deps.current(call)) return
    let text: string | null
    try { text = execute() }
    catch {
      const message = '定时任务操作结果未能保存，请先查询当前计划状态，不要直接重复变更。'
      this.deps.observe?.(call)?.({ status: 'unknown', delivery: 'blocked', result: message })
      this.deps.note(message); return
    }
    if (text === null) return
    const operation = { call, text, abort: new AbortController(), attempts: 0, sending: false, observe: this.deps.observe?.(call) }
    this.operation = operation
    operation.observe?.({ status: text.startsWith('【定时任务操作未完成】') ? 'failed' : 'done', result: text })
    this.deps.note(text)
    void this.deliver(operation)
  }
  private current(operation: NonNullable<ScheduledTaskTools['operation']>): boolean {
    try { return this.operation === operation && !operation.abort.signal.aborted && this.deps.current(operation.call) }
    catch { return false }
  }
  private async deliver(operation: NonNullable<ScheduledTaskTools['operation']>): Promise<void> {
    if (!this.current(operation)) { if (this.operation === operation) this.cancel(); return }
    let outcome: TaskResultSendOutcome
    operation.sending = true
    try { outcome = await this.deps.send(operation.text, operation.call, operation.abort.signal, () => this.current(operation)) }
    catch { outcome = 'unknown' }
    operation.sending = false
    const current = this.current(operation)
    operation.observe?.({ delivery: outcome === 'ok' ? 'sent' : outcome === 'unknown' ? 'unknown'
      : outcome === 'busy' || outcome === 'no-composer' ? current ? 'pending' : 'blocked' : outcome === 'stale' ? 'blocked' : 'failed' })
    if (!current) { if (this.operation === operation) this.clear(); return }
    if ((outcome === 'busy' || outcome === 'no-composer') && ++operation.attempts < 60) {
      operation.observe?.({ delivery: 'pending' })
      operation.timer = (this.deps.schedule ?? setTimeout)(() => { void this.deliver(operation) }, 2000)
      operation.timer.unref?.()
      return
    }
    if (outcome === 'busy' || outcome === 'no-composer') operation.observe?.({ delivery: 'failed' })
    if (outcome !== 'ok') this.deps.note('定时任务操作结果未确认发回 AI，请在「定时任务」页核对，或让 AI 重新查询；不会自动重复变更或重发不确定的消息。')
    this.clear()
  }
  reconcile(): void { if (this.operation && !this.current(this.operation)) this.cancel() }
  cancel(): void {
    this.operation?.observe?.({ delivery: this.operation.sending ? 'unknown' : 'blocked' })
    this.clear()
  }
  private clear(): void {
    const operation = this.operation
    this.operation = null
    if (!operation) return
    if (operation.timer) (this.deps.cancel ?? clearTimeout)(operation.timer)
    operation.abort.abort()
  }
}
