import type { ExecutionRecord } from './types'

export type ChatView = 'original' | 'local' | 'focus'
export type FocusTurnStatus = 'working' | 'answered' | 'stopped'
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
  notice?: 'parse-failed'
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
}
export interface FocusChatState extends FocusOwner {
  ready: boolean
  nativeDraft: boolean
  generating: FocusPageSnapshot['generating']
  waiting: boolean
  turns: FocusTurn[]
  executions: ExecutionRecord[]
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
