import { randomUUID } from 'node:crypto'
import { session } from 'electron'
import { DEFAULT_CLAUDE_ACCOUNT, DEFAULT_CLAUDE_ACCOUNT_ID, isClaudeAccountId } from '../shared/claude-accounts'
import type { ClaudeAccount } from '../shared/claude-accounts'
import { selectionQuestionConversation } from '../shared/deepseek-question'
import { CLAUDE_PLATFORM } from '../shared/platforms'
import type { ChatPlatform } from '../shared/platforms'

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

const ACCOUNTS_KEY = 'claudeAccounts'

export function listClaudeAccounts(store: Pick<SettingsStore, 'getSetting'>): ClaudeAccount[] {
  const accounts = new Map<string, ClaudeAccount>([[DEFAULT_CLAUDE_ACCOUNT_ID, { ...DEFAULT_CLAUDE_ACCOUNT }]])
  try {
    const saved: unknown = JSON.parse(store.getSetting(ACCOUNTS_KEY) ?? '[]')
    if (Array.isArray(saved)) for (const item of saved) {
      if (isClaudeAccountId(item?.id) && !accounts.has(item.id) &&
          typeof item.label === 'string' && item.label.trim() && item.label.length <= 40) {
        accounts.set(item.id, { id: item.id, label: item.label })
      }
    }
  } catch { /* The original Claude login is still available. */ }
  return [...accounts.values()]
}

export function newClaudeAccount(label: unknown): ClaudeAccount {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 40) {
    throw new Error('请输入 1 到 40 个字符的账号备注。')
  }
  return { id: randomUUID(), label: label.trim() }
}

export function saveClaudeAccount(store: SettingsStore, account: ClaudeAccount): void {
  store.setSetting(ACCOUNTS_KEY, JSON.stringify([...listClaudeAccounts(store).slice(1), account]))
}

export function claudePlatformForAccount(accountId: string): ChatPlatform {
  return accountId === DEFAULT_CLAUDE_ACCOUNT_ID ? CLAUDE_PLATFORM :
    { ...CLAUDE_PLATFORM, partition: `persist:claude-${accountId}` }
}

export async function applyChatPartitionProxy(partition: string, proxy: string): Promise<void> {
  const browserSession = session.fromPartition(partition)
  await browserSession.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' })
  await browserSession.closeAllConnections()
}

export function claudeConversationLocation(url: string): { url: string; conversationId: string | null } | null {
  const conversation = selectionQuestionConversation('claude', url)
  if (conversation) return { url: CLAUDE_PLATFORM.conversationUrl(conversation.id), conversationId: conversation.id }
  try {
    const page = new URL(url)
    const home = new URL(CLAUDE_PLATFORM.homeUrl)
    if (page.origin === home.origin && page.pathname === home.pathname) return { url: home.href, conversationId: null }
  } catch { /* Login redirects and malformed URLs are not saved chat locations. */ }
  return null
}

export function restoreClaudeWorkspace(raw: string | undefined, accounts: ClaudeAccount[]): {
  accountId: string; locations: Map<string, string>
} {
  const locations = new Map<string, string>()
  let accountId = DEFAULT_CLAUDE_ACCOUNT_ID
  try {
    const saved = JSON.parse(raw ?? '{}')
    for (const account of accounts) {
      if (saved.accountId === account.id) accountId = account.id
      const url = saved.locations?.[account.id]
      const location = typeof url === 'string' ? claudeConversationLocation(url) : null
      if (location) locations.set(account.id, location.url)
    }
  } catch { /* An invalid location cannot provide a URL to any partition. */ }
  return { accountId, locations }
}
