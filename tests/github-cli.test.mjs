// User-run only: node --test tests/github-cli.test.mjs
// The actual detector runs against fake command results. No real gh, Electron, credentials or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const exports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/main/github-cli.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({
  exports, process: { platform: 'win32', env: {} },
  require(name) {
    if (name === 'node:child_process') return { execFile() { throw new Error('Real processes must not run in these tests') } }
    if (name === 'node:os') return { homedir: () => '/fake-home' }
    if (name === 'node:path') return { join }
    throw new Error('Unexpected dependency: ' + name)
  }
})
const { inspectGithubCli, inspectGithubLogout } = exports
const ok = stdout => ({ ok: true, stdout, stderr: '', code: null, timedOut: false })
const failed = (code, stderr = '', timedOut = false) => ({ ok: false, stdout: '', stderr, code, timedOut })
const version = ok('gh version 2.80.0 (2025-09-23)\nhttps://github.com/cli/cli/releases\n')
const auth = (...entries) => ok(JSON.stringify({ hosts: { 'github.com': entries } }))
function fixture(result) {
  const calls = []
  return { calls, run: async (file, args) => {
    calls.push({ file, args: Array.from(args) })
    return args[0] === '--version' ? version : result
  } }
}

test('missing gh stops at installation instead of requesting authentication', async () => {
  const calls = []
  const state = await inspectGithubCli(async (file, args) => {
    calls.push([file, ...args])
    return failed('ENOENT')
  }, ['gh.exe', '/fallback/gh.exe'])
  assert.equal(state.status, 'missing')
  assert.equal(state.version, null)
  assert.equal(state.account, null)
  assert.equal(state.installCommand, 'winget install --id GitHub.cli --exact')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call[1] === '--version'))
})

test('fallback binary is used when the desktop PATH cannot locate gh', async () => {
  const calls = []
  const state = await inspectGithubCli(async (file, args) => {
    calls.push([file, ...args])
    if (file === 'gh.exe') return failed('ENOENT')
    return args[0] === '--version' ? version : auth({ active: true, state: 'success', login: 'alice' })
  }, ['gh.exe', '/fallback/gh.exe'])
  assert.equal(state.status, 'signed-in')
  assert.equal(state.version, '2.80.0')
  assert.equal(state.account, 'alice')
  assert.equal(calls[2][0], '/fallback/gh.exe')
})

test('only the active github.com account determines readiness, without exposing token fields', async () => {
  const f = fixture(auth(
    { active: false, state: 'error', login: 'inactive' },
    { active: true, state: 'success', login: 'alice', token: 'ghp_must_never_leave_main' }
  ))
  const state = await inspectGithubCli(f.run, ['gh'])
  assert.equal(state.status, 'signed-in')
  assert.equal(state.account, 'alice')
  assert.deepEqual(f.calls[1].args, ['auth', 'status', '--hostname', 'github.com', '--active', '--json', 'hosts'])
  assert.equal(JSON.stringify(state).includes('ghp_must_never_leave_main'), false)
})

test('zero exit status with invalid active credentials still requires login', async () => {
  const f = fixture(auth(
    { active: false, state: 'success', login: 'other-user' },
    { active: true, state: 'error', error: 'HTTP 401: bad credentials ghp_secret', tokenSource: 'keyring' }
  ))
  const state = await inspectGithubCli(f.run, ['gh'])
  assert.equal(state.status, 'signed-out')
  assert.equal(state.account, null)
  assert.equal(state.version, '2.80.0')
  assert.equal(JSON.stringify(state).includes('ghp_secret'), false)
})

test('no account, accounts on another host and expired credentials all guide login', async () => {
  for (const result of [ok('{"hosts":{}}'), ok('{"hosts":{"enterprise.example":[{"active":true,"state":"success","login":"other"}]}}'),
    auth(), auth({ active: true, state: 'refresh_expired' })]) {
    assert.equal((await inspectGithubCli(fixture(result).run, ['gh'])).status, 'signed-out')
  }
})

test('invalid environment credentials explain why an interactive login alone will not fix it', async () => {
  const state = await inspectGithubCli(fixture(auth({ active: true, state: 'error',
    error: 'HTTP 401', tokenSource: 'GH_TOKEN' })).run, ['gh'])
  assert.equal(state.status, 'signed-out')
  assert.match(state.message, /GH_TOKEN/)
})

test('network errors and timeouts are not misreported as logged out or missing', async () => {
  for (const result of [failed(null, '', true), failed(1, 'network unavailable'),
    auth({ active: true, state: 'timeout', error: 'network timed out' }),
    auth({ active: true, state: 'error', error: 'HTTP 503: service unavailable' })]) {
    const state = await inspectGithubCli(fixture(result).run, ['gh'])
    assert.equal(state.status, 'error')
    assert.equal(state.version, '2.80.0')
    assert.equal(state.account, null)
  }
})

test('unsupported and malformed CLI output keeps the installed state without guessing login', async () => {
  for (const result of [failed(1, 'unknown flag: --json'), ok('not JSON'), ok('{}'),
    ok('{"hosts":[]}'), ok('{"hosts":{"github.com":"unexpected"}}'), auth({ state: 'success', login: 'no-active-field' })]) {
    const state = await inspectGithubCli(fixture(result).run, ['gh'])
    assert.equal(state.status, 'error')
    assert.equal(state.version, '2.80.0')
    assert.equal(state.account, null)
  }
})

test('permission and execution failures are distinct from an absent installation', async () => {
  const state = await inspectGithubCli(async () => failed('EACCES'), ['gh'])
  assert.equal(state.status, 'error')
  assert.equal(state.version, null)
})

function logoutFixture(status, outcome = ok('Logged out')) {
  const calls = []
  return { calls, run: async (file, args) => {
    calls.push({ file, args: Array.from(args) })
    return args[0] === '--version' ? version : args[1] === 'status' ? status : outcome
  } }
}
const storedAccount = (login = 'alice') => ({ active: true, state: 'success', login, tokenSource: 'keyring' })

test('logout targets only the displayed github.com account using separate arguments', async () => {
  const f = logoutFixture(auth(storedAccount()))
  const result = await inspectGithubLogout('alice', f.run, ['gh'], {})
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls[2].args, ['auth', 'logout', '--hostname', 'github.com', '--user', 'alice'])
  assert.equal(f.calls.length, 3)
})

test('logout uses the current stored spelling when the displayed login differs only in case', async () => {
  const f = logoutFixture(auth(storedAccount('Alice')))
  assert.equal((await inspectGithubLogout('alice', f.run, ['gh'], {})).ok, true)
  assert.equal(f.calls[2].args.at(-1), 'Alice')
})

test('a changed active account cannot cause logout to remove a different account', async () => {
  const f = logoutFixture(auth(storedAccount('bob')))
  const result = await inspectGithubLogout('alice', f.run, ['gh'], {})
  assert.equal(result.ok, false)
  assert.match(result.message, /账号已变化/)
  assert.equal(f.calls.some(call => call.args[1] === 'logout'), false)
})

test('environment authentication is not reported as successfully logged out', async () => {
  for (const environment of [{ GH_TOKEN: 'ghp_not_output' }, { GITHUB_TOKEN: 'ghp_not_output' }]) {
    const f = logoutFixture(auth(storedAccount()))
    const result = await inspectGithubLogout('alice', f.run, ['gh'], environment)
    assert.equal(result.ok, false)
    assert.equal(f.calls.length, 0)
    assert.match(result.message, /环境变量/)
    assert.equal(JSON.stringify(result).includes('ghp_not_output'), false)
  }
  const f = logoutFixture(auth({ ...storedAccount(), tokenSource: 'GH_TOKEN' }))
  assert.equal((await inspectGithubLogout('alice', f.run, ['gh'], {})).ok, false)
  assert.equal(f.calls.some(call => call.args[1] === 'logout'), false)
})

test('expired stored credentials can be removed even if their auth check fails', async () => {
  const f = logoutFixture(auth({ ...storedAccount(), state: 'error', error: 'HTTP 401: bad credentials' }))
  assert.equal((await inspectGithubLogout('alice', f.run, ['gh'], {})).ok, true)
  assert.equal(f.calls.at(-1).args[1], 'logout')
})

test('an already logged out account is idempotent without running a mutation', async () => {
  const f = logoutFixture(ok('{"hosts":{}}'))
  const result = await inspectGithubLogout('alice', f.run, ['gh'], {})
  assert.equal(result.ok, true)
  assert.equal(f.calls.length, 2)
})

test('invalid account or unreadable account metadata cannot trigger a logout', async () => {
  for (const account of [null, '', '-u bob', 'alice; echo secret']) {
    const f = logoutFixture(auth(storedAccount()))
    assert.equal((await inspectGithubLogout(account, f.run, ['gh'], {})).ok, false)
    assert.equal(f.calls.length, 0)
  }
  for (const status of [ok('not JSON'), ok('{}'), auth({ ...storedAccount(), tokenSource: undefined }), failed(1)]) {
    const f = logoutFixture(status)
    assert.equal((await inspectGithubLogout('alice', f.run, ['gh'], {})).ok, false)
    assert.equal(f.calls.some(call => call.args[1] === 'logout'), false)
  }
})

test('logout failures and timeouts are reported without exposing command output', async () => {
  for (const outcome of [failed(1, 'failure with ghp_secret'), failed(null, '', true), failed(1, 'GH_TOKEN=ghp_secret')]) {
    const f = logoutFixture(auth(storedAccount()), outcome)
    const result = await inspectGithubLogout('alice', f.run, ['gh'], {})
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes('ghp_secret'), false)
  }
})
