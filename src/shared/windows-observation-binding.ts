import type { ComputerUseActionDefinition } from './computer-use'

export interface ObservationBinding { source_step_id: string; expires_at: string }
export const VALIDATE_OBSERVATION_DEFINITION: ComputerUseActionDefinition = {
  action: 'validate_observation',
  description: '只读复核当前任务最近一次 observe 的 observation_id，可核对该观察中的 element_id 或上传图片坐标 x/y；图像定位复核成功时返回 coordinate，含物理落点、显示器归属和虚拟桌面绝对坐标，留边、屏幕空隙或不可见落点不作输入定位；不能混用不同观察或猜测编号。purpose 默认 inspect；pointer／keyboard 检查对应的前台、焦点和目标可用性。窗口、布局、焦点、弹窗、显示器、图像或控件身份变化时返回 stale_observation，并最多自动补取一次原来源的新观察；原定位不执行，使用新编号重新判断。此动作不会点击、输入、激活或授予下一步输入许可，后续输入动作必须在原生派发入口再次实时复核。截图与 UIA 并非原子快照，检查只代表采集时状态。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '本任务最近一次 observe 返回的 observation_id；组合观察可使用图片或 controls 编号，控件必须属于相应控件观察。' },
    { name: 'element_id', type: 'string', required: false, minLength: 35, maxLength: 35, description: '同一观察的真实控件编号，与 x/y 互斥。' },
    { name: 'x', type: 'integer', required: false, minimum: 0, maximum: 2559, description: '原 PNG 左上角为 0 的实际上传图像像素，须与 y 一起提供并位于图像内容内；不提供桌面坐标或 DPI 倍率。' },
    { name: 'y', type: 'integer', required: false, minimum: 0, maximum: 2559, description: '实际上传图像像素坐标，须与 x 一起提供。' },
    { name: 'purpose', type: 'string', required: false, enum: ['inspect', 'pointer', 'keyboard'], description: '默认 inspect；pointer 必须有控件或图像坐标，keyboard 必须有焦点控件。显示器概览不作为窗口输入目标。' }
  ],
  example: { observation_id: 'obs_' + '0'.repeat(32) }
}
export function validateObservationCheckParameters(p: Record<string, unknown>): string | null {
  const id = (v: unknown, prefix: string): boolean => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
  const pixel = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2559
  const hasPoint = p.x !== undefined || p.y !== undefined, purpose = p.purpose ?? 'inspect'
  return Object.keys(p).some(k => !['observation_id', 'element_id', 'x', 'y', 'purpose'].includes(k)) || !id(p.observation_id, 'obs_') ||
    (p.element_id !== undefined && !id(p.element_id, 'el_')) || (hasPoint && (!pixel(p.x) || !pixel(p.y) || p.element_id !== undefined)) ||
    !['inspect', 'pointer', 'keyboard'].includes(purpose as string) || (purpose === 'pointer' && !hasPoint && p.element_id === undefined) ||
    (purpose === 'keyboard' && p.element_id === undefined) ? '观察复核只接受真实观察编号、互斥控件／完整图像坐标及用途，不接受窗口、任务、原生句柄或脚本覆盖。' : null
}
export const OBSERVATION_STALE_REASONS = ['expired', 'unknown_observation', 'source_step_mismatch', 'window_changed', 'window_state_changed', 'layout_changed', 'focus_changed', 'popup_changed', 'desktop_changed', 'image_changed', 'element_changed', 'element_unavailable', 'locator_unavailable', 'state_unavailable', 'input_target_unavailable'] as const
