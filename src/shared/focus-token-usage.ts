import { cleanFocusAnswer, cleanFocusUserText } from './focus-chat'
import type { FocusTurn } from './focus-chat'
import { injectionBudget, planInjection } from './prompt-injection'
import type { InjectionLedger, InjectionReason } from './prompt-injection'
import type { ConversationMessage, ExecutionRecord, InterceptorStatus } from './types'
import { emptyContextUsage } from './context-usage'
import type { ContextUsageSummary } from './context-usage'

export interface FocusTextUsage { estimatedTokens: number; characters: number }
export interface FocusContextUsage extends FocusTextUsage {
  details: { conversation: FocusTextUsage; recorded: ContextUsageSummary; visibleReasoning: FocusTextUsage;
    images: number; files: number; incompleteHistory: boolean }
}
export interface FocusPromptInjectionState {
  phase: 'loading' | 'disabled' | 'full-next' | 'countdown'
  charactersSinceFull: number
  characterBudget: number
  reason?: InjectionReason
}

/** Display estimate only. The injection planner continues to use its original character budget. */
export function focusPromptInjectionState(platformId: string, ledger: InjectionLedger | null,
  status: Pick<InterceptorStatus, 'installed' | 'enabled' | 'promptInjectionEnabled' | 'prefix'>): FocusPromptInjectionState {
  const base = { charactersSinceFull: ledger?.charsSinceFull ?? 0, characterBudget: injectionBudget(platformId) }
  if (!status.installed) return { ...base, phase: 'loading' }
  if (!status.enabled || !status.promptInjectionEnabled) return { ...base, phase: 'disabled' }
  if (!status.prefix.trim()) return { ...base, phase: 'loading' }
  const plan = planInjection(ledger, status.prefix, platformId)
  return { ...base, phase: plan.mode === 'full' ? 'full-next' : 'countdown', reason: plan.reason }
}

/** Estimate the actual submitted text, including its protocol/JSON, rather than a local execution log. */
export function estimateContextText(text: string): FocusTextUsage {
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    // ASCII letters/digits/spacing commonly share tokens; punctuation and non-ASCII weigh more.
    units += code > 127 ? 1 : /[a-z0-9\s]/i.test(char) ? .25 : .5
  }
  return { estimatedTokens: Math.ceil(units), characters: text.length }
}
/** Native presentation trees include binary/layout data and a readable text fallback. */
export function estimateFocusText(text: string): FocusTextUsage {
  const readable = text.replace(/<!--focus-(?:chart|ui|layout) \{[^\n]*\} -->\n?/g, '')
    .replace(/data:image\/[a-z0-9+.-]+(?:;[a-z0-9=+.-]+)*,[^\s)"'<>]+/gi, '').trim()
  return estimateContextText(readable)
}

/** Count the active transcript once even when a saved row is also represented by a live focus turn. */
export function estimateFocusConversation(input: {
  messages: Pick<ConversationMessage, 'id' | 'role' | 'sourceMessageId' | 'content' | 'createdAt' | 'attachments'>[]
  turns: FocusTurn[]
  executions: Pick<ExecutionRecord, 'messageId' | 'command' | 'description' | 'output'>[]
  hiddenMessageIds?: string[]
  smartReplies?: { sourceMessageId: string; answer: string }[]
  contextUsage?: ContextUsageSummary
}): FocusContextUsage {
  const recorded = input.contextUsage ?? emptyContextUsage()
  const turns = input.turns.filter(turn => !turn.supersededBy)
  const users = new Set(turns.flatMap(turn => turn.userMessageId ? [turn.userMessageId] : []))
  const sources = new Set(turns.flatMap(turn => turn.segments.flatMap(segment => segment.sourceMessageId ? [segment.sourceMessageId] : [])))
  const hidden = new Set(input.hiddenMessageIds ?? [])
  const executions = new Map(input.executions.map(record => [record.messageId, record]))
  const rich = new Map((input.smartReplies ?? []).map(reply => [reply.sourceMessageId, reply.answer]))
  const requests = new Set(recorded.requestSourceIds)
  const total = { estimatedTokens: 0, characters: 0 }
  const visibleReasoning = { estimatedTokens: 0, characters: 0 }
  let images = recorded.images, files = recorded.files
  const countFiles = (items: Array<{ mimeType: string }> = []): void => {
    for (const file of items) if (file.mimeType.startsWith('image/')) images++; else files++
  }
  const add = (text: string): void => {
    const usage = estimateFocusText(text)
    total.estimatedTokens += usage.estimatedTokens; total.characters += usage.characters
  }
  for (const message of input.messages) {
    if (hidden.has(message.id) || users.has(message.id) || message.sourceMessageId?.startsWith('read-files:') ||
      message.sourceMessageId && (sources.has(message.sourceMessageId) || executions.has(message.sourceMessageId) || requests.has(message.sourceMessageId))) continue
    add(message.role === 'user' ? cleanFocusUserText(message.content) : cleanFocusAnswer(rich.get(message.sourceMessageId ?? '') || message.content))
    if (message.role === 'user') countFiles(message.attachments)
  }
  const counted = new Set<string>()
  for (const turn of turns) {
    add(cleanFocusUserText(turn.userText))
    const saved = input.messages.find(message => message.id === turn.userMessageId)
    countFiles(turn.userAttachments?.length ? turn.userAttachments : saved?.attachments)
    for (const segment of turn.segments) {
      if (segment.sourceMessageId && counted.has(segment.sourceMessageId)) continue
      if (segment.sourceMessageId) counted.add(segment.sourceMessageId)
      for (const part of segment.parts) {
        const usage = estimateFocusText(part.text)
        visibleReasoning.estimatedTokens += usage.estimatedTokens; visibleReasoning.characters += usage.characters
      }
      if (!segment.sourceMessageId || !executions.has(segment.sourceMessageId) && !requests.has(segment.sourceMessageId)) {
        add(cleanFocusAnswer(rich.get(segment.sourceMessageId ?? '') || segment.answer))
      }
    }
  }
  const conversation = { ...total }
  for (const usage of [recorded.injections, recorded.toolDefinitions, recorded.toolResults, recorded.toolRequests]) {
    total.estimatedTokens += usage.estimatedTokens; total.characters += usage.characters
  }
  const dates = [...input.messages.filter(message => !hidden.has(message.id)).map(message => message.createdAt), ...turns.map(turn => turn.createdAt)].filter(Number.isFinite)
  const earliest = dates.reduce((first, time) => Math.min(first, time), Infinity)
  const incompleteHistory = dates.length > 0 && (recorded.observedSince === null || earliest < recorded.observedSince - 1000)
  return { ...total, details: { conversation, recorded, visibleReasoning, images, files, incompleteHistory } }
}

/** Convert the real remaining characters using the observed transcript's token density. */
export function remainingFocusInjectionTokens(injection: FocusPromptInjectionState, usage: FocusTextUsage): number {
  if (injection.phase === 'full-next') return 0
  const density = usage.characters > 0 ? usage.estimatedTokens / usage.characters : 1 / 3
  return Math.ceil(Math.max(0, injection.characterBudget - injection.charactersSinceFull) * density)
}
