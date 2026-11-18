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
}

export const DEFAULT_PLATFORM_ACCOUNT: Readonly<PlatformAccount> = {
  id: DEFAULT_PLATFORM_ACCOUNT_ID, label: '默认账号'
}

export function supportsPlatformAccounts(platformId: string): platformId is AccountPlatformId {
  return Object.hasOwn(ACCOUNT_PLATFORMS, platformId)
}

export function isPlatformAccountId(value: unknown): value is string {
  return value === DEFAULT_PLATFORM_ACCOUNT_ID || typeof value === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
}
