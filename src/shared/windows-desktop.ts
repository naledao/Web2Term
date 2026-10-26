import type { ComputerUseActionDefinition } from './computer-use'

export const INSPECT_INTERACTIONS_DEFINITION: ComputerUseActionDefinition = {
  action: 'inspect_interactions',
  description: '只读发现一个已知业务窗口关联的新弹窗、文件对话框及活动原生菜单，不点击、不激活、不统一确认。传入普通业务 window_id，软件核对 owner 链、真实身份和活动菜单路由，返回可供 observe/focus_window 使用的短期窗口引用，并保留原窗口引用。先 observe 新引用的截图及控件，理解文件名、路径、覆盖／未保存提示和影响，再按用户目标自主使用 click/type_text/press_key；UIA 模态未知不等于无弹窗。活动菜单不要 focus_window，以免关闭菜单；mode=popup 观察菜单引用，mode=owner 观察 keyboard_window_id 对应的原窗口；两种模式都直接 observe，截图不可用时改 target=controls，再用 click 或不带 element_id 的窗口级 press_key。活动菜单不使用 type_text/scroll/drag；关闭菜单后重新观察再输入。菜单输入仍由原生侧实时核对前台 owner、线程、捕获及菜单存活；普通窗口不能借此绕过菜单拦截。菜单关闭、子菜单或新弹窗出现后，以本次 parent_window_id 再检查，重新观察后继续，不重放旧动作。每次重新检查仅替换本来源上次派生的交互引用，30 秒或父窗口快照到期即失效；未知关联、自绘嵌入弹层可继续观察原窗口，不能仅凭标题／同 PID 猜测归属。',
  parameters: [
    { name: 'window_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '当前任务已发现的普通业务窗口编号，可检查禁用的父窗口；不接受菜单自身、原生句柄或会话字段。' },
    { name: 'limit', type: 'integer', required: false, minimum: 1, maximum: 16, description: '默认 8，最多 16 个关联窗口／菜单；超限或读取不足明确返回 complete=false，不能当作不存在其他弹窗。' }
  ],
  example: { window_id: 'win_' + '0'.repeat(32), limit: 8 }
}

export interface WindowsInteractions {
  snapshot_id: string; parent_window_id: string; before_at: string; observed_at: string; expires_at: string; parent: DesktopWindow
  windows: { kind: 'dialog' | 'owned_window' | 'menu'; is_modal: boolean | null; owner_chain: string[]; window: DesktopWindow }[]
  menu: { active: boolean; mode: 'none' | 'popup' | 'owner' | 'unavailable'; flags: number; owner_hwnd: string | null; root_hwnd: string | null; owner_window_id: string | null; keyboard_window_id: string | null }
  complete: boolean; limitations: string[]; snapshot_atomic: false; input_ready: false; goal_verified: false
}

export const LIST_WINDOWS_DEFINITION: ComputerUseActionDefinition = {
  action: 'list_windows',
  description: '发现当前本机桌面的业务顶层窗口，包括同一应用的多个窗口、标题、真实进程／应用信息、前台／可见／最小化状态和 owner 关系。客户端、helper、同一客户端程序的其他窗口／实例及其拥有的弹窗不作为业务候选；无法核实程序或 owner 归属的窗口不可操作。桌面概览中看见控制界面不能授权操作该界面、切换权限或向控制对话输入。由你根据任务自行选择；同名窗口不能只凭标题认定目标，应结合应用身份并继续观察。仅原样使用 windows 行中 identity_verified=true 的 window_id，hwnd、owner_hwnd 和启动候选不是操作引用。没有 window_id 的窗口仅供参考，不能猜测引用。每次不带 cursor 的查询都会重新采集并作废本任务上一批窗口引用；分页须保持 query、pid 和 include_hidden。引用还受任务、helper 代次和有效期约束，后续动作必须重新核实实际身份。此动作不激活窗口、不输入、不代表任务完成。',
  parameters: [
    { name: 'query', type: 'string', required: false, description: '按窗口标题、进程名称、真实路径或 AppUserModelID 子串过滤，忽略大小写。', maxLength: 200 },
    { name: 'pid', type: 'integer', required: false, description: '可选的进程筛选，PID 仅用于过滤，不能代替窗口身份。', minimum: 1, maximum: 4294967295 },
    { name: 'include_hidden', type: 'boolean', required: false, description: '默认 false，列出可见或最小化窗口；true 时也包括隐藏窗口。' },
    { name: 'limit', type: 'integer', required: false, description: '本页最多窗口数，默认 25，范围 1—50；结果预算可能缩短本页。', minimum: 1, maximum: 50 },
    { name: 'cursor', type: 'string', required: false, description: '使用上一页 next_cursor；须保持相同筛选条件，过期时重新查询。', minLength: 37, maxLength: 37 }
  ],
  example: { query: 'Excel', limit: 25 }
}

export const FOCUS_WINDOW_DEFINITION: ComputerUseActionDefinition = {
  action: 'focus_window',
  description: '恢复或激活 list_windows、inspect_interactions 或 wait_for 在当前任务实际返回、身份已核实的普通窗口 window_id，并读取真实前台、Win32 键盘焦点和 UIA 焦点。无需用户逐步选择或切换窗口。默认恢复最小化／隐藏窗口；Windows 可能拒绝激活，工具只做有界尝试。被禁用、其他桌面 cloaked 或弹窗阻挡时返回实际状态及候选句柄信息，不自动改选窗口；可用 inspect_interactions 检查被阻挡窗口，再 observe 新对话框。活动菜单不调用 focus_window，直接观察菜单引用。成功仅表示采集时焦点已核对，不能认定业务内容或任务完成，也不能把它当成后续输入许可；每次输入前仍须重新核对窗口与实时焦点。工具不发送按键、点击或文字，Web2Term 不在前台不表示任务暂停。',
  parameters: [
    { name: 'window_id', type: 'string', required: true, description: '原样使用 list_windows、inspect_interactions 或 wait_for 的有效普通窗口 window_id；不接受 HWND、PID、owner 句柄或猜测编号。', minLength: 36, maxLength: 36 },
    { name: 'restore', type: 'boolean', required: false, description: '默认 true，允许恢复最小化或显示隐藏窗口；false 时仅尝试激活已经显示的窗口。' },
    { name: 'wait_ms', type: 'integer', required: false, description: '恢复／激活后的有界观察等待，默认 1500 毫秒，范围 0—3000；阻塞的系统调用另受 helper 动作期限约束。', minimum: 0, maximum: 3000 }
  ],
  example: { window_id: 'win_' + '0'.repeat(32) }
}

export type WindowIdentityStatus = 'verified' | 'process_unavailable' | 'lifetime_unavailable' | 'changed'
export interface DesktopWindow {
  window_id: string | null
  hwnd: string
  pid: number
  process_started_at: string | null
  thread_id: number
  class_name: string
  title: string
  application: { name: string | null; executable_path: string | null; app_user_model_id: string | null }
  visible: boolean
  minimized: boolean
  foreground: boolean
  enabled: boolean
  cloaked: boolean | null
  owner_hwnd: string | null
  /** Present only when the verified owner is also a row in this page. */
  owner_window_id: string | null
  identity_verified: boolean
  identity_status: WindowIdentityStatus
}
export type WindowListLimitation = 'enumeration_limited' | 'metadata_unavailable' | 'lifetime_unavailable' | 'window_changed'
export interface WindowsWindowPage {
  snapshot_id: string
  collected_at: string
  expires_at: string
  query: string
  pid: number | null
  include_hidden: boolean
  windows: DesktopWindow[]
  total_matches: number
  has_more: boolean
  next_cursor: string | null
  complete: boolean
  limitations: WindowListLimitation[]
}

export type FocusWindowTarget = Pick<DesktopWindow, 'hwnd' | 'pid' | 'process_started_at' | 'thread_id' | 'class_name' | 'title' | 'visible' | 'minimized' | 'foreground' | 'enabled' | 'cloaked' | 'owner_hwnd'>
export interface WindowFocusObservation {
  foreground_hwnd: string | null
  active_hwnd: string | null
  focus_hwnd: string | null
  focus_root_hwnd: string | null
  win32_focus: 'confirmed' | 'outside_target' | 'unavailable'
  uia_focus: { status: 'confirmed' | 'outside_target' | 'unavailable' | 'not_checked'; root_hwnd: string | null; has_keyboard_focus: boolean | null }
}
export interface WindowsWindowFocusResult {
  snapshot_id: string
  window_id: string
  status: 'focused' | 'foreground_only' | 'denied' | 'blocked' | 'restore_required' | 'stale' | 'cancelled' | 'unknown'
  before_at: string
  observed_at: string
  restore: { attempted: boolean; accepted: boolean | null }
  activation_attempts: Array<boolean | null>
  target: FocusWindowTarget | null
  identity_verified: boolean
  observation: WindowFocusObservation
  blocking_window_hwnd: string | null
  focus_confirmed: boolean
  /** A past focus check never authorizes a later input. */
  input_ready: false
  goal_verified: false
}
