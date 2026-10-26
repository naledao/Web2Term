import type { ComputerUseActionDefinition } from './computer-use'

export const LIST_APPS_DEFINITION: ComputerUseActionDefinition = {
  action: 'list_apps',
  description: '发现本机应用与运行进程，按名称／路径查询候选应用，返回真实来源、已核实启动引用和窗口概况。由你根据任务选择应用，无需用户预选。未找到不代表未安装；可换关键词或使用现有文件／终端工具查找真实 exe 路径，再通过 register_path 核实登记。此动作不启动应用，也不产生可用于输入的窗口引用。',
  parameters: [
    { name: 'query', type: 'string', required: false, description: '名称、别名或路径的子串，忽略大小写；不填写则列出候选应用。', maxLength: 200 },
    { name: 'limit', type: 'integer', required: false, description: '本页最多应用数，默认 12。', minimum: 1, maximum: 25 },
    { name: 'cursor', type: 'string', required: false, description: '原样使用上一页 next_cursor，并保留相同 query；过期时重新查询。', minLength: 36, maxLength: 36 },
    { name: 'refresh', type: 'boolean', required: false, description: '重新采集应用和进程；不能和 cursor 同时使用。' },
    { name: 'register_path', type: 'string', required: false, description: '仅在已从文件／终端工具找到真实路径后提供：本机绝对 exe 路径，主进程与 helper 复核后登记；不得猜测。不能和 cursor 同时使用。', minLength: 7, maxLength: 1024 }
  ],
  example: { query: 'Excel', limit: 12 }
}

export const LAUNCH_APP_DEFINITION: ComputerUseActionDefinition = {
  action: 'launch_app',
  description: '使用 list_apps 实际返回的 app_id 和 launch_references 中的 reference_id 启动应用。无需用户预先打开或选择软件。只能使用已发现、仍有效的引用，不可提供路径、命令或额外参数。结果仅说明启动是否派发，并提供新采集的候选窗口；单实例复用、代理进程或暂无窗口都可能发生。不能仅凭成功或 PID 认定已找到业务界面或完成任务，应继续核对真实窗口／观察；结果未知时先查状态，不要盲目重复启动。',
  parameters: [
    { name: 'app_id', type: 'string', required: true, description: '原样使用 list_apps 返回的 app_id，不可猜测或复制示例编号。', minLength: 36, maxLength: 36 },
    { name: 'launch_reference_id', type: 'string', required: true, description: '从该应用的 launch_references 选一个 reference_id，原样提供。', minLength: 39, maxLength: 39 },
    { name: 'wait_ms', type: 'integer', required: false, description: '派发后采集候选窗口的有界等待，默认 1500 毫秒，范围 0—5000；等待结束不代表任务完成。', minimum: 0, maximum: 5000 }
  ],
  example: { app_id: 'app_' + '0'.repeat(32), launch_reference_id: 'launch_' + '0'.repeat(32) }
}

export const OPEN_RESOURCE_DEFINITION: ComputerUseActionDefinition = {
  action: 'open',
  description: '打开任务需要的本机文件、目录或 http(s) 网页。kind 明确资源类型，target 使用已找到的真实绝对路径或完整 URL，不能填写命令。默认使用 Windows 系统关联；网页在 Web2Term 控制对话之外的浏览器中打开，可能复用外部业务窗口，绝不导航控制对话。可成对提供 list_apps 已返回的 app_id 与 launch_reference_id 选择应用；带预置参数的快捷方式不能用作此入口，可换无预置参数的引用或系统关联。不能额外传参数。结果只表示派发和候选窗口变化，不表示内容已加载、资源已处理或任务完成；未知结果先检查实际状态，不要盲目重开。',
  parameters: [
    { name: 'kind', type: 'string', required: true, description: '资源类型，文件、目录和网页不能互相冒充。', enum: ['file', 'directory', 'url'] },
    { name: 'target', type: 'string', required: true, description: '本机磁盘绝对路径或完整 http(s) URL；不接受远程／设备路径、file:、自定义协议、命令或 URL 用户名密码。', minLength: 3, maxLength: 4096 },
    { name: 'app_id', type: 'string', required: false, description: '可选，已发现的应用编号；必须同时提供该应用的 launch_reference_id。', minLength: 36, maxLength: 36 },
    { name: 'launch_reference_id', type: 'string', required: false, description: '可选，原样使用该应用已返回的启动引用；不能猜测。', minLength: 39, maxLength: 39 },
    { name: 'wait_ms', type: 'integer', required: false, description: '派发后候选窗口观察等待，默认 1500 毫秒，范围 0—5000。', minimum: 0, maximum: 5000 }
  ],
  example: { kind: 'url', target: 'https://example.com/' }
}

/** Literal local filesystem names only, including directory roots; no Win32 aliases or devices. */
export function localResourcePath(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 1024 && /^[a-z]:[\\/]/i.test(value) &&
    !/[\x00-\x1f<>"|?*]/.test(value) && !value.slice(2).includes(':') && value.slice(3).split(/[\\/]/).every(part =>
      !part || (!/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))
}

export function normalizeResourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || /[\s\x00-\x1f<>"\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && url.href.length <= 4096 ? url.href : null
  } catch { return null }
}

/** Executable/shortcut launches belong to launch_app; scripts may be opened explicitly in an editor. */
export function requiresExplicitResourceApp(path: string): boolean {
  return /\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|cpl|lnk|url|appref-ms|reg)$/i.test(path)
}

export type WindowsAppSource = 'applications_folder' | 'start_menu' | 'app_paths' | 'running_process' | 'registered_path'
export interface WindowsAppLaunchReference {
  reference_id: string
  kind: 'shell_item' | 'shortcut' | 'executable'
  verified: true
}
export interface WindowsAppWindowSummary {
  hwnd: string
  title: string
  visible: boolean
  minimized: boolean
  /** Discovery metadata only; not an actionable window_id. */
}
export interface WindowsAppProcess {
  pid: number
  started_at: string | null
  identity_verified: boolean
  windows: WindowsAppWindowSummary[]
}
export interface WindowsApp {
  app_id: string
  name: string
  aliases: string[]
  sources: WindowsAppSource[]
  executable_path: string | null
  launch_references: WindowsAppLaunchReference[]
  processes: WindowsAppProcess[]
}
export interface WindowsAppCatalogPage {
  catalog_id: string
  collected_at: string
  query: string
  apps: WindowsApp[]
  total_matches: number
  has_more: boolean
  next_cursor: string | null
  complete: boolean
  sources: Array<{ source: WindowsAppSource; status: 'complete' | 'partial' | 'unavailable'; checked: number; errors: number }>
  registered_app_id: string | null
}

export interface WindowsAppLaunchResult {
  catalog_id: string
  app_id: string
  launch_reference_id: string
  dispatch_status: 'dispatched' | 'unknown'
  method: 'shell_execute' | 'application_activation'
  native_error: number | null
  returned_process: { pid: number; started_at: string | null } | null
  before_at: string
  observed_at: string
  observation_complete: boolean
  candidate_windows: Array<WindowsAppWindowSummary & {
    pid: number
    process_started_at: string
    foreground: boolean
    match_basis: 'app_user_model_id' | 'executable_path' | 'returned_pid' | 'window_change'
    change: 'new' | 'changed' | 'existing' | 'unconfirmed'
  }>
  target_window_confirmed: false
  goal_verified: false
}

export interface WindowsResourceOpenResult extends Omit<WindowsAppLaunchResult, 'catalog_id' | 'app_id' | 'launch_reference_id'> {
  kind: 'file' | 'directory' | 'url'
  target: string
  handler: 'system_association' | 'discovered_app'
  application: { executable_path: string | null; app_user_model_id: string | null; basis: 'association_query' | 'selected_reference' } | null
  catalog_id: string | null
  app_id: string | null
  launch_reference_id: string | null
  control_conversation_preserved: true
  content_verified: false
}
