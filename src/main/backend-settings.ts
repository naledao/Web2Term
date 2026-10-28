import { DEFAULT_BACKEND_URL, normalizeBackendUrl, readBackendUrl } from '../shared/backend-url'

export interface BackendSettings { backendUrl: string; forceDefaultBackendUrl: boolean }
export interface BackendSettingsStore {
  getSetting(key: string): string | null | undefined
  setSettings(values: Record<string, string>): void
}
export interface BackendSettingsPatch { backendUrl?: unknown; forceDefaultBackendUrl?: unknown }

/** Existing installations opt in unless the user explicitly saved false. */
export function readBackendSettings(store: BackendSettingsStore): BackendSettings {
  const forceDefaultBackendUrl = store.getSetting('forceDefaultBackendUrl') !== 'false'
  return { forceDefaultBackendUrl, backendUrl: forceDefaultBackendUrl ? DEFAULT_BACKEND_URL : readBackendUrl(store.getSetting('backendUrl')) }
}

/** Plan before writing any setting, including unrelated settings in the same IPC. */
export function resolveBackendSettingsPatch(store: BackendSettingsStore, patch: BackendSettingsPatch): BackendSettings {
  if (patch.forceDefaultBackendUrl !== undefined && typeof patch.forceDefaultBackendUrl !== 'boolean') {
    throw new Error('强制覆盖后端地址选项必须为是或否。')
  }
  const forceDefaultBackendUrl = patch.forceDefaultBackendUrl ?? readBackendSettings(store).forceDefaultBackendUrl
  const backendUrl = forceDefaultBackendUrl ? DEFAULT_BACKEND_URL : patch.backendUrl === undefined
    ? readBackendUrl(store.getSetting('backendUrl')) : normalizeBackendUrl(patch.backendUrl)
  return { backendUrl, forceDefaultBackendUrl }
}

/** Startup migration and settings saves use the same atomic persistence path. */
export function saveBackendSettings(store: BackendSettingsStore, patch: BackendSettingsPatch = {}): BackendSettings {
  const next = resolveBackendSettingsPatch(store, patch)
  const values: Record<string, string> = { backendUrl: next.backendUrl, forceDefaultBackendUrl: String(next.forceDefaultBackendUrl) }
  if (readBackendUrl(store.getSetting('backendUrl')) !== next.backendUrl) values.backendAuth = ''
  store.setSettings(values)
  return next
}
