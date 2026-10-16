import type { SshState } from './types'

/** The live execution directory is the workbench directory, including Files and Git. */
export function sshWorkingDirectory(state: Pick<SshState, 'remoteExec' | 'modelCwd' | 'ptyCwd'> | null | undefined): string {
  if (!state) return ''
  if (state.remoteExec && state.modelCwd) return state.modelCwd
  return state.ptyCwd || state.modelCwd || ''
}
