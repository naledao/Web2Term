export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default'

export interface ClaudeAccount {
  id: string
  label: string
}

export const DEFAULT_CLAUDE_ACCOUNT: Readonly<ClaudeAccount> = {
  id: DEFAULT_CLAUDE_ACCOUNT_ID, label: '默认账号'
}

export function isClaudeAccountId(value: unknown): value is string {
  return value === DEFAULT_CLAUDE_ACCOUNT_ID || typeof value === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
}
