import type { ComputerDiagnosis } from './computer-diagnostics'
import { normalizeComputerProgressLimits, normalizeComputerResultDelay } from './computer-progress'
import type { ComputerProgressLimits, ComputerProgressReport } from './computer-progress'
import { computerUseProtocol } from './computer-use-protocol'
import type { ComputerUseProtocolErrorCode } from './computer-use-protocol'
import type { WindowsHelperState } from './windows-helper'

/** These preferences apply only to computer use and its task context, not other tools. */
export interface ComputerUsePreferences {
  computerUseEnabled: boolean
  desktopControlEnabled: boolean
  computerUseLimits?: ComputerProgressLimits
  /** Seconds to wait after a computer action returns before its result is sent to the model. */
  computerResultDelaySeconds?: number
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
}

export interface ComputerUseWireRequest extends Record<string, unknown> {
  type: 'computer'
  version: typeof COMPUTER_USE_PROTOCOL_VERSION
  action: string
  step_token: string
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
  code: 'ok' | 'unavailable' | 'cancelled' | 'executor_error' | 'inactive_context' | 'no_progress' | 'progress_limit' | 'recovery_required' | 'verification_required' | 'stale_catalog' | 'stale_window' | 'invalid_result' | 'launch_failed' | 'open_failed'
    | 'focus_denied' | 'focus_unconfirmed' | 'external_input' | 'human_takeover' | 'input_monitor_unavailable' | 'window_blocked' | 'restore_required' | 'capture_failed' | 'capture_blocked' | 'stale_observation'
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
    ...(input.computerUseLimits !== undefined ? { computerUseLimits: normalizeComputerProgressLimits(input.computerUseLimits) } : {}),
    ...(input.computerResultDelaySeconds !== undefined ? { computerResultDelaySeconds: normalizeComputerResultDelay(input.computerResultDelaySeconds) } : {})
  }
}

const MESSAGES: Record<ComputerUseReason, string> = {
  'emergency-stopped': '全局急停已锁定自动操作，请在客户端明确解除。',
  'no-session': '请在 DeepSeek 本机会话中查看桌面能力。',
  'remote-session': '远程会话暂不提供本机桌面控制，请使用 DeepSeek 本机会话。',
  'unsupported-platform': '桌面能力首版仅适配 DeepSeek，请切换到 DeepSeek 本机会话。',
  'unsupported-os': '桌面能力首版仅支持 Windows x64 本机环境。',
  'unsupported-arch': '当前客户端架构暂不支持桌面控制，首版仅支持 Windows x64。',
  'computer-use-disabled': 'computer use 已关闭。',
  'desktop-disabled': 'computer use 的桌面控制已关闭。',
  'runtime-not-ready': '当前版本已支持工具接入与任务记录，桌面执行器尚未接入。',
  ready: 'computer use 工具已就绪。'
}

const PARAMETER_TYPES: readonly ComputerUseParameterType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array']
const RESERVED_FIELDS = new Set(['type', 'version', 'action', 'step_token', 'command', 'read_files', 'question', 'questions', 'files',
  'background', 'task_id', 'session_id', 'generation', 'permissions', 'connection', 'constructor', 'prototype', '__proto__'])
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const shortText = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit

/** Structural argument types only; action-specific bounds and identities belong to its validator. */
export function computerUseParametersMatch(definition: ComputerUseActionDefinition, value: unknown): value is Record<string, unknown> {
  return computerUseProtocol.parametersMatch(definition, value)
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
      : context.platformId !== 'deepseek' ? 'unsupported-platform'
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
export function computerUseCapabilityPrompt(capability: ComputerUseCapability, stepToken?: string | null): string {
  if (!capability.computerUseEnabled && !capability.desktopControlEnabled) return ''
  return [
    '【工具能力：computer use】',
    '用途：操作本机应用界面，发现与启动应用、查看窗口、获取截图与控件信息、执行已接入的桌面输入动作，以及等待动作清单支持的桌面条件或已有后台任务依赖。具体可调用范围以下方当前动作清单为准。',
    '需要操作应用界面时可选择此工具；适合命令、文件或耗时处理的步骤可使用现有终端、文件和后台任务工具，并按任务需要组合使用。',
    '此工具不要求先提交计划或拆分步骤。收到工具的真实结果后，根据当前任务判断下一步；不要臆测未返回的界面状态。',
    `computer use：${capability.computerUseEnabled ? '已启用' : '已关闭'}；桌面控制：${capability.desktopControlEnabled ? '已允许' : '已关闭'}。`,
    ...(capability.context.platformId === 'deepseek' ? ['DeepSeek 网页视觉理解能力已由用户确认，无需再次确认或配置视觉模型 API Key。'] : []),
    capability.message,
    ...(!capability.available ? [
      '当前没有可调用的 computer 桌面动作。不要输出 computer 工具请求，不要声称已观察或操作桌面。继续使用实际提供的现有工具。'
    ] : [
      '【computer 当前可调用动作与参数】',
      ...capability.actionDefinitions.flatMap(definition => [
        `${definition.action}：${definition.description}`,
        ...(definition.parameters.length ? definition.parameters.map(parameter =>
          `- ${parameter.name}：${parameter.type}，${parameter.required ? '必填' : '可选'}；${parameter.description}` +
          (parameter.minimum !== undefined ? `；最小值 ${parameter.minimum}` : '') + (parameter.maximum !== undefined ? `；最大值 ${parameter.maximum}` : '') +
          (parameter.minLength !== undefined ? `；最少 ${parameter.minLength} 字符` : '') + (parameter.maxLength !== undefined ? `；最多 ${parameter.maxLength} 字符` : '') +
          (parameter.maxItems !== undefined ? `；最多 ${parameter.maxItems} 项` : '') + (parameter.enum ? `；取值 ${JSON.stringify(parameter.enum)}` : '')) : ['- 无动作专属参数。']),
        ...(definition.locatorAlternatives ? [`定位方式必须完整选择一组，组间互斥：${JSON.stringify(definition.locatorAlternatives)}`] : [])
      ]),
      '【computer 调用格式】',
      '沿用现有每轮一个 JSON 请求的方式，需要当前动作提供的观察、输入或条件等待时输出一个 computer JSON 代码块。type 固定为 computer，version 为 1，action 从当前动作清单选择；动作参数放在顶层。',
      'step_token 使用软件为当前任务提供的有效步骤令牌；没有令牌或观察引用时不得猜测。不得在同一请求中混入 command、read_files 或 questions。',
      ...(stepToken === null ? ['当前步骤正在处理或令牌尚未就绪，等待 computer_result 返回 next_step_token 后再发起下一请求。'] : [
      ...(stepToken ? [`当前 step_token：${stepToken}`] : []),
      '以下仅为格式示例；使用实际动作参数及有效令牌：',
      '```json',
      JSON.stringify({ type: 'computer', version: COMPUTER_USE_PROTOCOL_VERSION,
        action: capability.actionDefinitions[0].action, step_token: stepToken ?? '<当前有效步骤令牌>', ...capability.actionDefinitions[0].example }),
      '```']),
      '【computer 返回结果】',
      '返回 type=computer_result、version、action、ok、execution、code、message，以及该动作提供的 data；截图、控件和观察引用由实际动作结果提供。',
      'task_continuity 是同一目标的跨应用历史线索，包含已发现应用、窗口身份、实际读取／打开的资源和切换记录；应用、窗口不要求用户预选。历史线索不授权输入，也不证明文件由本任务生成或业务完成。requires_fresh_observation 约束历史线索，当前动作 data 中实际返回的新观察仍按原规则使用，无需为该标记重复采集。切换应用、返回旧窗口或终端执行后，按真实窗口重新发现／激活／观察，再使用新观察引用输入；每次动作仍明确提供目标，不默认操作上一个窗口。',
      'execution=not_executed 表示未执行，executed 表示动作执行器已返回，unknown 表示操作可能已生效但结果未确认。ok 不代表整项用户任务完成，需按实际界面或产物核对结果。',
      'diagnosis 是客户端根据结构化错误、真实执行事实、当前可用工具和本次观察提供的诊断线索；candidate_paths 只列可选路径，不是已经执行的修复计划。由你结合原目标自主选择重新发现／观察、调整方法、条件等待或已有终端／文件工具，沿用各工具协议及确认规则。常规窗口定位、焦点修复和控件失效优先自主处理，不直接要求用户代操作。',
      '只读观察失败可在归属仍有效时重新请求；点击、输入、启动、发送或保存可能已生效时先查真实后状态，不能为补截图重复输入。diagnosis 中的观察摘要不授予输入权限；优先利用本次 data／附件中已有的新观察，requires_fresh_observation=true 时先取得新的 observe。部分控件树、等待超时和空发现结果不证明目标不存在或业务失败。',
      '焦点变化本身不代表人工接管；应用启动、自己的点击或弹窗出现后，旧观察可能已失效，先核对真实窗口和焦点，再决定观察或恢复。external_input 表示其他来源的注入干扰，先重新观察并自主选择后续路径；human_takeover 表示用户接管，暂停并等待用户明确继续，不能自行抢回焦点。',
      '需要澄清或任务内授权时沿用原 questions 协议和确认规则，不增加逐应用或逐步确认。先用实际工具取得可核实的信息；仅为无法从环境取得的必要用户信息、会超出原目标的决定或系统／站点强制人类步骤提问，并在题干说明阻塞原因、所需回答或最小人工步骤。登录、验证码等由用户在实际界面完成，不索取密码或验证码正文。',
      'task_clarification_context 只记录原任务的问题、真实回答及交付状态，grants_permissions=false；用户允许、拒绝和新增限制以原对话完整回答为准，不能将一次回答扩大为全局授权或替用户修改执行开关／确认模式。关闭问题、发送中、发送未知和历史回放都不代表同意。回答确认后继续原目标，先重新观察人工介入后状态，尊重用户预设限制，不重放之前的输入或提交。',
      'task_completion_context 提供本任务所有输入编号和主进程证据。整项目标完成请调用 complete_task，逐条说明要求如何满足并引用实际证据；先核对回读内容、下载完成状态和界面后状态，再列出实际文件产物与未确认事项。主进程会复核文件与未决依赖，确认交付报告后才完成任务。空 command 或普通完成文字只作为模型声明，不能代替核对。',
      'progress_control 记录当前目标的步骤、重复动作、相同观察、超时和恢复预算；新令牌、新观察编号、交付成功和退出码 0 不证明业务进展。出现信号时根据真实结果重新诊断或换路径；相同输入／启动动作没有新状态证据时会被拦截。达到硬上限后保留未完成原因并停止，不自动重启任务或放宽上限，不能声称目标已完成。',
      '每个 step_token 只用于当前任务的一步；收到 next_step_token 后只使用新令牌。协议错误结果明确标记 not_executed，按错误信息修正请求；操作是否生效为 unknown 时先观察核对。'
    ])
  ].join('\n')
}
