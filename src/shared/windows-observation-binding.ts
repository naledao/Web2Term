import type { ComputerUseActionDefinition } from './computer-use'

export interface ObservationBinding { source_step_id: string; expires_at: string }
export const VALIDATE_OBSERVATION_DEFINITION: ComputerUseActionDefinition = {
  action: 'validate_observation',
  description: '按需只读复核当前任务最近一次观察，不是每次输入的必要前置步骤。可核对同组 element_id 或上传图片坐标 x/y，不混用或猜测编号。窗口图像坐标按点击相同的来源身份、几何、DPI及映射规则复核，不要求无关动画或旧整图不变；桌面坐标核对落点局部图像。成功返回 coordinate，包含物理落点、显示器和绝对坐标。purpose 默认 inspect；控件 pointer/keyboard 按各自目标要求复核。来源或目标失效时返回 stale_observation，最多补取一次新观察。此动作不输入、不激活、不消费输入机会，也不授予下一步许可；实际输入仍在原生派发前核对真实窗口、路由和命中。截图与UIA不是原子快照。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '本任务最近一次 observe 返回的 observation_id；组合观察可使用图片或 controls 编号，控件必须属于相应控件观察。' },
    { name: 'element_id', type: 'string', required: false, minLength: 35, maxLength: 35, description: '同一观察的真实控件编号，与 x/y 互斥。' },
    { name: 'x', type: 'integer', required: false, minimum: 0, maximum: 8191, description: '原 PNG 左上角为 0 的实际上传图像像素，须与 y 一起提供并位于图像内容内；不提供桌面坐标或 DPI 倍率。' },
    { name: 'y', type: 'integer', required: false, minimum: 0, maximum: 8191, description: '实际上传图像像素坐标，须与 x 一起提供。' },
    { name: 'purpose', type: 'string', required: false, enum: ['inspect', 'pointer', 'keyboard'], description: '默认 inspect；pointer 必须有控件或图像坐标，keyboard 必须有焦点控件。显示器概览不作为窗口输入目标。' }
  ],
  example: { observation_id: 'obs_' + '0'.repeat(32) }
}
export function validateObservationCheckParameters(p: Record<string, unknown>): string | null {
  const id = (v: unknown, prefix: string): boolean => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
  const pixel = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 8191
  const hasPoint = p.x !== undefined || p.y !== undefined, purpose = p.purpose ?? 'inspect'
  return Object.keys(p).some(k => !['observation_id', 'element_id', 'x', 'y', 'purpose'].includes(k)) || !id(p.observation_id, 'obs_') ||
    (p.element_id !== undefined && !id(p.element_id, 'el_')) || (hasPoint && (!pixel(p.x) || !pixel(p.y) || p.element_id !== undefined)) ||
    !['inspect', 'pointer', 'keyboard'].includes(purpose as string) || (purpose === 'pointer' && !hasPoint && p.element_id === undefined) ||
    (purpose === 'keyboard' && p.element_id === undefined) ? '观察复核只接受真实观察编号、互斥控件／完整图像坐标及用途，不接受窗口、任务、原生句柄或脚本覆盖。' : null
}
export const OBSERVATION_STALE_REASONS = ['expired', 'unknown_observation', 'source_step_mismatch', 'window_changed', 'window_state_changed', 'layout_changed', 'focus_changed', 'popup_changed', 'desktop_changed', 'image_changed', 'element_changed', 'element_unavailable', 'locator_unavailable', 'state_unavailable', 'input_target_unavailable'] as const
