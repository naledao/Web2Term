// Installs Electron's runtime only. Never launches Electron or opens an app profile.
import { spawn } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const script = fileURLToPath(import.meta.url)
export const DEFAULT_MIRROR = 'https://npmmirror.com/mirrors/electron/'
export const OFFICIAL_MIRROR = 'https://github.com/electron/electron/releases/download/'
export const LOCAL_PROXY = 'http://127.0.0.1:7897'
const mirrorKeys = [
  'npm_config_electron_mirror', 'NPM_CONFIG_ELECTRON_MIRROR',
  'npm_package_config_electron_mirror', 'ELECTRON_MIRROR'
]

export function isInstalled(root, env, hostPlatform = process.platform) {
  const platform = env.ELECTRON_INSTALL_PLATFORM || env.npm_config_platform || hostPlatform
  const executable = platform === 'win32' ? 'electron.exe'
    : ['darwin', 'mas'].includes(platform) ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
  try {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return readFileSync(join(root, 'dist/version'), 'utf8').replace(/^v/, '') === version &&
      readFileSync(join(root, 'path.txt'), 'utf8') === executable &&
      existsSync(join(env.ELECTRON_OVERRIDE_DIST_PATH || join(root, 'dist'), executable))
  } catch {
    return false
  }
}

function localProxyAvailable() {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: 7897 })
    const finish = available => { socket.destroy(); resolve(available) }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

export async function downloadEnvironment(env, canUseLocalProxy = localProxyAvailable) {
  const next = { ...env }
  const httpProxy = env.http_proxy || env.HTTP_PROXY || env.npm_config_proxy
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || env.npm_config_https_proxy || httpProxy
  const proxy = httpsProxy || (await canUseLocalProxy() ? LOCAL_PROXY : '')
  if (proxy) {
    next.HTTP_PROXY = httpProxy || proxy
    next.HTTPS_PROXY = proxy
    // @electron/get supports Node 22.12+ via undici; newer Node also supports this natively.
    next.ELECTRON_GET_USE_PROXY = '1'
    next.NODE_USE_ENV_PROXY = '1'
  }
  return next
}

export function downloadMirrors(env) {
  // Explicit environment settings take priority over the repository default.
  const mirror = env.ELECTRON_MIRROR || env.npm_config_electron_mirror ||
    env.NPM_CONFIG_ELECTRON_MIRROR || env.npm_package_config_electron_mirror || DEFAULT_MIRROR
  const normalized = mirror.endsWith('/') ? mirror : `${mirror}/`
  return normalized === DEFAULT_MIRROR ? [DEFAULT_MIRROR, OFFICIAL_MIRROR] : [normalized]
}

export function safeError(error) {
  const seen = new Set()
  const messages = []
  function visit(value) {
    if (!value || seen.has(value)) return
    seen.add(value)
    messages.push([value.code, value.message || String(value)].filter(Boolean).join(': '))
    if (Array.isArray(value.errors)) value.errors.forEach(visit)
    visit(value.cause)
  }
  visit(error)
  return messages.join(' -> ').replace(/https?:\/\/[^\s)]+/g, value => {
    try {
      const url = new URL(value)
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      return url.href
    } catch { return '[URL]' }
  })
}

function runInstaller(root, env) {
  return new Promise((resolve, reject) => {
    // This child is Node running the upstream installer, not the Electron executable.
    const child = spawn(process.execPath, [script, '--install-attempt', root], {
      env, stdio: 'inherit', windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => signal
      ? reject(new Error(`Electron installer stopped (${signal})`)) : resolve(code ?? 1))
  })
}

export async function installElectron({
  root = dirname(require.resolve('electron/package.json')),
  env = process.env,
  canUseLocalProxy = localProxyAvailable,
  run = runInstaller,
  log = console.log
} = {}) {
  // No connection checks or downloads when the upstream install is already complete.
  if (isInstalled(root, env)) return
  const next = await downloadEnvironment(env, canUseLocalProxy)
  const proxy = next.https_proxy || next.HTTPS_PROXY
  log(`[electron:install] Network: ${proxy ? safeError({ message: proxy }) : 'direct'}`)
  for (const mirror of downloadMirrors(env)) {
    const attempt = { ...next }
    // @electron/get gives npm_config_* priority; clear aliases so fallback actually changes source.
    for (const key of mirrorKeys) delete attempt[key]
    attempt.ELECTRON_MIRROR = mirror
    log(`[electron:install] Download source: ${safeError({ message: mirror })}`)
    if (await run(root, attempt) === 0) return
    log('[electron:install] Installation attempt failed.')
  }
  throw new Error('Electron runtime installation failed. See the download error above; check the proxy or set ELECTRON_MIRROR to an accessible source, then run npm run dev again.')
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--install-attempt') {
    // Electron's installer prints err.stack without err.cause. Keep the underlying network error.
    channel('undici:request:error').subscribe(({ error }) => {
      console.error(`[electron:install] Network error: ${safeError(error)}`)
    })
    require(join(process.argv[3], 'install.js'))
  } else {
    installElectron().catch(error => {
      console.error(`[electron:install] ${safeError(error)}`)
      process.exitCode = 1
    })
  }
}
