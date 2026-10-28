// User-run offline regression: node --test tests/web2term-device-management.test.mjs
// Uses mocked requests only; never starts Electron or contacts a backend.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(output).runInNewContext({ exports, Buffer, AbortSignal, URL, fetch,
    require: (name) => {
      if (name in dependencies) return dependencies[name]
      if (name.startsWith('node:')) return {}
      throw new Error(`Unexpected import: ${name}`)
    }
  })
  return exports
}
const url = load('../src/shared/backend-url.ts')
const backendSettings = load('../src/main/backend-settings.ts', { '../shared/backend-url': url })
const { BackendAuthService } = load('../src/main/backend-auth.ts', { '../shared/backend-url': url, './backend-settings': backendSettings })
const { Web2termConnection } = load('../src/main/web2term-connection.ts', {
  '../shared/backend-url': url, ws: class {}, './web2term-terminals': { Web2termTerminals: class {} }
})
const DEVICE_ID = 'aabbccdd-1234-5678-9abc-0123456789ab'
const DEVICE_NAME = '我的 Linux 主机'
const TOKEN = 'private-test-token'

function service(request) {
  const settings = new Map([
    ['forceDefaultBackendUrl', 'false'],
    ['backendUrl', 'https://example.invalid/deployment'],
    ['backendAuth', JSON.stringify({ backendUrl: 'https://example.invalid/deployment', accessToken: TOKEN,
      tokenType: 'Bearer', expiresAt: '2030-01-01T00:00:00.000Z',
      user: { publicId: 'owner', email: 'owner@example.invalid', nickname: 'Owner', role: 'USER', avatarUrl: null } })]
  ])
  const logs = []
  const auth = new BackendAuthService({ getSetting: (key) => settings.get(key), setSettings: (patch) => {
    for (const [key, value] of Object.entries(patch)) settings.set(key, value)
  } }, { encrypt: (value) => value, decrypt: (value) => value, onBackendUrlSaved() {}, request,
    now: () => Date.parse('2026-10-20T00:00:00.000Z'), log: { path: null, write: (record) => logs.push(record) } })
  return { auth, settings, logs }
}

test('desktop with forced overrides disabled uses its default only for first use and preserves custom or cleared addresses', () => {
  const { auth, settings } = service(async () => { throw new Error('no request expected') })
  settings.delete('backendUrl')
  assert.equal(auth.getState().backendUrl, 'https://web2term.kangnasi.xyz')
  assert.equal(auth.getState().status, 'signed-out') // Saved credentials belong to another backend.
  assert.equal(auth.getConnectionCredentials(), null)
  settings.set('backendUrl', 'https://example.invalid/deployment')
  assert.equal(auth.getState().status, 'signed-in')
  settings.set('backendUrl', '')
  assert.equal(auth.getState().backendUrl, '')
  assert.equal(auth.getConnectionCredentials(), null)
})

test('clearing a first-use default persists an explicit empty backend', () => {
  const { auth, settings } = service(async () => { throw new Error('no request expected') })
  settings.delete('backendUrl')
  auth.setBackendUrl('')
  assert.equal(settings.get('backendUrl'), '')
  assert.equal(settings.get('backendAuth'), '')
  assert.equal(auth.getState().backendUrl, '')
})

test('rename uses authenticated PATCH, preserves deployment path and returns normalized name', async () => {
  let calls = 0
  const { auth, logs } = service(async (address, options) => {
    calls++
    assert.equal(address, `https://example.invalid/deployment/api/user/devices/${DEVICE_ID}`)
    assert.equal(options.method, 'PATCH')
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(options.redirect, 'manual')
    assert.deepEqual(JSON.parse(options.body), { deviceName: DEVICE_NAME })
    return new Response(null, { status: 204 })
  })
  const result = await auth.renameDevice({ deviceId: DEVICE_ID.toUpperCase(), deviceName: `  ${DEVICE_NAME}  ` })
  assert.equal(result.ok, true)
  assert.equal(result.value.deviceId, DEVICE_ID)
  assert.equal(result.value.deviceName, DEVICE_NAME)
  assert.equal(calls, 1)
  const serialized = JSON.stringify(logs)
  assert.ok(serialized.includes('device_rename_success'))
  for (const secret of [TOKEN, DEVICE_NAME, 'owner@example.invalid']) assert.ok(!serialized.includes(secret))
})

test('invalid IDs, blank/long/control-character names and signed-out users never issue a request', async () => {
  let calls = 0
  const { auth, settings } = service(async () => { calls++; throw new Error('should not request') })
  for (const draft of [null, { deviceId: '../other', deviceName: 'name' },
    ...[' ', 'x'.repeat(101), 'first\nsecond', 'name\u0000'].map((deviceName) => ({ deviceId: DEVICE_ID, deviceName }))]) {
    assert.equal((await auth.renameDevice(draft)).ok, false)
  }
  settings.delete('backendAuth')
  assert.equal((await auth.renameDevice({ deviceId: DEVICE_ID, deviceName: DEVICE_NAME })).ok, false)
  assert.equal(calls, 0)
})

test('rejected, outdated, throttled, redirected and unavailable backends return actionable errors', async () => {
  const categories = new Map([[400, '名称'], [401, '登录'], [403, '权限'], [404, '后端'], [405, '更新'], [429, '频繁'], [302, '重定向'], [503, '异常']])
  for (const [status, word] of categories) {
    const { auth } = service(async () => new Response('private response', { status }))
    const result = await auth.renameDevice({ deviceId: DEVICE_ID, deviceName: DEVICE_NAME })
    assert.equal(result.ok, false)
    assert.ok(result.message.includes(word), `status ${status}: ${result.message}`)
    assert.ok(!result.message.includes('private response'))
  }
})

test('a response for a previous account/server is never applied to the new identity', async () => {
  let finish
  const response = new Promise((resolve) => { finish = resolve })
  const { auth } = service(() => response)
  const pending = auth.renameDevice({ deviceId: DEVICE_ID, deviceName: DEVICE_NAME })
  auth.setBackendUrl('https://other.invalid')
  finish(new Response(null, { status: 204 }))
  const result = await pending
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('登录状态已变化'))
})

test('device list retains both online and offline device status', async () => {
  const { auth } = service(async () => new Response(JSON.stringify([
    { deviceId: DEVICE_ID, deviceName: DEVICE_NAME, enabled: 1, onlineStatus: 1 },
    { deviceId: '00000000-1234-5678-9abc-0123456789ab', deviceName: 'Offline', enabled: 0, onlineStatus: 0 }
  ]), { status: 200 }))
  const result = await auth.listDevices()
  assert.equal(result.ok, true)
  assert.equal(result.value.length, 2)
  assert.equal(result.value[0].onlineStatus, 1)
  assert.equal(result.value[1].onlineStatus, 0)
  assert.equal(result.value[1].enabled, 0)
})

test('renaming a connected device refreshes its cached label without replacing its transport', () => {
  const { auth, settings } = service(async () => { throw new Error('no request expected') })
  settings.set('web2termTargetAgent', JSON.stringify({ backendUrl: auth.getState().backendUrl,
    publicId: 'owner', agentId: DEVICE_ID, deviceName: 'Old name' }))
  const changes = []
  const connection = new Web2termConnection({ getSetting: (key) => settings.get(key), setSettings: (patch) => {
    for (const [key, value] of Object.entries(patch)) settings.set(key, value)
  } }, auth, { changed: (state) => changes.push(state), schedule() {}, unschedule() {}, log: { path: null, write() {} } })
  const socket = {}
  connection.socket = socket
  connection.agentId = DEVICE_ID
  connection.deviceName = 'Old name'
  connection.status = 'connected'
  connection.updateDeviceName(DEVICE_ID, DEVICE_NAME)
  assert.equal(connection.socket, socket)
  assert.equal(connection.getState().status, 'connected')
  assert.equal(connection.getState().deviceName, DEVICE_NAME)
  assert.equal(JSON.parse(settings.get('web2termTargetAgent')).deviceName, DEVICE_NAME)
  assert.equal(changes.length, 1)
  connection.updateDeviceName('00000000-1234-5678-9abc-0123456789ab', 'Other device')
  assert.equal(connection.getState().deviceName, DEVICE_NAME)
  assert.equal(changes.length, 1)
})
