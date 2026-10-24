import type { CommandRecoveryState, ExecutionRecord } from './types'

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
/** `superseded`: a newer execution took over before this result was handed back; nothing to do. */
export type FocusDelivery = 'pending' | 'sent' | 'blocked' | 'failed' | 'superseded'
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
export interface FocusPageSnapshot {
  path: string
  ready: boolean
  nativeDraft: boolean
  waiting: boolean
  generating: 'active' | 'idle' | 'unknown'
  reply: { sourceMessageId: string; parts: FocusPart[]; answer: string } | null
  smartReplies?: { sourceMessageId: string; answer: string }[]
}
export interface FocusChatState extends FocusOwner {
  ready: boolean
  nativeDraft: boolean
  generating: FocusPageSnapshot['generating']
  waiting: boolean
  turns: FocusTurn[]
  executions: ExecutionRecord[]
  hiddenMessageIds?: string[]
  smartReplies?: { sourceMessageId: string; answer: string }[]
}
/** File delivery has its own persisted lifecycle; shell delivery is recorded by the turn. */
export function focusDelivery(record: ExecutionRecord, delivery?: FocusDelivery): FocusDelivery | undefined {
  if (record.kind !== 'read_files') return delivery
  return record.deliveryStatus === 'sent' ? 'sent' :
    record.deliveryStatus === 'failed' || record.deliveryStatus === 'unknown' ? 'failed' :
      record.deliveryStatus === 'pending' || record.deliveryStatus === 'uploading' ? 'pending' : undefined
}
export type FocusSendOutcome = 'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed' | 'unavailable' | 'invalid' | 'upload-failed' | 'unsupported-file-type' | 'unknown' | 'cancelled'
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
  return text.replace(/^\s*【任务完成】\s*/, '')
}
export function cleanFocusUserText(text: string): string {
  const marker = '\u0000\u0001'
  const index = text.lastIndexOf(marker)
  return index < 0 ? text : text.slice(index + marker.length)
}
