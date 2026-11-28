export const GEMINI_USAGE_REFRESH_MS = 5 * 60_000

export interface GeminiUsageLimit {
  usedPercent: number
  resetLabel: string | null
}

export interface GeminiUsageSnapshot {
  current: GeminiUsageLimit
  weekly: GeminiUsageLimit
  checkedAt: number
}

export interface GeminiUsageResult {
  outcome: 'ok' | 'unavailable' | 'redirected' | 'timeout'
  snapshot: GeminiUsageSnapshot | null
}

export function parseGeminiUsageSnapshot(value: unknown, checkedAt: number): GeminiUsageSnapshot | null {
  function readLimit(raw: unknown): GeminiUsageLimit | null {
    if (!raw || typeof raw !== 'object') return null
    const { usedPercent, resetLabel } = raw as Partial<GeminiUsageLimit>
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null
    if (resetLabel !== null && (typeof resetLabel !== 'string' || resetLabel.length > 72 || !/\d/.test(resetLabel) ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069%@<>]/.test(resetLabel))) return null
    return { usedPercent, resetLabel }
  }
  if (!value || typeof value !== 'object') return null
  const { current, weekly } = value as Partial<GeminiUsageSnapshot>
  const currentLimit = readLimit(current), weeklyLimit = readLimit(weekly)
  return currentLimit && weeklyLimit ? { current: currentLimit, weekly: weeklyLimit, checkedAt } : null
}
