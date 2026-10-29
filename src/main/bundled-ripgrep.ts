import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { join, posix, resolve, win32 } from 'node:path'

interface RipgrepLocationOptions {
  platform?: NodeJS.Platform
  arch?: string
  resourcesPath?: string
  developmentRoot?: string
}

/** Only real files outside app.asar can be executed by a child shell. */
export function bundledRipgrepPath(options: RipgrepLocationOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
  const resources = options.resourcesPath ?? process.resourcesPath
  const development = options.developmentRoot ?? resolve(__dirname, '..', 'ripgrep')
  const directories = [
    ...(resources ? [join(resources, 'ripgrep')] : []),
    join(development, `${os}-${arch === 'arm' ? 'armv7l' : arch}`)
  ]
  for (const directory of directories) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
      if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch) continue
      const binary = join(directory, platform === 'win32' ? 'rg.exe' : 'rg')
      if (!statSync(binary).isFile()) continue
      accessSync(binary, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return binary
    } catch { /* Missing resources must never advertise a tool that isn't there. */ }
  }
  return null
}

/** A process-local PATH; never changes process.env, the registry or the user's shell profile. */
export function withRipgrepPath(env: NodeJS.ProcessEnv, binary = bundledRipgrepPath(), platform = process.platform): NodeJS.ProcessEnv {
  if (!binary) return { ...env }
  const windows = platform === 'win32'
  const separator = windows ? ';' : ':'
  const pathKeys = Object.keys(env).filter(key => windows ? key.toLowerCase() === 'path' : key === 'PATH')
  const pathsApi = windows ? win32 : posix
  const entries = [pathsApi.dirname(binary), ...pathKeys.flatMap(key => (env[key] ?? '').split(separator))]
  const seen = new Set<string>()
  const paths = entries.filter(entry => {
    if (!entry) return false
    const key = windows
      ? (entry.length > win32.parse(entry).root.length ? entry.replace(/[\\/]+$/, '') : entry).toLowerCase()
      : entry
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const next = { ...env }
  for (const key of pathKeys) delete next[key]
  next[windows ? 'Path' : 'PATH'] = paths.join(separator)
  return next
}
