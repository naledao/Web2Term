import { parseReadToolPromptRequest, toolPromptReadReply } from '../shared/tool-prompts'
import type { ToolPromptLookup, ToolPromptName, ToolPromptReadCall } from '../shared/tool-prompts'
import type { TaskResultSendOutcome } from './task-progression'
import type { FocusToolObserver } from '../shared/focus-chat'

interface Dependencies {
  current(call: ToolPromptReadCall): boolean
  /** Built when the reply is sent, so it reflects the conversation's tools at that moment. */
  lookup(name: ToolPromptName): ToolPromptLookup
  send(text: string, call: ToolPromptReadCall, signal: AbortSignal, current: () => boolean): Promise<TaskResultSendOutcome>
  note(message: string): void
  observe?(call: ToolPromptReadCall): FocusToolObserver | undefined
}

/** Sends one requested tool definition back to the AI; a busy page is retried, nothing else is. */
export class ToolPromptReads {
  private operation: { call: ToolPromptReadCall; abort: AbortController; text: string; attempts: number; sending: boolean;
    observe?: FocusToolObserver;
    timer?: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly dependencies: Dependencies) {}

  get busy(): boolean { return this.operation !== null }

  receive(call: ToolPromptReadCall): void {
    if (this.operation || !this.dependencies.current(call)) return
    let request: unknown
    try { request = JSON.parse(call.rawJson) } catch { request = null }
    const parsed = parseReadToolPromptRequest(request)
    const unavailable: string[] = []
    const operation = { call, abort: new AbortController(), attempts: 0, sending: false, observe: this.dependencies.observe?.(call),
      text: toolPromptReadReply(parsed, name => {
        const result = this.dependencies.lookup(name)
        if ('unavailable' in result) unavailable.push(name + '：' + result.unavailable)
        return result
      }) }
    this.operation = operation
    operation.observe?.({ status: parsed ? 'done' : 'failed', result: parsed
      ? [`已处理 ${parsed.tools.length} 项工具说明读取（${operation.text.length} 字符）。`, ...unavailable].join('\n') : '工具说明读取请求格式无效，已提示 AI 修正。' })
    this.dependencies.note(parsed ? '已向 AI 发送工具说明：' + parsed.tools.join('、') : '工具说明读取请求格式无效，已提示 AI 修正。')
    void this.deliver(operation).catch(() => { if (this.operation === operation) this.cancel() })
  }

  private current(operation: NonNullable<ToolPromptReads['operation']>): boolean {
    try { return this.operation === operation && !operation.abort.signal.aborted && this.dependencies.current(operation.call) }
    catch { return false }
  }

  private async deliver(operation: NonNullable<ToolPromptReads['operation']>): Promise<void> {
    if (!this.current(operation)) { if (this.operation === operation) this.cancel(); return }
    let outcome: TaskResultSendOutcome
    operation.sending = true
    try { outcome = await this.dependencies.send(operation.text, operation.call, operation.abort.signal, () => this.current(operation)) }
    catch { outcome = 'unknown' }
    operation.sending = false
    const current = this.current(operation)
    operation.observe?.({ delivery: outcome === 'ok' ? 'sent' : outcome === 'unknown' ? 'unknown'
      : outcome === 'busy' || outcome === 'no-composer' ? current ? 'pending' : 'blocked' : outcome === 'stale' ? 'blocked' : 'failed' })
    if (!current) { if (this.operation === operation) this.clear(); return }
    if ((outcome === 'busy' || outcome === 'no-composer') && ++operation.attempts < 60) {
      operation.observe?.({ delivery: 'pending' })
      operation.timer = setTimeout(() => {
        void this.deliver(operation).catch(() => { if (this.operation === operation) this.cancel() })
      }, 2000)
      operation.timer.unref?.()
      return
    }
    if (outcome === 'busy' || outcome === 'no-composer') operation.observe?.({ delivery: 'failed' })
    if (outcome !== 'ok') this.dependencies.note('工具说明未能自动发回 AI，可让 AI 重新读取。')
    this.clear()
  }

  reconcile(): void {
    if (this.operation && !this.current(this.operation)) this.cancel()
  }

  cancel(): void {
    this.operation?.observe?.({ delivery: this.operation.sending ? 'unknown' : 'blocked' })
    this.clear()
  }
  private clear(): void {
    const operation = this.operation
    this.operation = null
    if (!operation) return
    if (operation.timer) clearTimeout(operation.timer)
    operation.abort.abort()
  }
}
