import {
  DEFAULT_PLATFORM_ACCOUNT,
  DEFAULT_PLATFORM_ACCOUNT_ID,
  isPlatformAccountId
} from './platform-accounts'
import type { PlatformAccount } from './platform-accounts'

export const DEFAULT_CLAUDE_ACCOUNT_ID = DEFAULT_PLATFORM_ACCOUNT_ID
export type ClaudeAccount = PlatformAccount
export const DEFAULT_CLAUDE_ACCOUNT: Readonly<ClaudeAccount> = DEFAULT_PLATFORM_ACCOUNT
export const isClaudeAccountId = isPlatformAccountId
