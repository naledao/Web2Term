import { normalizeConversationTools } from '../shared/conversation-tools'
import type { ConversationToolPreferences, ConversationToolsUpdate } from '../shared/conversation-tools'
import { parseComputerUsePreferencesPatch } from './computer-use-settings'

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  setSettings(values: Record<string, string>): void
}

/** Conversation choices outlive a window or workspace; a new chat has its own temporary draft. */
export class ConversationTools {
  constructor(private readonly sessionId: string, private readonly store: SettingsStore) {}

  private key(platformId: string, conversationId: string | null): string {
    return 'conversationTools:' + JSON.stringify(conversationId === null
      ? ['draft', this.sessionId, platformId] : ['conversation', platformId, conversationId])
  }

  read(platformId: string, conversationId: string | null): ConversationToolPreferences {
    const raw = this.store.getSetting(this.key(platformId, conversationId))
    try { return normalizeConversationTools(raw ? JSON.parse(raw) : undefined) }
    catch { return normalizeConversationTools(undefined) }
  }

  update(platformId: string, conversationId: string | null, value: unknown): ConversationToolPreferences {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具设置格式无效。')
    const input = value as ConversationToolsUpdate['patch']
    const patch = parseComputerUsePreferencesPatch(input)
    for (const key of ['fileReadingEnabled', 'backgroundTasksEnabled', 'scheduledTasksEnabled'] as const) {
      if (!Object.hasOwn(input, key)) continue
      if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须为布尔值。`)
    }
    const preferences = normalizeConversationTools({ ...this.read(platformId, conversationId), ...patch,
      ...(input.fileReadingEnabled !== undefined ? { fileReadingEnabled: input.fileReadingEnabled } : {}),
      ...(input.backgroundTasksEnabled !== undefined ? { backgroundTasksEnabled: input.backgroundTasksEnabled } : {}),
      ...(input.scheduledTasksEnabled !== undefined ? { scheduledTasksEnabled: input.scheduledTasksEnabled } : {}) })
    this.store.setSetting(this.key(platformId, conversationId), JSON.stringify(preferences))
    return preferences
  }

  /** Only a confirmed first human send may carry an unsaved chat's choices into its new id. */
  submitted(platformId: string): void {
    const key = this.key(platformId, null)
    if (this.store.getSetting(key)) this.store.setSetting(key + ':submitted', '1')
  }

  bind(platformId: string, previousId: string | null, conversationId: string | null): void {
    if (previousId !== null || conversationId === null) return
    const draftKey = this.key(platformId, null), raw = this.store.getSetting(draftKey)
    if (!raw) return
    const target = this.key(platformId, conversationId)
    const carry = this.store.getSetting(draftKey + ':submitted') === '1' && this.store.getSetting(target) === null
    this.store.setSettings({ ...(carry ? { [target]: JSON.stringify(this.read(platformId, null)) } : {}),
      [draftKey]: '', [draftKey + ':submitted']: '' })
  }
}
