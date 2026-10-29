import type { ComputerDiagnosis } from './computer-diagnostics'
import { normalizeComputerResultDelay } from './computer-progress'
import type { ComputerProgressReport } from './computer-progress'
import { computerUseProtocol } from './computer-use-protocol'
import type { ComputerUseProtocolErrorCode } from './computer-use-protocol'
import type { WindowsHelperState } from './windows-helper'

/** These preferences apply only to computer use and its task context, not other tools. */
export interface ComputerUsePreferences {
  computerUseEnabled: boolean
  desktopControlEnabled: boolean
  /** Seconds to wait after a computer action returns before its result is sent to the model. */
  computerResultDelaySeconds?: number
  /** Opt-in: click at x/y of a desktop or region screenshot, outside any observed business window. Off when absent. */
  desktopPointClickEnabled?: boolean
}

export const DEFAULT_COMPUTER_USE_PREFERENCES: Readonly<ComputerUsePreferences> = Object.freeze({
  computerUseEnabled: false,
  desktopControlEnabled: false
})

export type ComputerUseConnection = 'local' | 'ssh' | 'web2term' | 'none'

export interface ComputerUseContext {
  sessionId: string | null
  platformId: string
  hostPlatform: string
  hostArch: string
  connection: ComputerUseConnection
}

export type ComputerUseReason = 'emergency-stopped' | 'no-session' | 'remote-session' | 'unsupported-platform' | 'unsupported-os'
  | 'unsupported-arch' | 'computer-use-disabled' | 'desktop-disabled' | 'runtime-not-ready' | 'ready'

export const COMPUTER_USE_PROTOCOL_VERSION = 1 as const

export type ComputerUseParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
export interface ComputerUseParameter {
  name: string
  type: ComputerUseParameterType
  description: string
  required: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  enum?: Array<string | number | boolean>
}

/** Metadata is registered by a real main-process executor, never supplied by the model. */
export interface ComputerUseActionDefinition {
  action: string
  description: string
  parameters: ComputerUseParameter[]
  example: Record<string, unknown>
  /** Exactly one full locator group is required, e.g. [[element_id], [x, y]]. */
  locatorAlternatives?: string[][]
}

/** Internal dispatch input. Raw page JSON must pass the page/protocol adapters first. */
export interface ComputerUseToolCall {
  action: string
  parameters: Record<string, unknown>
  /** Display-only model intent; optional for internal calls and legacy history. */
  description?: string
}

export interface ComputerUseWireRequest extends Record<string, unknown> {
  type: 'computer'
  version: typeof COMPUTER_USE_PROTOCOL_VERSION
  action: string
  step_token: string
  description: string
}

/** Recognition only. The original envelope must still pass the main-process protocol validator. */
export interface ComputerUsePageRequest {
  messageId: string
  sourceSubmissionId: string
  taskPromptGeneration: number
  pagePath: string
  /** Main-issued document epoch; optional only for older stored receipt snapshots. */
  pageEpoch?: string
  rawJson: string
  outcome: 'candidate' | 'invalid'
  issue: 'invalid-json' | 'ambiguous-request' | 'oversized-request' | null
}

export interface ComputerUseToolResult {
  type: 'computer_result'
  version: typeof COMPUTER_USE_PROTOCOL_VERSION
  action: string
  ok: boolean
  execution: 'not_executed' | 'executed' | 'unknown'
  code: 'ok' | 'unavailable' | 'cancelled' | 'executor_error' | 'inactive_context' | 'no_progress' | 'recovery_required' | 'verification_required' | 'stale_catalog' | 'stale_window' | 'invalid_result' | 'launch_failed' | 'open_failed'
    | 'focus_denied' | 'focus_unconfirmed' | 'external_input' | 'human_input' | 'human_paused' | 'input_monitor_unavailable' | 'window_blocked' | 'restore_required' | 'capture_failed' | 'capture_blocked' | 'stale_observation'
    | 'click_blocked' | 'click_failed' | 'type_text_blocked' | 'type_text_failed' | 'press_key_blocked' | 'press_key_failed' | 'scroll_blocked' | 'scroll_failed' | 'drag_blocked' | 'drag_failed' | 'wait_timeout' | 'wait_failed' | 'wait_ambiguous' | ComputerUseProtocolErrorCode
  message: string
  data?: unknown
  /** Opaque task-bound temporary images. Never model-selected paths or image bytes. */
  attachments?: ComputerUseImageReference[]
  /** Main-side evidence/options, never an automatically executed repair plan. */
  diagnosis?: ComputerDiagnosis
  progress_control?: ComputerProgressReport
}

export interface ComputerUseImageReference { id: string; mime_type: 'image/png'; sha256: string }

export type ComputerUseWireEnvelope = ComputerUseWireRequest | ComputerUseToolResult

export interface ComputerUseCapability extends ComputerUsePreferences {
  context: ComputerUseContext
  scopeSupported: boolean
  /** Both preferences are on and this is a supported platform/host/connection. */
  enabled: boolean
  available: boolean
  actions: string[]
  actionDefinitions: ComputerUseActionDefinition[]
  reason: ComputerUseReason
  message: string
  helper?: WindowsHelperState
}

export function normalizeComputerUsePreferences(value: unknown): ComputerUsePreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<ComputerUsePreferences> : {}
  return {
    computerUseEnabled: input.computerUseEnabled === true,
    desktopControlEnabled: input.desktopControlEnabled === true,
    ...(input.computerResultDelaySeconds !== undefined ? { computerResultDelaySeconds: normalizeComputerResultDelay(input.computerResultDelaySeconds) } : {}),
    ...(input.desktopPointClickEnabled !== undefined ? { desktopPointClickEnabled: input.desktopPointClickEnabled === true } : {})
  }
}

/**
 * Sites whose page adapter recognizes desktop requests (`PageAdapter.computerUseRequests`).
 * Kept here rather than read from platforms.ts so this module stays dependency-free for the VM tests.
 */
export const COMPUTER_USE_PLATFORM_IDS: readonly string[] = ['deepseek', 'chatgpt']
export const supportsComputerUsePlatform = (platformId: string | null | undefined): boolean =>
  typeof platformId === 'string' && COMPUTER_USE_PLATFORM_IDS.includes(platformId)

const MESSAGES: Record<ComputerUseReason, string> = {
  'emergency-stopped': '全局急停已锁定自动操作，请在客户端明确解除。',
  'no-session': '请在 DeepSeek 或 ChatGPT 本机会话中查看桌面能力。',
  'remote-session': '远程会话暂不提供本机桌面控制，请使用 DeepSeek 或 ChatGPT 本机会话。',
  'unsupported-platform': '桌面能力目前仅适配 DeepSeek 和 ChatGPT，请切换到其中一个本机会话。',
  'unsupported-os': '桌面能力首版仅支持 Windows x64 本机环境。',
  'unsupported-arch': '当前客户端架构暂不支持桌面控制，首版仅支持 Windows x64。',
  'computer-use-disabled': 'computer use 已关闭。',
  'desktop-disabled': 'computer use 的桌面控制已关闭。',
  'runtime-not-ready': '当前版本已支持工具接入与任务记录，桌面执行器尚未接入。',
  ready: 'computer use 工具已就绪。'
}

const PARAMETER_TYPES: readonly ComputerUseParameterType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array']
const RESERVED_FIELDS = new Set(['type', 'version', 'action', 'step_token', 'description', 'command', 'read_files', 'question', 'questions', 'files',
  'background', 'task_id', 'session_id', 'generation', 'permissions', 'connection', 'constructor', 'prototype', '__proto__'])
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const shortText = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit

/** Structural argument types only; action-specific bounds and identities belong to its validator. */
export function computerUseParametersMatch(definition: ComputerUseActionDefinition, value: unknown): value is Record<string, unknown> {
  return computerUseProtocol.parametersMatch(definition, value)
}

/** The fields that broke `computerUseParametersMatch`, with the action's accepted parameters. */
export function computerUseParameterIssues(definition: ComputerUseActionDefinition, value: unknown): string {
  return computerUseProtocol.parameterIssues(definition, value).message
}

/** Return an isolated, bounded definition so callers cannot change published capabilities. */
export function normalizeComputerUseActionDefinition(value: unknown): ComputerUseActionDefinition | null {
  if (!object(value) || typeof value.action !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.action) ||
    ['command', 'read_files', 'questions', 'background_task'].includes(value.action) || !shortText(value.description, 2000) ||
    !Array.isArray(value.parameters) || value.parameters.length > 24 || !object(value.example)) return null
  const parameters: ComputerUseParameter[] = []
  for (const raw of value.parameters) {
    if (!object(raw) || typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.name) || RESERVED_FIELDS.has(raw.name) ||
      parameters.some(parameter => parameter.name === raw.name) || !PARAMETER_TYPES.includes(raw.type as ComputerUseParameterType) ||
      !shortText(raw.description, 1000) || typeof raw.required !== 'boolean') return null
    const parameter: ComputerUseParameter = { name: raw.name, type: raw.type as ComputerUseParameterType,
      description: raw.description.trim(), required: raw.required }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'] as const) {
      if (raw[key] === undefined) continue
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) return null
      if (key === 'minimum' || key === 'maximum') {
        if (!['number', 'integer'].includes(parameter.type) || (parameter.type === 'integer' && !Number.isSafeInteger(raw[key]))) return null
      } else if (!Number.isSafeInteger(raw[key]) || raw[key] < 0 ||
        (key === 'maxItems' ? parameter.type !== 'array' || raw[key] > 256 : parameter.type !== 'string' || raw[key] > 32_768)) return null
      parameter[key] = raw[key]
    }
    if ((parameter.minimum !== undefined && parameter.maximum !== undefined && parameter.minimum > parameter.maximum) ||
      (parameter.minLength !== undefined && parameter.maxLength !== undefined && parameter.minLength > parameter.maxLength)) return null
    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > 32 || !['string', 'boolean', 'number', 'integer'].includes(parameter.type) ||
        new Set(raw.enum).size !== raw.enum.length || raw.enum.some(item => parameter.type === 'string' ? typeof item !== 'string' || item.length > 1000
          : parameter.type === 'boolean' ? typeof item !== 'boolean' : typeof item !== 'number' || !Number.isFinite(item) ||
            (parameter.type === 'integer' && !Number.isSafeInteger(item)))) return null
      if (raw.enum.some(item => (typeof item === 'number' && ((parameter.minimum !== undefined && item < parameter.minimum) ||
        (parameter.maximum !== undefined && item > parameter.maximum))) || (typeof item === 'string' &&
          ((parameter.minLength !== undefined && item.length < parameter.minLength) || (parameter.maxLength !== undefined && item.length > parameter.maxLength))))) return null
      parameter.enum = structuredClone(raw.enum) as Array<string | number | boolean>
    }
    parameters.push(parameter)
  }
  let locatorAlternatives: string[][] | undefined
  if (value.locatorAlternatives !== undefined) {
    const groups = value.locatorAlternatives
    if (!Array.isArray(groups) || groups.length < 2 || groups.length > 4 || groups.some(group => !Array.isArray(group) ||
      !group.length || group.length > 4 || group.some(name => typeof name !== 'string' || !parameters.some(parameter => parameter.name === name && !parameter.required)))) return null
    const names = groups.flat()
    if (new Set(names).size !== names.length) return null
    locatorAlternatives = structuredClone(groups) as string[][]
  }
  try {
    const example = JSON.stringify(value.example)
    if (example.length > 20_000) return null
    const definition: ComputerUseActionDefinition = { action: value.action, description: value.description.trim(), parameters, example: JSON.parse(example),
      ...(locatorAlternatives ? { locatorAlternatives } : {}) }
    return computerUseParametersMatch(definition, definition.example) ? definition : null
  } catch { return null }
}

/** Uses host facts and the live connection, never the remote shell's OS description. */
export function resolveComputerUseCapability(preferences: unknown, context: ComputerUseContext,
  registeredActions: readonly ComputerUseActionDefinition[] = [], helper?: WindowsHelperState): ComputerUseCapability {
  const saved = normalizeComputerUsePreferences(preferences)
  const scopeReason: ComputerUseReason | null = context.connection === 'none' || !context.sessionId ? 'no-session'
    : context.connection !== 'local' ? 'remote-session'
      : !supportsComputerUsePlatform(context.platformId) ? 'unsupported-platform'
        : context.hostPlatform !== 'win32' ? 'unsupported-os'
          : context.hostArch !== 'x64' ? 'unsupported-arch' : null
  const enabled = scopeReason === null && saved.computerUseEnabled && saved.desktopControlEnabled
  const actualActions = helper ? registeredActions.filter(value => value.action === 'complete_task' || helper.phase === 'ready' && helper.actions.includes(value.action)) : registeredActions
  const definitions = enabled ? actualActions.flatMap(value => normalizeComputerUseActionDefinition(value) ?? []) : []
  const actionDefinitions = definitions.filter((definition, index) => definitions.findIndex(item => item.action === definition.action) === index)
  const reason = scopeReason ?? (!saved.computerUseEnabled ? 'computer-use-disabled'
    : !saved.desktopControlEnabled ? 'desktop-disabled' : actionDefinitions.length ? 'ready' : 'runtime-not-ready')
  return {
    ...saved, context: { ...context }, scopeSupported: scopeReason === null,
    enabled, available: enabled && actionDefinitions.length > 0,
    actions: actionDefinitions.map(definition => definition.action), actionDefinitions, reason,
    message: reason === 'runtime-not-ready' && helper ? helper.message + (helper.phase === 'ready' ? ' 当前尚无已接入的桌面动作。' : '') : MESSAGES[reason],
    ...(helper ? { helper: structuredClone(helper) } : {})
  }
}

/**
 * User sends wait for the Windows helper while computer use is on. The tool prompt is injected
 * once per task, so a prompt captured before the helper is ready offers the model only
 * complete_task, and the model then reports, correctly, that it cannot operate the desktop.
 * @returns the user-facing reason, or null when sending may proceed.
 */
export function computerUseSendBlock(capability: ComputerUseCapability): string | null {
  const helper = capability.helper
  if (!capability.enabled || !helper || helper.phase === 'ready') return null
  if (helper.phase === 'starting' || helper.code === 'not_started') return 'Windows 桌面助手正在启动，就绪后即可发送消息，通常只需几秒。'
  return `Windows 桌面助手暂未就绪：${helper.message} 如需先继续对话，可在设置中关闭 computer use。`
}

/** Appended only to the tool section; the existing system and other tool instructions stay intact. */
const COMPUTER_ACTION_SUMMARIES: Readonly<Record<string, string>> = {
  list_apps: '发现本机应用及真实启动引用；不启动、不产生输入窗口。',
  launch_app: '用 list_apps 返回的 app_id 和 launch_reference_id 启动应用；启动后继续核对窗口。',
  open: '打开已确认的本机文件、目录或 http(s) 网页；只表示已派发，不表示内容完成。',
  list_windows: '发现业务窗口并返回可操作的真实 window_id；不激活、不输入。',
  inspect_interactions: '发现指定业务窗口关联的弹窗、文件对话框或活动菜单；不点击、不激活。',
  focus_window: '恢复并激活已确认的业务窗口，核对前台和焦点；不发送输入。',
  observe: '读取桌面、窗口、区域截图或控件树；只读，不激活、不输入。',
  validate_observation: '只读复核最新观察中的控件或图像定位；不执行输入，也不授予输入许可。',
  click: '点击最新观察中的控件或上传 PNG 像素点。',
  type_text: '向最新观察中已确认焦点的可写控件输入文字。',
  press_key: '在已确认的前台业务窗口发送一次按键或组合键。',
  scroll: '在最新观察中的控件或图像落点滚动一次。',
  drag: '在同一业务窗口的最新截图内执行有界拖拽。',
  wait_for: '有界等待已存在的后台任务或桌面条件；不启动、停止、点击或输入。',
  complete_task: '可选的逐项证据核对与产物交付。'
}

function compactParameter(parameter: ComputerUseParameter): string {
  const name = `${parameter.name}${parameter.required ? '!' : ''}:${parameter.type}`
  // Names such as target/text/window_id have different meanings per action. Keep
  // registered conditions and nested structures rather than truncating their contract.
  const summary = parameter.description
  const limits = [
    ...(parameter.enum ? [`{${parameter.enum.join('|')}}`] : []),
    ...(parameter.minimum !== undefined ? [`≥${parameter.minimum}`] : []),
    ...(parameter.maximum !== undefined ? [`≤${parameter.maximum}`] : []),
    ...(parameter.minLength !== undefined ? [`len≥${parameter.minLength}`] : []),
    ...(parameter.maxLength !== undefined ? [`len≤${parameter.maxLength}`] : []),
    ...(parameter.maxItems !== undefined ? [`items≤${parameter.maxItems}`] : [])
  ]
  return `${name}=${summary}${limits.length ? ` [${limits.join(',')}]` : ''}`
}

function compactAction(definition: ComputerUseActionDefinition): string {
  const summary = COMPUTER_ACTION_SUMMARIES[definition.action] ?? definition.description.split(/[。！？]/, 1)[0].slice(0, 120)
  const parameters = definition.parameters.map(compactParameter).join('; ')
  const locator = definition.locatorAlternatives ? `；定位二选一：${definition.locatorAlternatives.map(group => group.join('+')).join(' 或 ')}` : ''
  return `${definition.action}：${summary}${parameters ? ` 参数：${parameters}` : ''}${locator}`
}

/** A copyable example must use a real current token and a no-input discovery action. */
function computerDiscoveryExample(capability: ComputerUseCapability, stepToken?: string | null): string[] {
  if (!stepToken || !/^cu_[a-f0-9]{32}$/.test(stepToken)) return []
  for (const action of ['list_windows', 'list_apps']) {
    const definition = capability.actionDefinitions.find(item => item.action === action)
    if (!definition || !computerUseParametersMatch(definition, {})) continue
    const request: ComputerUseWireRequest = {
      type: 'computer', version: COMPUTER_USE_PROTOCOL_VERSION, action, step_token: stepToken,
      description: action === 'list_windows' ? '查看可操作窗口' : '查找可用应用'
    }
    return ['调用示例（按实际目标选择动作，使用最新令牌）：', '```json', JSON.stringify(request), '```']
  }
  return []
}

/**
 * The computer use state injected with the tool summaries. The full definition is read on demand,
 * but the step token, pause notice and availability change per step, so they always travel inline.
 */
export function computerUseStatusPrompt(capability: ComputerUseCapability, stepToken?: string | null, pausedByInput = false): string {
  if (!capability.computerUseEnabled && !capability.desktopControlEnabled) return ''
  return [
    '【computer use 状态】',
    `computer use：${capability.computerUseEnabled ? '已启用' : '已关闭'}；桌面控制：${capability.desktopControlEnabled ? '已允许' : '已关闭'}。`,
    ...(pausedByInput ? [
      '上一轮 computer use 因用户在桌面上连续 3 次键鼠操作而暂停，暂停时那一步的结果没有回传。本条用户消息继续同一任务：先重新观察真实界面，核对暂停前最后一步是否已生效，不要盲目重做；再按用户本条消息和原要求继续。'
    ] : []),
    ...(capability.context.platformId === 'deepseek' ? ['DeepSeek 网页视觉理解能力已由用户确认，无需再次确认或配置视觉模型 API Key。'] : []),
    capability.message,
    ...(!capability.available ? [
      '当前没有可调用的 computer 桌面动作。不要输出 computer 工具请求，不要声称已观察或操作桌面。继续使用实际提供的现有工具。'
    ] : stepToken === null ? ['当前步骤正在处理或令牌尚未就绪，等待 computer_result 返回 next_step_token 后再发起下一请求。']
      : stepToken ? [`当前 step_token：${stepToken}`] : [])
  ].filter(Boolean).join('\n')
}

/**
 * @param pausedByInput the conversation's task was paused by the user's keyboard/mouse input; this prompt
 *   travels with the user's next message, which continues that task.
 */
export function computerUseCapabilityPrompt(capability: ComputerUseCapability, stepToken?: string | null, pausedByInput = false): string {
  if (!capability.computerUseEnabled && !capability.desktopControlEnabled) return ''
  return [
    '【工具能力：computer use】',
    '用于发现、观察和操作本机桌面应用；命令、文件和后台任务使用对应工具。',
    `computer use：${capability.computerUseEnabled ? '已启用' : '已关闭'}；桌面控制：${capability.desktopControlEnabled ? '已允许' : '已关闭'}。`,
    ...(pausedByInput ? [
      '【computer use 暂停后继续】',
      '上一轮 computer use 因用户在桌面上连续 3 次键鼠操作而暂停，暂停时那一步的结果没有回传。本条用户消息继续同一任务：先重新观察真实界面，核对暂停前最后一步是否已生效，不要盲目重做；再按用户本条消息和原要求继续。'
    ] : []),
    ...(capability.context.platformId === 'deepseek' ? ['DeepSeek 网页视觉理解能力已由用户确认，无需再次确认或配置视觉模型 API Key。'] : []),
    capability.message,
    ...(!capability.available ? [
      '当前没有可调用的 computer 桌面动作。不要输出 computer 工具请求，不要声称已观察或操作桌面。继续使用实际提供的现有工具。'
    ] : [
      '【computer 当前可调用动作与参数】',
      '参数标记 ! 表示必填；同时遵守各动作的条件必填、范围和互斥规则。',
      ...capability.actionDefinitions.map(compactAction),
      ...(capability.desktopPointClickEnabled === true && capability.actions.includes('click') ? [
        '【桌面坐标点击：用户已开启】',
        '仅业务窗口外可用：先 observe target=desktop/region，再用同一 observation_id 的 x/y click；业务窗口内优先使用 window/controls 观察。'
      ] : []),
      '【computer 规则】',
      '输入前确认目标窗口与焦点，使用当前任务最新有效观察；窗口、焦点或布局变化后重新观察。引用来自真实回传，坐标依据实际上传 PNG。',
      '操作后依据新观察继续；execution=not_executed 表示未执行，executed 表示执行器已返回，unknown 表示结果未确认。可能已生效时先核对，不盲目重试；ok 不代表业务目标完成。',
      'human_paused 时停止 computer 调用并等待用户新消息；恢复后先重新观察并核对上一步。human_input/external_input 后重新观察。',
      '澄清与授权遵循【判断与确认】，完成回复遵循【任务完成】；complete_task 用于可选的详细核对和产物交付。',
      '【computer 调用格式】',
      `每次仅输出一个 JSON 代码块，包含 type="computer"、version=${COMPUTER_USE_PROTOCOL_VERSION}、action、step_token、description；action 使用当前可调用动作名，动作参数放同一顶层，不混入其他调用。`,
      'description 为 1–160 字单行中文，说明本步对象、动作和目的，不含思考过程、敏感原文或尚未执行的完成断言。',
      'step_token 使用最新状态或 computer_result.next_step_token，等待结果后再继续，不复用旧令牌；无令牌时等待结果。',
      ...(stepToken === null ? ['当前步骤正在处理或令牌尚未就绪，等待 computer_result 返回 next_step_token 后再发起下一请求。']
        : stepToken ? [`当前 step_token：${stepToken}`] : []),
      ...computerDiscoveryExample(capability, stepToken),
      '按 code/message/data 核对结果；未执行的协议或参数错误按回传修正，不重放未知动作。'
    ])
  ].join('\n')
}
