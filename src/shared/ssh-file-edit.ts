export const MAX_SSH_TEXT_FILE_BYTES = 1024 * 1024

export interface SshTextFileTarget {
  sessionId: string
  hostId: string
  path: string
}

export interface SshTextFile extends SshTextFileTarget {
  content: string
  revision: string
  size: number
  lineEnding: 'LF' | 'CRLF' | 'CR'
  bom: boolean
}

export interface SshTextFileSaveRequest extends SshTextFileTarget {
  content: string
  revision: string
}

export type SshTextFileSaveResult = { status: 'saved'; file: SshTextFile } | { status: 'conflict' }

export function validSshTextFileTarget(value: unknown): value is SshTextFileTarget {
  const target = value as SshTextFileTarget | null
  return !!target && typeof target.sessionId === 'string' && target.sessionId.length > 0 && target.sessionId.length <= 128 &&
    typeof target.hostId === 'string' && target.hostId.length > 0 && target.hostId.length <= 128 &&
    typeof target.path === 'string' && target.path.startsWith('/') && target.path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(target.path)
}

/** Content is checked again on the main-process side before enabling a save. */
export function canEditSshTextFile(path: string, size?: number): boolean {
  return (size === undefined || size <= MAX_SSH_TEXT_FILE_BYTES) &&
    !/\.(?:pdf|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|zip|gz|bz2|xz|7z|rar|tar|exe|dll|so|bin|wasm|db|sqlite3?|mp[34]|wav|ogg|mov|avi|woff2?|ttf|otf|jar|class|pyc|docx?|xlsx?|pptx?)$/i.test(path)
}
