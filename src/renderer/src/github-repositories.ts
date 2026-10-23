import type { GithubRepository, GithubRepositoryErrorCode, GithubRepositoryPage, GithubRepositoryRequest } from '@shared/github'

export interface GithubRepositorySnapshot {
  repositories: GithubRepository[]
  totalCount: number | null
  complete: boolean
}
export interface GithubRepositoryFilters {
  query: string
  ownership: 'all' | 'owned' | 'shared'
  visibility: 'all' | GithubRepository['visibility']
  sort: 'updated' | 'name' | 'stars'
}
export const DEFAULT_GITHUB_FILTERS: GithubRepositoryFilters = { query: '', ownership: 'all', visibility: 'all', sort: 'updated' }

export class GithubRepositoryLoadError extends Error {
  constructor(readonly code: GithubRepositoryErrorCode, message: string) { super(message) }
}

/** Fetch every cursor page, publishing early results; cancellation prevents late writes or more requests. */
export async function loadGithubRepositories(account: string,
  fetchPage: (request: GithubRepositoryRequest) => Promise<GithubRepositoryPage>,
  publish: (snapshot: GithubRepositorySnapshot) => void, cancelled: () => boolean): Promise<void> {
  const repositories = new Map<string, GithubRepository>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  while (!cancelled()) {
    const page = await fetchPage({ account, cursor })
    if (cancelled()) return
    if (!page.ok) throw new GithubRepositoryLoadError(page.code, page.message)
    if (page.account.toLowerCase() !== account.toLowerCase()) {
      throw new GithubRepositoryLoadError('account-changed', 'GitHub 账号已切换，请重新检测后加载仓库。')
    }
    if (page.hasNextPage && (!page.endCursor || cursors.has(page.endCursor) || page.repositories.length === 0)) {
      throw new GithubRepositoryLoadError('error', '仓库分页异常，列表尚未完整，请刷新重试。')
    }
    for (const repository of page.repositories) repositories.set(repository.id, repository)
    publish({ repositories: [...repositories.values()], totalCount: page.totalCount, complete: !page.hasNextPage })
    if (!page.hasNextPage) return
    cursor = page.endCursor
    cursors.add(cursor!)
  }
}

export function selectGithubRepositories(repositories: GithubRepository[], filters: GithubRepositoryFilters, account: string): GithubRepository[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const selected = repositories.filter(repository => {
    const owned = repository.owner.toLowerCase() === account.toLowerCase()
    if (filters.ownership === 'owned' && !owned || filters.ownership === 'shared' && owned) return false
    if (filters.visibility !== 'all' && repository.visibility !== filters.visibility) return false
    const text = `${repository.fullName} ${repository.description} ${repository.language ?? ''}`.toLowerCase()
    return terms.every(term => text.includes(term))
  })
  return selected.sort((left, right) => {
    const order = filters.sort === 'updated' ? Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      : filters.sort === 'stars' ? right.stars - left.stars : 0
    return order || left.fullName.localeCompare(right.fullName, 'en')
  })
}

export function githubRepositoryUpdated(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso))
  if (elapsed < 60000) return '刚刚更新'
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前更新`
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} 小时前更新`
  if (elapsed < 7 * 86400000) return `${Math.floor(elapsed / 86400000)} 天前更新`
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) + ' 更新'
}
