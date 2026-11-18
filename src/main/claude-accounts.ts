import type { ClaudeAccount } from '../shared/claude-accounts'
import type { ChatPlatform } from '../shared/platforms'
import {
  applyChatPartitionProxy,
  clearPlatformAccountPartition,
  listPlatformAccounts,
  newPlatformAccount,
  platformConversationLocation,
  platformForAccount,
  removePlatformAccount,
  restorePlatformWorkspace,
  savePlatformAccount
} from './platform-accounts'

export { applyChatPartitionProxy }

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

export const listClaudeAccounts = (store: Pick<SettingsStore, 'getSetting'>): ClaudeAccount[] =>
  listPlatformAccounts(store, 'claude')

export const newClaudeAccount = (label: unknown): ClaudeAccount => newPlatformAccount(label)

export const saveClaudeAccount = (store: SettingsStore, account: ClaudeAccount): void =>
  savePlatformAccount(store, 'claude', account)

export const removeClaudeAccount = (store: SettingsStore, accountId: unknown): ClaudeAccount[] =>
  removePlatformAccount(store, 'claude', accountId)

export const claudePlatformForAccount = (accountId: string): ChatPlatform => platformForAccount('claude', accountId)

export const clearClaudeAccountPartition = (accountId: string): Promise<void> =>
  clearPlatformAccountPartition('claude', accountId)

export const claudeConversationLocation = (url: string): { url: string; conversationId: string | null } | null =>
  platformConversationLocation('claude', url)

export const restoreClaudeWorkspace = (raw: string | undefined, accounts: ClaudeAccount[]): {
  accountId: string; locations: Map<string, string>
} => restorePlatformWorkspace('claude', raw, accounts)
