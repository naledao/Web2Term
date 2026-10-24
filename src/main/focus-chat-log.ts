import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FocusOwner, FocusSendOutcome, FocusEditDiagnostic } from '../shared/focus-chat'

interface FocusDiagnostic extends FocusEditDiagnostic {
  event: 'view-state' | 'send-request' | 'send-outcome' | 'edit-request' | 'edit-page' | 'edit-outcome' | 'smart-ui-request' | 'smart-ui-page' | 'smart-ui-outcome' | 'smart-ui-recovered' | 'end-task' | 'user-started' | 'user-captured' | 'user-stored' | 'user-discarded'
  action?: 'choose' | 'submit'
  taskOpen?: boolean
  ready?: boolean
  nativeDraft?: boolean
  waiting?: boolean
  generating?: 'active' | 'idle' | 'unknown'
  turnCount?: number
  executionCount?: number
  reasoningCount?: number
  searchCount?: number
  answerLength?: number
  inputLength?: number
  attachmentCount?: number
  savedAttachmentCount?: number
  turnId?: string
  messageId?: string | null
  imageSource?: 'provided' | 'page'
  outcome?: FocusSendOutcome
}
// One file per platform: `<platform>-focus-ui-*.log`, as for the other diagnostic logs.
const files = new Map<string, { path: string; bytes: number }>()
let serial = 0
const signatures = new Map<string, string>()
const identifier = (value: string | null): string | null => value && /^[a-zA-Z0-9_:-]{1,160}$/.test(value) ? value : null

/** Automatic metadata only. No prompts, messages, commands, output, cookies or screenshots. */
export function writeFocusDiagnostic(owner: FocusOwner, payload: FocusDiagnostic): void {
  try {
    const details: Record<string, string | number | boolean | null> = {
      event: payload.event, sessionId: identifier(owner.sessionId), conversationId: identifier(owner.conversationId)
    }
    for (const key of ['ready', 'nativeDraft', 'waiting', 'taskOpen', 'anchored', 'submitted', 'originalMatches', 'draftMatches',
      'requestBodyReadable', 'requestTextMatches', 'requestOriginalMatches', 'requestStateMatches', 'requestStatePresent', 'requestPathMatches',
      'nativeClickReceived', 'clickTrusted', 'clickPrevented'] as const) if (typeof payload[key] === 'boolean') details[key] = payload[key]!
    if (payload.action === 'choose' || payload.action === 'submit') details.action = payload.action
    for (const key of ['turnCount', 'executionCount', 'reasoningCount', 'searchCount', 'answerLength', 'inputLength', 'attachmentCount', 'savedAttachmentCount',
      'groupCount', 'candidateCount', 'originalLength', 'pageTextLength', 'editorTextLength', 'editorStableReads',
      'settleMs', 'requestUserLength', 'requestCount', 'requestSnapshotCount'] as const) {
      if (Number.isSafeInteger(payload[key]) && Number(payload[key]) >= 0) details[key] = Number(payload[key])
    }
    if (['prepare', 'locate', 'open', 'verify', 'insert', 'submit', 'request', 'confirm'].includes(payload.stage ?? '')) details.stage = payload.stage!
    if (['invalid-request', 'conversation-changed', 'page-busy', 'no-composer', 'native-draft', 'missing-prefix', 'candidate-not-unique',
      'invalid-position', 'edit-button-missing', 'cancelled', 'editor-missing', 'original-text-mismatch', 'insert-failed', 'form-not-ready',
      'new-user-confirmed', 'submit-unconfirmed', 'page-unavailable', 'rules-missing', 'edit-in-progress', 'api-missing', 'invalid-result',
      'page-exception', 'ack-missing', 'draft-not-stable', 'request-matched', 'request-original', 'request-mismatch',
      'request-body-unavailable', 'request-schema-unavailable', 'request-not-observed', 'send-in-progress', 'command-in-flight',
      'question-pending', 'programmatic-send', 'file-send', 'awaiting-reply', 'model-generating', 'text-draft',
      'attachment-draft', 'image-draft', 'history-edit-draft', 'component-missing', 'component-disabled',
      'option-confirmed', 'option-unconfirmed', 'native-click-dispatched', 'native-click-not-received',
      'native-click-target-changed', 'native-click-unreachable', 'native-click-window-unfocused',
      'native-click-dispatch-failed', 'request-unrelated', 'request-state-mismatch', 'request-state-absent'].includes(payload.reason ?? '')) details.reason = payload.reason!
    for (const key of ['turnId', 'messageId'] as const) if (payload[key] !== undefined) details[key] = identifier(payload[key] ?? null)
    if (payload.imageSource === 'provided' || payload.imageSource === 'page') details.imageSource = payload.imageSource
    if (['active', 'idle', 'unknown'].includes(payload.generating ?? '')) details.generating = payload.generating!
    if (['ok', 'busy', 'stuck', 'no-composer', 'insert-failed', 'unavailable', 'invalid', 'upload-failed', 'unsupported-file-type', 'unknown', 'cancelled'].includes(payload.outcome ?? '')) details.outcome = payload.outcome!
    const signature = JSON.stringify(details)
    const ownerKey = owner.sessionId + ':' + owner.platformId
    if (payload.event === 'view-state') {
      if (signatures.get(ownerKey) === signature) return
      // One entry per open workspace; keep the diagnostic cache bounded too.
      if (signatures.size >= 100) signatures.clear()
      signatures.set(ownerKey, signature)
    }
    const now = new Date().toISOString()
    const line = now + ' ' + signature + '\n'
    const bytes = Buffer.byteLength(line)
    // The platform id becomes part of a file name, so only a plain lowercase word is used.
    const platform = /^[a-z]{1,32}$/.test(owner.platformId) ? owner.platformId : 'unknown'
    let file = files.get(platform)
    if (!file || file.bytes + bytes > 2 * 1024 * 1024) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      file = { path: join(directory, platform + '-focus-ui-' + now.replace(/[:.]/g, '-') + '-' + process.pid + '-' + (++serial) + '.log'), bytes: 0 }
      files.set(platform, file)
    }
    appendFileSync(file.path, line, 'utf8')
    file.bytes += bytes
  } catch { /* Logging must never block reading, sending or stopping a task. */ }
}
