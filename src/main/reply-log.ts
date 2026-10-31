import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPlatform } from '../shared/platforms'
import type { InterceptorPageEvent } from '../shared/types'

type PlatformId = ChatPlatform['id']
type Metadata = Record<string, string | number | boolean | null>

export interface ReplyDiagnosticContext {
  viewId: number | null
  conversationId: string | null
  mainPendingQuestion: boolean
  mainTaskPromptGeneration?: number
  questionAccepted?: boolean
  computerAccepted?: boolean
}

const events = new Set([
  'installed', 'configured', 'sent', 'sent-raw', 'scan', 'reply-state', 'question',
  'question-cleared', 'command', 'read-files', 'computer-request', 'parse-failed', 'task-finished', 'end-task', 'reply-watchdog',
  'continue-generation', 'command-recovery', 'native-edit'
])
const reasons = new Set([
  'no-turns', 'no-visible-turns', 'not-assistant-turn', 'no-key', 'already-handled', 'question-still-generating',
  'question-not-live', 'invalid-question', 'invalid-read-files', 'no-command', 'still-generating',
  'terminal-mode-off', 'result-sent', 'user-sent', 'question-detected', 'non-command-reply',
  'history-baseline', 'manual-resume', 'file-send-submitted', 'configured-baseline', 'task-ended',
  'continue-clicked', 'continue-unreachable', 'continue-limit', 'duplicate-command', 'command-format-error',
  'computer-quoted-content', 'computer-not-live', 'computer-reply-cut-off',
  'stopped-continue-sent', 'stopped-continue-failed', 'stopped-continue-limit', 'resume-forced', 'computer-rejected',
  'user-edited', 'native-edit-retry', 'native-edit-unconfirmed', 'native-edit-not-latest', 'native-edit-no-task',
  'safety-leak-detected', 'safety-leak-edit-click', 'safety-leak-send-click', 'safety-leak-limit', 'safety-leak-failed',
  'analysis-leak-detected', 'analysis-leak-edit-click', 'analysis-leak-send-click', 'analysis-leak-limit', 'analysis-leak-failed',
  'native-edit-draft', 'stopped-retry-detected', 'stopped-retry-edit-click', 'stopped-retry-send-click',
  'stopped-retry-limit', 'stopped-retry-failed', 'stopped-retry-abandoned'
])

function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(value) ? value : null
}

/** Explicit metadata whitelist: never retain commands, questions, prose, DOM text or URLs. */
export function replyDiagnosticMetadata(
  platformId: PlatformId,
  payload: InterceptorPageEvent,
  context: ReplyDiagnosticContext
): Metadata | null {
  if (!['chatgpt', 'deepseek', 'claude', 'gemini'].includes(platformId) || !events.has(payload.event)) return null
  const details: Metadata = {
    platformId,
    event: payload.event,
    viewId: Number.isSafeInteger(context.viewId) && Number(context.viewId) >= 0 ? context.viewId : null,
    conversationId: identifier(context.conversationId),
    mainPendingQuestion: context.mainPendingQuestion === true
  }
  if (Number.isSafeInteger(context.mainTaskPromptGeneration) && context.mainTaskPromptGeneration! >= 0) {
    details.mainTaskPromptGeneration = context.mainTaskPromptGeneration!
  }
  if (payload.reason !== undefined) details.reason = reasons.has(payload.reason) ? payload.reason : 'unknown'
  for (const key of ['messageId', 'lastHandledMessageId', 'lastMatchedMessageId', 'lastVisibleMessageId', 'visibleAnswerOwnerMessageId'] as const) {
    if (payload[key] !== undefined) details[key] = identifier(payload[key])
  }
  for (const key of [
    'taskPromptGeneration', 'assistantTurnCount', 'hiddenTurnCount', 'replyTextLength', 'codeBlockCount', 'textLength', 'objectCount',
    'selectedNodeTextLength', 'replyTextContentLength', 'visibleAssistantTurnCount', 'lastVisibleReplyTextLength',
    'lastVisibleReplyCodeBlockCount', 'visibleAnswerMarkerCount', 'visibleAnswerTextLength',
    'visibleAnswerCodeBlockCount', 'visibleCodeBlockCount', 'lastScanAgeMs', 'lastMutationAgeMs', 'attempt', 'parseErrorOffset', 'parseFailureToken'
  ] as const) {
    const value = payload[key]
    if (Number.isSafeInteger(value) && Number(value) >= 0) details[key] = Number(value)
  }
  for (const key of [
    'enabled', 'awaitingReply', 'awaitingReplyBefore', 'taskActive', 'pendingQuestionFound', 'replySnapshotAvailable',
    'answerMarkerFound', 'replyRootIsTurn', 'stopButtonFound', 'stopButtonOnPage',
    'composerFound', 'toolbarRootFound', 'bracesBalanced', 'live', 'completed', 'selectedNodeVisible',
    'selectedReplyVisible', 'selectedMatchesLastVisible', 'selectedFromRenderedTurns', 'replySettlePending', 'fileSendPending'
  ] as const) {
    if (typeof payload[key] === 'boolean') details[key] = payload[key]!
  }
  if (['row', 'edit-button', 'editor', 'submit', 'task', 'generation', 'error'].includes(payload.step ?? '')) details.step = payload.step!
  for (const key of ['replyKind', 'lastVisibleReplyKind', 'visibleAnswerKind'] as const) {
    if (['empty', 'questions', 'read-files', 'command', 'computer', 'prose'].includes(payload[key] ?? '')) details[key] = payload[key]!
  }
  for (const key of ['lastScanAgeMs', 'lastMutationAgeMs'] as const) {
    if (payload[key] === null) details[key] = null
  }
  if (['true', 'false', 'missing', 'unknown'].includes(payload.replyStreamingState ?? '')) details.replyStreamingState = payload.replyStreamingState!
  if (['code', 'rendered'].includes(payload.commandSource ?? '')) details.commandSource = payload.commandSource!
  if (['invalid-json', 'invalid-background', 'invalid-command', 'duplicate-field'].includes(payload.parseErrorCode ?? '')) details.parseErrorCode = payload.parseErrorCode!
  if (['command', 'description', 'background', 'timeout_seconds'].includes(payload.parseErrorField ?? '')) details.parseErrorField = payload.parseErrorField!
  if (payload.parseRepair === 'windows-path') details.parseRepair = payload.parseRepair
  if (['pending', 'sent', 'blocked', 'failed', 'uncertain'].includes(payload.recoveryStatus ?? '')) details.recoveryStatus = payload.recoveryStatus!
  if (payload.reason === 'computer-not-live' && payload.computerLive && typeof payload.computerLive === 'object') {
    const live = payload.computerLive
    if (typeof live.failed === 'string' && /^[a-z-]{1,40}$/.test(live.failed)) details.liveFailed = live.failed
    for (const key of ['waitPresent', 'waitIsCurrent', 'reported', 'enabled', 'computerUseEnabled', 'sourceSubmission', 'awaiting',
      'pendingQuestion', 'epochMatch', 'pathBindable', 'pathMatch', 'nodeConnected', 'nodeVisible', 'latestIsNode', 'idPresent',
      'idInBaseline', 'positionPresent', 'positionInBaseline']) {
      if (typeof live[key] === 'boolean') details[`live${key[0].toUpperCase()}${key.slice(1)}`] = live[key] as boolean
    }
    for (const key of ['waitConversationId', 'locationConversationId']) {
      if (live[key] !== undefined) details[`live${key[0].toUpperCase()}${key.slice(1)}`] = identifier(live[key])
    }
    for (const key of ['waitGeneration', 'stateGeneration', 'bindCount', 'baselineIdCount', 'baselinePositionCount', 'replyCandidateCount']) {
      if (Number.isSafeInteger(live[key]) && Number(live[key]) >= 0) details[`live${key[0].toUpperCase()}${key.slice(1)}`] = Number(live[key])
    }
    // Shapes only: the page already replaced every long segment (ids) with :id.
    for (const key of ['locationPath', 'waitPath', 'baselinePath']) {
      if (typeof live[key] === 'string' && /^[a-z0-9/:_-]{1,60}$/i.test(live[key] as string)) details[`live${key[0].toUpperCase()}${key.slice(1)}`] = live[key] as string
    }
  }
  if (typeof context.questionAccepted === 'boolean') details.questionAccepted = context.questionAccepted
  if (typeof context.computerAccepted === 'boolean') details.computerAccepted = context.computerAccepted
  if (payload.event === 'computer-request') {
    if (['invalid_json', 'duplicate_field', 'unsafe_field', 'limit_exceeded', 'invalid_envelope', 'unsupported_version',
      'unknown_action', 'invalid_parameters', 'invalid_step_token', 'stale_step_token', 'ambiguous_request', 'invalid_description'].includes(payload.computerProtocolCode ?? '')) {
      details.computerProtocolCode = payload.computerProtocolCode!
    }
    if (['candidate', 'invalid'].includes(payload.computerOutcome ?? '')) details.computerOutcome = payload.computerOutcome!
    if (['invalid-json', 'ambiguous-request', 'oversized-request'].includes(payload.computerIssue ?? '')) details.computerIssue = payload.computerIssue!
    if (typeof payload.rawJson === 'string') details.computerRequestLength = payload.rawJson.length
  }
  if (typeof payload.command === 'string') details.commandLength = payload.command.length
  if (typeof payload.text === 'string' && details.textLength === undefined) details.textLength = payload.text.length
  if (Array.isArray(payload.questions)) details.questionCount = payload.questions.length
  else if (typeof payload.question === 'string') details.questionCount = 1
  return details
}

/** Always-on reply tracing; synchronous append preserves the last event before an app exit. */
export class ReplyDiagnosticLog {
  private readonly directory: string
  private readonly maxBytes: number
  private readonly files = new Map<PlatformId, { path: string; bytes: number }>()
  private serial = 0
  private sequence = 0

  constructor(directory = join(tmpdir(), 'gpt-login-diag'), maxBytes = 2 * 1024 * 1024) {
    this.directory = directory
    this.maxBytes = maxBytes
  }

  write(platformId: PlatformId, payload: InterceptorPageEvent, context: ReplyDiagnosticContext): string | null {
    try {
      const details = replyDiagnosticMetadata(platformId, payload, context)
      if (!details) return null
      const now = new Date().toISOString()
      const line = `${now} ${JSON.stringify({ sequence: ++this.sequence, ...details })}\n`
      const bytes = Buffer.byteLength(line)
      let file = this.files.get(platformId)
      if (!file || file.bytes + bytes > this.maxBytes) {
        mkdirSync(this.directory, { recursive: true })
        file = {
          path: join(this.directory, `${platformId}-reply-${now.replace(/[:.]/g, '-')}-${process.pid}-${++this.serial}.log`),
          bytes: 0
        }
        this.files.set(platformId, file)
      }
      appendFileSync(file.path, line, 'utf8')
      file.bytes += bytes
      return file.path
    } catch {
      // Full disks or unavailable temporary directories must not interrupt the command loop.
      return null
    }
  }
}

const replyLog = new ReplyDiagnosticLog()
export function writeReplyDiagnostic(platformId: PlatformId, payload: InterceptorPageEvent, context: ReplyDiagnosticContext): string | null {
  return replyLog.write(platformId, payload, context)
}
