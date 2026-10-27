import type { ComputerUseActionDefinition } from './computer-use'

export const scrollAxis = (direction: string): 'vertical' | 'horizontal' => direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
export const scrollDelta = (direction: string, amount: number): number => (direction === 'up' || direction === 'right' ? 1 : -1) * amount * 120
export const SCROLL_DEFINITION: ComputerUseActionDefinition = {
  action: 'scroll',
  description: '在最近观察的业务窗口中向指定控件或原 PNG 像素落点滚动。必须明确选择同组 element_id 或完整 x/y，不默认使用当前鼠标或整个桌面。direction 为 up/down/left/right；amount 默认 3，范围 1—10，单位为滚轮刻度（每刻度 120），不是像素／行数，实际位移和是否到边界取决于系统及应用。先把鼠标移动到已核对的可见点，确认到达，再核对来源几何、控件、实时命中和滚轮路由；无关像素或普通悬停高亮不要求整图相同；路由不明确时不滚动，由 AI 定位区域并重新观察。水平滚动使用原生水平滚轮，不模拟 Shift+滚轮；不点击、不更改焦点或系统设置。每次最多一个有界滚轮事件，不自动连续滚到末尾或切换其他区域。窗口已前台且无菜单／捕获／按键占用时才派发，不操作本软件控制窗口。应用可能忽略或向父容器传递滚轮；接收事件不等于已移动或业务成功，必须看自动返回的新观察。取消、失效或未知结果不补滚，后观察／交付失败也不重放。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '本任务最近一组业务窗口观察编号；显示器概览不能直接授权输入。' },
    { name: 'element_id', type: 'string', required: false, minLength: 35, maxLength: 35, description: '同组真实控件，取其已核对可见区域中的落点；与完整 x/y 互斥。' },
    { name: 'x', type: 'integer', required: false, minimum: 0, maximum: 8191, description: '原上传 PNG 中要滚动区域的图像像素点，与 y 配对；不接受桌面或缩略图坐标。' },
    { name: 'y', type: 'integer', required: false, minimum: 0, maximum: 8191, description: '原上传 PNG 像素；必须属于当前可见窗口和该观察。' },
    { name: 'direction', type: 'string', required: true, enum: ['up', 'down', 'left', 'right'], description: '垂直 up/down 或水平 left/right；每次只滚一个方向。' },
    { name: 'amount', type: 'integer', required: false, minimum: 1, maximum: 10, description: '默认 3，最多 10 个滚轮刻度；实际位移必须核对新观察，不解释为像素。' }
  ],
  locatorAlternatives: [['element_id'], ['x', 'y']],
  example: { observation_id: 'obs_' + '0'.repeat(32), x: 100, y: 100, direction: 'down', amount: 3 }
}
export function validateScrollParameters(p: Record<string, unknown>): string | null {
  const id = (v: unknown, prefix: string): boolean => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
  const point = Number.isSafeInteger(p.x) && Number(p.x) >= 0 && Number(p.x) <= 8191 && Number.isSafeInteger(p.y) && Number(p.y) >= 0 && Number(p.y) <= 8191 && p.element_id === undefined
  const element = id(p.element_id, 'el_') && p.x === undefined && p.y === undefined
  const amount = p.amount === undefined ? 3 : p.amount
  return !id(p.observation_id, 'obs_') || !(point || element) || !['up', 'down', 'left', 'right'].includes(p.direction as string) ||
    !Number.isSafeInteger(amount) || Number(amount) < 1 || Number(amount) > 10 ||
    Object.keys(p).some(k => !['observation_id', 'element_id', 'x', 'y', 'direction', 'amount'].includes(k))
    ? 'scroll 只接受最新窗口观察、互斥的控件／完整图像落点、一个方向及 1—10 个滚轮刻度，不接受原生定位、脚本、按键或重复指令。' : null
}
export interface WindowsScrollReceipt {
  request_id: string; observation_id: string; source_step_id: string; window_id: string | null; element_id: string | null
  direction: 'up' | 'down' | 'left' | 'right'; amount: number; axis: 'vertical' | 'horizontal'; wheel_delta: number
  move_attempted: boolean; move_accepted: number | null; scroll_attempted: boolean; scroll_completed: boolean
  wheel_events_requested: number; wheel_events_accepted: number | null; routing: 'mouse_position' | 'focused_hit' | 'focused_descendant' | null
  point: { x: number; y: number } | null; before_at: string; completed_at: string
  scroll_verified: false; goal_verified: false; input_ready: false; validation?: unknown
}
