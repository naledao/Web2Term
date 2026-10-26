import { COMPUTER_USE_PROTOCOL_VERSION, computerUseParametersMatch, normalizeComputerUseActionDefinition } from '../shared/computer-use'
import type { ComputerUseActionDefinition, ComputerUseCapability, ComputerUseToolCall, ComputerUseToolResult, ComputerUseImageReference } from '../shared/computer-use'
import type { TaskLease } from '../shared/autonomous-task'
import type { DesktopCoordinator, DesktopPermit } from './desktop-coordinator'
import type { WindowsHelperActionResult } from '../shared/windows-helper'

export interface ComputerUseDispatchContext {
  /** Trusted main-process task identity; never accepted from model action parameters. */
  lease?: TaskLease
  /** Main-issued consumed step provenance, never read from action parameters. */
  step?: { id: string; token: string | null; sourceMessageId: string }
  /** Re-read live scope and settings immediately before dispatch. */
  capability(): ComputerUseCapability
  isCurrent(): boolean
  signal?: AbortSignal
  /** Process-local execution credential, never accepted in model JSON. */
  desktopPermit?: DesktopPermit
  /** Session-owned background monitor bridge, never a helper or model-supplied executor. */
  waitForBackground?(parameters: Record<string, unknown>): Promise<{ message: string; data: unknown }>
}

export interface ComputerUseActionHandler {
  /** Action-specific validation is mandatory; definitions alone do not authorize an input. */
  validate(parameters: Record<string, unknown>): string | null
  execute(parameters: Record<string, unknown>, context: ComputerUseDispatchContext): Promise<{ message: string; data?: unknown; attachments?: ComputerUseImageReference[] }>
}

/** Trusted adapters use this to preserve a backend's known failure/execution state. */
export class ComputerUseActionError extends Error {
  constructor(readonly result: Pick<ComputerUseToolResult, 'code' | 'message' | 'execution' | 'data' | 'attachments'>) { super(result.message) }
}

/** Preserve an actual interruption receipt before success-payload or post-observation validation. */
export function throwIfDesktopInterrupted(response: WindowsHelperActionResult): void {
  if (['external_input', 'human_takeover', 'input_monitor_unavailable'].includes(response.code))
    throw new ComputerUseActionError({ code: response.code as ComputerUseToolResult['code'], execution: response.execution,
      message: response.message, data: { helper_code: response.code } })
}

/** Desktop dispatch has no shell fallback. Only explicitly registered executors can run. */
export class ComputerUseTool {
  private readonly actions = new Map<string, { definition: ComputerUseActionDefinition; handler: ComputerUseActionHandler }>()

  constructor(private readonly changed: () => void = () => {}, private readonly desktop?: DesktopCoordinator) {}

  register(definition: ComputerUseActionDefinition, handler: ComputerUseActionHandler): () => void {
    const normalized = normalizeComputerUseActionDefinition(definition)
    if (!normalized || typeof handler?.validate !== 'function' || typeof handler.execute !== 'function') {
      throw new Error('invalid-computer-use-registration')
    }
    if (this.actions.has(normalized.action)) throw new Error('duplicate-computer-use-action')
    if (this.actions.size >= 32) throw new Error('too-many-computer-use-actions')
    const entry = { definition: normalized, handler: { validate: handler.validate.bind(handler), execute: handler.execute.bind(handler) } }
    this.actions.set(normalized.action, entry)
    this.changed()
    return () => {
      if (this.actions.get(normalized.action) !== entry) return
      this.actions.delete(normalized.action)
      this.changed()
    }
  }

  definitions(): ComputerUseActionDefinition[] {
    return structuredClone([...this.actions.values()].map(entry => entry.definition))
  }

  async invoke(call: ComputerUseToolCall, context: ComputerUseDispatchContext): Promise<ComputerUseToolResult> {
    const action = typeof call?.action === 'string' ? call.action : ''
    const result = (code: ComputerUseToolResult['code'], message: string,
      execution: ComputerUseToolResult['execution'] = 'not_executed', data?: unknown): ComputerUseToolResult => ({
      type: 'computer_result', version: COMPUTER_USE_PROTOCOL_VERSION, action,
      ok: code === 'ok', execution, code, message, ...(data === undefined ? {} : { data })
    })
    const guard = (): ComputerUseToolResult | null => {
      if (!context.isCurrent()) return result('inactive_context', '原调用上下文已失效，本次动作未执行。')
      if (context.signal?.aborted) return result('cancelled', '动作已取消，本次未执行。')
      const capability = context.capability()
      if (!capability.scopeSupported || !capability.enabled || !capability.available) return result('unavailable', capability.message)
      return null
    }
    const blocked = guard()
    if (blocked) return blocked
    const entry = this.actions.get(action)
    if (!entry || !context.capability().actions.includes(action)) return result('unknown_action', '当前没有可调用的这个 computer 动作。')
    let parameters: Record<string, unknown>
    try {
      parameters = structuredClone(call.parameters)
      if (!computerUseParametersMatch(entry.definition, parameters)) return result('invalid_parameters', '动作参数缺失、包含未知字段或类型不匹配。')
      const invalid = entry.handler.validate(parameters)
      if (invalid !== null) return result('invalid_parameters', invalid || '动作参数未通过执行器校验。')
    } catch {
      return result('invalid_parameters', '执行器未能确认动作参数，本次未执行。')
    }
    // A validator may discover that the task/settings/backend changed. Check again before executing.
    const changed = guard()
    if (changed) return changed
    const usesDesktop = !(action === 'wait_for' && ['background_ready', 'background_finished'].includes(parameters.condition as string))
    if (this.desktop && usesDesktop && (!context.lease || !this.desktop.authorizes(context.desktopPermit, context.lease, 'desktop')))
      return result('inactive_context', '本次桌面动作没有当前任务的全局运行凭据，未派发。')
    if (this.actions.get(action) !== entry || !context.capability().actions.includes(action)) return result('unavailable', '动作执行器已停止或不可用，本次未执行。')
    try {
      const output = await entry.handler.execute(parameters, context)
      return { ...result('ok', output.message, 'executed', output.data), ...(output.attachments?.length ? { attachments: structuredClone(output.attachments) } : {}) }
    } catch (error) {
      if (error instanceof ComputerUseActionError) return { ...result(error.result.code, error.result.message, error.result.execution, error.result.data),
        ...(error.result.attachments?.length ? { attachments: structuredClone(error.result.attachments) } : {}) }
      // The executor may have performed input before throwing. Never promise a rollback or safe replay.
      return result('executor_error', '动作执行器异常，操作是否生效尚未确认；请先核对实际状态。', 'unknown')
    }
  }
}
