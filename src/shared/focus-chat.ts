import type { CommandRecoveryState, ExecutionRecord } from './types'
import type { FocusPromptInjectionState } from './focus-token-usage'
import type { ContextUsageSummary } from './context-usage'
import type { TaskToolStep } from './autonomous-task'
import type { ComputerUseToolResult } from './computer-use'

export type ChatView = 'original' | 'local' | 'focus'
export const DEFAULT_CHAT_VIEW: ChatView = 'focus'

/**
 * The platforms that get the focus view, and how the view names them.
 *
 * The ONE switch for the whole feature: the view, its IPC, the turn reducer and the page
 * reads all ask `supportsFocusView`. A platform belongs here only once its page has measured
 * focus rules (`PageAdapter.focus` in platforms.ts) — without them the view has nothing to
 * read — and its uploader, composer and stop control already work in the original view.
 */
const FOCUS_PLATFORMS: Readonly<Record<string, { label: string }>> = {
  deepseek: { label: 'DeepSeek' },
  chatgpt: { label: 'ChatGPT' }
}
export function supportsFocusView(platformId: string): boolean {
  return Object.prototype.hasOwnProperty.call(FOCUS_PLATFORMS, platformId)
}
/** Editing rules have been measured only for ChatGPT. */
export function supportsFocusEdit(platformId: string): boolean { return platformId === 'chatgpt' }
/** The model's name as the focus view shows it. */
export function focusPlatformLabel(platformId: string): string {
  return supportsFocusView(platformId) ? FOCUS_PLATFORMS[platformId].label : platformId
}
/** For "专注对话当前支持 …" hints. */
export function focusPlatformLabels(): string {
  return Object.values(FOCUS_PLATFORMS).map(platform => platform.label).join('、')
}
export type FocusTurnStatus = 'working' | 'answered' | 'stopped' | 'blocked'
/** `superseded`: a newer execution took over; `background`: dedicated task notifications own the results. */
export type FocusDelivery = 'pending' | 'sent' | 'blocked' | 'failed' | 'superseded' | 'background'
export const FOCUS_MAX_FILES = 3
export const FOCUS_MAX_FILE_BYTES = 20 * 1024 * 1024
export const FOCUS_MAX_BATCH_BYTES = 25 * 1024 * 1024
export interface FocusAttachmentInfo { fileName: string; mimeType: string; sizeBytes: number }
export interface FocusAttachmentInput extends FocusAttachmentInfo { dataBase64: string }
export function validFocusFiles(files: unknown): files is FocusAttachmentInput[] {
  if (!Array.isArray(files) || files.length > FOCUS_MAX_FILES) return false
  let total = 0
  return files.every(file => {
    if (!file || typeof file.fileName !== 'string' || !file.fileName.trim() || file.fileName.length > 240 ||
      /[\\/\u0000-\u001f]/.test(file.fileName) || typeof file.mimeType !== 'string' ||
      file.mimeType.length > 160 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > FOCUS_MAX_FILE_BYTES ||
      typeof file.dataBase64 !== 'string' || file.dataBase64.length !== 4 * Math.ceil(file.sizeBytes / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64)) return false
    total += file.sizeBytes
    return total <= FOCUS_MAX_BATCH_BYTES
  })
}
export interface FocusPart {
  kind: 'reasoning' | 'search'
  text: string
  url?: string
}
export interface FocusSegment {
  cycle: number
  sourceMessageId: string | null
  parts: FocusPart[]
  answer: string
  settled: boolean
}
export type FocusToolKind = 'read_tool_prompt' | 'scheduled_task' | 'send_email' | 'computer'
export type FocusToolStatus = 'running' | 'done' | 'failed' | 'blocked' | 'cancelled' | 'unknown'
export type FocusToolDelivery = 'pending' | 'sent' | 'blocked' | 'failed' | 'unknown'
/** Display history only. It never grants permission to dispatch or retry a tool. */
export interface FocusToolCall {
  id: string
  sourceMessageId: string
  tool: FocusToolKind
  title: string
  request: string
  cycle: number
  status: FocusToolStatus
  delivery: FocusToolDelivery
  result: string
  createdAt: number
  updatedAt: number
}
export type FocusToolUpdate = Partial<Pick<FocusToolCall, 'status' | 'delivery' | 'result'>>
export type FocusToolObserver = (update: FocusToolUpdate) => void
export const FOCUS_TOOL_LABELS: Readonly<Record<FocusToolKind, string>> = {
  read_tool_prompt: '读取工具说明', scheduled_task: '定时任务', send_email: '发送邮件通知', computer: '电脑操作'
}
export function focusToolInfo(tool: FocusToolKind, rawJson: string): { title: string; request: string } {
  let value: Record<string, unknown> = {}
  try { if (rawJson.length <= 256_000) value = JSON.parse(rawJson) ?? {} } catch { /* Display metadata never authorizes a request. */ }
  const text = (input: unknown, limit = 200): string => typeof input === 'string' ? input.slice(0, limit) : ''
  const names: Readonly<Record<string, string>> = { ...FOCUS_TOOL_LABELS, read_files: '读取文件', background_task: '后台任务' }
  if (tool === 'read_tool_prompt') return { title: FOCUS_TOOL_LABELS[tool], request: Array.isArray(value.tools)
    ? value.tools.filter((item): item is string => typeof item === 'string' && /^[a-z_]{1,40}$/.test(item)).slice(0, 5)
      .map(item => Object.hasOwn(names, item) ? names[item] : item).join('、') : '' }
  if (tool === 'scheduled_task') {
    const actions: Record<string, string> = { create: '创建定时任务', list: '查询定时任务', get: '查看定时任务', update: '修改定时任务', delete: '删除定时任务' }
    const action = text(value.action) || 'create'
    return { title: Object.hasOwn(actions, action) ? actions[action] : FOCUS_TOOL_LABELS[tool], request: text(value.id) }
  }
  // Do not copy email bodies, computer input text, screenshots or credentials into display history.
  return { title: FOCUS_TOOL_LABELS[tool], request: text(tool === 'send_email' ? value.subject : value.action) }
}
export function focusToolDelivery(outcome: string): FocusToolDelivery {
  return outcome === 'ok' || outcome === 'sent' ? 'sent' : outcome === 'busy' || outcome === 'no-composer' ? 'pending'
    : outcome === 'stale' || outcome === 'cancelled' ? 'blocked' : outcome === 'unknown' ? 'unknown' : 'failed'
}
export function focusComputerResultUpdate(result: Pick<ComputerUseToolResult, 'ok' | 'execution' | 'message'>): FocusToolUpdate {
  return { status: result.execution === 'unknown' ? 'unknown' : result.ok === true ? 'done' : result.execution === 'not_executed' ? 'blocked' : 'failed',
    ...(typeof result.message === 'string' ? { result: result.message } : {}) }
}
export function focusComputerToolUpdate(step: Pick<TaskToolStep, 'status' | 'execution' | 'delivery' | 'message' | 'resultText'>): FocusToolUpdate {
  const update: FocusToolUpdate = { delivery: step.delivery === 'sent' ? 'sent' : step.delivery === 'failed' ? 'failed'
    : step.delivery === 'uncertain' ? 'unknown' : step.delivery === 'cancelled' ? 'blocked' : 'pending' }
  if (step.message) update.result = step.message
  if (step.status === 'queued' || step.status === 'executing') update.status = 'running'
  else if (step.resultText) {
    try {
      Object.assign(update, focusComputerResultUpdate(JSON.parse(step.resultText)))
    } catch { update.status = 'unknown' }
  } else if (step.execution === 'unknown') update.status = 'unknown'
  else if (step.status === 'interrupted' && step.execution === 'not_executed') update.status = 'cancelled'
  // Delivery clears resultText. Preserve the recorded execution outcome instead of inventing success.
  return update
}
export function validFocusToolCall(value: unknown): value is FocusToolCall {
  if (!value || typeof value !== 'object') return false
  const call = value as FocusToolCall
  return typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 600 &&
    typeof call.sourceMessageId === 'string' && call.sourceMessageId.length > 0 && call.sourceMessageId.length <= 512 &&
    Object.hasOwn(FOCUS_TOOL_LABELS, call.tool) && typeof call.title === 'string' && call.title.length <= 100 &&
    typeof call.request === 'string' && call.request.length <= 500 && typeof call.result === 'string' && call.result.length <= 4100 &&
    ['running', 'done', 'failed', 'blocked', 'cancelled', 'unknown'].includes(call.status) &&
    ['pending', 'sent', 'blocked', 'failed', 'unknown'].includes(call.delivery) &&
    Number.isSafeInteger(call.cycle) && call.cycle >= 0 && Number.isFinite(call.createdAt) && Number.isFinite(call.updatedAt)
}
export interface FocusTurn {
  id: string
  userMessageId: string | null
  userText: string
  userAttachments?: FocusAttachmentInfo[]
  createdAt: number
  updatedAt: number
  status: FocusTurnStatus
  segments: FocusSegment[]
  executionIds: string[]
  executionCycles: Record<string, number>
  deliveries: Record<string, FocusDelivery>
  toolCalls?: FocusToolCall[]
  /** Archived locally after a confirmed edit; retained for execution/history records. */
  supersededBy?: string
  /** Local transcript rows belonging to branches replaced by this edit. */
  hiddenMessageIds?: string[]
  notice?: 'parse-failed'
  commandRecovery?: CommandRecoveryState
  /** Unexecuted protocol requests; never added to the shell execution queue. */
  parseFailures?: { messageId: string; text: string; code: string; createdAt: number }[]
}
export interface FocusOwner {
  sessionId: string
  platformId: string
  conversationId: string | null
}
export type FocusComposerModeId = 'thinking' | 'search'
export const FOCUS_COMPOSER_MODES = [{ id: 'thinking', label: '深度思考' }, { id: 'search', label: '智能搜索' }] as const
export interface FocusComposerMode { id: FocusComposerModeId; active: boolean | null; disabled: boolean }
export interface FocusComposerModeRequest extends FocusOwner { id: FocusComposerModeId; active: boolean }
export function validFocusComposerModes(value: unknown): value is FocusComposerMode[] {
  return Array.isArray(value) && value.length <= 2 && new Set(value.map(mode => mode?.id)).size === value.length && value.every(mode =>
    !!mode && ['thinking', 'search'].includes(mode.id) && (mode.active === null || typeof mode.active === 'boolean') && typeof mode.disabled === 'boolean')
}
export interface FocusModelOption { value: string; label: string }
export interface FocusModelSettings {
  model: string | null
  effort: string | null
  models: FocusModelOption[]
  efforts: FocusModelOption[]
}
export type FocusModelSettingKind = 'read' | 'model' | 'effort'
export interface FocusModelSettingsRequest extends FocusOwner { kind: FocusModelSettingKind; value?: string }
export interface FocusModelSettingsResult { outcome: FocusSendOutcome; settings: FocusModelSettings | null; reason?: string }
export function validFocusModelSettings(value: unknown): value is FocusModelSettings {
  if (!value || typeof value !== 'object') return false
  const settings = value as FocusModelSettings
  const options = (items: unknown): items is FocusModelOption[] => Array.isArray(items) && items.length <= 20 &&
    new Set(items.map(item => item?.value)).size === items.length && items.every(item => item &&
      typeof item.value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._()+:/-]{0,79}$/.test(item.value) &&
      typeof item.label === 'string' && item.label.trim().length > 0 && item.label.length <= 100 && !/[\u0000-\u001f]/.test(item.label))
  return options(settings.models) && options(settings.efforts) &&
    (settings.model === null || settings.models.some(item => item.value === settings.model)) &&
    (settings.effort === null || settings.efforts.some(item => item.value === settings.effort))
}
export function validFocusModelSettingsRequest(request: FocusModelSettingsRequest): boolean {
  return request.kind === 'read' ? request.value === undefined : ['model', 'effort'].includes(request.kind) &&
    typeof request.value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._()+:/-]{0,79}$/.test(request.value)
}
export interface FocusSendFailure {
  id: string
  message: string
  retryable: boolean
}
export function validFocusSendFailure(value: unknown): value is FocusSendFailure {
  if (!value || typeof value !== 'object') return false
  const failure = value as FocusSendFailure
  return typeof failure.id === 'string' && failure.id.length > 0 && failure.id.length <= 512 &&
    typeof failure.message === 'string' && failure.message.trim().length > 0 && failure.message.length <= 500 &&
    typeof failure.retryable === 'boolean'
}
export interface FocusPageSnapshot {
  path: string
  ready: boolean
  nativeDraft: boolean
  waiting: boolean
  sendFailure?: FocusSendFailure | null
  generating: 'active' | 'idle' | 'unknown'
  reply: { sourceMessageId: string; parts: FocusPart[]; answer: string } | null
  smartReplies?: { sourceMessageId: string; answer: string }[]
  composerModes?: FocusComposerMode[]
  modelSettings?: FocusModelSettings
  /** The current page has one rendered, enabled model trigger; independent of the composer. */
  modelSettingsReady?: boolean
}
export interface FocusChatState extends FocusOwner {
  historyCursor?: FocusHistoryCursor
  ready: boolean
  nativeDraft: boolean
  generating: FocusPageSnapshot['generating']
  waiting: boolean
  sendFailure?: FocusSendFailure | null
  turns: FocusTurn[]
  executions: ExecutionRecord[]
  hiddenMessageIds?: string[]
  smartReplies?: { sourceMessageId: string; answer: string }[]
  composerModes?: FocusComposerMode[]
  modelSettings?: FocusModelSettings
  modelSettingsReady?: boolean
  /** Display-only snapshot of the same planner that owns the next task's prefix. */
  promptInjection?: FocusPromptInjectionState
  contextUsage?: ContextUsageSummary
  /** Set while computer use is on and the Windows helper is not ready: why sending waits. */
  sendBlock?: string | null
}
/** Revisions are scoped to an owner; omitted collections mean reuse that owner's snapshot. */
export interface FocusHistoryCursor {
  ownerKey: string
  turns: number
  executions: string
}
export type FocusChatUpdate = Omit<FocusChatState, 'turns' | 'executions' | 'hiddenMessageIds'> & {
  turns?: FocusTurn[]
  executions?: ExecutionRecord[]
  hiddenMessageIds?: string[]
}
/** File delivery has its own persisted lifecycle; shell delivery is recorded by the turn. */
export function focusDelivery(record: ExecutionRecord, delivery?: FocusDelivery): FocusDelivery | undefined {
  if (record.kind !== 'read_files') {
    // Older turns saved a successful background startup as waiting for a normal
    // shell result, even though the background notification queue replaced it.
    if (record.background && record.status === 'done' && (!delivery || delivery === 'pending')) return 'background'
    return delivery
  }
  return record.deliveryStatus === 'sent' ? 'sent' :
    record.deliveryStatus === 'failed' || record.deliveryStatus === 'unknown' ? 'failed' :
      record.deliveryStatus === 'pending' || record.deliveryStatus === 'uploading' ? 'pending' : undefined
}
export type FocusSendOutcome = 'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed' | 'unavailable' | 'invalid' | 'upload-failed' | 'unsupported-file-type' | 'unknown' | 'cancelled' | 'helper-not-ready'
export interface FocusSendRequest extends FocusOwner { text: string; files?: FocusAttachmentInput[] }
export interface FocusEditRequest extends FocusOwner { messageId: string; text: string }
/** Metadata only, produced by the page's edit pipeline; no message or prompt text. */
export interface FocusEditDiagnostic {
  stage?: string
  reason?: string
  anchored?: boolean
  submitted?: boolean
  originalMatches?: boolean
  draftMatches?: boolean
  requestBodyReadable?: boolean
  requestTextMatches?: boolean
  requestOriginalMatches?: boolean
  requestStateMatches?: boolean
  requestStatePresent?: boolean
  requestSnapshotCount?: number
  requestPathMatches?: boolean
  nativeClickReceived?: boolean
  clickTrusted?: boolean
  clickPrevented?: boolean
  groupCount?: number
  candidateCount?: number
  originalLength?: number
  pageTextLength?: number
  editorTextLength?: number
  editorStableReads?: number
  settleMs?: number
  requestUserLength?: number
  requestCount?: number
}
/** A text selection in a focus-view answer, asked about in the side chat. */
export interface FocusSelectionRequest extends FocusOwner {
  selectedText: string
  question: string
  /** The rendered answer's text, so the selection can be checked against it. */
  answerText: string
  /** The capture key of that answer; absent for history rows saved without one. */
  sourceMessageId?: string
}
export function focusOwnerKey(owner: FocusOwner): string {
  return JSON.stringify([owner.sessionId, owner.platformId, owner.conversationId])
}
export function cleanFocusAnswer(text: string): string {
  const answer = text.replace(/^\s*(?:#{1,6}[ \t]+)?(?:\*\*【任务完成】\*\*|__【任务完成】__|【任务完成】)\s*/, '')
  // Interpret only an entire transport object. Prose explaining JSON and code
  // examples embedded in a normal answer must retain their original formatting.
  let body = answer.trim().replace(/^JSON[ \t]*(?:\r?\n)+/i, '')
  const opening = /^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n/i.exec(body)
  if (opening) {
    body = body.slice(opening[0].length)
    const closing = new RegExp('(?:^|\\r?\\n)' + opening[1] + '[ \\t]*(?:\\r?\\n|$)').exec(body)
    if (closing) {
      if (body.slice(closing.index + closing[0].length).trim()) return answer
      body = body.slice(0, closing.index)
    }
  }
  body = body.trim()
  if (!body.startsWith('{')) return answer
  let value: Record<string, unknown>
  try { value = JSON.parse(body) }
  catch {
    // Never flash an unfinished transport request while its code block streams.
    return /^\{\s*(?:"command"\s*:|"type"\s*:\s*"(?:questions?|read_files|scheduled_task|send_email|read_tool_prompt)"(?:\s*[,}]|\s*$))/.test(body) ? '' : answer
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return answer
  if (typeof value.command === 'string' || value.type === 'read_files' || value.type === 'send_email') return ''
  if (value.type === 'read_tool_prompt') {
    const tools = Array.isArray(value.tools) ? value.tools.filter((name): name is string => typeof name === 'string' && /^[a-z_]{1,40}$/.test(name)) : []
    return tools.length ? `正在读取工具说明：${tools.join('、')}` : ''
  }
  if (value.type === 'scheduled_task') {
    if (value.action === undefined || value.action === 'create') return '正在创建定时任务'
    if (value.action === 'list' || value.action === 'get') return '正在查询定时任务'
    if (value.action === 'update') return '正在修改定时任务'
    if (value.action === 'delete') return '正在删除定时任务'
    return ''
  }
  if (value.type !== 'question' && value.type !== 'questions') return answer
  const questions = value.type === 'questions' ? value.questions : [{ question: value.question }]
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 20 ||
    questions.some(item => !item || typeof item.question !== 'string' || !item.question.trim() || item.question.length > 16000)) return ''
  return questions.map((item, index) => `${index + 1}. ${item.question.trim()}`).join('\n')
}
export function cleanFocusUserText(text: string): string {
  const marker = '\u2063\u2063'
  const index = Math.max(text.lastIndexOf(marker), text.lastIndexOf('\u0000\u0001'))
  return index < 0 ? text : text.slice(index + marker.length)
}
