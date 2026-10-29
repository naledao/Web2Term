// User-run only: node --test tests/software-proxy.test.mjs
// Mocked Electron sessions and sockets; no application, real settings or network access.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText).runInNewContext({ exports, URL, require(name) {
    if (name in dependencies) return dependencies[name]
    throw new Error(`Unexpected dependency: ${name}`)
  } })
  return exports
}
const policy = load('../src/shared/software-proxy.ts')
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(hooks = {}) {
  const routes = [], requests = [], sockets = [], partitions = []
  let closed = 0
  const softwareSession = {
    async setProxy(value) { routes.push(plain(value)); await hooks.setProxy?.(value) },
    async closeAllConnections() { closed++ },
    async fetch(input, init) { requests.push({ input, init }); return new Response('{}') }
  }
  class Socket {
    constructor(url, options) { this.url = url; this.options = options; sockets.push(this) }
  }
  class Agent { constructor(proxy) { this.proxy = proxy } }
  const network = load('../src/main/software-network.ts', {
    electron: { session: { fromPartition(partition) { partitions.push(partition); return softwareSession } } },
    ws: { __esModule: true, default: Socket },
    'https-proxy-agent': { HttpsProxyAgent: Agent },
    '../shared/software-proxy': policy
  })
  return { network, routes, requests, sockets, partitions, get closed() { return closed } }
}

test('new installations use the default, while custom and cleared settings survive restart', () => {
  assert.equal(policy.DEFAULT_SOFTWARE_PROXY, 'http://127.0.0.1:7897')
  assert.equal(policy.readSoftwareProxy(null), policy.DEFAULT_SOFTWARE_PROXY)
  assert.equal(policy.readSoftwareProxy(undefined), policy.DEFAULT_SOFTWARE_PROXY)
  assert.equal(policy.readSoftwareProxy(''), '')
  assert.equal(policy.readSoftwareProxy('http://proxy.example.invalid:8080'), 'http://proxy.example.invalid:8080')
  assert.equal(policy.normalizeSoftwareProxy(' 127.0.0.1:7897 '), policy.DEFAULT_SOFTWARE_PROXY)
  assert.equal(policy.normalizeSoftwareProxy('https://[::1]:7897/'), 'https://[::1]:7897')
  for (const value of [42, null, 'socks5://localhost:1080', 'http://user:secret@localhost:7897',
    'http://localhost:0', 'http://localhost:99999', 'http://localhost/path', 'http://localhost?x=1',
    'http://localhost#fragment', 'http://local host:7897', 'http://localhost\\path']) {
    assert.throws(() => policy.normalizeSoftwareProxy(value))
  }
})

test('backend HTTP waits for proxy configuration and keeps credentials out of the isolated session', async () => {
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const applying = new Promise(resolve => { started = resolve })
  const f = fixture({ async setProxy() { started(); await gate } })
  await assert.rejects(f.network.softwareFetch('https://example.invalid'), /尚未初始化/u)
  const ready = f.network.applySoftwareProxy(policy.DEFAULT_SOFTWARE_PROXY)
  await applying
  const controller = new AbortController()
  const headers = { Authorization: 'Bearer synthetic-token' }
  const pending = f.network.softwareFetch(new URL('https://example.invalid/api'), {
    method: 'POST', body: '{}', headers, redirect: 'manual', signal: controller.signal, credentials: 'include'
  })
  assert.equal(f.requests.length, 0)
  release()
  await ready
  await pending
  assert.deepEqual(f.routes, [{ mode: 'fixed_servers', proxyRules: policy.DEFAULT_SOFTWARE_PROXY }])
  assert.equal(f.closed, 1)
  assert.ok(f.partitions.every(value => value === 'software-network'))
  const request = f.requests[0]
  assert.equal(request.input, 'https://example.invalid/api')
  assert.equal(request.init.credentials, 'omit')
  assert.equal(request.init.cache, 'no-store')
  assert.equal(request.init.headers, headers)
  assert.equal(request.init.redirect, 'manual')
  assert.equal(request.init.signal, controller.signal)
  assert.equal(request.init.body, '{}')
})

test('proxy changes route the next device handshake and clearing selects direct without closing existing sockets', async () => {
  const f = fixture()
  const options = { headers: { Authorization: 'Bearer synthetic-token' }, followRedirects: false, handshakeTimeout: 10000 }
  assert.throws(() => f.network.createSoftwareSocket('wss://example.invalid', options), /尚未初始化/u)
  await f.network.applySoftwareProxy(policy.DEFAULT_SOFTWARE_PROXY)
  const first = f.network.createSoftwareSocket('wss://example.invalid/ws/desktop', options)
  assert.equal(first.options.agent.proxy, policy.DEFAULT_SOFTWARE_PROXY)
  assert.equal(first.options.headers, options.headers)
  assert.equal(first.options.followRedirects, false)
  assert.equal(first.options.handshakeTimeout, 10000)
  await f.network.applySoftwareProxy('https://proxy.example.invalid:8443')
  const second = f.network.createSoftwareSocket('ws://example.invalid/ws/desktop', options)
  assert.equal(second.options.agent.proxy, 'https://proxy.example.invalid:8443')
  assert.equal(first.options.agent.proxy, policy.DEFAULT_SOFTWARE_PROXY)
  await f.network.applySoftwareProxy('')
  assert.deepEqual(f.routes.at(-1), { mode: 'direct' })
  assert.equal(f.network.createSoftwareSocket('wss://example.invalid/ws/desktop', options).options.agent, undefined)
})

test('a failed configuration cannot send HTTP through a different route and a later save can recover', async () => {
  let fail = true
  const f = fixture({ setProxy() { if (fail) throw new Error('synthetic configuration failure') } })
  await assert.rejects(f.network.applySoftwareProxy(policy.DEFAULT_SOFTWARE_PROXY), /synthetic/u)
  await assert.rejects(f.network.softwareFetch('https://example.invalid'), /synthetic/u)
  assert.equal(f.requests.length, 0)
  fail = false
  await f.network.applySoftwareProxy('')
  await f.network.softwareFetch('https://example.invalid')
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.routes.at(-1), { mode: 'direct' })
})

test('settings validate before side effects, persist the normalized route and invalidate old release requests', async () => {
  const file = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let handler
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'ipcMain.handle' &&
      node.arguments[0]?.getText(file) === 'IpcChannels.settingsUpdate') handler = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(handler)
  const effects = [], frame = {}, event = { senderFrame: frame, sender: { mainFrame: frame } }
  const context = {
    settings: { softwareProxy: '' }, SETTING_SOFTWARE_PROXY: 'softwareProxy',
    isManagerEvent: value => value === event,
    store: { setSetting(key, value) { effects.push(['saved', key, value]) } },
    parseComputerUsePreferencesPatch: () => ({}), resolveBackendSettingsPatch: () => ({}),
    normalizeSoftwareProxy: policy.normalizeSoftwareProxy,
    async applySoftwareProxy(value) { effects.push(['applied', value]) },
    invalidateReleaseNotes() { effects.push(['invalidated']) }
  }
  const callback = new Script(ts.transpileModule(`(${handler.getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext(context)
  await assert.rejects(callback(event, { softwareProxy: 'socks5://localhost:1080', theme: 'dark' }))
  assert.deepEqual(effects, [])
  const next = await callback(event, { softwareProxy: '127.0.0.1:7897' })
  assert.equal(next.softwareProxy, policy.DEFAULT_SOFTWARE_PROXY)
  assert.deepEqual(effects, [
    ['applied', policy.DEFAULT_SOFTWARE_PROXY], ['saved', 'softwareProxy', policy.DEFAULT_SOFTWARE_PROXY], ['invalidated']
  ])
})
