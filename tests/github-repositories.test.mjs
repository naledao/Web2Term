// User-run only: node --test tests/github-repositories.test.mjs
// Real page parser, pagination and filters with fake gh responses; no processes, credentials, Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, Date, Intl, process: { platform: 'win32', env: {} }, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/github.ts')
const cli = load('../src/main/github-cli.ts', {
  'node:child_process': { execFile() { throw new Error('Real processes must not run') } },
  'node:os': { homedir: () => '/fake-home' }, 'node:path': { join }
})
const main = load('../src/main/github-repositories.ts', { '../shared/github': shared, './github-cli': cli })
const renderer = load('../src/renderer/src/github-repositories.ts')
const clone = value => JSON.parse(JSON.stringify(value))
const ok = stdout => ({ ok: true, stdout, stderr: '', code: null, timedOut: false })
const rawRepository = (id = '1', owner = 'alice') => ({ id, name: 'repo-' + id, nameWithOwner: owner + '/repo-' + id,
  owner: { login: owner }, description: 'Repository description', visibility: 'PRIVATE', isArchived: false, isFork: false,
  stargazerCount: 2, updatedAt: '2026-10-23T01:00:00Z', primaryLanguage: { name: 'TypeScript', color: '#3178c6' } })
const response = (nodes = [rawRepository()], options = {}) => ({ data: { viewer: { login: options.account ?? 'alice',
  repositories: { nodes, totalCount: options.totalCount ?? nodes.length,
    pageInfo: { hasNextPage: options.hasNextPage ?? false, endCursor: options.endCursor ?? null } } } } })
function fixture(value, result) {
  const calls = []
  return { calls, run: async (file, args) => {
    calls.push({ file, args: Array.from(args) })
    return args[0] === '--version' ? ok('gh version 2.80.0\n') : result ?? ok(JSON.stringify(value))
  } }
}
const request = { account: 'alice', cursor: null }

test('queries all affiliations with cursor pagination and normalizes private repository metadata', async () => {
  const f = fixture(response())
  const result = await main.inspectGithubRepositoryPage(request, f.run, ['gh'])
  assert.equal(result.ok, true)
  assert.equal(result.repositories[0].fullName, 'alice/repo-1')
  assert.equal(result.repositories[0].url, 'https://github.com/alice/repo-1')
  assert.equal(result.repositories[0].visibility, 'private')
  assert.equal(result.repositories[0].language, 'TypeScript')
  assert.equal(result.repositories[0].languageColor, '#3178c6')
  assert.deepEqual(f.calls[1].args.slice(0, 4), ['api', 'graphql', '--hostname', 'github.com'])
  assert.match(f.calls[1].args[5], /first: 100/)
  assert.match(f.calls[1].args[5], /ownerAffiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]/)
})

test('cursor values stay a separate argument and matching account names are case insensitive', async () => {
  const f = fixture(response([], { account: 'Alice' }))
  const result = await main.inspectGithubRepositoryPage({ account: 'alice', cursor: 'cursor=$not-a-shell' }, f.run, ['gh'])
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls[1].args.slice(-2), ['-f', 'after=cursor=$not-a-shell'])
})

test('invalid requests cannot invoke gh', async () => {
  for (const value of [null, {}, { account: '-invalid', cursor: null }, { account: 'alice', cursor: '\n' },
    { account: 'alice', cursor: 'x'.repeat(4097) }]) {
    const result = await main.inspectGithubRepositoryPage(value, () => { throw new Error('Should not execute') }, ['gh'])
    assert.equal(result.ok, false)
  }
})

test('account switches reject the page before it can mix with the previous account', async () => {
  const result = await main.inspectGithubRepositoryPage(request, fixture(response([rawRepository('1', 'bob')], { account: 'bob' })).run, ['gh'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'account-changed')
  assert.equal('repositories' in result, false)
})

test('nullable languages, internal visibility, forks and archived repositories are retained', async () => {
  const node = { ...rawRepository(), primaryLanguage: null, description: null, visibility: 'INTERNAL', isFork: true, isArchived: true }
  const result = await main.inspectGithubRepositoryPage(request, fixture(response([node])).run, ['gh'])
  assert.equal(result.repositories[0].visibility, 'internal')
  assert.equal(result.repositories[0].fork, true)
  assert.equal(result.repositories[0].archived, true)
  assert.equal(result.repositories[0].description, '')
  assert.equal(result.repositories[0].language, null)
})

test('repository links cannot be replaced by arbitrary schemes or paths', async () => {
  assert.equal(shared.githubRepositoryUrl('alice/valid.repo'), 'https://github.com/alice/valid.repo')
  for (const fullName of ['alice/..', 'alice/../../escape', 'https://evil.example/repo', 'javascript:alert(1)', 'alice/repo?token=secret']) {
    assert.equal(shared.githubRepositoryUrl(fullName), null)
  }
  const node = { ...rawRepository(), url: 'javascript:alert(1)', token: 'secret' }
  const result = await main.inspectGithubRepositoryPage(request, fixture(response([node])).run, ['gh'])
  assert.equal(result.repositories[0].url, 'https://github.com/alice/repo-1')
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('malformed or incomplete pages fail without silently omitting repositories', async () => {
  for (const value of [response([null]), response([{ ...rawRepository(), visibility: 'UNKNOWN' }]),
    response([{ ...rawRepository(), updatedAt: 'not a date' }]), response([], { hasNextPage: true, endCursor: 'next' }),
    response([rawRepository()], { hasNextPage: true }), { data: { viewer: { login: 'alice' } } }]) {
    assert.equal((await main.inspectGithubRepositoryPage(request, fixture(value).run, ['gh'])).ok, false)
  }
})

test('GraphQL partial errors, rate limits, expired auth and network failures remain distinct and sanitized', async () => {
  for (const [message, code] of [['Resource not accessible by personal access token', 'permission'],
    ['API rate limit exceeded', 'rate-limit'], ['HTTP 401: Bad credentials ghp_secret', 'auth'], ['connection timed out', 'network']]) {
    const result = await main.inspectGithubRepositoryPage(request, fixture({ ...response(), errors: [{ message }] }).run, ['gh'])
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.equal(JSON.stringify(result).includes('ghp_secret'), false)
  }
  const result = await main.inspectGithubRepositoryPage(request, fixture(null, { ok: false, stdout: '', stderr: '', code: null, timedOut: true }).run, ['gh'])
  assert.equal(result.code, 'network')
})

const repository = (id, owner = 'alice', extra = {}) => ({ id: String(id), owner, name: 'repo-' + id, fullName: owner + '/repo-' + id,
  url: 'https://github.com/' + owner + '/repo-' + id, description: 'A useful tool', visibility: 'public', fork: false, archived: false,
  language: 'TypeScript', languageColor: '#3178c6', stars: 0, updatedAt: '2026-10-23T01:00:00Z', ...extra })
const page = (repositories, endCursor, totalCount, account = 'alice') => ({ ok: true, account, repositories, endCursor, hasNextPage: endCursor !== null, totalCount })

test('loads beyond default limits, follows every cursor and deduplicates repeated IDs', async () => {
  const calls = [], snapshots = []
  const pages = [page(Array.from({ length: 100 }, (_, i) => repository(i)), 'next', 150),
    page([repository(99), ...Array.from({ length: 50 }, (_, i) => repository(i + 100))], null, 150)]
  await renderer.loadGithubRepositories('alice', async request => { calls.push(clone(request)); return pages.shift() }, value => snapshots.push(clone(value)), () => false)
  assert.deepEqual(calls.map(call => call.cursor), [null, 'next'])
  assert.equal(snapshots[0].repositories.length, 100)
  assert.equal(snapshots[0].complete, false)
  assert.equal(snapshots[1].repositories.length, 150)
  assert.equal(snapshots[1].complete, true)
})

test('later failures preserve published results as incomplete', async () => {
  const snapshots = [], pages = [page([repository(1)], 'next', 2), { ok: false, code: 'network', message: 'Try again' }]
  await assert.rejects(renderer.loadGithubRepositories('alice', async () => pages.shift(), value => snapshots.push(clone(value)), () => false), error => error.code === 'network')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].repositories.length, 1)
  assert.equal(snapshots[0].complete, false)
})

test('leaving the pane ignores a late page and does not fetch another', async () => {
  let cancelled = false, calls = 0, published = 0
  await renderer.loadGithubRepositories('alice', async () => {
    calls++
    cancelled = true
    return page([repository(1)], 'next', 2)
  }, () => { published++ }, () => cancelled)
  assert.equal(calls, 1)
  assert.equal(published, 0)
})

test('repeating cursors and account changes stop before publishing a mixed or endless list', async () => {
  for (const next of [page([repository(2)], 'next', 2), page([repository(2, 'bob')], null, 2, 'bob')]) {
    const snapshots = [], pages = [page([repository(1)], 'next', 2), next]
    await assert.rejects(renderer.loadGithubRepositories('alice', async () => pages.shift(), value => snapshots.push(value), () => false))
    assert.equal(snapshots.length, 1)
  }
})

test('search, ownership and visibility filters cover the entire collection without mutating it', () => {
  const repositories = Array.from({ length: 80 }, (_, i) => repository(i))
  repositories.push(repository('needle', 'team', { visibility: 'private', description: 'Rare database service' }))
  const filters = { ...renderer.DEFAULT_GITHUB_FILTERS, query: 'TEAM database', ownership: 'shared', visibility: 'private' }
  const selected = renderer.selectGithubRepositories(repositories, filters, 'alice')
  assert.equal(selected.length, 1)
  assert.equal(selected[0].id, 'needle')
  assert.equal(repositories.length, 81)
  assert.equal(repositories[0].id, '0')
  assert.equal(renderer.selectGithubRepositories(repositories, { ...renderer.DEFAULT_GITHUB_FILTERS, ownership: 'owned' }, 'ALICE').length, 80)
})

test('sorts by update time, stars or name with stable name tie breaks', () => {
  const repositories = [repository('z', 'alice', { stars: 1 }), repository('a', 'alice', { stars: 3, updatedAt: '2026-10-22T01:00:00Z' })]
  const ids = sort => Array.from(renderer.selectGithubRepositories(repositories, { ...renderer.DEFAULT_GITHUB_FILTERS, sort }, 'alice'), item => item.id)
  assert.deepEqual(ids('updated'), ['z', 'a'])
  assert.deepEqual(ids('stars'), ['a', 'z'])
  assert.deepEqual(ids('name'), ['a', 'z'])
})
