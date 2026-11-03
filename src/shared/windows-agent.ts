export const WINDOWS_AGENT_GET = 'windows-agent:get'
export const WINDOWS_AGENT_SET_ENABLED = 'windows-agent:set-enabled'
export const WINDOWS_AGENT_CHANGED = 'windows-agent:changed'

export interface WindowsAgentState {
  revision: number
  supported: boolean
  enabled: boolean
  status: 'disabled' | 'waiting-login' | 'connecting' | 'online' | 'reconnecting' | 'error'
  deviceId: string
  deviceName: string
  terminalCount: number
  maxTerminals: number
  message: string
  logPath: string | null
}

export const EMPTY_WINDOWS_AGENT: WindowsAgentState = {
  revision: 0, supported: false, enabled: false, status: 'disabled', deviceId: '', deviceName: '',
  terminalCount: 0, maxTerminals: 3, message: '', logPath: null
}
