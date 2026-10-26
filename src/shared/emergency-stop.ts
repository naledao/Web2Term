export type InputReleaseStatus = 'not-needed' | 'pending' | 'released' | 'unconfirmed'
export interface EmergencyStopState {
  active: boolean
  revision: number
  epoch: number
  triggeredAt: number | null
  source: 'button' | 'shortcut' | null
  shortcut: string
  shortcutRegistered: boolean
  pendingSessions: number
  failedSessions: number
  executing: number
  helperRunning: boolean
  inputRelease: InputReleaseStatus
  canReset: boolean
  message: string
}
export interface EmergencyStopResetResult { ok: boolean; state: EmergencyStopState; message: string }
export const EMERGENCY_STOP_SHORTCUT = 'CommandOrControl+Alt+Shift+F12'
