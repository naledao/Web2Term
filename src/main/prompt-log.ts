import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatPlatform } from '../shared/platforms'
import type { InterceptorPageEvent } from '../shared/types'
import type { InjectionLedger, InjectionPlan } from '../shared/prompt-injection'

const logPaths = new Map<ChatPlatform['id'], string>()
const events = ['configured', 'send-observed', 'injected', 'sent', 'inject-failed', 'send-failed', 'send-recovery']
const recoveryActions = ['toolbar-last', 'enter']
const reasons = [
  'accepted', 'programmatic-send', 'terminal-disabled', 'missing-prefix', 'draft-rejected',
  'composer-missing', 'composer-target-mismatch', 'empty-draft', 'ime-composition',
  'shift-enter', 'repeat-key', 'event-prevented'
]

/** Always retain the prompt/send boundary as metadata; optional app logs contain more detail. */
export function writePromptDiagnostic(
  platformId: ChatPlatform['id'],
  payload: InterceptorPageEvent,
  mainState: { taskPromptInjected: boolean; taskPromptGeneration: number; injectionMode?: string | null; taskActive?: boolean; currentPage?: boolean }
): string | null {
  const missingCompletion = payload.event === 'task-finished' && payload.completed === false && payload.live === true &&
    payload.taskPromptGeneration === mainState.taskPromptGeneration && mainState.taskActive === true && mainState.currentPage === true
  if (!['chatgpt', 'deepseek', 'claude', 'gemini'].includes(platformId) || (!events.includes(payload.event) && !missingCompletion)) return null
  // Observation only: settled prose is not proof that the user's goal has been fulfilled.
  const details: Record<string, string | number | boolean | null> = { event: missingCompletion ? 'reply-without-completion' : payload.event }
  if (missingCompletion) { details.completed = false; details.taskActive = true }
  if (payload.event === 'send-observed') {
    details.reason = reasons.includes(payload.reason ?? '') ? payload.reason! : 'unknown'
    if (payload.trigger === 'enter' || payload.trigger === 'click') details.trigger = payload.trigger
  }
  for (const key of ['count', 'prefixLength', 'replyProtocolVersion', 'replyProtocolLength', 'taskPromptGeneration', 'composerTextLength', 'attempts', 'attempt', 'toolbarCount'] as const) {
    const value = payload[key]
    if (Number.isSafeInteger(value) && Number(value) >= 0) details[key] = Number(value)
  }
  if (payload.replyProtocolKind === 'full' || payload.replyProtocolKind === 'short') details.replyProtocolKind = payload.replyProtocolKind
  for (const key of [
    'enabled', 'promptInjectionEnabled', 'programmatic', 'promptInjected', 'conversationPromptInjected', 'taskPromptInjected', 'composerFound',
    'targetMatchesComposer', 'defaultPrevented', 'isComposing', 'sendButtonFound',
    'sendButtonDisabled', 'sendButtonVisible', 'sendButtonInComposer', 'stopButtonFound'
  ] as const) {
    if (typeof payload[key] === 'boolean') details[key] = payload[key]!
  }
  if (payload.sendButtonDisabled === null) details.sendButtonDisabled = null
  if (payload.recoveryTried === null) details.recoveryTried = null
  else if (recoveryActions.includes(payload.recoveryTried ?? '')) details.recoveryTried = payload.recoveryTried!
  if (recoveryActions.includes(payload.action ?? '')) details.action = payload.action!
  if (payload.composerKind === null) details.composerKind = null
  else if (['textarea', 'input', 'div'].includes(payload.composerKind ?? '')) details.composerKind = payload.composerKind!
  if (typeof mainState.taskPromptInjected === 'boolean') details.mainTaskPromptInjected = mainState.taskPromptInjected
  if (Number.isSafeInteger(mainState.taskPromptGeneration) && mainState.taskPromptGeneration >= 0) {
    details.mainTaskPromptGeneration = mainState.taskPromptGeneration
  }
  if (typeof mainState.injectionMode === 'string') details.injectionMode = mainState.injectionMode
  return appendPromptLog(platformId, details)
}

/** Section keys are the prompt's own headings; no prompt or conversation text is logged. */
const sectionKeys = (keys: string[]) => keys.slice(0, 20).map(key => key.slice(0, 24))

/** The prefix main pushed for the next task start changed. */
export function writeInjectionPlanDiagnostic(platformId: ChatPlatform['id'], plan: InjectionPlan | null, prefixLength: number): string | null {
  if (!plan) return appendPromptLog(platformId, { event: 'injection-plan', mode: 'unplanned', prefixLength })
  return appendPromptLog(platformId, { event: 'injection-plan', mode: plan.mode, reason: plan.reason, prefixLength,
    fullLength: plan.fullLength, charsSinceFull: plan.charsSinceFull, violations: plan.violations, budget: plan.budget,
    changed: sectionKeys(plan.changed).join('|'), removed: sectionKeys(plan.removed).join('|') })
}

/** The conversation's ledger moved: a confirmed injection, a violation, a reset, or a send the plan no longer matched. */
export function writeInjectionLedgerDiagnostic(
  platformId: ChatPlatform['id'],
  event: 'injection-committed' | 'injection-unmatched' | 'injection-violation' | 'injection-reset',
  conversation: 'draft' | 'saved',
  ledger: InjectionLedger | null,
  mode?: string
): string | null {
  return appendPromptLog(platformId, { event, conversation, ...(mode ? { mode } : {}),
    ...(ledger ? { charsSinceFull: ledger.charsSinceFull, violations: ledger.violations, sendsSinceFull: ledger.sendsSinceFull,
      sections: Object.keys(ledger.sections).length } : { ledger: null }) })
}

function appendPromptLog(platformId: ChatPlatform['id'], details: Record<string, string | number | boolean | null>): string | null {
  if (!['chatgpt', 'deepseek', 'claude', 'gemini'].includes(platformId)) return null
  try {
    let logPath = logPaths.get(platformId)
    if (!logPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `${platformId}-prompt-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
      logPaths.set(platformId, logPath)
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify(details)}\n`, 'utf8')
    return logPath
  } catch {
    // A diagnostic failure must never interrupt the user's send.
    return null
  }
}
