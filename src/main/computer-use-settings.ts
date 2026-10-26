import type { ComputerUsePreferences } from '../shared/computer-use'
import { MAX_COMPUTER_RESULT_DELAY_SECONDS, normalizeComputerProgressLimits, normalizeComputerResultDelay, parseComputerProgressLimits } from '../shared/computer-progress'

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

const KEYS = ['computerUseEnabled', 'desktopControlEnabled'] as const

export function readComputerUsePreferences(store: Pick<SettingsStore, 'getSetting'>): ComputerUsePreferences {
  // An explicit value under the new name takes precedence, including a saved "off".
  const enabled = store.getSetting('computerUseEnabled') ?? store.getSetting('autonomousExecutionEnabled')
  const savedLimits = store.getSetting('computerUseLimits')
  let limits: unknown
  try { limits = savedLimits ? JSON.parse(savedLimits) : undefined } catch { /* Corrupt saved preferences use bounded defaults. */ }
  const savedDelay = store.getSetting('computerResultDelaySeconds')
  return {
    computerUseEnabled: enabled === '1',
    desktopControlEnabled: store.getSetting('desktopControlEnabled') === '1',
    ...(savedLimits != null ? { computerUseLimits: normalizeComputerProgressLimits(limits) } : {}),
    ...(savedDelay != null ? { computerResultDelaySeconds: normalizeComputerResultDelay(savedDelay) } : {})
  }
}

/** Validate the entire new-settings patch before the existing settings handler changes anything. */
export function parseComputerUsePreferencesPatch(value: unknown): Partial<ComputerUsePreferences> {
  const patch: Partial<ComputerUsePreferences> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return patch
  for (const key of KEYS) {
    if (!Object.hasOwn(value, key)) continue
    const candidate = (value as Record<string, unknown>)[key]
    if (candidate === undefined) continue
    if (typeof candidate !== 'boolean') throw new Error(`${key} 必须为布尔值。`)
    patch[key] = candidate
  }
  if (Object.hasOwn(value, 'computerUseLimits') && (value as Record<string, unknown>).computerUseLimits !== undefined) {
    const limits = parseComputerProgressLimits((value as Record<string, unknown>).computerUseLimits)
    if (!limits) throw new Error('computer use 运行上限必须为完整且在允许范围内的整数设置。')
    patch.computerUseLimits = limits
  }
  if (Object.hasOwn(value, 'computerResultDelaySeconds') && (value as Record<string, unknown>).computerResultDelaySeconds !== undefined) {
    const seconds = (value as Record<string, unknown>).computerResultDelaySeconds
    if (!Number.isInteger(seconds) || (seconds as number) < 0 || (seconds as number) > MAX_COMPUTER_RESULT_DELAY_SECONDS) {
      throw new Error(`computer 结果回传间隔必须为 0–${MAX_COMPUTER_RESULT_DELAY_SECONDS} 的整数秒。`)
    }
    patch.computerResultDelaySeconds = seconds as number
  }
  return patch
}

export function saveComputerUsePreferences(store: SettingsStore, value: unknown): Partial<ComputerUsePreferences> {
  const patch = parseComputerUsePreferencesPatch(value)
  for (const key of KEYS) {
    if (patch[key] !== undefined) store.setSetting(key, patch[key] ? '1' : '0')
  }
  if (patch.computerUseLimits) store.setSetting('computerUseLimits', JSON.stringify(patch.computerUseLimits))
  if (patch.computerResultDelaySeconds !== undefined) store.setSetting('computerResultDelaySeconds', String(patch.computerResultDelaySeconds))
  return patch
}
