import type { ComputerUseActionDefinition } from './computer-use'
import { UIA_ROLES } from './windows-controls'
import type { ControlTreeObservation } from './windows-controls'
import type { DesktopWindow } from './windows-desktop'

export const WAIT_FOR_DEFINITION: ComputerUseActionDefinition = {
  action: 'wait_for',
  description: '只读、有界等待。后台条件 background_ready／background_finished 只接受本目标真实 background_id，由主进程订阅既有后台监控，默认等待 600000 毫秒，最多 3600000 毫秒；不接受桌面筛选字段或 observation，不调用原生 helper，不采集截图，不启动或停止进程。等待开始前持久化启动步骤、依赖步骤和机器关联；就绪仅依据原服务就绪证据，成功结束需最终日志回读及退出码 0。失败、未知退出码、手动停止和超时返回真实状态；产物和整体业务目标仍需后续验证。无依赖的工作可以先继续，依赖步骤用此工具等待，禁止重复启动或高频模型轮询。桌面固定条件：window_present 按 query 子串和可选 pid 发现唯一可见普通窗口；text_present 在已知 window_id 的 UIA 可见非密码控件名称中查找 text 子串（区分大小写，不是 OCR／文档全文）；control_available 在该窗口按 selector.name 精确名称及可选 role 等待唯一可见且启用的控件。条件字段互斥，不接受脚本、正则、原生句柄或固定休眠。桌面 timeout_ms 默认 10000，范围 100—30000；本地异步检查并退避，不反复请求模型或上传截图。多窗口／多控件不任意选第一个；部分读取、提供方错误及超时不当作完成。桌面等待结束时最多补取一次新观察，observation 默认 controls，可选 window（截图加控件），该采集有独立期限。返回 condition_met、最后检查、耗时及最新观察或采集失败。新观察仍需支持条件，才报告满足；目标变化或无法确认时明确失败。窗口发现保留原引用，wait_for 返回的窗口引用可继续 observe/focus_window；后续输入仍需新观察及原生复核。事件修订只用于退避和检查变化，不把稳定、等待结束或一次条件满足当成业务成功。取消／换任务／helper 更换停止后续检查及回传，不点击、不聚焦、不输入，不自动无界重试。',
  parameters: [
    { name: 'condition', type: 'string', required: true, enum: ['window_present', 'text_present', 'control_available', 'background_ready', 'background_finished'], description: '桌面条件，或等待已有后台任务的服务就绪／最终结束结果；后者只订阅现有监控，不启动进程。' },
    { name: 'background_id', type: 'string', required: false, minLength: 36, maxLength: 36, description: 'background_ready／background_finished 必填，取自本任务真实后台登记结果的 background_id，不接受 PID、任务名或任意日志路径。服务就绪不等于业务成功；结束条件仅在最终日志回读且退出码为 0 时满足。' },
    { name: 'query', type: 'string', required: false, minLength: 1, maxLength: 200, description: '仅 window_present 必填，按真实标题／进程名／路径／AppUserModelID 子串匹配，忽略大小写，不接受空白查询。' },
    { name: 'pid', type: 'integer', required: false, minimum: 1, maximum: 4294967295, description: '仅 window_present 可选的进程筛选，不能代替真实窗口身份。' },
    { name: 'window_id', type: 'string', required: false, minLength: 36, maxLength: 36, description: 'text_present／control_available 必填，使用本任务真实窗口引用，不把旧控件编号当等待目标。' },
    { name: 'text', type: 'string', required: false, minLength: 1, maxLength: 200, description: '仅 text_present 必填，非空可见文字子串；名称被截断或树不完整时不把未匹配说成确定不存在。' },
    { name: 'selector', type: 'object', required: false, description: '仅 control_available 必填，仅含 name（1—256 字符完整精确名称）及可选 role（现有 UIA 角色）；多个同名匹配需进一步观察定位。' },
    { name: 'timeout_ms', type: 'integer', required: false, minimum: 100, maximum: 3600000, description: '桌面条件默认 10000，最多 30000；后台条件默认 600000，最多 3600000。后台等待由现有监控事件唤醒；超时只返回当前事实，不终止或重复启动进程。' },
    { name: 'observation', type: 'string', required: false, enum: ['controls', 'window'], description: '默认 controls；window 返回一张截图及控件。无唯一窗口时返回最后发现状态，不猜测窗口或截取整个桌面。' }
  ],
  example: { condition: 'text_present', window_id: 'win_' + '0'.repeat(32), text: '完成', timeout_ms: 10000 }
}
export function validateWaitParameters(p: Record<string, unknown>): string | null {
  if (isBackgroundWait(p)) return Object.keys(p).some(k => !['condition', 'background_id', 'timeout_ms'].includes(k)) ||
    typeof p.background_id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(p.background_id) ||
    p.timeout_ms !== undefined && (!Number.isSafeInteger(p.timeout_ms) || Number(p.timeout_ms) < 100 || Number(p.timeout_ms) > 3600000)
    ? '后台等待只接受 background_ready／background_finished、真实 background_id 和 100—3600000 毫秒的有界 timeout_ms。' : null
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v)
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const kind = p.condition, global = kind === 'window_present', selector = p.selector
  const validSelector = object(selector) && Object.keys(selector).every(k => ['name', 'role'].includes(k)) && text(selector.name, 256) &&
    (selector.role === undefined || UIA_ROLES.includes(selector.role as typeof UIA_ROLES[number]))
  return Object.keys(p).some(k => !['condition', 'query', 'pid', 'window_id', 'text', 'selector', 'timeout_ms', 'observation'].includes(k)) ||
    !['window_present', 'text_present', 'control_available'].includes(kind as string) ||
    (global ? !text(p.query, 200) || p.window_id !== undefined || p.text !== undefined || selector !== undefined || p.pid !== undefined && (!Number.isSafeInteger(p.pid) || Number(p.pid) < 1 || Number(p.pid) > 0xffffffff)
      : typeof p.window_id !== 'string' || !/^win_[a-f0-9]{32}$/.test(p.window_id) || p.query !== undefined || p.pid !== undefined ||
        (kind === 'text_present' ? !text(p.text, 200) || selector !== undefined : !validSelector || p.text !== undefined)) ||
    p.timeout_ms !== undefined && (!Number.isSafeInteger(p.timeout_ms) || Number(p.timeout_ms) < 100 || Number(p.timeout_ms) > 30000) ||
    p.observation !== undefined && !['controls', 'window'].includes(p.observation as string)
    ? 'wait_for 只接受一个固定条件及其互斥字段、有界 timeout_ms 和 controls/window 后观察，不接受脚本、正则、句柄或休眠指令。' : null
}
export function isBackgroundWait(p: Record<string, unknown>): boolean { return p.condition === 'background_ready' || p.condition === 'background_finished' }
export interface WaitEvaluation { status: 'met' | 'not_met' | 'ambiguous' | 'unavailable'; matches: number }
/** Existence in a visible UIA name is evidence; an incomplete tree cannot establish uniqueness or absence. */
export function evaluateWaitControls(p: Record<string, unknown>, window: DesktopWindow, tree: ControlTreeObservation | null): WaitEvaluation {
  if (!tree || !window.visible || window.minimized || window.cloaked !== false) return { status: 'unavailable', matches: 0 }
  const visible = tree.elements.filter(r => r.properties_complete && r.password === false && r.offscreen === false && r.bounds !== null && r.name !== null)
  if (p.condition === 'text_present') {
    const matches = visible.filter(r => r.name!.includes(p.text as string)).length
    return { status: matches > 0 ? 'met' : tree.complete ? 'not_met' : 'unavailable', matches }
  }
  const selector = p.selector as { name: string; role?: string }
  const matches = visible.filter(r => !r.name_truncated && r.name === selector.name && (!selector.role || r.role === selector.role) && r.enabled === true && window.enabled).length
  return { status: matches > 1 ? 'ambiguous' : !tree.complete ? 'unavailable' : matches === 1 ? 'met' : 'not_met', matches }
}
