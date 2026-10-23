// User-run only: node --test tests/github-login-task.test.mjs
// No Electron, real browser, gh, credentials or network. The sender and CLI lookup are fakes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/github.ts')
const { dispatchGithubLoginTask } = load('../src/main/github-login-task.ts', { '../shared/github': shared })
const cli = (status = 'signed-out') => ({ status, version: '2.96.0', account: status === 'signed-in' ? 'alice' : null,
  installCommand: null, message: 'Fake prerequisite state: ' + status })
function fixture(overrides = {}) {
  const calls = { inspect: 0, tasks: [] }
  return { calls, deps: {
    blockedReason: () => null,
    inspect: async () => { calls.inspect++; return cli() },
    send: async text => { calls.tasks.push(text); return 'ok' },
    ...overrides
  } }
}

test('an installed, signed-out CLI sends one login task through the existing sender', async () => {
  const f = fixture()
  assert.equal((await dispatchGithubLoginTask(f.deps)).status, 'sent')
  assert.equal(f.calls.inspect, 1)
  assert.equal(f.calls.tasks.length, 1)
  assert.match(f.calls.tasks[0], /gh auth login --hostname github\.com --web/)
  assert.match(f.calls.tasks[0], /background_task/)
  assert.match(f.calls.tasks[0], /一次性设备码/)
  assert.match(f.calls.tasks[0], /state=success/)
})

test('a newly signed-in account refreshes the pane without sending another authorization task', async () => {
  const f = fixture({ inspect: async () => cli('signed-in') })
  assert.equal((await dispatchGithubLoginTask(f.deps)).status, 'already-signed-in')
  assert.equal(f.calls.tasks.length, 0)
})

test('missing CLI and ambiguous auth failures cannot send a misleading login task', async () => {
  for (const status of ['missing', 'error']) {
    const f = fixture({ inspect: async () => cli(status) })
    const result = await dispatchGithubLoginTask(f.deps)
    assert.equal(result.status, 'blocked')
    assert.equal(result.message, cli(status).message)
    assert.equal(f.calls.tasks.length, 0)
  }
})

test('remote target, busy task or disabled automation blocks before checking or sending', async () => {
  for (const reason of ['SSH attached', 'AI busy', 'Terminal mode disabled']) {
    const f = fixture({ blockedReason: () => reason })
    const result = await dispatchGithubLoginTask(f.deps)
    assert.equal(result.status, 'blocked')
    assert.equal(result.message, reason)
    assert.equal(f.calls.inspect, 0)
    assert.equal(f.calls.tasks.length, 0)
  }
})

test('a chat or host switch during the asynchronous lookup prevents delivery', async () => {
  let current = true
  const f = fixture({ blockedReason: () => current ? null : 'Chat changed',
    inspect: async () => { current = false; return cli() } })
  const result = await dispatchGithubLoginTask(f.deps)
  assert.equal(result.status, 'blocked')
  assert.equal(result.message, 'Chat changed')
  assert.equal(f.calls.tasks.length, 0)
})

test('a failed prerequisite lookup stops without forwarding diagnostic details', async () => {
  const f = fixture({ inspect: async () => { throw new Error('ghp_private_details') } })
  const result = await dispatchGithubLoginTask(f.deps)
  assert.equal(result.status, 'blocked')
  assert.equal(JSON.stringify(result).includes('ghp_private_details'), false)
  assert.equal(f.calls.tasks.length, 0)
})

test('draft and page readiness guards are shown as blocked rather than a successful send', async () => {
  for (const outcome of ['busy', 'no-composer', 'insert-failed', 'unavailable', 'cancelled']) {
    let sends = 0
    const f = fixture({ send: async () => { sends++; return outcome } })
    assert.equal((await dispatchGithubLoginTask(f.deps)).status, 'blocked')
    assert.equal(sends, 1)
  }
})

test('unconfirmed submission or a lost transport result never triggers an automatic retry', async () => {
  for (const outcome of ['stuck', 'unknown', 'throw']) {
    let sends = 0
    const f = fixture({ send: async () => {
      sends++
      if (outcome === 'throw') throw new Error('ghp_private_details')
      return outcome
    } })
    const result = await dispatchGithubLoginTask(f.deps)
    assert.equal(result.status, 'uncertain')
    assert.equal(sends, 1)
    assert.equal(JSON.stringify(result).includes('ghp_private_details'), false)
  }
})
