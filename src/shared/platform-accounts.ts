export const ACCOUNT_PLATFORMS = {
  claude: { label: 'Claude', sampleLabel: '例如 Claude 工作账号' },
  gemini: { label: 'Gemini', sampleLabel: '例如 Gemini 工作账号' },
  deepseek: { label: 'DeepSeek', sampleLabel: '例如 DeepSeek 工作账号' },
  chatgpt: { label: 'ChatGPT', sampleLabel: '例如 ChatGPT 工作账号' }
} as const

export type AccountPlatformId = keyof typeof ACCOUNT_PLATFORMS
export const ACCOUNT_PLATFORM_IDS = Object.keys(ACCOUNT_PLATFORMS) as AccountPlatformId[]
export const DEFAULT_PLATFORM_ACCOUNT_ID = 'default'

export interface PlatformAccount {
  id: string
  label: string
  hasQuota: boolean
}

export const DEFAULT_PLATFORM_ACCOUNT: Readonly<PlatformAccount> = {
  id: DEFAULT_PLATFORM_ACCOUNT_ID, label: '默认账号', hasQuota: true
}

export function accountHasQuota(account: Pick<PlatformAccount, 'hasQuota'> | null | undefined): boolean {
  return account?.hasQuota !== false
}

export function nextAvailablePlatformAccount(
  accounts: readonly PlatformAccount[],
  currentAccountId: string
): PlatformAccount | null {
  if (accounts.length < 2) return null
  const start = accounts.findIndex(account => account.id === currentAccountId)
  for (let offset = 1; offset <= accounts.length; offset++) {
    const candidate = accounts[(start >= 0 ? start + offset : offset - 1) % accounts.length]
    if (candidate.id !== currentAccountId && accountHasQuota(candidate)) return candidate
  }
  return null
}

export function supportsPlatformAccounts(platformId: string): platformId is AccountPlatformId {
  return Object.hasOwn(ACCOUNT_PLATFORMS, platformId)
}

export function isPlatformAccountId(value: unknown): value is string {
  return value === DEFAULT_PLATFORM_ACCOUNT_ID || typeof value === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
}
