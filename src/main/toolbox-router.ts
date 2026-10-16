import { TOOLBOX_METHODS } from '../shared/toolbox'
import type { ToolboxInvocation, ToolboxMethod } from '../shared/toolbox'
import type { AppApi } from '../shared/types'

/** Explicit routing prevents delayed requests from using a newly selected session. */
export class ToolboxRouter<Runtime> {
  private handlers = new Map<ToolboxMethod, (runtime: Runtime, args: unknown[]) => unknown>()
  constructor(private readonly resolve: (sessionId: string) => Runtime | undefined) {}

  register<K extends ToolboxMethod>(method: K, handler: (runtime: Runtime, ...args: Parameters<AppApi[K]>) => unknown): void {
    this.handlers.set(method, (runtime, args) => handler(runtime, ...args as Parameters<AppApi[K]>))
  }

  invoke(request: ToolboxInvocation): unknown {
    if (!request || typeof request.sessionId !== 'string' || !request.sessionId || request.sessionId.length > 200 ||
      typeof request.method !== 'string' || !Object.hasOwn(TOOLBOX_METHODS, request.method) ||
      !Array.isArray(request.args) || request.args.length > 8) throw new Error('工具请求无效。')
    const runtime = this.resolve(request.sessionId)
    if (!runtime) throw new Error('原会话已关闭，请重新打开工具。')
    const handler = this.handlers.get(request.method)
    if (!handler) throw new Error('工具操作不可用。')
    return handler(runtime, request.args)
  }
}
