// User-run offline regressions: node --test tests/remote-interrupt.test.mjs tests/ssh-directory.test.mjs tests/recent-command-run.test.mjs
// Fake channels and a manual clock only; never opens SSH, starts Electron or kills a process.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as stringDecoder from 'node:string_decoder'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, Buffer, Error, AbortController, ...globals, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`)
    return dependencies[name]
  } })
  return exports
}
const stop = load('../src/main/ssh-command-stop.ts')
const started = Buffer.from('Sun Oct 25 20:00:00 2026').toString('base64')
const identity = { pid: 2301, started }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  writes = []
  signals = []
  closes = 0
  acknowledgeClose = true
  write(text) { this.writes.push(text) }
  signal(name) { this.signals.push(name) }
  close() { this.closes++; if (this.acknowledgeClose) this.emit('close') }
  identify(value = identity) {
    const token = this.writes.at(-1).match(/__CT_SHELL_([a-f0-9]+)__/)[1]
    this.emit('data', Buffer.from(`__CT_SHELL_${token}__ ${value.pid} ${value.started}\n`))
  }
  done(cwd = '/work', output = '', newline = true) {
    const envelope = this.writes.at(-1)
    const token = envelope.match(/__CT_DONE_([a-f0-9]+)_%s__/)[1]
    const seq = envelope.match(/'(\d+)' "\$\?" "\$PWD"/)[1]
    this.emit('data', Buffer.from(`${output}__CT_DONE_${token}_${seq}__ 0 ${cwd}${newline ? '\n' : ''}`))
  }
}

function fixture(t, options = {}) {
  const timers = new Map()
  const remote = load('../src/main/remote-shell.ts', {
    'node:crypto': crypto, 'node:string_decoder': stringDecoder,
    './shell': { IDLE_TIMEOUT_MS: 60000, MAX_RUNTIME_MS: 1800000 },
    './environment': { REMOTE_DETECT_COMMAND: 'fixture only' }
  }, {
    setTimeout(fn, ms) { const timer = {}; timers.set(timer, { fn, ms }); return timer },
    clearTimeout(timer) { timers.delete(timer) }
  })
  const channel = new Channel()
  const output = [], closed = []
  const shell = new remote.RemoteShell(channel, {
    onOutput: chunk => output.push(chunk), onClosed: value => closed.push(value), ...options
  })
  t.after(() => shell.dispose())
  return { shell, channel, output, closed, remote,
    expire() {
      const entry = [...timers.entries()].find(([, value]) => value.ms === remote.REMOTE_INTERRUPT_TIMEOUT_MS)
      assert.ok(entry, 'the confirmation deadline must exist independently of command runtime timers')
      timers.delete(entry[0]); entry[1].fn()
    }
  }
}

test('SSH interruption waits for independent child-process verification as well as channel close', async t => {
  let confirm
  const requests = []
  const f = fixture(t, { stopProcess: (value, signal) => {
    requests.push({ ...value, signal })
    return new Promise(resolve => { confirm = resolve })
  } })
  const running = f.shell.run('apt-get update -qq && apt-get install -y openjdk-17-jdk maven -qq')
  f.channel.identify()
  let finished = false
  void running.then(() => { finished = true })
  const first = f.shell.interrupt()
  const second = f.shell.interrupt()
  await tick()
  assert.equal(requests.length, 1, 'repeated clicks share one stop request')
  assert.equal(requests[0].pid, identity.pid)
  assert.equal(requests[0].started, identity.started)
  assert.equal(f.channel.closes, 0, 'do not close the parent before capturing descendants')
  assert.deepEqual(f.channel.signals, [], 'servers that ignore SSH signals use the independent control channel')
  f.channel.done('/work', 'last output\n', false)
  f.channel.emit('close')
  await tick()
  assert.equal(finished, false, 'a racing completion/close must not release automation before the child check')
  assert.equal(f.shell.running, true)
  assert.deepEqual(f.closed, [])
  assert.equal((await f.shell.run('duplicate installation')).rejected, true)
  confirm()
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  const result = await running
  assert.equal(result.interrupted, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.sessionLost, false)
  assert.deepEqual(f.closed, [true])
  assert.equal(f.shell.running, false)
  assert.equal(f.shell.alive, false)
  assert.ok(!f.output.join('').includes('__CT_SHELL_'), 'identity metadata is never displayed as command output')
})

test('missing SSH close acknowledgement has a deadline and never claims the pending command stopped', async t => {
  const f = fixture(t)
  f.channel.acknowledgeClose = false
  const running = f.shell.run('quiet command')
  let finished = false
  void running.then(() => { finished = true })
  const stopping = f.shell.interrupt()
  const rejected = assert.rejects(stopping, /10 秒内未确认/)
  f.expire()
  await rejected
  assert.equal(f.shell.running, true)
  assert.equal(finished, false)
  assert.deepEqual(f.closed, [])
  const replacement = await f.shell.run('must not run')
  assert.equal(replacement.rejected, true)
  assert.match(replacement.output, /停止状态未确认/)
  f.channel.done()
  f.channel.emit('close')
  await tick()
  assert.equal(finished, false, 'late completion alone cannot turn an unconfirmed stop into success')
  assert.equal(f.channel.listenerCount('close'), 1, 'deadline removes its temporary listener')
  f.shell.dispose()
  const result = await running
  assert.equal(result.sessionLost, true)
  assert.equal(result.interrupted, false)
  assert.equal(result.exitCode, null)
})

test('opening a control channel is also covered by the deadline and aborted without repeating the command', async t => {
  let callback
  const control = new Channel()
  const client = { exec(_command, cb) { callback = cb } }
  const f = fixture(t, { stopProcess: (value, signal) => stop.stopSshCommand(client, value, signal) })
  const running = f.shell.run('quiet command')
  f.channel.identify()
  const stopping = f.shell.interrupt()
  const rejected = assert.rejects(stopping, /10 秒内未确认/)
  await tick()
  assert.equal(typeof callback, 'function')
  f.expire()
  await rejected
  callback(null, control)
  assert.equal(control.closes, 1, 'a late control channel must be released')
  assert.equal(f.channel.writes.length, 1)
  assert.equal(f.channel.signals.length, 0)
  assert.equal(f.shell.running, true)
  f.shell.dispose()
  await running
})

test('missing process identity is a reported failure rather than a guessed PID kill', async t => {
  let calls = 0
  const f = fixture(t, { stopProcess: async () => { calls++ } })
  const running = f.shell.run('not identified yet')
  await assert.rejects(f.shell.interrupt(), /进程身份/)
  assert.equal(calls, 0)
  assert.equal(f.channel.closes, 0)
  assert.equal(f.shell.running, true)
  f.shell.dispose()
  assert.equal((await running).sessionLost, true)
})

test('disposing during a stop settles both promises without resurrecting a command channel', async t => {
  let confirm
  const f = fixture(t, { stopProcess: () => new Promise(resolve => { confirm = resolve }) })
  const running = f.shell.run('quiet command')
  f.channel.identify()
  const stopping = f.shell.interrupt()
  await tick()
  f.shell.dispose()
  assert.equal(await stopping, false)
  assert.equal((await running).sessionLost, true)
  const closes = f.channel.closes
  confirm()
  await tick()
  assert.equal(f.channel.closes, closes)
  assert.deepEqual(f.closed, [])
})

test('control-channel success requires its explicit verification marker and successful exit', async () => {
  for (const [output, code, ok] of [
    ['__CT_REMOTE_STOP__stopped\n', 0, true],
    ['__CT_REMOTE_STOP__unconfirmed\n', 0, false],
    ['', 0, false], ['__CT_REMOTE_STOP__stopped\n', 1, false]
  ]) {
    const channel = new Channel()
    const client = { exec(command, callback) {
      assert.match(command, /ps -e -o pid= -o ppid=/)
      callback(null, channel)
    } }
    const result = stop.stopSshCommand(client, identity, new AbortController().signal)
    const settled = ok ? result : assert.rejects(result, /未确认/)
    channel.emit('data', Buffer.from(output.slice(0, 8)))
    channel.emit('data', Buffer.from(output.slice(8)))
    channel.emit('close', code)
    await settled
  }
})

test('invalid process identities are rejected before opening any control channel', async () => {
  for (const value of [{ ...identity, pid: 1 }, { ...identity, pid: NaN }, { ...identity, started: "x'; kill -1; '" }]) {
    const client = { exec() { assert.fail('invalid identity must never reach SSH') } }
    await assert.rejects(stop.stopSshCommand(client, value, new AbortController().signal), /进程身份/)
  }
})

test('control-channel open failures and cancellation are reported without waiting on a close event', async () => {
  const failure = { exec(_command, callback) { callback(new Error('server refused exec')) } }
  await assert.rejects(stop.stopSshCommand(failure, identity, new AbortController().signal), /server refused exec/)
  const controller = new AbortController()
  controller.abort()
  const aborted = { exec() { assert.fail('an aborted stop must not request a channel') } }
  await assert.rejects(stop.stopSshCommand(aborted, identity, controller.signal), /取消/)
})
