import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GithubCliState, GithubLogoutResult } from '../shared/github'

interface GhResult {
  ok: boolean
  stdout: string
  stderr: string
  code: string | number | null
  timedOut: boolean
}
export type GhRunner = (file: string, args: string[]) => Promise<GhResult>

export const runGithubCli: GhRunner = (file, args) => new Promise(resolve => {
  const child = execFile(file, args, {
    cwd: homedir(), encoding: 'utf8', windowsHide: true,
    timeout: args[0] === '--version' ? 5000 : args[0] === 'api' ? 30000 : 20000,
    maxBuffer: args[0] === 'api' ? 2 * 1024 * 1024 : 128 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
  }, (error, stdout, stderr) => {
    // Never log or forward command output: auth failures can contain credential details.
    resolve({ ok: !error, stdout, stderr, code: error?.code ?? null, timedOut: error?.killed === true })
  })
  child.stdin?.end()
})

function candidates(): string[] {
  if (process.platform === 'win32') {
    const directories = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]
      .filter((directory): directory is string => Boolean(directory))
    return [...new Set(['gh.exe', ...directories.map(directory => join(directory, 'GitHub CLI', 'gh.exe')),
      ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe')] : [])])]
  }
  // Desktop apps on macOS may not inherit Homebrew's PATH.
  return ['gh', ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : ['/usr/local/bin/gh', '/usr/bin/gh'])]
}

export async function resolveGithubCli(run: GhRunner = runGithubCli, files = candidates()): Promise<{
  executable: string | null; version: string | null; executionFailed: boolean
}> {
  let executionFailed = false
  for (const file of files) {
    const result = await run(file, ['--version'])
    const version = result.ok ? result.stdout.match(/^gh version ([^\s]+)/m)?.[1] : null
    if (version) return { executable: file, version: version.slice(0, 80), executionFailed: false }
    if (result.code !== 'ENOENT') executionFailed = true
  }
  return { executable: null, version: null, executionFailed }
}

/** Local-machine prerequisites; this never runs through the conversation's SSH/remote shell. */
export async function inspectGithubCli(run: GhRunner = runGithubCli, files = candidates()): Promise<GithubCliState> {
  const installCommand = process.platform === 'win32' ? 'winget install --id GitHub.cli --exact'
    : process.platform === 'darwin' ? 'brew install gh' : null
  const state = (status: GithubCliState['status'], message: string, version: string | null = null, account: string | null = null): GithubCliState =>
    ({ status, message, version, account, installCommand })
  let version: string | null = null
  try {
    const resolved = await resolveGithubCli(run, files)
    const { executable, executionFailed } = resolved
    version = resolved.version
    if (!executable) return executionFailed
      ? state('error', '无法运行 GitHub CLI，请检查安装和执行权限后重试。')
      : state('missing', '本机尚未找到 GitHub CLI（gh），请先安装。')

    const result = await run(executable, ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'])
    if (!result.ok) {
      if (result.timedOut) return state('error', '检测 GitHub 登录状态超时，请检查网络或代理后重试。', version)
      if (/unknown flag|unknown shorthand flag/i.test(result.stderr)) {
        return state('error', '当前 GitHub CLI 版本不支持登录状态检测，请升级后重试。', version)
      }
      return state('error', '暂时无法检测 GitHub 登录状态，请检查网络、代理或 GitHub CLI 配置后重试。', version)
    }

    // --json can exit successfully when authentication fails. Inspect the active account itself.
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object' || !('hosts' in value) || !value.hosts || typeof value.hosts !== 'object' || Array.isArray(value.hosts)) {
      return state('error', '无法识别 GitHub CLI 返回的状态，请升级后重试。', version)
    }
    const hosts = value.hosts as Record<string, unknown>
    const accounts = hosts['github.com']
    if (accounts === undefined || (Array.isArray(accounts) && accounts.length === 0)) {
      return state('signed-out', 'GitHub CLI 已安装，请登录 GitHub 账号。', version)
    }
    if (!Array.isArray(accounts)) return state('error', '无法识别 GitHub CLI 返回的账号状态，请升级后重试。', version)
    const active = accounts.find(entry => entry && typeof entry === 'object' && entry.active === true) as Record<string, unknown> | undefined
    if (!active) return state('error', '未能确定当前 GitHub 账号，请在本机终端运行 gh auth status 后重试。', version)
    if (active.state === 'success' && typeof active.login === 'string' && active.login.trim()) {
      return state('signed-in', 'GitHub CLI 已就绪。', version, active.login.trim().slice(0, 100))
    }
    if (active.state === 'refresh_expired' || (active.state === 'error' && typeof active.error === 'string'
      && /HTTP 401|bad credentials|invalid token|token.*invalid/i.test(active.error))) {
      if (typeof active.tokenSource === 'string' && active.tokenSource.endsWith('_TOKEN')) {
        return state('signed-out', '环境变量中的 GitHub 凭据已失效，请先更新或移除本机 GH_TOKEN / GITHUB_TOKEN，再重新登录。', version)
      }
      return state('signed-out', 'GitHub 登录凭据已失效，请重新登录。', version)
    }
    return state('error', '暂时无法确认 GitHub 账号状态，请检查网络或代理后重试。', version)
  } catch {
    return state('error', 'GitHub CLI 检测未完成，请重新检测；若仍失败，请检查安装、网络和配置。', version)
  }
}

let pendingCheck: Promise<GithubCliState> | null = null
let pendingLogout: { account: string; promise: Promise<GithubLogoutResult> } | null = null
export function getGithubCliState(): Promise<GithubCliState> {
  if (pendingLogout) return pendingLogout.promise.then(() => getGithubCliState())
  // Opening multiple session panes or React strict mode must not duplicate the same check.
  if (!pendingCheck) pendingCheck = inspectGithubCli().finally(() => { pendingCheck = null })
  return pendingCheck
}

export async function inspectGithubLogout(account: string, run: GhRunner = runGithubCli,
  files = candidates(), environment: NodeJS.ProcessEnv = process.env): Promise<GithubLogoutResult> {
  if (typeof account !== 'string' || !/^[a-z\d][a-z\d-]{0,38}$/i.test(account)) {
    return { ok: false, message: '退出账号无效，请重新检测登录状态。' }
  }
  const environmentMessage = '当前 GitHub 登录来自环境变量，gh 无法移除。请在本机系统环境中移除 GH_TOKEN / GITHUB_TOKEN，重启应用后重新检测。'
  if (environment.GH_TOKEN || environment.GITHUB_TOKEN) return { ok: false, message: environmentMessage }
  try {
    const { executable } = await resolveGithubCli(run, files)
    if (!executable) return { ok: false, message: '无法运行 GitHub CLI，请重新检测安装状态。' }
    const status = await run(executable, ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'])
    if (!status.ok) return { ok: false, message: '未能确认当前 GitHub 账号，请重新检测后再退出。' }
    const value: unknown = JSON.parse(status.stdout)
    if (!value || typeof value !== 'object' || !('hosts' in value) || !value.hosts || typeof value.hosts !== 'object' || Array.isArray(value.hosts)) {
      return { ok: false, message: '无法识别 GitHub 账号状态，请重新检测后再退出。' }
    }
    const entries = (value.hosts as Record<string, unknown>)['github.com']
    if (entries === undefined || (Array.isArray(entries) && entries.length === 0)) {
      return { ok: true, message: `@${account} 当前已退出登录。` }
    }
    if (!Array.isArray(entries)) return { ok: false, message: '无法识别 GitHub 账号状态，请重新检测后再退出。' }
    const active = entries.find(entry => entry && typeof entry === 'object' && entry.active === true) as Record<string, unknown> | undefined
    if (!active || typeof active.login !== 'string' || active.login.toLowerCase() !== account.toLowerCase()) {
      return { ok: false, message: 'GitHub 账号已变化，请刷新列表后再退出。' }
    }
    if (typeof active.tokenSource !== 'string' || !active.tokenSource) {
      return { ok: false, message: '无法确认 GitHub 凭据来源，请在本机终端检查 gh auth status 后重试。' }
    }
    if (active.tokenSource.endsWith('_TOKEN')) return { ok: false, message: environmentMessage }
    const result = await run(executable, ['auth', 'logout', '--hostname', 'github.com', '--user', active.login])
    if (!result.ok) {
      return { ok: false, message: /environment variable|GH_TOKEN|GITHUB_TOKEN/i.test(result.stderr) ? environmentMessage
        : result.timedOut ? '退出登录超时，请重新检测账号状态后重试。' : '退出登录未完成，请重新检测账号状态后重试。' }
    }
    return { ok: true, message: `已退出 GitHub CLI 账号 @${account}。` }
  } catch {
    return { ok: false, message: '退出登录未完成，请重新检测账号状态后重试。' }
  }
}

export function logoutGithubCli(account: string): Promise<GithubLogoutResult> {
  if (typeof account !== 'string' || !/^[a-z\d][a-z\d-]{0,38}$/i.test(account)) {
    return Promise.resolve({ ok: false, message: '退出账号无效。' })
  }
  if (pendingLogout) return pendingLogout.account.toLowerCase() === account.toLowerCase() ? pendingLogout.promise
    : Promise.resolve({ ok: false, message: '正在退出另一个 GitHub 账号，请稍后重试。' })
  const previousCheck = pendingCheck
  const promise = (async () => {
    // Finish earlier checks before changing credentials; their cached result must not survive logout.
    if (previousCheck) await previousCheck
    return inspectGithubLogout(account)
  })().finally(() => { pendingCheck = null; pendingLogout = null })
  pendingLogout = { account, promise }
  return promise
}
