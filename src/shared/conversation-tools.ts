import type { ComputerUseCapability, ComputerUsePreferences } from './computer-use'
import { normalizeComputerResultDelay } from './computer-progress'

export type ConversationToolId = 'files' | 'background' | 'scheduled' | 'mail' | 'computer'

export interface ConversationToolPreferences extends ComputerUsePreferences {
  fileReadingEnabled: boolean
  backgroundTasksEnabled: boolean
  scheduledTasksEnabled: boolean
  mailNotificationsEnabled: boolean
}

export const DEFAULT_CONVERSATION_TOOLS: Readonly<ConversationToolPreferences> = Object.freeze({
  fileReadingEnabled: true,
  backgroundTasksEnabled: true,
  scheduledTasksEnabled: true,
  mailNotificationsEnabled: true,
  computerUseEnabled: false,
  desktopControlEnabled: false,
  desktopPointClickEnabled: false,
  computerResultDelaySeconds: 0
})

export interface ConversationToolsOwner {
  sessionId: string
  platformId: string
  conversationId: string | null
}

export interface ConversationToolEntry {
  id: ConversationToolId
  name: string
  enabled: boolean
  available: boolean
  message: string
  prompt: string
}

export interface ConversationToolsState {
  owner: ConversationToolsOwner
  preferences: ConversationToolPreferences
  tools: ConversationToolEntry[]
  computerUseCapability: ComputerUseCapability
}

export interface ConversationToolsUpdate extends ConversationToolsOwner {
  patch: Partial<Pick<ConversationToolPreferences, 'fileReadingEnabled' | 'backgroundTasksEnabled' | 'scheduledTasksEnabled' | 'mailNotificationsEnabled' | 'computerUseEnabled' | 'computerResultDelaySeconds'>>
}

export function normalizeConversationTools(value: unknown): ConversationToolPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<ConversationToolPreferences> : {}
  const on = input.computerUseEnabled === true
  return {
    fileReadingEnabled: input.fileReadingEnabled !== false,
    backgroundTasksEnabled: input.backgroundTasksEnabled !== false,
    scheduledTasksEnabled: input.scheduledTasksEnabled !== false,
    mailNotificationsEnabled: input.mailNotificationsEnabled !== false,
    computerUseEnabled: on,
    desktopControlEnabled: on,
    desktopPointClickEnabled: on,
    computerResultDelaySeconds: normalizeComputerResultDelay(input.computerResultDelaySeconds ?? 0)
  }
}

export function sameConversationToolsOwner(a: ConversationToolsOwner, b: ConversationToolsOwner): boolean {
  return a.sessionId === b.sessionId && a.platformId === b.platformId && a.conversationId === b.conversationId
}
