// User-run only: node --test tests/remote-ripgrep.test.mjs tests/web2term-environment.test.mjs
// Actual state machine, prompt and runtime methods with fake remote connections and AI pages.
// No Electron, shell, package manager, SSH login, AI message or network is started.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/remote-ripgrep.ts')
const { RemoteRipgrepSetup } = load('../src/main/remote-ripgrep.ts', { 'node:crypto': { randomUUID } })
const target = { transport: 'ssh', hostId: 'host-a', name: 'Server A', target: 'server-a.invalid:22' }
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const events = [], setup = new RemoteRipgrepSetup(state => events.push(state)), key = {}
  setup.observe(key, target)
  const id = setup.getState().connectionId
  return { setup, events, key, id }
}

test('new connections start unknown; available and unknown never claim that rg is missing', () => {
  const f = fixture()
  assert.equal(f.setup.getState().availability, 'unknown')
  f.setup.update(f.id, 'available')
  assert.equal(f.setup.getState().availability, 'available')
  f.setup.update(f.id, 'unknown')
  assert.equal(f.setup.getState().availability, 'unknown')
})

test('declining once lasts through cwd changes, output and command-channel reopens on the same connection', () => {
  const f = fixture()
  f.setup.update(f.id, 'missing')
  assert.equal(f.setup.dismiss(f.id), true)
  f.setup.observe(f.key, target)
  f.setup.update(f.id, 'missing')
  assert.equal(f.setup.getState().prompt, 'dismissed')
  assert.equal(f.setup.getState().connectionId, f.id)
  f.setup.observe({}, target)
  assert.notEqual(f.setup.getState().connectionId, f.id)
  assert.equal(f.setup.getState().prompt, 'pending')
  assert.equal(f.setup.getState().availability, 'unknown')
})

test('disconnect and a different connection reject stale probe results and old approvals', async () => {
  const f = fixture()
  f.setup.update(f.id, 'missing')
  f.setup.observe(null)
  assert.equal(f.setup.getState(), null)
  f.setup.observe({}, { ...target, hostId: 'host-b' })
  f.setup.update(f.id, 'missing')
  assert.equal(f.setup.getState().availability, 'unknown')
  assert.equal(f.setup.dismiss(f.id), false)
  const result = await f.setup.request(f.id, () => assert.fail('must not send to another host'))
  assert.equal(result.status, 'blocked')
})

test('concurrent confirmation and repeated clicks dispatch exactly one AI task', async () => {
  const f = fixture()
  f.setup.update(f.id, 'missing')
  let resolve, calls = 0
  const first = f.setup.request(f.id, () => { calls++; return new Promise(done => { resolve = done }) })
  assert.equal(f.setup.getState().prompt, 'sending')
  assert.equal(f.setup.dismiss(f.id), false)
  assert.equal((await f.setup.request(f.id, () => { calls++; return 'ok' })).status, 'blocked')
  resolve('ok')
  assert.equal((await first).status, 'sent')
  assert.equal(f.setup.getState().prompt, 'requested')
  assert.equal(f.setup.getState().availability, 'missing', 'sending is not installation success')
  f.setup.update(f.id, 'available')
  assert.equal(f.setup.getState().availability, 'available')
  assert.equal(calls, 1)
})

test('busy AI leaves the choice pending; an uncertain send never enables another automatic dispatch', async () => {
  const f = fixture()
  f.setup.update(f.id, 'missing')
  assert.equal((await f.setup.request(f.id, async () => 'busy')).status, 'blocked')
  assert.equal(f.setup.getState().prompt, 'pending')
  assert.equal((await f.setup.request(f.id, async () => 'stuck')).status, 'uncertain')
  assert.equal(f.setup.getState().prompt, 'uncertain')
  assert.equal((await f.setup.request(f.id, () => assert.fail('must not duplicate uncertain send'))).status, 'blocked')
})

test('late send outcomes cannot change the next connection or its consent', async () => {
  const f = fixture()
  f.setup.update(f.id, 'missing')
  let resolve
  const pending = f.setup.request(f.id, () => new Promise(done => { resolve = done }))
  f.setup.observe({}, { ...target, hostId: 'host-b' })
  const next = plain(f.setup.getState())
  resolve('ok')
  assert.equal((await pending).status, 'uncertain')
  assert.deepEqual(plain(f.setup.getState()), next)
})

test('installation instructions identify the remote, forbid local installation and require actual version verification', () => {
  const text = shared.remoteRipgrepInstallPrompt(target, 'Linux', 'aarch64')
  for (const expected of ['server-a.invalid:22', 'aarch64', '不要在本机安装', 'command -v rg && rg --version', '官方校验', 'PATH']) assert.ok(text.includes(expected))
  assert.ok(!text.includes('curl | sh'))
  for (const invalid of [null, {}, { sessionId: 's', platformId: 'deepseek', conversationId: null, connectionId: 9 }]) assert.equal(shared.validRemoteRipgrepRequest(invalid), false)
})

const path = '../src/main/session-runtime.ts'
const ast = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const names = ['syncRemoteRipgrep', 'getRemoteRipgrepState', 'dismissRemoteRipgrep', 'requestRemoteRipgrepInstall', 'refreshRemoteRipgrep']
const body = names.map(name => cls.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
const Runtime = new Script(compile(`class Runtime { ${body} }; Runtime`)).runInNewContext(shared)
function runtimeFixture() {
  const sends = [], runtime = new Runtime(), connection = {}, setup = new RemoteRipgrepSetup(() => {})
  const sshState = { status: 'connected', hostId: target.hostId, name: target.name, target: target.target }
  Object.assign(runtime, {
    id: 'session-a', disposed: false, active: true, activePlatformId: 'deepseek', remoteRipgrep: setup,
    ssh: { connectionKey: connection, getState: () => sshState }, remoteShell: { alive: true },
    runner: { hasInFlightWork: () => false }, taskRunning: () => false,
    embed: { getState: () => ({ conversationId: 'conversation-a' }),
      getInterceptorStatus: () => ({ installed: true, enabled: true, promptInjectionEnabled: true }),
      sendUserTask: async text => { sends.push(text); return 'ok' } },
    environment: { osCaption: 'Linux', architecture: 'x86_64' }, options: {}
  })
  const state = runtime.getRemoteRipgrepState()
  setup.update(state.connectionId, 'missing')
  const request = { sessionId: runtime.id, platformId: runtime.activePlatformId, conversationId: 'conversation-a', connectionId: state.connectionId }
  return { runtime, setup, sends, request, sshState }
}

test('runtime dispatches through the existing AI user-message pipeline only after matching connection consent', async () => {
  const f = runtimeFixture()
  assert.equal((await f.runtime.requestRemoteRipgrepInstall(f.request)).status, 'sent')
  assert.equal(f.sends.length, 1)
  assert.ok(f.sends[0].includes(target.target))
  assert.equal(f.runtime.focusSending, false)
})

test('stale session, model, conversation, connection and a local/disconnected terminal never receive an installation task', async () => {
  for (const patch of [{ sessionId: 'other' }, { platformId: 'chatgpt' }, { conversationId: 'other' }, { connectionId: 'other' }]) {
    const f = runtimeFixture()
    assert.equal((await f.runtime.requestRemoteRipgrepInstall({ ...f.request, ...patch })).status, 'blocked')
    assert.equal(f.sends.length, 0)
  }
  for (const change of [f => { f.runtime.active = false }, f => { f.runtime.remoteShell = null }, f => { f.sshState.status = 'disconnected' }]) {
    const f = runtimeFixture(); change(f)
    assert.equal((await f.runtime.requestRemoteRipgrepInstall(f.request)).status, 'blocked')
    assert.equal(f.sends.length, 0)
  }
})

test('busy tasks and disabled terminal mode keep the recommendation pending without interrupting current work', async () => {
  for (const change of [f => { f.runtime.taskRunning = () => true }, f => { f.runtime.runner.hasInFlightWork = () => true },
    f => { f.runtime.embed.getInterceptorStatus = () => ({ installed: true, enabled: false, promptInjectionEnabled: true }) }]) {
    const f = runtimeFixture(); change(f)
    assert.equal((await f.runtime.requestRemoteRipgrepInstall(f.request)).status, 'blocked')
    assert.equal(f.sends.length, 0)
    assert.equal(f.setup.getState().prompt, 'pending')
  }
})

test('device terminals have their own connection checks, and verification waits for a free remote shell', async () => {
  const f = runtimeFixture()
  f.runtime.web2term = { alive: true, connectionKey: {}, hostId: 'device-a', binding: { deviceName: 'Device A', agentId: 'agent-a' } }
  const state = f.runtime.getRemoteRipgrepState()
  assert.equal(state.transport, 'web2term')
  assert.notEqual(state.connectionId, f.request.connectionId)
  assert.equal(state.availability, 'unknown')
  let probes = 0
  f.runtime.probeEnvironment = async () => { probes++ }
  f.runtime.runner.hasInFlightWork = () => true
  f.runtime.refreshRemoteRipgrep()
  assert.equal(probes, 0)
  f.runtime.runner.hasInFlightWork = () => false
  f.runtime.refreshRemoteRipgrep()
  await Promise.resolve()
  assert.equal(probes, 1)
})
