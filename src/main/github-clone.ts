import { spawn } from 'node:child_process'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { githubRepositoryUrl, initialGithubCloneProgress, validGithubCloneRequest } from '../shared/github'
import type { GithubCliState, GithubCloneProgress, GithubCloneRequest, GithubCloneResult } from '../shared/github'
import { getGithubCliState, resolveGithubCli } from './github-cli'
import { createGithubCloneProgressReader } from './github-clone-progress'

interface CloneFiles {
  isDirectory(path: string): boolean
  realpath(path: string): string
  reserve(path: string): void
}
interface CloneOutput { ok: boolean; stderr: string; code: string | number | null }
interface CloneDependencies {
  cwd: string
  current(): boolean
  chooseDirectory(defaultPath: string): Promise<string | null>
  inspect?(): Promise<GithubCliState>
  executable?(): Promise<string | null>
  clone?(file: string, args: string[], cwd: string, onProgress: (progress: GithubCloneProgress) => void): Promise<CloneOutput>
  onProgress?(progress: GithubCloneProgress): void
  files?: CloneFiles
}
const localFiles: CloneFiles = {
  isDirectory(path) { try { return statSync(path).isDirectory() } catch { return false } },
  realpath: realpathSync,
  // Exclusive creation also rejects existing empty folders, symlinks and racing clones.
  reserve(path) { mkdirSync(path) }
}

/** Drain bounded diagnostics without buffering a large repository's progress output. */
function runClone(file: string, args: string[], cwd: string, onProgress: (progress: GithubCloneProgress) => void): Promise<CloneOutput> {
  return new Promise(resolve => {
    let stderr = ''
    const progress = createGithubCloneProgressReader(onProgress)
    try {
      const child = spawn(file, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', NO_COLOR: '1', LC_ALL: 'C', LANG: 'C' } })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-16384); progress.write(data) })
      child.once('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, stderr, code: error.code ?? null }))
      child.once('close', code => { progress.end(); resolve({ ok: code === 0, stderr, code }) })
    } catch { resolve({ ok: false, stderr, code: null }) }
  })
}

function cloneError(result: CloneOutput): string {
  if (/could not find.*git|unable to find git|git.*not (?:found|installed)|executable.*git/i.test(result.stderr)) return '本机尚未找到 Git，请安装 Git 后重试。'
  if (result.code === 'ENOENT') return '无法启动 GitHub CLI，请重新检测安装状态。'
  if (/authentication|could not read username|403|401|repository not found|not logged|auth login/i.test(result.stderr)) return '无法访问该仓库，请检查当前 GitHub 账号、仓库权限或组织授权。'
  if (/could not resolve|connection|timed out|timeout|network|tls|ssl|proxy/i.test(result.stderr)) return '克隆失败，请检查网络或代理后重试。'
  if (/permission denied|access is denied|disk.*full|no space left/i.test(result.stderr)) return '无法写入目标目录，请检查目录权限和磁盘空间。'
  return '仓库克隆未完成，请检查 Git、网络和仓库权限后重试。'
}

const pending = new Set<string>()
/** A native directory selection authorizes one local clone, independent of the AI terminal. */
export async function cloneGithubRepository(request: GithubCloneRequest, deps: CloneDependencies): Promise<GithubCloneResult> {
  const error = (message: string, directory: string | null = null): GithubCloneResult => ({ status: 'error', directory, message })
  if (!validGithubCloneRequest(request)) return error('仓库克隆请求无效，请刷新后重试。')
  if (pending.has(request.sessionId)) return error('当前会话已有克隆操作，请等待完成。')
  pending.add(request.sessionId)
  const report = (progress: GithubCloneProgress): void => {
    // A closed window or detached observer must never interrupt the actual clone.
    try { deps.onProgress?.(progress) } catch { /* Observer is no longer available. */ }
  }
  let target: string | null = null
  try {
    if (!deps.current()) return error('原会话已切换，请重新操作。')
    const files = deps.files ?? localFiles
    const defaultPath = isAbsolute(deps.cwd) && files.isDirectory(deps.cwd) ? deps.cwd : homedir()
    report(initialGithubCloneProgress('selecting'))
    const selected = await deps.chooseDirectory(defaultPath)
    if (selected === null) return { status: 'cancelled', directory: null, message: '' }
    if (!deps.current()) return error('原会话已切换，克隆未开始。')
    if (!selected || selected.length > 8192 || /[\u0000-\u001f\u007f]/.test(selected) || !isAbsolute(selected) || !files.isDirectory(selected)) {
      return error('所选目录不可用，请重新选择本地目录。')
    }
    report(initialGithubCloneProgress('checking'))
    const executable = await (deps.executable ?? (async () => (await resolveGithubCli()).executable))()
    if (!executable) return error('本机尚未找到 GitHub CLI，请重新检测安装状态。')
    const cli = await (deps.inspect ?? getGithubCliState)()
    if (cli.status !== 'signed-in' || !cli.account) return error('GitHub 登录状态不可用，请重新登录后克隆。')
    if (cli.account.toLowerCase() !== request.account.toLowerCase()) return error('GitHub 账号已切换，请刷新仓库列表后重试。')
    if (!deps.current()) return error('原会话已切换，克隆未开始。')
    const name = request.fullName.split('/')[1]
    if (process.platform === 'win32' && (/[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) {
      return error('该仓库名称无法作为 Windows 文件夹名称。')
    }
    const parent = files.realpath(selected)
    target = join(parent, name)
    try { files.reserve(target) }
    catch (cause) {
      return error((cause as NodeJS.ErrnoException).code === 'EEXIST'
        ? '所选目录下已存在同名文件或文件夹，请选择其他位置。' : '无法创建仓库文件夹，请检查目录权限和磁盘空间。')
    }
    report(initialGithubCloneProgress('connecting'))
    const result = await (deps.clone ?? runClone)(executable, ['repo', 'clone', githubRepositoryUrl(request.fullName)!, target, '--', '--progress'], parent, report)
    if (!result.ok) return error(cloneError(result), target)
    report(initialGithubCloneProgress('verifying'))
    if (!files.isDirectory(join(target, '.git'))) return error(cloneError(result), target)
    return { status: 'cloned', directory: target, message: '已克隆到本地' }
  } catch {
    return error(target ? '克隆结果未确认，请先检查目标目录，避免重复操作。' : '克隆未开始，请重新选择目录后重试。', target)
  } finally { pending.delete(request.sessionId) }
}
