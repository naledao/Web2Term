// User-run offline regression: node --test tests/windows-agent.test.mjs
// Synthetic sockets, timers and PTYs only. Never starts Electron/PowerShell or accesses a backend/profile.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as stringDecoder from 'node:string_decoder'
import * as util from 'node:util'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(file, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { filename: file }).runInNewContext({
    exports, Buffer, URL, process: { platform: 'fixture' }, setTimeout, clearTimeout, queueMicrotask,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`); return dependencies[name] }, ...globals
  })
  return exports
}
const forbidden = () => { throw new Error('Real I/O is forbidden') }
const protocol = load('../src/main/windows-agent-terminals.ts', { 'node:string_decoder': stringDecoder })
const powershell = load('../src/main/powershell-terminal.ts')
const shared = load('../src/shared/windows-agent.ts')
const backend = load('../src/shared/backend-url.ts')
const DEVICE = '00000000-1234-5678-9abc-0123456789ab'
const id = number => `${String(number).padStart(8, '0')}-1234-5678-9abc-0123456789ab`
const packet = (type, sessionId, payload = {}) => ({ version: 1, type, session_id: sessionId, payload })

class Pty {
  input = []
  sizes = []
  killed = 0
  data = new Set()
  exits = new Set()
  write(data) { this.input.push(data) }
  resize(cols, rows) { this.sizes.push({ cols, rows }) }
  kill() { this.killed++ }
  onData(listener) { this.data.add(listener); return { dispose: () => this.data.delete(listener) } }
  onExit(listener) { this.exits.add(listener); return { dispose: () => this.exits.delete(listener) } }
  output(data) { for (const listener of [...this.data]) listener(data) }
  exit(exitCode = 0) { for (const listener of [...this.exits]) listener({ exitCode }) }
}
function terminalFixture(spawn) {
  const messages = [], logs = [], ptys = []
  const terminals = new protocol.WindowsAgentTerminals({
    spawn: spawn ?? (() => { const pty = new Pty(); ptys.push(pty); return { pty, shell: 'pwsh.exe' } }),
    send(message) { messages.push(message); return true }, changed() {}, log: record => logs.push(record)
  })
  return { terminals, messages, logs, ptys }
}

test('three slots include closing shells and disconnected generations until exit is confirmed', () => {
  const f = terminalFixture()
  for (let n = 0; n < 3; n++) f.terminals.receive(packet('terminal_open', id(n)))
  f.terminals.receive(packet('terminal_open', id(3)))
  assert.equal(f.ptys.length, 3)
  assert.equal(f.messages.at(-1).payload.code, 'TERMINAL_LIMIT_REACHED')
  f.terminals.receive(packet('terminal_close', id(0)))
  f.terminals.receive(packet('terminal_open', id(4)))
  assert.equal(f.ptys[0].killed, 1)
  assert.equal(f.terminals.count, 3)
  f.terminals.disconnect(); f.terminals.attach()
  f.terminals.receive(packet('terminal_open', id(5)))
  assert.equal(f.ptys.length, 3)
  const before = f.messages.length
  f.ptys[0].exit()
  assert.equal(f.messages.length, before, 'a retired generation must not send exits on a new connection')
  f.terminals.receive(packet('terminal_open', id(5)))
  assert.equal(f.ptys.length, 4)
  assert.equal(f.terminals.count, 3)
})

test('input preserves split UTF-8 and control bytes; output is split into valid protocol packets', () => {
  const f = terminalFixture()
  f.terminals.receive(packet('terminal_open', DEVICE))
  const bytes = Buffer.from('中文\x03')
  f.terminals.receive(packet('terminal_input', DEVICE, { data: bytes.subarray(0, 2).toString('base64') }))
  f.terminals.receive(packet('terminal_input', DEVICE, { data: bytes.subarray(2).toString('base64') }))
  assert.equal(f.ptys[0].input.join(''), '中文\x03')
  f.ptys[0].output('中文'.repeat(10000))
  const output = f.messages.filter(message => message.type === 'terminal_output')
  assert.ok(output.length > 1)
  assert.ok(output.every(message => Buffer.byteLength(message.payload.data, 'base64') <= 16384))
  assert.equal(Buffer.concat(output.map(message => Buffer.from(message.payload.data, 'base64'))).toString(), '中文'.repeat(10000))
  assert.ok(!JSON.stringify(f.logs).includes('中文'))
  f.terminals.receive(packet('terminal_resize', DEVICE, { cols: 132, rows: 43 }))
  assert.deepEqual(f.ptys[0].sizes, [{ cols: 132, rows: 43 }])
})

test('rejects invalid payloads, session reuse and size/base64 limits without spawning extra shells', () => {
  const f = terminalFixture()
  f.terminals.receive(packet('terminal_open', 'not-a-uuid'))
  assert.equal(f.messages.at(-1).payload.code, 'INVALID_SESSION_ID')
  assert.equal(f.messages.at(-1).session_id, undefined)
  for (const payload of [{ shell: 'evil.exe' }, { cols: 1001 }, { rows: 1.5 }, { cols: null }]) f.terminals.receive(packet('terminal_open', DEVICE, payload))
  assert.equal(f.ptys.length, 0)
  f.terminals.receive(packet('terminal_open', DEVICE))
  for (const data of ['!!', 'Zh==', Buffer.alloc(16385).toString('base64')]) {
    f.terminals.receive(packet('terminal_input', DEVICE, { data }))
    assert.equal(f.messages.at(-1).payload.code, 'INVALID_INPUT')
  }
  f.terminals.receive(packet('terminal_open', DEVICE))
  assert.equal(f.messages.at(-1).payload.code, 'SESSION_EXISTS')
  f.ptys[0].exit(7)
  assert.equal(f.messages.at(-1).payload.exit_code, 7)
  f.terminals.receive(packet('terminal_open', DEVICE))
  assert.equal(f.messages.at(-1).payload.code, 'SESSION_CLOSED')
  assert.equal(f.terminals.count, 0)
})

test('spawn failures release slots without sending terminal_ready', () => {
  const f = terminalFixture(() => { throw new Error('fixture failure') })
  f.terminals.receive(packet('terminal_open', DEVICE))
  assert.equal(f.terminals.count, 0)
  assert.equal(f.messages.length, 1)
  assert.equal(f.messages[0].payload.code, 'TERMINAL_START_FAILED')
})

class Socket extends EventEmitter {
  static OPEN = 1
  readyState = 0
  bufferedAmount = 0
  sent = []
  deferWrites = false
  pendingSends = []
  terminated = false
  send(value, callback) {
    this.sent.push(JSON.parse(value))
    if (this.deferWrites) {
      const bytes = Buffer.byteLength(value)
      this.bufferedAmount += bytes
      this.pendingSends.push({ callback, bytes })
    } else callback?.()
  }
  completeSend(index = 0, error) {
    const [write] = this.pendingSends.splice(index, 1)
    assert.ok(write, 'A deferred send must exist')
    this.bufferedAmount -= write.bytes
    write.callback?.(error)
  }
  terminate() { this.terminated = true; this.readyState = 3 }
  open() { this.readyState = Socket.OPEN; this.emit('open') }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
}
function agentFixture() {
  const timers = new Map(), sockets = [], logs = [], settings = new Map(), states = [], ptys = []
  let now = 1000
  let owner = 'owner'
  let backendUrl = 'https://example.invalid/context'
  let signedIn = true
  const auth = {
    getState: () => ({ status: signedIn ? 'signed-in' : 'signed-out', backendUrl, user: signedIn ? { publicId: owner } : null }),
    getConnectionCredentials: () => signedIn ? { backendUrl, accessToken: 'fixture-secret-never-log', expiresAt: 100000 } : null
  }
  const schedule = (callback, milliseconds) => { const handle = { unref() {} }; timers.set(handle, { callback, milliseconds, dueAt: now + milliseconds }); return handle }
  const advance = milliseconds => {
    const target = now + milliseconds
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
      if (!next) break
      timers.delete(next[0]); now = Math.max(now, next[1].dueAt); next[1].callback()
    }
    now = target
  }
  const { WindowsAgent, agentWebSocketUrl } = load('../src/main/windows-agent.ts', {
    'node:fs': { appendFileSync: forbidden, mkdirSync: forbidden, writeFileSync: forbidden }, 'node:crypto': crypto,
    'node:os': { ...os, hostname: () => 'fixture-pc' }, 'node:path': path, 'node:module': { createRequire: forbidden },
    ws: Socket, '../shared/backend-url': backend, '../shared/windows-agent': shared,
    './shell': { resolvePowerShell: forbidden }, './bundled-ripgrep': { withRipgrepPath: forbidden }, './windows-agent-terminals': protocol
  })
  const agent = new WindowsAgent({ getSetting: key => settings.get(key), setSettings: values => Object.entries(values).forEach(([key, value]) => settings.set(key, value)) }, auth, {
    supported: true, now: () => now, random: () => 0,
    schedule, unschedule: handle => timers.delete(handle), log: { path: 'fixture.log', write: record => logs.push(record) },
    changed: state => states.push(state),
    spawn: () => { const pty = new Pty(); ptys.push(pty); return { pty, shell: 'powershell.exe' } },
    createSocket(url, options) { const socket = new Socket(); sockets.push({ socket, url, options }); return socket }
  })
  return { agent, sockets, states, settings, logs, timers, ptys, agentWebSocketUrl, advance,
    setIdentity(value) { owner = value }, setSignedIn(value) { signedIn = value }, setBackend(value) { backendUrl = value }, setNow(value) { now = value },
    fire(milliseconds) { const found = [...timers.entries()].find(([, timer]) => timer.milliseconds === milliseconds); assert.ok(found, `Timer ${milliseconds} missing`); timers.delete(found[0]); found[1].callback() }
  }
}

test('agent is opt-in; keeps auth in headers; online requires ack; paths and heartbeat order are preserved', () => {
  const f = agentFixture(); f.agent.start()
  assert.equal(f.sockets.length, 0)
  f.agent.setEnabled(true)
  assert.equal(f.sockets[0].url, 'wss://example.invalid/context/ws/agent')
  assert.equal(f.sockets[0].options.followRedirects, false)
  assert.equal(f.sockets[0].options.headers.Authorization, 'Bearer fixture-secret-never-log')
  const socket = f.sockets[0].socket; socket.open()
  assert.equal(f.agent.getState().status, 'connecting')
  assert.deepEqual(socket.sent, [{ type: 'heartbeat' }])
  socket.message({ type: 'heartbeat_ack' })
  assert.equal(f.agent.getState().status, 'online')
  assert.equal(socket.sent[1].type, 'agent_hello')
  socket.message({ type: 'heartbeat_ack' })
  assert.equal(socket.sent.length, 2)
  f.fire(20000)
  assert.equal(socket.sent.at(-1).type, 'heartbeat')
  assert.ok(!JSON.stringify([f.agent.getState(), f.states, f.logs, [...f.settings]]).includes('fixture-secret'))
  assert.equal(f.agentWebSocketUrl('http://[::1]:8080/context/'), 'ws://[::1]:8080/context/ws/agent')
  f.agent.dispose()
})

test('terminal requests before the first heartbeat ack are processed in order while status stays connecting', () => {
  const f = agentFixture(); f.agent.setEnabled(true)
  const socket = f.sockets[0].socket; socket.open()
  socket.message(packet('terminal_open', DEVICE))
  assert.equal(f.ptys.length, 1)
  assert.equal(f.agent.getState().terminalCount, 1)
  assert.equal(socket.sent.at(-1).type, 'terminal_ready')
  socket.message(packet('terminal_input', DEVICE, { data: Buffer.from('early input').toString('base64') }))
  socket.message(packet('terminal_resize', DEVICE, { cols: 132, rows: 43 }))
  assert.deepEqual(f.ptys[0].input, ['early input'])
  assert.deepEqual(f.ptys[0].sizes, [{ cols: 132, rows: 43 }])
  socket.message(packet('terminal_close', DEVICE))
  assert.equal(f.ptys[0].killed, 1)
  f.ptys[0].exit()
  assert.equal(socket.sent.at(-1).type, 'terminal_exit')
  assert.equal(f.agent.getState().terminalCount, 0)
  assert.equal(f.agent.getState().status, 'connecting')
  assert.ok(!socket.sent.some(message => message.type === 'agent_hello'))
  socket.message({ type: 'heartbeat_ack' })
  assert.equal(f.agent.getState().status, 'online')
  assert.equal(socket.sent.at(-1).type, 'agent_hello')
  f.agent.dispose()
})

test('a completed send cannot expire a fresh output queued just before its old deadline', () => {
  const f = agentFixture(); f.agent.setEnabled(true)
  const socket = f.sockets[0].socket; socket.open(); socket.message({ type: 'heartbeat_ack' })
  socket.message(packet('terminal_open', DEVICE))
  assert.ok(![...f.timers.values()].some(timer => timer.milliseconds === 10000), 'Completed writes must clear their timeout')
  f.advance(9900)
  socket.deferWrites = true
  f.ptys[0].output('fresh output')
  assert.ok(socket.bufferedAmount > 0)
  f.advance(100)
  assert.equal(f.agent.getState().status, 'online')
  assert.equal(f.ptys[0].killed, 0)
  socket.completeSend()
  assert.ok(![...f.timers.values()].some(timer => timer.milliseconds === 10000))
  f.advance(9900)
  assert.equal(f.agent.getState().status, 'online')
  assert.equal(f.ptys[0].killed, 0)
  f.agent.dispose()
})

test('overlapping writes keep each remaining send deadline and still recycle a genuinely blocked socket', () => {
  const f = agentFixture(); f.agent.setEnabled(true)
  const socket = f.sockets[0].socket; socket.open(); socket.message({ type: 'heartbeat_ack' })
  socket.message(packet('terminal_open', DEVICE))
  socket.deferWrites = true
  f.ptys[0].output('first output')
  f.advance(4000)
  f.ptys[0].output('second output')
  f.advance(5000)
  socket.completeSend()
  f.advance(1000)
  assert.equal(f.agent.getState().status, 'online', 'The second send must not inherit the first send deadline')
  f.advance(3999)
  assert.equal(f.ptys[0].killed, 0)
  f.advance(1)
  assert.equal(f.agent.getState().status, 'reconnecting')
  assert.equal(socket.terminated, true)
  assert.equal(f.ptys[0].killed, 1)
  f.agent.dispose()
  assert.equal(f.timers.size, 0)
})

test('late send callbacks from a retired socket cannot clear a replacement socket timeout', () => {
  const f = agentFixture(); f.agent.setEnabled(true)
  const first = f.sockets[0].socket; first.open(); first.message({ type: 'heartbeat_ack' })
  first.message(packet('terminal_open', DEVICE))
  first.deferWrites = true
  f.ptys[0].output('old output')
  first.emit('error', new Error('fixture failure'))
  f.ptys[0].exit()
  f.advance(1000)
  const second = f.sockets[1].socket; second.open(); second.message({ type: 'heartbeat_ack' })
  second.message(packet('terminal_open', id(1)))
  second.deferWrites = true
  f.ptys[1].output('new output')
  first.completeSend()
  assert.equal(f.agent.getState().status, 'online')
  f.advance(10000)
  assert.equal(f.agent.getState().status, 'reconnecting')
  assert.equal(second.terminated, true)
  assert.equal(f.ptys[1].killed, 1)
  f.agent.dispose()
})

test('network failures recycle terminals, back off, ignore stale sockets and preserve device identity', () => {
  const f = agentFixture(); f.agent.setEnabled(true)
  const first = f.sockets[0].socket; first.open(); first.message({ type: 'heartbeat_ack' })
  const deviceId = f.agent.getState().deviceId
  first.message(packet('terminal_open', DEVICE))
  assert.equal(f.agent.getState().terminalCount, 1)
  first.emit('error', new Error('fixture secret'))
  assert.equal(f.agent.getState().status, 'reconnecting')
  assert.equal(f.ptys[0].killed, 1)
  f.fire(1000)
  assert.equal(f.sockets.length, 2)
  assert.equal(f.agent.getState().deviceId, deviceId)
  first.emit('close', 1000)
  assert.equal(f.agent.getState().status, 'connecting')
  f.sockets[1].socket.emit('error', new Error('again'))
  f.fire(2000)
  f.agent.dispose()
  assert.equal(f.timers.size, 0)
})

test('account/backend switches cannot silently expose this machine to another identity', () => {
  const f = agentFixture(); f.agent.setEnabled(true)
  const initial = f.agent.getState().deviceId
  f.setIdentity('someone-else'); f.agent.credentialsChanged()
  assert.equal(f.agent.getState().status, 'waiting-login')
  assert.equal(f.sockets.length, 1)
  f.agent.setEnabled(false); f.agent.setEnabled(true)
  assert.notEqual(f.agent.getState().deviceId, initial)
  f.setBackend('https://another.invalid'); f.agent.credentialsChanged()
  assert.equal(f.agent.getState().status, 'waiting-login')
  assert.equal(f.sockets.length, 2)
  f.agent.dispose()
})

test('expired credentials, disable and replacement do not reconnect automatically', () => {
  const f = agentFixture(); f.agent.setEnabled(true)
  f.setNow(100000); f.fire(99000)
  assert.equal(f.agent.getState().status, 'waiting-login')
  assert.equal(f.timers.size, 0)
  f.setNow(1000); f.agent.credentialsChanged()
  f.sockets.at(-1).socket.emit('close', 1000)
  assert.equal(f.agent.getState().status, 'error')
  assert.equal(f.timers.size, 0)
  f.agent.setEnabled(false)
  f.agent.start()
  assert.equal(f.sockets.length, 2)
  assert.equal(f.agent.getState().enabled, false)
  f.agent.dispose()
})

test('malformed saved identities are preserved and never replaced with a new device', () => {
  for (const invalid of ['null', 'false', '0', '{}', '{broken']) {
    const f = agentFixture(); f.agent.setEnabled(true)
    const key = [...f.settings.keys()].find(key => key.startsWith('windowsAgentIdentity:'))
    f.agent.setEnabled(false); f.settings.set(key, invalid); f.agent.setEnabled(true)
    assert.equal(f.agent.getState().status, 'error')
    assert.equal(f.settings.get(key), invalid)
    assert.equal(f.sockets.length, 1)
    f.agent.dispose()
  }
})

test('PowerShell framing limits console lines, preserves long Unicode commands and separates markers', () => {
  const command = "Set-Location -LiteralPath 'C:\\中文 路径'; Write-Output '" + '长'.repeat(20000) + "'"
  const envelope = powershell.powerShellEnvelope('token', 12, command)
  const lines = envelope.trimEnd().split('\r')
  assert.ok(lines.every(line => line.length <= 254), 'command frames must fit the default Console.ReadLine buffer')
  assert.ok(lines.slice(0, -1).every(line => line[0] === '+'))
  assert.equal(lines.at(-1)[0], '=')
  const script = Buffer.from(lines.map(line => line.slice(1)).join(''), 'base64').toString()
  assert.ok(script.includes('__CT_DONE_token_12__'))
  const encodedCommand = /FromBase64String\('([^']+)'\)/.exec(script)[1]
  assert.equal(Buffer.from(encodedCommand, 'base64').toString(), command)
  assert.ok(script.includes('[Console]::SetIn($w2tSavedIn)'))
  const bootstrap = powershell.powerShellBootstrap('__FIXTURE_READY__')
  assert.ok(bootstrap.split('\r').every(line => line.length <= 254), 'loader syntax counts towards the console line limit')
  assert.ok(!bootstrap.includes('stty'))
})

test('bootstrap survives a receiver limited to 254 characters per line and checks its complete payload', () => {
  const token = '__W2T_READY_' + 'a'.repeat(32) + '__'
  assert.ok(powershell.powerShellPrepare(token).trimEnd().length <= 254)
  const lines = powershell.powerShellBootstrap(token).split('\r').map(line => line.slice(0, 254))
  const fragments = lines.flatMap(line => {
    const match = /^\[void\]\$w2tStartup\.Append\('([A-Za-z0-9+/=]+)'\)$/.exec(line)
    return match ? [match[1]] : []
  })
  const encoded = fragments.join('')
  assert.ok(fragments.length > 1)
  assert.ok(lines.some(line => line.includes(`$w2tStartup.Length -ne ${encoded.length}`)))
  const script = Buffer.from(encoded, 'base64').toString('utf8')
  assert.ok(script.includes(`[Console]::WriteLine([Environment]::NewLine + '${token}')`))
  assert.ok(script.endsWith('\nexit'))
  for (const stage of ['console_mode', 'encoding', 'command_loop']) assert.ok(script.includes(`$w2tStage = '${stage}'`))
  // The remote machine must not need a working C# compiler/reference assembly set to open a terminal.
  assert.doesNotMatch(script, /Add-Type|DllImport|W2TConsole/u)
  assert.ok(script.includes('[Console]::ReadKey($true)'), 'framed input must be read without echo')
  assert.ok(script.includes('[Console]::TreatControlCAsInput = $false'), 'raw Ctrl+C must keep console interrupt semantics')
})

test('bootstrap error metadata accepts only fixed stages and short identifiers', () => {
  const token = '__FIXTURE_READY__'
  assert.deepEqual({ ...powershell.parsePowerShellBootstrapFailure(`${token}_FAILED decode BOOTSTRAP_LENGTH_MISMATCH`, token) },
    { bootstrapStage: 'decode', errorId: 'BOOTSTRAP_LENGTH_MISMATCH' })
  assert.equal(powershell.parsePowerShellBootstrapFailure(`Write-Output '${token}_FAILED'`, token), null)
  assert.equal(powershell.parsePowerShellBootstrapFailure('__WRONG_READY___FAILED', token), null)
  for (const suffix of ['', ' unknown Failure', ' console_type ' + 'a'.repeat(41), ' encoding private output', ' console_mode path/secret']) {
    const result = powershell.parsePowerShellBootstrapFailure(token + '_FAILED' + suffix, token)
    assert.deepEqual({ ...result }, { bootstrapStage: 'unknown', errorId: 'unknown' })
  }
})

test('native ConsoleHost submits both bootstrap blocks before waiting for more input', () => {
  // Model ConsoleHost.InputLoop: after incomplete input, only a blank line submits the block.
  // Closing braces alone do not leave block mode. No PowerShell process is started here.
  function nativeInput(input) {
    const commands = []
    let pending = null
    for (const line of input.split('\r').slice(0, -1)) {
      if (pending) {
        if (line.trim() === '') { commands.push(pending.join('\n')); pending = null }
        else pending.push(line)
      } else if (/^(?:function\b.*|try)\s*\{$/.test(line)) pending = [line]
      else if (line.trim() !== '') commands.push(line)
    }
    return { commands, pending }
  }
  const bootstrap = powershell.powerShellBootstrap('__FIXTURE_READY__')
  const received = nativeInput(bootstrap)
  assert.equal(received.pending, null, 'the final try/catch must execute instead of waiting at the continuation prompt')
  const reporter = received.commands.find(command => command.startsWith('function '))
  assert.ok(reporter)
  assert.ok(!reporter.includes('$w2tStartup'), 'payload lines must execute after the reporter is defined')
  assert.ok(received.commands.includes('$w2tStartup = New-Object Text.StringBuilder'))
  assert.ok(received.commands.filter(command => command.startsWith('[void]$w2tStartup.Append(')).length > 1)
  assert.ok(received.commands.at(-1).startsWith('try {\n'))
  assert.ok(received.commands.at(-1).includes('Invoke-Expression'))
  const missingTerminators = nativeInput(bootstrap.replaceAll('\r\r', '\r'))
  assert.ok(missingTerminators.pending, 'the model must reproduce the old stalled continuation prompt')
  assert.ok(!missingTerminators.commands.includes('$w2tStartup = New-Object Text.StringBuilder'))
})

function bootstrapFixture(kind = 'windows') {
  const timers = new Map(), writes = [], logs = [], sessions = []
  let receive, closes = 0, ready = 0
  const { Web2termShell } = load('../src/main/web2term-shell.ts', {
    'node:crypto': crypto, 'node:events': { EventEmitter }, 'node:util': util,
    './powershell-terminal': powershell,
    './remote-shell': { RemoteShell: class {
      alive = true
      constructor(channel) { channel.on('close', () => { this.alive = false }) }
      dispose() { this.alive = false }
    } },
    './environment': { DETECT_COMMAND: 'windows probe', REMOTE_DETECT_COMMAND: 'posix probe' }
  }, {
    setTimeout(callback, milliseconds) { const handle = { unref() {} }; timers.set(handle, { callback, milliseconds }); return handle },
    clearTimeout(handle) { timers.delete(handle) }
  })
  const connection = {
    getState: () => ({ status: 'connected', agentId: DEVICE,
      auth: { status: 'signed-in', backendUrl: 'https://example.invalid', user: { publicId: 'owner' } } }),
    terminals: {
      subscribe(_changed, output) { receive = output; return () => {} },
      getState: () => ({ connectionId: 'route', sessions }),
      open() { sessions.push({ id: DEVICE, status: 'opening', shell: '' }); return { ok: true, sessionId: DEVICE } },
      input(_id, data) { writes.push(Buffer.from(data).toString()); return { ok: true } },
      close() { closes++; sessions[0].status = 'closing'; return { ok: true } },
      recordShellEvent(sessionId, event, details = {}) { logs.push({ sessionId, event, ...details }) }
    }
  }
  const shell = new Web2termShell({ agentId: DEVICE, deviceName: 'Fixture device', backendUrl: 'https://example.invalid', userId: 'owner' }, connection)
  shell.onReady = () => ready++
  shell.activate()
  Object.assign(sessions[0], { status: 'ready', shell: kind === 'windows' ? 'powershell.exe' : '/bin/bash' })
  shell.sync()
  const token = /__W2T_READY_[a-f0-9]+__/.exec(writes[0])[0]
  return { shell, writes, logs, timers, token, get closes() { return closes }, get ready() { return ready },
    output(text) { receive({ connectionId: 'route', sessionId: DEVICE, data: Buffer.from(text).toString('base64') }) },
    expire() { const [handle, timer] = [...timers][0]; timers.delete(handle); timer.callback() }
  }
}

test('Windows bootstrap waits for the input handoff before sending lines PSReadLine could read ahead', t => {
  const f = bootstrapFixture()
  t.after(() => f.shell.dispose())
  assert.equal(f.writes.length, 1)
  assert.equal(f.writes[0].trimEnd().split('\r').length, 1, 'PSReadLine must receive only its final command line')
  assert.ok(f.writes[0].includes('Remove-Module PSReadLine'))
  assert.ok(!f.writes[0].includes('$w2tStartup'))
  // Echoed commands, a final marker arriving too early and incomplete lines cannot release the handoff.
  f.output(f.writes[0] + '\n' + f.token + '\r\n')
  f.output('\x1b[0m' + f.token + '_IN')
  assert.equal(f.writes.length, 1)
  assert.equal(f.ready, 0)
  f.output('PUT\x1b[0m\r\n')
  const startup = f.writes.slice(1).join('')
  assert.ok(startup.includes('$w2tStartup'))
  assert.equal(f.ready, 0, 'input handoff is not command-loop readiness')
  f.output(f.token + '_INPUT\r\n')
  assert.equal(f.writes.slice(1).join(''), startup, 'a duplicate acknowledgement must not replay the script')
  f.output('\x1b[0m' + f.token.slice(0, 15))
  f.output(f.token.slice(15) + '\x1b[0m\r\n')
  assert.equal(f.ready, 1)
  assert.equal(f.shell.alive, true)
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.logs.map(log => log.event), ['shell_initializing', 'shell_input_ready', 'shell_ready'])
})

test('bootstrap timeouts report the stalled phase and byte count without logging terminal content', t => {
  for (const phase of ['input', 'script']) {
    const f = bootstrapFixture()
    t.after(() => f.shell.dispose())
    if (phase === 'script') f.output(f.token + '_INPUT\r\n')
    f.output('fixture-private-output')
    f.expire()
    assert.equal(f.closes, 1)
    assert.equal(f.ready, 0)
    assert.equal(f.shell.transport.status, 'error')
    assert.equal(f.logs.at(-1).event, 'shell_init_timeout')
    assert.equal(f.logs.at(-1).phase, phase)
    assert.ok(f.logs.at(-1).outputBytes > 0)
    assert.ok(!JSON.stringify(f.logs).includes('fixture-private-output'))
  }
})

test('PowerShell bootstrap failures close immediately instead of waiting for the readiness timeout', t => {
  const f = bootstrapFixture()
  t.after(() => f.shell.dispose())
  f.output(f.token + '_INPUT\r\n')
  f.output('\x1b[0m' + f.token + '_FAILED console_mode CONSOLE_UNAVAILABLE\r\n')
  assert.equal(f.closes, 1)
  assert.equal(f.ready, 0)
  assert.equal(f.timers.size, 0)
  assert.equal(f.logs.at(-1).event, 'shell_init_failed')
  assert.equal(f.logs.at(-1).bootstrapStage, 'console_mode')
  assert.equal(f.logs.at(-1).errorId, 'CONSOLE_UNAVAILABLE')
  assert.equal(f.shell.transport.status, 'error')
  assert.ok(f.shell.transport.message.includes('控制台输入模式'))
})

test('bootstrap failures without metadata still close with a generic diagnostic', t => {
  const f = bootstrapFixture()
  t.after(() => f.shell.dispose())
  f.output(f.token + '_INPUT\r\n')
  f.output(f.token + '_FAILED\r\n')
  assert.equal(f.closes, 1)
  assert.equal(f.ready, 0)
  assert.equal(f.logs.at(-1).bootstrapStage, 'unknown')
  assert.equal(f.logs.at(-1).errorId, 'unknown')
})

test('POSIX bootstrap keeps its existing single-stage handshake', t => {
  const f = bootstrapFixture('posix')
  t.after(() => f.shell.dispose())
  assert.equal(f.writes.length, 1)
  assert.ok(f.writes[0].startsWith('stty '))
  f.output(f.token + '\n')
  assert.equal(f.ready, 1)
  assert.equal(f.shell.alive, true)
  assert.equal(f.timers.size, 0)
})

test('remote PowerShell parses ANSI completion markers and keeps Windows cwd and exit code', async () => {
  const remote = load('../src/main/remote-shell.ts', {
    'node:crypto': crypto, 'node:string_decoder': stringDecoder, 'node:util': util,
    './powershell-terminal': powershell, './shell': { IDLE_TIMEOUT_MS: 10000, MAX_RUNTIME_MS: 20000 },
    './environment': { DETECT_COMMAND: 'windows probe', REMOTE_DETECT_COMMAND: 'posix probe' }
  })
  class Channel extends EventEmitter { write(value) { this.written = value } close() { this.emit('close') } signal() {} }
  const channel = new Channel(), shell = new remote.RemoteShell(channel, { kind: 'windows' })
  const running = shell.run("Write-Output '中文'")
  const script = Buffer.from(channel.written.trimEnd().split('\r').map(line => line.slice(1)).join(''), 'base64').toString()
  const marker = /__CT_DONE_[a-f0-9]+_1__/.exec(script)[0]
  channel.emit('data', Buffer.from(`中文\r\n\x1b[0m${marker} 3 C:\\中文 路径\r\n`))
  const result = await running
  assert.equal(shell.kind, 'windows'); assert.equal(shell.probeCommand, 'windows probe')
  assert.equal(result.cwd, 'C:\\中文 路径'); assert.equal(result.exitCode, 3)
  assert.equal(result.output, '中文')
  shell.dispose()
})
