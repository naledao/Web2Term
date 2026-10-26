import type { ComputerUseActionDefinition } from './computer-use'

export interface DragPoint { x: number; y: number }
export const DRAG_DEFINITION: ComputerUseActionDefinition = {
  action: 'drag',
  description: '在最近业务窗口截图内拖拽或作基础画布输入。path 必填，为 2—33 个原 PNG 像素点 {x,y}，首点按下、末点释放；两个点为直线，更多点为折线，不接受桌面／缩略图坐标、控件编号或跨窗轨迹。button 默认 left，可选 right/middle；duration_ms 默认 600，范围 100—3000，为轨迹计划时长，检查耗时可使实际时间更长。软件按最多每轴 16 个物理像素一段细分，最多 256 段，超限需由 AI 重新规划有界轨迹。先严格核对原观察、整条可见客户端路径、窗口／DPI／遮挡及输入占用，移动到起点后复核，再按下并逐段移动。持有期间允许目标内部正常焦点／内容变化及鼠标捕获，每段核对窗口身份、前台、几何、DPI、捕获与鼠标位置；取消、干扰或异常停止后续移动，并尝试释放本次按钮。不跨轮按住、不自动重拖、不回滚；系统拒绝或进程被强制结束时不能保证释放。完整输入不等于拖放、选区或画布内容成功，依据自动返回的新观察判断。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '当前任务最近一组业务窗口图像观察，不能使用显示器概览或纯控件观察。' },
    { name: 'path', type: 'array', required: true, maxItems: 33, description: '2—33 个仅含整数 x/y 的原上传 PNG 像素点，首点为起点、末点为终点；相邻点不能相同，整条轨迹必须位于本窗口可见客户端及显示器内。' },
    { name: 'button', type: 'string', required: false, enum: ['left', 'right', 'middle'], description: '默认 left；一次仅按住一个鼠标按钮，不接受修饰键、压力、触摸或跨请求持续按住。' },
    { name: 'duration_ms', type: 'integer', required: false, minimum: 100, maximum: 3000, description: '默认 600；有界计划时长，分段间可取消。实际时长包含检查和鼠标到达确认。' }
  ],
  example: { observation_id: 'obs_' + '0'.repeat(32), path: [{ x: 100, y: 100 }, { x: 300, y: 200 }], button: 'left', duration_ms: 600 }
}
export function validateDragParameters(p: Record<string, unknown>): string | null {
  const point = (v: unknown): v is DragPoint => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 2 &&
    ['x', 'y'].every(k => Object.hasOwn(v, k) && Number.isSafeInteger((v as Record<string, unknown>)[k]) && Number((v as Record<string, unknown>)[k]) >= 0 && Number((v as Record<string, unknown>)[k]) <= 2559)
  const path = p.path, duration = p.duration_ms === undefined ? 600 : p.duration_ms, button = p.button === undefined ? 'left' : p.button
  return Object.keys(p).some(k => !['observation_id', 'path', 'button', 'duration_ms'].includes(k)) ||
    typeof p.observation_id !== 'string' || !/^obs_[a-f0-9]{32}$/.test(p.observation_id) || !Array.isArray(path) || path.length < 2 || path.length > 33 ||
    !path.every(point) || path.some((v, i) => i > 0 && v.x === path[i - 1].x && v.y === path[i - 1].y) ||
    !['left', 'right', 'middle'].includes(button as string) || !Number.isSafeInteger(duration) || Number(duration) < 100 || Number(duration) > 3000
    ? 'drag 只接受最新窗口图像观察、2—33 个完整原图像素点、有界时长和一个鼠标按钮，不接受原生坐标、脚本、重复或跨轮按住。' : null
}
/** Shared rounding and bounded subdivision; stride=1 checks every raster pixel against physical geometry. */
export function interpolateDragPath(anchors: readonly DragPoint[], stride = 16): DragPoint[] | null {
  if (anchors.length < 2 || anchors.length > 33 || ![1, 16].includes(stride)) return null
  const points: DragPoint[] = [{ ...anchors[0] }], maximum = stride === 16 ? 256 : 4096
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i], dx = b.x - a.x, dy = b.y - a.y, count = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / stride)
    if (!Number.isSafeInteger(count) || count < 1 || points.length - 1 + count > maximum) return null
    for (let j = 1; j <= count; j++) points.push({ x: a.x + Math.floor(dx * j / count + 0.5), y: a.y + Math.floor(dy * j / count + 0.5) })
  }
  return points
}
export interface WindowsDragReceipt {
  request_id: string; observation_id: string; source_step_id: string; window_id: string | null; button: string; duration_ms: number
  start: DragPoint | null; end: DragPoint | null; segments_planned: number
  move_attempted: boolean; move_accepted: number | null; move_arrived: boolean
  down_attempted: boolean; down_accepted: number | null; down_confirmed: boolean
  segments: { index: number; accepted: number | null; arrived: boolean }[]
  up_attempted: boolean; up_accepted: number | null
  release_required: boolean; release_attempted: boolean; release_accepted: number | null
  drag_completed: boolean; before_at: string; completed_at: string; drag_verified: false; goal_verified: false; input_ready: false
  validation?: unknown
}
