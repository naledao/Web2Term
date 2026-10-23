import { githubRepositoryUrl, validGithubRepositoryRequest } from '../shared/github'
import type { GithubRepository, GithubRepositoryPage, GithubRepositoryRequest } from '../shared/github'
import { resolveGithubCli, runGithubCli } from './github-cli'
import type { GhRunner } from './github-cli'

// One response binds every page to its authenticated viewer, including when gh switches accounts mid-load.
const REPOSITORIES_QUERY = `query($after: String) {
  viewer {
    login
    repositories(first: 100, after: $after,
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
      orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { endCursor hasNextPage }
      nodes {
        id name nameWithOwner description visibility isArchived isFork stargazerCount updatedAt
        owner { login }
        primaryLanguage { name color }
      }
    }
  }
}`

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function commandFailure(text: string, timedOut = false): GithubRepositoryPage {
  if (/HTTP 401|bad credentials|requires authentication|not logged|auth login/i.test(text)) {
    return { ok: false, code: 'auth', message: 'GitHub 登录已失效，请重新登录后刷新仓库列表。' }
  }
  if (/rate limit|secondary rate|abuse detection/i.test(text)) {
    return { ok: false, code: 'rate-limit', message: 'GitHub 请求次数暂时受限，请稍后刷新。' }
  }
  if (/HTTP 403|resource not accessible|saml|insufficient.*scope|forbidden/i.test(text)) {
    return { ok: false, code: 'permission', message: '当前授权无法读取仓库，请检查账号权限或组织的 SSO 授权后重试。' }
  }
  if (timedOut || /timeout|timed out|could not resolve|connection|network|tls|dial tcp|HTTP 50[234]/i.test(text)) {
    return { ok: false, code: 'network', message: '仓库列表加载失败，请检查网络或代理后重试。' }
  }
  return { ok: false, code: 'error', message: '暂时无法加载仓库列表，请刷新重试。' }
}

function repository(value: unknown): GithubRepository | null {
  const node = object(value)
  const owner = object(node?.owner)
  if (!node || typeof node.id !== 'string' || !node.id || typeof node.name !== 'string'
    || typeof node.nameWithOwner !== 'string' || !owner || typeof owner.login !== 'string'
    || node.nameWithOwner !== `${owner.login}/${node.name}`
    || (node.description !== null && typeof node.description !== 'string')
    || typeof node.isArchived !== 'boolean' || typeof node.isFork !== 'boolean'
    || typeof node.stargazerCount !== 'number' || !Number.isSafeInteger(node.stargazerCount) || node.stargazerCount < 0
    || typeof node.updatedAt !== 'string' || !Number.isFinite(Date.parse(node.updatedAt))) return null
  const url = githubRepositoryUrl(node.nameWithOwner)
  const visibility = typeof node.visibility === 'string' ? node.visibility.toLowerCase() : ''
  if (!url || !['public', 'private', 'internal'].includes(visibility)) return null
  const language = object(node.primaryLanguage)
  if (node.primaryLanguage !== null && (!language || typeof language.name !== 'string')) return null
  return {
    id: node.id, name: node.name, owner: owner.login, fullName: node.nameWithOwner, url,
    description: typeof node.description === 'string' ? node.description : '',
    visibility: visibility as GithubRepository['visibility'], archived: node.isArchived, fork: node.isFork,
    stars: node.stargazerCount, updatedAt: node.updatedAt,
    language: language && typeof language.name === 'string' ? language.name : null,
    languageColor: language && typeof language.color === 'string' && /^#[\da-f]{6}$/i.test(language.color) ? language.color : null
  }
}

export async function inspectGithubRepositoryPage(request: GithubRepositoryRequest, run: GhRunner = runGithubCli, files?: string[]): Promise<GithubRepositoryPage> {
  if (!validGithubRepositoryRequest(request)) return { ok: false, code: 'error', message: '仓库列表请求无效，请刷新重试。' }
  try {
    const { executable } = await resolveGithubCli(run, files)
    if (!executable) return { ok: false, code: 'error', message: '无法运行 GitHub CLI，请重新检测安装状态。' }
    const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${REPOSITORIES_QUERY}`]
    if (request.cursor !== null) args.push('-f', `after=${request.cursor}`)
    const result = await run(executable, args)
    // No raw stdout/stderr is logged or sent to the renderer.
    if (!result.ok) return commandFailure(result.stderr, result.timedOut)
    const value = object(JSON.parse(result.stdout))
    if (Array.isArray(value?.errors) && value.errors.length) {
      return commandFailure(value.errors.map(error => {
        const item = object(error)
        return typeof item?.message === 'string' ? item.message : ''
      }).join('\n'))
    }
    const viewer = object(object(value?.data)?.viewer)
    if (!viewer || typeof viewer.login !== 'string') return { ok: false, code: 'error', message: '无法识别 GitHub 返回的账号信息，请刷新重试。' }
    if (viewer.login.toLowerCase() !== request.account.toLowerCase()) {
      return { ok: false, code: 'account-changed', message: 'GitHub 账号已切换，请重新检测后加载仓库。' }
    }
    const connection = object(viewer.repositories)
    const page = object(connection?.pageInfo)
    if (!connection || !Array.isArray(connection.nodes) || connection.nodes.length > 100
      || typeof connection.totalCount !== 'number' || !Number.isSafeInteger(connection.totalCount) || connection.totalCount < 0
      || !page || typeof page.hasNextPage !== 'boolean'
      || (page.endCursor !== null && (typeof page.endCursor !== 'string' || page.endCursor.length > 4096))
      || (page.hasNextPage && (!page.endCursor || page.endCursor === request.cursor || connection.nodes.length === 0))) {
      return { ok: false, code: 'error', message: '仓库分页信息异常，请刷新重试。' }
    }
    const repositories = connection.nodes.map(repository)
    if (repositories.some(item => item === null)) return { ok: false, code: 'error', message: '仓库信息不完整，请刷新重试。' }
    return { ok: true, account: viewer.login, repositories: repositories as GithubRepository[], totalCount: connection.totalCount,
      hasNextPage: page.hasNextPage, endCursor: page.endCursor as string | null }
  } catch {
    return { ok: false, code: 'error', message: '仓库列表读取未完成，请检查 GitHub CLI、网络和配置后重试。' }
  }
}

const pendingPages = new Map<string, Promise<GithubRepositoryPage>>()
export function getGithubRepositoryPage(request: GithubRepositoryRequest): Promise<GithubRepositoryPage> {
  if (!validGithubRepositoryRequest(request)) return Promise.resolve({ ok: false, code: 'error', message: '仓库列表请求无效。' })
  const key = JSON.stringify([request.account.toLowerCase(), request.cursor])
  let pending = pendingPages.get(key)
  if (!pending) {
    pending = inspectGithubRepositoryPage(request).finally(() => { pendingPages.delete(key) })
    pendingPages.set(key, pending)
  }
  return pending
}
