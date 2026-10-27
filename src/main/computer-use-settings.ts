import type { ComputerUsePreferences } from '../shared/computer-use'
import { MAX_COMPUTER_RESULT_DELAY_SECONDS, normalizeComputerResultDelay } from '../shared/computer-progress'

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

const KEYS = ['computerUseEnabled', 'desktopControlEnabled', 'desktopPointClickEnabled'] as const

export function readComputerUsePreferences(store: Pick<SettingsStore, 'getSetting'>): ComputerUsePreferences {
  // An explicit value under the new name takes precedence, including a saved "off".
  const enabled = store.getSetting('computerUseEnabled') ?? store.getSetting('autonomousExecutionEnabled')
  const savedDelay = store.getSetting('computerResultDelaySeconds')
  const on = enabled === '1'
  return {
    computerUseEnabled: on,
    // Desktop control and coordinate clicks follow computer use; the settings page no longer offers
    // them separately, so values saved under their own keys by older versions are ignored.
    desktopControlEnabled: on,
    desktopPointClickEnabled: on,
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
  // Only the computer use switch is a choice; the two desktop keys are written alongside it so the
  // stored values never disagree with what readComputerUsePreferences reports.
  if (patch.computerUseEnabled !== undefined) for (const key of KEYS) store.setSetting(key, patch.computerUseEnabled ? '1' : '0')
  if (patch.computerResultDelaySeconds !== undefined) store.setSetting('computerResultDelaySeconds', String(patch.computerResultDelaySeconds))
  return patch
}
