import { parseReadToolPromptRequest, toolPromptReadReply } from '../shared/tool-prompts'
import type { ToolPromptLookup, ToolPromptName, ToolPromptReadCall } from '../shared/tool-prompts'
import type { TaskResultSendOutcome } from './task-progression'

interface Dependencies {
  current(call: ToolPromptReadCall): boolean
  /** Built when the reply is sent, so it reflects the conversation's tools at that moment. */
  lookup(name: ToolPromptName): ToolPromptLookup
  send(text: string, call: ToolPromptReadCall, signal: AbortSignal, current: () => boolean): Promise<TaskResultSendOutcome>
  note(message: string): void
}

/** Sends one requested tool definition back to the AI; a busy page is retried, nothing else is. */
export class ToolPromptReads {
  private operation: { call: ToolPromptReadCall; abort: AbortController; text: string; attempts: number;
    timer?: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly dependencies: Dependencies) {}

  get busy(): boolean { return this.operation !== null }

  receive(call: ToolPromptReadCall): void {
    if (this.operation || !this.dependencies.current(call)) return
    let request: unknown
    try { request = JSON.parse(call.rawJson) } catch { request = null }
    const parsed = parseReadToolPromptRequest(request)
    const operation = { call, abort: new AbortController(), attempts: 0,
      text: toolPromptReadReply(parsed, name => this.dependencies.lookup(name)) }
    this.operation = operation
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
    try { outcome = await this.dependencies.send(operation.text, operation.call, operation.abort.signal, () => this.current(operation)) }
    catch { outcome = 'unknown' }
    if (!this.current(operation)) { if (this.operation === operation) this.cancel(); return }
    if ((outcome === 'busy' || outcome === 'no-composer') && ++operation.attempts < 60) {
      operation.timer = setTimeout(() => {
        void this.deliver(operation).catch(() => { if (this.operation === operation) this.cancel() })
      }, 2000)
      operation.timer.unref?.()
      return
    }
    if (outcome !== 'ok') this.dependencies.note('工具说明未能自动发回 AI，可让 AI 重新读取。')
    this.cancel()
  }

  reconcile(): void {
    if (this.operation && !this.current(this.operation)) this.cancel()
  }

  cancel(): void {
    const operation = this.operation
    this.operation = null
    if (!operation) return
    if (operation.timer) clearTimeout(operation.timer)
    operation.abort.abort()
  }
}
