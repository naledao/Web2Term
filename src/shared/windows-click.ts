import type { ComputerUseActionDefinition } from './computer-use'

export const CLICK_DEFINITION: ComputerUseActionDefinition = {
  action: 'click',
  description: '点击当前任务最近一次观察中的控件或原 PNG 像素点；需要先发现、激活并观察实际业务窗口。默认左键单击，button 可为 left/right/middle，click_count 为 1 或 2。method=auto 时左键单击优先使用适用的 UIA Invoke/Toggle/SelectionItem，缺少模式时才使用鼠标；method=mouse 明确使用鼠标，右键、中键及双击始终使用鼠标。定位互斥且必须绑定 observation_id；不接受原生句柄、桌面坐标、脚本或替代窗口；本软件控制窗口不作为点击目标。鼠标移动后再次检查观察、焦点、实际控件与落点归属；失效不点，最多返回一次新观察。任何可能已生效的调用都不补点、不改用另一条输入路径。操作后自动返回新观察或明确的观察失败；点击回执不代表保存、发送、下载或业务目标完成。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '本任务最近一次 observe 的图片或组合控件观察编号。' },
    { name: 'element_id', type: 'string', required: false, minLength: 35, maxLength: 35, description: '同一观察中的真实控件编号，与完整 x/y 互斥。' },
    { name: 'x', type: 'integer', required: false, minimum: 0, maximum: 2559, description: '原上传 PNG 左上角为 0 的图像像素，须与 y 配对，不能使用桌面或缩略预览坐标。' },
    { name: 'y', type: 'integer', required: false, minimum: 0, maximum: 2559, description: '原上传 PNG 像素，与 x 配对；点必须处于真实图像内容与可见窗口中。' },
    { name: 'button', type: 'string', required: false, enum: ['left', 'right', 'middle'], description: '默认 left；对应 Win32 左／右／中键事件，不接受任意按键或修饰键。' },
    { name: 'click_count', type: 'integer', required: false, minimum: 1, maximum: 2, description: '默认 1，2 表示双击；同位置平衡的按下／释放序列，不保证应用具有双击行为。' },
    { name: 'method', type: 'string', required: false, enum: ['auto', 'mouse'], description: '默认 auto；仅左键单击的合适控件选择一次语义操作，模式调用开始后不回退鼠标。' }
  ],
  locatorAlternatives: [['element_id'], ['x', 'y']],
  example: { observation_id: 'obs_' + '0'.repeat(32), x: 100, y: 100 }
}
export function validateClickParameters(p: Record<string, unknown>): string | null {
  const id = (v: unknown, prefix: string): boolean => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
  const point = Number.isSafeInteger(p.x) && Number(p.x) >= 0 && Number(p.x) <= 2559 && Number.isSafeInteger(p.y) && Number(p.y) >= 0 && Number(p.y) <= 2559
  const element = id(p.element_id, 'el_') && p.x === undefined && p.y === undefined
  return Object.keys(p).some(k => !['observation_id', 'element_id', 'x', 'y', 'button', 'click_count', 'method'].includes(k)) || !id(p.observation_id, 'obs_') ||
    !(element || point && p.element_id === undefined) || !['left', 'right', 'middle'].includes((p.button ?? 'left') as string) ||
    ![1, 2].includes((p.click_count ?? 1) as number) || !['auto', 'mouse'].includes((p.method ?? 'auto') as string)
    ? 'click 只接受本次观察及互斥的控件／完整图像坐标、左／右／中键、单／双击和 auto／mouse，不接受原生定位、脚本或任务覆盖。' : null
}

export interface WindowsClickReceipt {
  request_id: string; observation_id: string; source_step_id: string; window_id: string | null
  button: 'left' | 'right' | 'middle'; click_count: 1 | 2; requested_method: 'auto' | 'mouse'
  method: 'none' | 'mouse' | 'uia_invoke' | 'uia_toggle' | 'uia_select'
  move_attempted: boolean; move_accepted: number | null
  click_attempted: boolean; click_completed: boolean
  button_events_requested: number; button_events_accepted: number | null
  release_required: boolean; release_attempted: boolean; release_accepted: number | null
  point: { x: number; y: number } | null
  before_at: string; completed_at: string; goal_verified: false; input_ready: false
  validation?: unknown
}
