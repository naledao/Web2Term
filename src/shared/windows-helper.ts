/** Private parent/helper transport. This is never a model-facing tool or renderer command. */
// v4 adds a main-issued desktop watch and scoped native activity events. Model protocol remains v1.
// v5 adds each activity's input category (keyboard/click/wheel) for the takeover log.
export const WINDOWS_HELPER_PROTOCOL_VERSION = 5 as const
export const WINDOWS_HELPER_MAX_FRAME_BYTES = 262_144
export const WINDOWS_HELPER_MAX_REQUEST_BYTES = 65_536

export type WindowsHelperPhase = 'unsupported' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error'
export type WindowsHelperCode = 'unsupported_host' | 'not_started' | 'starting' | 'ready' | 'stopping'
  | 'executable_missing' | 'spawn_failed' | 'handshake_timeout' | 'protocol_mismatch' | 'invalid_frame'
  | 'pipe_closed' | 'process_exited' | 'heartbeat_timeout' | 'action_timeout'
  | 'emergency_stopped' | 'cancelled' | 'busy' | 'unknown_action' | 'invalid_request' | 'restart_limit' | 'disposed'

export interface WindowsHelperState {
  phase: WindowsHelperPhase
  code: WindowsHelperCode
  message: string
  /** Process incarnation; never restored from disk. */
  generation: number
  pid: number | null
  protocolVersion: number | null
  actions: string[]
}

export interface WindowsHelperActionResult {
  ok: boolean
  execution: 'not_executed' | 'executed' | 'unknown'
  code: string
  message: string
  data?: unknown
}
