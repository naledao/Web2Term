import { randomUUID } from 'node:crypto'
import { session } from 'electron'
import {
  ACCOUNT_PLATFORMS,
  DEFAULT_PLATFORM_ACCOUNT,
  DEFAULT_PLATFORM_ACCOUNT_ID,
  isPlatformAccountId
} from '../shared/platform-accounts'
import type { AccountPlatformId, PlatformAccount } from '../shared/platform-accounts'
import { selectionQuestionConversation } from '../shared/deepseek-question'
import { CHATGPT_PLATFORM, CLAUDE_PLATFORM, DEEPSEEK_PLATFORM, GEMINI_PLATFORM } from '../shared/platforms'
import type { ChatPlatform } from '../shared/platforms'

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

interface SqliteAccountStore {
  listPlatformAccountRecords(platformId: AccountPlatformId): PlatformAccount[]
  savePlatformAccountRecord(platformId: AccountPlatformId, account: PlatformAccount): void
  removePlatformAccountRecord(platformId: AccountPlatformId, accountId: string): PlatformAccount[]
  setPlatformAccountQuotaRecord(platformId: AccountPlatformId, accountId: string, hasQuota: boolean): PlatformAccount[]
}

export type PlatformAccountStore = SettingsStore & Partial<SqliteAccountStore>
export type PlatformAccountReadStore = Pick<SettingsStore, 'getSetting'> & Partial<Pick<SqliteAccountStore, 'listPlatformAccountRecords'>>

const PLATFORM_CONFIG: Readonly<Record<AccountPlatformId, {
  platform: ChatPlatform
  settingsKey: string
  partitionPrefix: string
  label: string
}>> = {
  claude: { platform: CLAUDE_PLATFORM, settingsKey: 'claudeAccounts', partitionPrefix: 'persist:claude-', label: ACCOUNT_PLATFORMS.claude.label },
  gemini: { platform: GEMINI_PLATFORM, settingsKey: 'geminiAccounts', partitionPrefix: 'persist:gemini-', label: ACCOUNT_PLATFORMS.gemini.label },
  deepseek: { platform: DEEPSEEK_PLATFORM, settingsKey: 'deepseekAccounts', partitionPrefix: 'persist:deepseek-', label: ACCOUNT_PLATFORMS.deepseek.label },
  chatgpt: { platform: CHATGPT_PLATFORM, settingsKey: 'chatgptAccounts', partitionPrefix: 'persist:chatgpt-', label: ACCOUNT_PLATFORMS.chatgpt.label }
}

const defaultQuotaSettingKey = (settingsKey: string): string => `${settingsKey}DefaultQuota`

export function listPlatformAccounts(store: PlatformAccountReadStore, platformId: AccountPlatformId): PlatformAccount[] {
  if (typeof store.listPlatformAccountRecords === 'function') {
    return store.listPlatformAccountRecords(platformId)
  }
  const { settingsKey } = PLATFORM_CONFIG[platformId]
  const defaultHasQuota = store.getSetting(defaultQuotaSettingKey(settingsKey)) !== '0'
  const accounts = new Map<string, PlatformAccount>([
    [DEFAULT_PLATFORM_ACCOUNT_ID, { ...DEFAULT_PLATFORM_ACCOUNT, hasQuota: defaultHasQuota }]
  ])
  try {
    const saved: unknown = JSON.parse(store.getSetting(settingsKey) ?? '[]')
    if (Array.isArray(saved)) for (const item of saved) {
      if (isPlatformAccountId(item?.id) && !accounts.has(item.id) &&
          typeof item.label === 'string' && item.label.trim() && item.label.length <= 40) {
        accounts.set(item.id, { id: item.id, label: item.label, hasQuota: item.hasQuota !== false })
      }
    }
  } catch { /* The default login stays available. */ }
  return [...accounts.values()]
}

export function newPlatformAccount(label: unknown): PlatformAccount {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 40) {
    throw new Error('请输入 1 到 40 个字符的账号备注。')
  }
  return { id: randomUUID(), label: label.trim(), hasQuota: true }
}

export function savePlatformAccount(store: PlatformAccountStore, platformId: AccountPlatformId, account: PlatformAccount): void {
  if (typeof store.savePlatformAccountRecord === 'function') {
    store.savePlatformAccountRecord(platformId, account)
    return
  }
  const { settingsKey } = PLATFORM_CONFIG[platformId]
  store.setSetting(settingsKey, JSON.stringify([...listPlatformAccounts(store, platformId).slice(1), account]))
}

export function removePlatformAccount(
  store: PlatformAccountStore,
  platformId: AccountPlatformId,
  accountId: unknown
): PlatformAccount[] {
  const { settingsKey, label } = PLATFORM_CONFIG[platformId]
  if (accountId === DEFAULT_PLATFORM_ACCOUNT_ID) throw new Error('默认账号不能删除。')
  if (!isPlatformAccountId(accountId)) throw new Error(`${label} 账号不可用。`)
  if (typeof store.removePlatformAccountRecord === 'function') {
    return store.removePlatformAccountRecord(platformId, accountId)
  }
  const accounts = listPlatformAccounts(store, platformId)
  if (!accounts.some(account => account.id === accountId)) throw new Error(`${label} 账号不可用。`)
  const remaining = accounts.filter(account => account.id !== accountId)
  store.setSetting(settingsKey, JSON.stringify(remaining.slice(1)))
  return remaining
}

export function setPlatformAccountQuota(
  store: PlatformAccountStore,
  platformId: AccountPlatformId,
  accountId: unknown,
  hasQuota: boolean
): PlatformAccount[] {
  const { settingsKey, label } = PLATFORM_CONFIG[platformId]
  if (!isPlatformAccountId(accountId)) throw new Error(`${label} 账号不可用。`)
  if (typeof store.setPlatformAccountQuotaRecord === 'function') {
    return store.setPlatformAccountQuotaRecord(platformId, accountId, hasQuota)
  }
  const accounts = listPlatformAccounts(store, platformId)
  if (!accounts.some(account => account.id === accountId)) throw new Error(`${label} 账号不可用。`)
  if (accountId === DEFAULT_PLATFORM_ACCOUNT_ID) {
    store.setSetting(defaultQuotaSettingKey(settingsKey), hasQuota ? '1' : '0')
    return listPlatformAccounts(store, platformId)
  }
  const updated = accounts.slice(1).map(account =>
    account.id === accountId ? { ...account, hasQuota } : account
  )
  store.setSetting(settingsKey, JSON.stringify(updated))
  return listPlatformAccounts(store, platformId)
}

export function platformForAccount(platformId: AccountPlatformId, accountId: string): ChatPlatform {
  const config = PLATFORM_CONFIG[platformId]
  return accountId === DEFAULT_PLATFORM_ACCOUNT_ID ? config.platform :
    { ...config.platform, partition: `${config.partitionPrefix}${accountId}` }
}

export async function clearPlatformAccountPartition(platformId: AccountPlatformId, accountId: string): Promise<void> {
  if (!isPlatformAccountId(accountId) || accountId === DEFAULT_PLATFORM_ACCOUNT_ID) return
  const browserSession = session.fromPartition(platformForAccount(platformId, accountId).partition)
  await browserSession.closeAllConnections().catch(() => {})
  await Promise.allSettled([
    browserSession.clearStorageData(),
    browserSession.clearCache(),
    browserSession.clearAuthCache()
  ])
}

export async function applyChatPartitionProxy(partition: string, proxy: string): Promise<void> {
  const browserSession = session.fromPartition(partition)
  await browserSession.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' })
  await browserSession.closeAllConnections()
}

export function platformConversationLocation(
  platformId: AccountPlatformId,
  url: string
): { url: string; conversationId: string | null } | null {
  const base = PLATFORM_CONFIG[platformId].platform
  const conversation = selectionQuestionConversation(platformId, url)
  if (conversation) return { url: base.conversationUrl(conversation.id), conversationId: conversation.id }
  try {
    const page = new URL(url)
    const home = new URL(base.homeUrl)
    if (page.origin === home.origin && (page.pathname === home.pathname ||
        (home.pathname !== '/' && page.pathname === home.pathname + '/'))) {
      return { url: home.href, conversationId: null }
    }
  } catch { /* Login redirects and malformed URLs are not saved chat locations. */ }
  return null
}

export function restorePlatformWorkspace(
  platformId: AccountPlatformId,
  raw: string | undefined,
  accounts: PlatformAccount[]
): { accountId: string; locations: Map<string, string> } {
  const locations = new Map<string, string>()
  let accountId = DEFAULT_PLATFORM_ACCOUNT_ID
  try {
    const saved = JSON.parse(raw ?? '{}')
    for (const account of accounts) {
      if (saved.accountId === account.id) accountId = account.id
      const url = saved.locations?.[account.id]
      const location = typeof url === 'string' ? platformConversationLocation(platformId, url) : null
      if (location) locations.set(account.id, location.url)
    }
  } catch { /* An invalid location cannot provide a URL to any partition. */ }
  return { accountId, locations }
}
