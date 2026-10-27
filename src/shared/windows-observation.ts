import type { ComputerUseActionDefinition } from './computer-use'
import type { ControlTreeObservation } from './windows-controls'
import type { ObservationBinding } from './windows-observation-binding'
import type { DesktopCoordinateContext } from './windows-coordinates'

/** Screenshots keep their source resolution by default; this caps the longest edge (8K) and matches the native encoder. */
export const OBSERVE_MAX_DIMENSION = 8192
/** Used once, automatically, when an unscaled PNG exceeds the 8 MB attachment budget. */
export const OBSERVE_FALLBACK_DIMENSION = 2560
/** The native controls-only request carries this fixed value; it never produces an image. */
export const OBSERVE_CONTROLS_DIMENSION = 1600

export const OBSERVE_DEFINITION: ComputerUseActionDefinition = {
  action: 'observe',
  description: '按需获取单显示器概览、当前任务 list_windows／inspect_interactions／wait_for 返回的窗口或其中区域的截图；target=controls 可独立读取指定窗口的 UIA 可见控件树及焦点，无需截图。窗口截图可选 include_controls=true，将控件信息和图片同消息回传。控件字段包括 element_id、层级、role、name、enabled、focused、物理 bounds 和支持模式；include_selection 可按需读取焦点控件的选中文字，密码控件不读名称或选区。控件树有深度／数量／时间与结果预算，complete=false 及 limitations 表示部分结果；UIA 不完整时可使用截图及其他可用工具，不要求用户定位。控件编号仅对应本次观察，未提供输入许可。desktop 默认只截主屏；region 坐标为来源原始像素偏移。截图和控件树不是原子快照，返回各自时间。图像坐标以原附件左上角为 (0,0)，使用实际上传 PNG 的尺寸与 content_bounds；按裁剪／缩图采样转换到物理桌面，不额外乘系统缩放比例。窗口位置、DPI 或显示器布局变化须重新观察。观察绑定来源步骤和任务／helper 代次，最长有效 2 分钟，仅最新一组可复核；新观察或状态变化作废旧定位。可用 validate_observation 只读复核，失效会最多补取一次新观察；通过不构成后续输入许可。此工具不激活窗口、不输入、不代表任务完成。',
  parameters: [
    { name: 'target', type: 'string', required: true, enum: ['desktop', 'window', 'region', 'controls'], description: 'desktop：单屏；window：窗口截图；region：裁剪截图；controls：仅窗口控件树和焦点，无图片。' },
    { name: 'window_id', type: 'string', required: false, minLength: 36, maxLength: 36, description: '当前任务 list_windows／inspect_interactions 的真实窗口引用；window／controls 必填，region 可选，与 monitor_id 互斥。' },
    { name: 'monitor_id', type: 'string', required: false, minLength: 36, maxLength: 36, description: '原样使用 observe 返回的 monitor_id；未指定时选主屏，与 window_id 互斥。' },
    ...['x', 'y', 'width', 'height'].map(name => ({ name, type: 'integer' as const, required: false, minimum: name === 'x' || name === 'y' ? 0 : 1, maximum: 32768, description: `region 专用的 ${name}，四个字段必须齐全，矩形须完整位于来源原始像素内。` })),
    { name: 'max_dimension', type: 'integer', required: false, minimum: 256, maximum: 8192, description: '仅截图使用，默认原始分辨率不缩放；需要更小图片时可指定最长边，保持比例且不放大。原始 PNG 超过 8MB 时自动改为最长边 2560 重取一次并在结果中说明。' },
    { name: 'include_controls', type: 'boolean', required: false, description: '仅 window 或提供 window_id 的 region 可选，默认 false；true 时随截图读取该窗口控件树（不限于裁剪区域）。controls 模式不需要此字段。' },
    { name: 'max_depth', type: 'integer', required: false, minimum: 1, maximum: 8, description: '读取控件时的层级上限，默认 4；根深度为 0。' },
    { name: 'max_elements', type: 'integer', required: false, minimum: 1, maximum: 200, description: '控件返回数量上限，默认 100；输出预算和提供方错误可能使数量更少。' },
    { name: 'timeout_ms', type: 'integer', required: false, minimum: 100, maximum: 3000, description: '控件读取软预算，默认 1200 毫秒；单次阻塞 COM 调用仍受 helper 硬期限约束。' },
    { name: 'include_selection', type: 'boolean', required: false, description: '读取控件时可选，默认 false；只尝试当前窗口内焦点控件的 Text 模式选区，最多 2048 字符，不读取全文或密码内容。' }
  ],
  example: { target: 'desktop' }
}

export interface ObservationRect { x: number; y: number; width: number; height: number }
export interface ObservationMonitor { monitor_id: string; bounds: ObservationRect; primary: boolean; dpi_x: number | null; dpi_y: number | null; scale_percent: number | null }
export interface WindowsObservation {
  observation_id: string
  target: 'desktop' | 'window' | 'region'
  window_id: string | null
  monitor_id: string | null
  window_identity: { hwnd: string; pid: number; process_started_at: string; thread_id: number; class_name: string } | null
  before_at: string
  captured_at: string
  observed_at: string
  source_bounds: ObservationRect
  source_size: { width: number; height: number }
  crop: ObservationRect
  image: { width: number; height: number; mime_type: 'image/png'; size_bytes: number; sha256: string }
  /** Subtract content origin, then use the actual encoder's floor sampling. DPI is not multiplied again. */
  transform: { origin_x: number; origin_y: number; scale_x: number; scale_y: number; coordinate_space: 'desktop_physical_pixels';
    content_bounds: ObservationRect; pixel_mapping: 'nearest_floor' }
  monitors: ObservationMonitor[]
  coordinate_context: DesktopCoordinateContext
  geometry_consistent: true
  content_verified: false
  input_ready: false
  goal_verified: false
  controls?: ControlTreeObservation
  binding?: ObservationBinding
}

export function validateObserveParameters(p: Record<string, unknown>): string | null {
  const integer = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max
  const validId = (v: unknown, prefix: string): boolean => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
  if (Object.keys(p).some(k => !['target', 'window_id', 'monitor_id', 'x', 'y', 'width', 'height', 'max_dimension', 'include_controls', 'max_depth', 'max_elements', 'timeout_ms', 'include_selection'].includes(k)) ||
      !['desktop', 'window', 'region', 'controls'].includes(p.target as string) ||
      (p.window_id !== undefined && !validId(p.window_id, 'win_')) || (p.monitor_id !== undefined && !validId(p.monitor_id, 'mon_')) ||
      (p.window_id !== undefined && p.monitor_id !== undefined) || (['window', 'controls'].includes(p.target as string) && p.window_id === undefined) ||
      (p.target === 'desktop' && p.window_id !== undefined) ||
      (p.max_dimension !== undefined && !integer(p.max_dimension, 256, OBSERVE_MAX_DIMENSION))) return 'observe 的来源、引用或尺寸参数不符合约定。'
  const controls = p.target === 'controls' || p.include_controls === true
  if ((p.include_controls !== undefined && (typeof p.include_controls !== 'boolean' || !['window', 'region'].includes(p.target as string) || p.window_id === undefined)) ||
      (p.target === 'controls' && p.max_dimension !== undefined) ||
      (!controls && ['max_depth', 'max_elements', 'timeout_ms', 'include_selection'].some(k => p[k] !== undefined)) ||
      (p.max_depth !== undefined && !integer(p.max_depth, 1, 8)) || (p.max_elements !== undefined && !integer(p.max_elements, 1, 200)) ||
      (p.timeout_ms !== undefined && !integer(p.timeout_ms, 100, 3000)) || (p.include_selection !== undefined && typeof p.include_selection !== 'boolean'))
    return '控件选项仅用于 controls 或显式 include_controls=true 的窗口观察，且必须满足读取预算。'
  const crop = ['x', 'y', 'width', 'height']
  if (p.target === 'region' ? crop.some(k => !integer(p[k], k === 'x' || k === 'y' ? 0 : 1, 32768)) : crop.some(k => p[k] !== undefined))
    return '仅 region 接受 x、y、width、height，且四个字段必须齐全并位于来源内。'
  return null
}
