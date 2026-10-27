export type InputReleaseStatus = 'not-needed' | 'pending' | 'released' | 'unconfirmed'
export interface EmergencyStopState {
  active: boolean
  revision: number
  epoch: number
  triggeredAt: number | null
  source: 'button' | 'mouse-gesture' | null
  gestureAvailable: boolean
  pendingSessions: number
  failedSessions: number
  executing: number
  helperRunning: boolean
  inputRelease: InputReleaseStatus
  canReset: boolean
  message: string
}
/** A physical input interrupted one desktop step; the limit-th in a row pauses the task. Kind of input only. */
export interface DesktopInputWarning { strike: number; limit: number; input: 'keyboard' | 'click' | 'wheel' | null; at: number }
export interface EmergencyStopResetResult { ok: boolean; state: EmergencyStopState; message: string }
