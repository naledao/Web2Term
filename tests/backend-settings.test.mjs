// User-run only: node --test tests/backend-settings.test.mjs
// In-memory settings and mocked HTTP; never starts Electron or uses real credentials.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText).runInNewContext({ exports, Buffer, URL, AbortSignal, fetch, require(name) {
    if (name in dependencies) return dependencies[name]
    if (name.startsWith('node:')) return {}
    throw new Error(`Unexpected import: ${name}`)
  } })
  return exports
}
const urls = load('../src/shared/backend-url.ts')
const policy = load('../src/main/backend-settings.ts', { '../shared/backend-url': urls })
const { BackendAuthService } = load('../src/main/backend-auth.ts', { '../shared/backend-url': urls, './backend-settings': policy })
const DEFAULT = 'https://web2term.kangnasi.xyz'
const CUSTOM = 'https://custom.example.invalid/backend'
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(values = {}) {
  const data = new Map(Object.entries(values)), batches = []
  const store = {
    getSetting: key => data.get(key),
    setSettings(patch) { batches.push({ ...patch }); for (const [key, value] of Object.entries(patch)) data.set(key, value) }
  }
  return { data, batches, store }
}

test('existing manual addresses and explicitly cleared addresses migrate to the default unless opted out', () => {
  for (const old of ['http://frp.kangnasi.xyz:8082', CUSTOM, '', 'corrupt address']) {
    const f = fixture({ backendUrl: old, backendAuth: 'old-backend-secret' })
    assert.deepEqual(plain(policy.saveBackendSettings(f.store)), { backendUrl: DEFAULT, forceDefaultBackendUrl: true })
    assert.equal(f.data.get('backendUrl'), DEFAULT)
    assert.equal(f.data.get('forceDefaultBackendUrl'), 'true')
    assert.equal(f.data.get('backendAuth'), '')
    assert.equal(f.batches.length, 1)
    assert.equal(f.batches[0].backendAuth, '') // Address and secret change in one store transaction.
  }
  const fresh = fixture()
  assert.equal(policy.saveBackendSettings(fresh.store).backendUrl, DEFAULT)
  assert.equal(fresh.data.get('forceDefaultBackendUrl'), 'true')
})

test('a valid default-backend session survives repeated startup and same-address policy changes', () => {
  const f = fixture({ backendUrl: DEFAULT, backendAuth: 'keep-default-secret' })
  policy.saveBackendSettings(f.store)
  policy.saveBackendSettings(f.store)
  policy.saveBackendSettings(f.store, { forceDefaultBackendUrl: false })
  policy.saveBackendSettings(f.store, { forceDefaultBackendUrl: true })
  assert.equal(f.data.get('backendAuth'), 'keep-default-secret')
  assert.equal(f.data.get('backendUrl'), DEFAULT)
})

test('opting out persists across startup and allows custom and explicitly empty addresses', () => {
  const f = fixture({ backendUrl: DEFAULT })
  policy.saveBackendSettings(f.store, { forceDefaultBackendUrl: false, backendUrl: CUSTOM })
  assert.deepEqual(plain(policy.saveBackendSettings(f.store)), { backendUrl: CUSTOM, forceDefaultBackendUrl: false })
  assert.equal(f.data.get('forceDefaultBackendUrl'), 'false')
  policy.saveBackendSettings(f.store, { backendUrl: '' })
  assert.equal(policy.saveBackendSettings(f.store).backendUrl, '')
  assert.equal(f.data.get('forceDefaultBackendUrl'), 'false')
  policy.saveBackendSettings(f.store, { forceDefaultBackendUrl: true, backendUrl: CUSTOM })
  assert.equal(f.data.get('backendUrl'), DEFAULT)
  assert.equal(f.data.get('forceDefaultBackendUrl'), 'true')
})

test('forced mode ignores custom URL patches while invalid policy and custom-mode URLs cannot partly save', () => {
  const f = fixture({ backendUrl: DEFAULT, forceDefaultBackendUrl: 'true' })
  policy.saveBackendSettings(f.store, { backendUrl: CUSTOM })
  assert.equal(f.data.get('backendUrl'), DEFAULT)
  policy.saveBackendSettings(f.store, { backendUrl: '' })
  assert.equal(f.data.get('backendUrl'), DEFAULT)
  const before = [...f.data], count = f.batches.length
  assert.throws(() => policy.saveBackendSettings(f.store, { forceDefaultBackendUrl: 'false' }), /选项/)
  assert.throws(() => policy.saveBackendSettings(f.store, { forceDefaultBackendUrl: false, backendUrl: 'javascript:alert(1)' }))
  assert.deepEqual([...f.data], before)
  assert.equal(f.batches.length, count)
})

const user = { publicId: 'user', email: 'user@example.invalid', nickname: 'User', role: 'USER', avatarUrl: null }
function loginResponse() {
  return new Response(JSON.stringify({ accessToken: 'new-test-token', tokenType: 'Bearer', expiresInSeconds: 3600, user }), { status: 200 })
}
function authFixture(f, request) {
  const changes = [], connections = [], encryptions = []
  const auth = new BackendAuthService(f.store, {
    request, now: () => Date.parse('2026-10-28T00:00:00Z'),
    encrypt(value) { encryptions.push(value); return value }, decrypt: value => value,
    onBackendUrlSaved: value => changes.push(value), onLoginChanged: () => connections.push('changed'),
    log: { path: null, write() {} }
  })
  return { auth, changes, connections, encryptions }
}

test('forced mode rejects custom login and code requests before sending and allows login after saved opt-out', async () => {
  const f = fixture({ backendUrl: DEFAULT })
  let requests = 0
  const { auth } = authFixture(f, async () => { requests++; return loginResponse() })
  const input = { backendUrl: CUSTOM, email: user.email, code: '123456' }
  assert.equal((await auth.sendCode(input)).ok, false)
  assert.equal((await auth.login(input)).ok, false)
  assert.equal(requests, 0)
  auth.updateBackendSettings({ forceDefaultBackendUrl: false, backendUrl: CUSTOM })
  assert.equal((await auth.login(input)).ok, true)
  assert.equal(requests, 1)
  assert.equal(auth.getState().backendUrl, CUSTOM)
  assert.equal(auth.getState().status, 'signed-in')
})

test('switching from custom backend to forced default clears the old login and notifies dependents', () => {
  const secret = JSON.stringify({ backendUrl: CUSTOM, accessToken: 'old-test-token', tokenType: 'Bearer', expiresAt: '2030-01-01T00:00:00Z', user })
  const f = fixture({ backendUrl: CUSTOM, forceDefaultBackendUrl: 'false', backendAuth: secret })
  const a = authFixture(f, async () => { throw new Error('no request expected') })
  assert.equal(a.auth.getState().status, 'signed-in')
  a.auth.updateBackendSettings({ forceDefaultBackendUrl: true })
  assert.equal(f.data.get('backendAuth'), '')
  assert.equal(a.auth.getState().backendUrl, DEFAULT)
  assert.equal(a.auth.getState().status, 'signed-out')
  assert.equal(a.auth.getConnectionCredentials(), null)
  assert.deepEqual(a.changes, [DEFAULT])
  assert.equal(a.connections.length, 1)
})

test('enabling forced mode cancels a pending custom login even when the saved URL does not change', async () => {
  const f = fixture({ backendUrl: DEFAULT, forceDefaultBackendUrl: 'false', backendAuth: 'keep-existing-default-secret' })
  let finish
  const a = authFixture(f, () => new Promise(resolve => { finish = resolve }))
  const pending = a.auth.login({ backendUrl: CUSTOM, email: user.email, code: '123456' })
  a.auth.updateBackendSettings({ forceDefaultBackendUrl: true })
  finish(loginResponse())
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(f.data.get('backendUrl'), DEFAULT)
  assert.equal(f.data.get('backendAuth'), 'keep-existing-default-secret')
  assert.equal(a.encryptions.length, 0)
  assert.equal(a.connections.length, 0)
})

test('a directly changed force preference cannot let an old custom login overwrite the default', async () => {
  const f = fixture({ backendUrl: DEFAULT, forceDefaultBackendUrl: 'false' })
  let finish
  const a = authFixture(f, () => new Promise(resolve => { finish = resolve }))
  const pending = a.auth.login({ backendUrl: CUSTOM, email: user.email, code: '123456' })
  f.data.set('forceDefaultBackendUrl', 'true')
  finish(loginResponse())
  assert.equal((await pending).ok, false)
  assert.equal(f.data.get('backendUrl'), DEFAULT)
  assert.equal(a.encryptions.length, 0)
})
