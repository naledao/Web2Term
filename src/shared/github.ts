export const GITHUB_LOGIN_COMMAND = 'gh auth login --hostname github.com --web --skip-ssh-key'

export interface GithubLoginTaskResult {
  status: 'sent' | 'already-signed-in' | 'blocked' | 'uncertain'
  message: string
}

/** A user task, sent through the active conversation's normal prompt and command loop. */
export function githubLoginTask(): string {
  return [
    '帮我在运行本应用的本机登录 GitHub CLI（github.com），供右侧 GitHub 仓库管理使用。继续在当前对话协助我。',
    '先检查本机 gh 的安装与当前登录状态。gh 不在 PATH 时检查系统常见安装路径；未安装时说明并停止，不擅自安装。已经登录则报告当前账号，不重复授权或退出其他账号。',
    `未登录时使用 ${GITHUB_LOGIN_COMMAND} 发起官方浏览器授权。使用非 TTY 且关闭 stdin 的独立进程，不设置 GH_FORCE_TTY；不要使用需要我在终端选择菜单或按 Enter 的交互方式。`,
    '授权需要等待我操作浏览器：通过 background_task 工具提交登录命令，设置 background:true，由软件启动、登记和监控本次唯一的登录进程。command 只填写实际 gh 登录命令；使用绝对路径时按当前 shell 的规则调用。',
    '软件的后台创建通知会提供真实 PID、日志路径和已经取得的启动输出。根据通知展示一次性设备码和 GitHub 官方授权地址；未收到授权信息时说明等待状态。',
    '在回答中清楚展示本次一次性设备码（如果有）和 GitHub 官方授权链接。非交互 gh 可能只输出 URL、不自动开浏览器；可调用本机默认浏览器打开其 github.com 官方授权地址。浏览器中的登录和授权由我本人完成。',
    '收到后台创建通知后简短引导我授权并等待软件自动回传最终结果；不要自行 sleep、轮询、重复启动或提前报告完成。',
    '登录进程结束后，用 gh auth status --hostname github.com --active --json hosts 检查 hosts 中当前账号的 state 和 login；--json 即使凭据无效也可能退出码为 0，只有 state=success 才算登录成功。',
    '不要索取或输出密码、PAT、OAuth token，不运行 gh auth token 或 --show-token，不读取凭据文件内容，不使用 --insecure-storage。若 GH_TOKEN / GITHUB_TOKEN 阻碍登录，只说明变量名和处理方式，不打印值、不擅自修改我的环境变量。',
    '只有实际检查成功后才报告已登录及账号；失败时说明实际原因，保留由我重试的入口。'
  ].join('\n')
}

export interface GithubCliState {
  status: 'missing' | 'signed-out' | 'signed-in' | 'error'
  version: string | null
  account: string | null
  message: string
  installCommand: string | null
}

export interface GithubLogoutResult {
  ok: boolean
  message: string
}

export interface GithubRepository {
  id: string
  name: string
  owner: string
  fullName: string
  url: string
  description: string
  visibility: 'public' | 'private' | 'internal'
  archived: boolean
  fork: boolean
  stars: number
  language: string | null
  languageColor: string | null
  updatedAt: string
}

export interface GithubRepositoryRequest {
  account: string
  cursor: string | null
}

export interface GithubCloneRequest {
  requestId: string
  sessionId: string
  account: string
  fullName: string
}

export interface GithubCloneResult {
  status: 'cloned' | 'cancelled' | 'error'
  directory: string | null
  message: string
}

export const GITHUB_CLONE_STAGES = {
  selecting: '选择目录',
  checking: '检查登录状态',
  connecting: '连接仓库',
  enumerating: '枚举对象',
  counting: '统计对象',
  compressing: '压缩对象',
  receiving: '接收对象',
  resolving: '解析差异',
  checkout: '写入文件',
  filtering: '下载大文件',
  verifying: '确认克隆结果'
} as const

export interface GithubCloneProgress {
  stage: keyof typeof GITHUB_CLONE_STAGES
  percent: number | null
  completed: number | null
  total: number | null
  transferred: string | null
  speed: string | null
}

export interface GithubCloneProgressEvent extends GithubCloneRequest {
  progress: GithubCloneProgress
}

export function initialGithubCloneProgress(stage: GithubCloneProgress['stage']): GithubCloneProgress {
  return { stage, percent: null, completed: null, total: null, transferred: null, speed: null }
}

export function validGithubCloneRequest(value: unknown): value is GithubCloneRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<GithubCloneRequest>
  return typeof request.requestId === 'string' && /^[a-z\d_-]{1,128}$/i.test(request.requestId) &&
    typeof request.sessionId === 'string' && request.sessionId.length > 0 && request.sessionId.length <= 128 &&
    typeof request.account === 'string' && /^[a-z\d][a-z\d-]{0,38}$/i.test(request.account) &&
    typeof request.fullName === 'string' && githubRepositoryUrl(request.fullName) !== null
}

export type GithubRepositoryErrorCode = 'auth' | 'account-changed' | 'permission' | 'rate-limit' | 'network' | 'error'

export type GithubRepositoryPage = {
  ok: true
  account: string
  repositories: GithubRepository[]
  totalCount: number
  endCursor: string | null
  hasNextPage: boolean
} | {
  ok: false
  code: GithubRepositoryErrorCode
  message: string
}

export function validGithubRepositoryRequest(value: unknown): value is GithubRepositoryRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<GithubRepositoryRequest>
  return typeof request.account === 'string' && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(request.account)
    && (request.cursor === null || (typeof request.cursor === 'string' && request.cursor.length > 0
      && request.cursor.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(request.cursor)))
}

/** Construct navigation URLs from repository names rather than trusting arbitrary API links. */
export function githubRepositoryUrl(fullName: string): string | null {
  const match = /^([a-z\d][a-z\d-]{0,38})\/([a-z\d._-]{1,100})$/i.exec(fullName)
  if (!match || match[2] === '.' || match[2] === '..') return null
  return `https://github.com/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`
}
