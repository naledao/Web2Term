// User-run offline regressions: node --test tests/ssh-reconnect.test.mjs
// Fake SSH clients, channels and timers only; no Electron, processes or network.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const plain = value => JSON.parse(JSON.stringify(value))
const source = readFileSync(new URL('../src/main/ssh.ts', import.meta.url), 'utf8')
const target = { hostId: 'host-a', name: '测试主机', host: 'example.invalid', port: 2222,
  username: 'tester', password: 'memory-only-password', proxy: '' }
const forbidden = () => assert.fail('real I/O is forbidden')

function fixture(t) {
  const clients = [], timers = new Map()
  let timerId = 0
  class Channel extends EventEmitter {
    stderr = new EventEmitter()
    writes = []
    write(text) { this.writes.push(text) }
    close() { this.emit('close') }
  }
  class Client extends EventEmitter {
    pty = new Channel()
    execCommands = []
    ended = false
    constructor() { super(); clients.push(this) }
    connect(options) { this.options = plain(options) }
    shell(_options, callback) { callback(null, this.pty) }
    exec(command, callback) { this.execCommands.push(command); callback(null, new Channel()) }
    end() { this.ended = true; this.emit('close') }
  }
  class RemoteShell {
    alive = true
    cwd = '/home/tester'
    run() { return Promise.resolve({ output: '/home/tester\n' }) }
    noteCwd(cwd) { this.cwd = cwd }
    dispose(stopRunning) { this.alive = false; this.stopRunning = Boolean(this.stopRunning || stopRunning) }
  }
  const dependencies = {
    ssh2: { Client }, 'node:crypto': crypto, 'node:path': path,
    'node:fs/promises': { stat: forbidden, unlink: forbidden },
    'node:http': { request: forbidden }, 'node:https': { request: forbidden },
    './remote-shell': { RemoteShell, REMOTE_SHELL_COMMAND: 'fixture-shell' },
    './ssh-command-stop': { stopSshCommand: forbidden },
    './git-diagnostic': { writeGitDiagnostic() {} },
    './ssh-pdf-preview': { SshPdfPreviewReader: class { cancel() {} } },
    '../shared/ssh-directory': { sshWorkingDirectory: state => state.modelCwd || state.ptyCwd }
  }
  const exports = {}
  new Script(compile(source)).runInNewContext({
    exports, Buffer, Error, URL, performance,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) { assert.ok(name in dependencies, `unexpected dependency ${name}`); return dependencies[name] }
  })
  const manager = new exports.SshManager(() => {}, () => {}, () => {})
  t.after(() => manager.dispose())
  return { manager, clients, timers,
    async ready() {
      clients.at(-1).emit('ready')
      for (let i = 0; i < 6; i++) await Promise.resolve()
    },
    retryTimer() {
      const [id, callback] = timers.entries().next().value
      timers.delete(id)
      callback()
    }
  }
}

test('a failed handshake can retry with the same unsaved credentials and transcript', t => {
  const f = fixture(t)
  f.manager.connect(target, '/work/model', '/work/manual')
  f.clients[0].emit('error', new Error('Connection lost before handshake'))
  assert.equal(f.manager.getState().status, 'error')
  const before = plain(f.manager.getState().lines)
  const next = f.manager.reconnect()
  assert.equal(next.status, 'connecting')
  assert.match(next.message, /重新连接/)
  assert.deepEqual(plain(next.lines.slice(0, before.length)), before)
  assert.equal(f.clients.length, 2)
  assert.equal(f.clients[1].options.password, target.password)
  assert.equal(f.clients[1].options.port, 2222)
  assert.equal(f.manager.reconnectCwd, '/work/model')
  assert.equal(f.manager.reconnectPtyCwd, '/work/manual')
  assert.equal(f.manager.reconnect().status, 'connecting')
  assert.equal(f.clients.length, 2, 'a second click does not dial another client')
  assert.ok(!JSON.stringify(next).includes(target.password), 'credentials never enter renderer state')
})

test('a live reconnect restores both directories and ignores callbacks from the old client', async t => {
  const f = fixture(t)
  f.manager.connect(target)
  await f.ready()
  const old = f.clients[0], shell = f.manager.execShell()
  shell.noteCwd('/work/model')
  f.manager.ptyCwd = '/work/manual'
  f.manager.pushModelLine({ kind: 'command', text: 'never-replay-this-command' })
  f.manager.pushModelOutput('preserved output')
  f.manager.reconnect()
  assert.equal(old.ended, true)
  assert.equal(shell.stopRunning, true)
  assert.ok(f.manager.getState().lines.some(line => line.text === 'preserved output'))
  old.emit('error', new Error('late error'))
  old.emit('close')
  assert.equal(f.manager.getState().status, 'connecting')
  assert.equal(f.clients.length, 2)
  await f.ready()
  assert.equal(f.manager.execShell().cwd, '/work/model')
  assert.deepEqual(f.clients[1].pty.writes, ["cd '/work/manual'\n"])
  assert.deepEqual(f.clients[1].execCommands, ["cd '/work/model' && fixture-shell"])
})

test('manual reconnect remains available after automatic retries are exhausted', async t => {
  const f = fixture(t)
  f.manager.connect(target)
  await f.ready()
  f.manager.execShell().noteCwd('/work/saved')
  f.clients[0].emit('error', new Error('offline'))
  for (let attempt = 0; attempt < 3; attempt++) {
    f.retryTimer()
    f.clients.at(-1).emit('error', new Error('still offline'))
  }
  assert.equal(f.manager.getState().status, 'error')
  assert.equal(f.timers.size, 0)
  assert.equal(f.manager.reconnect().status, 'connecting')
  assert.equal(f.manager.reconnectAttempts, 0)
  assert.equal(f.manager.reconnectCwd, '/work/saved')
  assert.equal(f.clients.length, 5)
})

test('disconnect retains retry settings, while dismiss and restore forget old credentials', async t => {
  const f = fixture(t)
  f.manager.connect(target)
  await f.ready()
  f.manager.execShell().noteCwd('/work/saved')
  f.manager.ptyCwd = '/work/manual'
  f.manager.disconnect()
  assert.equal(f.manager.reconnect().status, 'connecting')
  assert.equal(f.manager.reconnectCwd, '/work/saved')
  await f.ready()
  assert.equal(f.manager.execShell().cwd, '/work/saved')
  assert.deepEqual(f.clients[1].execCommands, ["cd '/work/saved' && fixture-shell"])
  assert.deepEqual(f.clients[1].pty.writes, ["cd '/work/manual'\n"])
  f.manager.dismiss()
  assert.equal(f.manager.reconnect(), null)
  f.manager.restoreAttachment({ hostId: 'host-b', name: '另一台主机', host: 'other.invalid', port: 22 })
  assert.equal(f.manager.reconnect(), null, 'a restored pane must resolve its own saved host')
  assert.equal(f.clients.length, 2)
})

const runtimeSource = ts.createSourceFile('session-runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const runtime = runtimeSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const reconnect = runtime.members.find(node => node.name?.getText(runtimeSource) === 'reconnectSsh')
const Runtime = new Script(compile(`class Runtime { ${reconnect.getText(runtimeSource)} }; Runtime`)).runInNewContext({ Error })

test('a restored SSH pane reconnects only its saved host at the saved directory', () => {
  const calls = []
  const host = { id: target.hostId, name: target.name, host: target.host, port: target.port, username: target.username, proxy: 'http://proxy.invalid:7897' }
  const instance = Object.assign(new Runtime(), {
    ssh: { getState: () => ({ attached: true, hostId: target.hostId, status: 'disconnected' }), reconnect: () => null },
    runner: { prepareTerminalReconnect() { calls.push('invalidate') } },
    options: { store: { listSshHosts: () => [{ ...host, id: 'unrelated-host' }, host] } },
    sshCwd: '/work/restored',
    connectSsh(draft, cwd) { calls.push({ draft: plain(draft), cwd }); return { status: 'connecting' } }
  })
  assert.equal(instance.reconnectSsh().status, 'connecting')
  assert.deepEqual(calls, ['invalidate', { draft: { ...host, password: '' }, cwd: '/work/restored' }])
  instance.options.store.listSshHosts = () => []
  assert.throws(() => instance.reconnectSsh(), /配置已不存在/)
  instance.options.store.listSshHosts = () => [host]
  instance.connectSsh = () => ({ status: 'error', message: '请输入密码' })
  assert.throws(() => instance.reconnectSsh(), /请输入密码/)
})

test('unattached and connecting SSH panes ignore repeated reconnect requests', () => {
  for (const state of [{ attached: false, status: 'disconnected' }, { attached: true, status: 'connecting' }]) {
    const instance = Object.assign(new Runtime(), { ssh: { getState: () => state, reconnect: forbidden }, runner: { prepareTerminalReconnect: forbidden } })
    assert.equal(instance.reconnectSsh(), state)
  }
})

const main = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const registrations = []
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(main) === 'ipcMain.handle'
    && ['IpcChannels.terminalReconnect', 'IpcChannels.terminalReset'].includes(node.arguments[0]?.getText(main))) registrations.push(node.getText(main))
  ts.forEachChild(node, visit)
}
visit(main)
assert.equal(registrations.length, 2)

test('device reconnect retains output while reset clears it, including when offline', () => {
  const calls = [], handlers = new Map()
  let lines = [{ kind: 'output', text: 'previous device output' }]
  const device = { alive: false, transport: { status: 'error' },
    reconnect() { calls.push('reconnect') }, reset() { calls.push('reset') } }
  const runner = { getTerminalState: () => ({ lines }),
    prepareTerminalReconnect() { calls.push('invalidate') },
    resetTerminal() { calls.push('clear'); lines = [] } }
  const current = { web2term: device, runner, ssh: { getState: () => ({ attached: false }) } }
  new Script(compile(registrations.join('\n'))).runInNewContext({
    IpcChannels: { terminalReconnect: 'reconnect', terminalReset: 'reset' },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    runtimeForEvent: () => current
  })
  assert.equal(handlers.get('reconnect')({}).lines.length, 1)
  assert.deepEqual(calls, ['invalidate', 'reconnect'])
  for (const status of ['connecting', 'closing']) {
    device.transport.status = status
    handlers.get('reconnect')({})
  }
  assert.deepEqual(calls, ['invalidate', 'reconnect'], 'connecting or closing terminals are not replaced again')
  device.transport.status = 'error'
  assert.equal(handlers.get('reset')({}).lines.length, 0)
  assert.deepEqual(calls, ['invalidate', 'reconnect', 'clear', 'reset'])
})
