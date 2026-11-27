// User-run offline regression: node --test tests/extra-terminal-pty.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function compile(relative) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  return new Script(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText)
}
const compiled = compile('../src/main/extra-terminals.ts')
const transcript = {}
compile('../src/main/ssh-pty-transcript.ts').runInNewContext({ exports: transcript })
const plain = value => JSON.parse(JSON.stringify(value))

class Channel extends EventEmitter {
  stderr = new EventEmitter()
  writes = []
  writableLength = 0
  closed = false
  write(data) { this.writes.push(data) }
  close() { this.closed = true; this.emit('close') }
}

function fixture() {
  const requests = [], changes = []
  const timers = new Set(), exports = {}
  const dependencies = {
    'node:crypto': { randomUUID }, 'node:string_decoder': { StringDecoder },
    './commands': {}, './shell': {}, './ssh-pty-transcript': transcript
  }
  compiled.runInNewContext({
    exports, Buffer,
    require(name) { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] },
    setTimeout(callback) { timers.add(callback); return callback },
    clearTimeout(callback) { timers.delete(callback) }
  })
  const terminals = new exports.ExtraTerminals({
    target: () => ({ transport: 'ssh', hostId: 'remote-a', label: 'Test server', cwd: '/work' }),
    openSsh: (hostId, cwd, size) => new Promise(resolve => requests.push({ hostId, cwd, size, resolve })),
    sshHome: () => '/home/tester',
    onChanged: state => changes.push(plain(state))
  })
  const open = async (index, channel = new Channel()) => {
    requests[index].resolve(channel)
    await Promise.resolve()
    return channel
  }
  const state = id => plain(terminals.getState().terminals.find(tab => tab.id === id))
  return { terminals, requests, changes, open, state,
    flush() {
      for (const callback of [...timers]) { timers.delete(callback); callback() }
    }
  }
}

test('new SSH tabs display command echoes, split UTF-8 output and partial prompts separately', async () => {
  const f = fixture()
  const first = f.terminals.create().id, second = f.terminals.create().id
  assert.deepEqual(plain(f.requests.map(({ hostId, cwd }) => ({ hostId, cwd }))), [
    { hostId: 'remote-a', cwd: '/work' }, { hostId: 'remote-a', cwd: '/work' }
  ])
  const a = await f.open(0), b = await f.open(1)
  a.emit('data', Buffer.from('\x1b[?20'))
  a.emit('data', Buffer.from('04htester@host:~/demo$ '))
  await f.terminals.input(first, 'ls\npwd')
  assert.deepEqual(a.writes, ['\x1b[200~ls\npwd\x1b[201~\r'])
  assert.equal(f.state(first).cwd, '/home/tester/demo')
  a.emit('data', Buffer.from('ls\r\n'))
  const result = Buffer.from('目录\r\n')
  a.emit('data', result.subarray(0, 2))
  a.emit('data', result.subarray(2))
  b.emit('data', Buffer.from('[sudo] password for tester:'))
  await f.terminals.input(second, 'fixture-password')
  await f.terminals.interrupt(first)
  assert.equal(a.writes.at(-1), '\x03')
  assert.deepEqual(b.writes, ['fixture-password\r'])
  assert.deepEqual(f.state(first).lines.find(line => line.kind === 'command'),
    { kind: 'command', text: 'tester@host:~/demo$ ls', inputEcho: true })
  assert.ok(f.state(first).lines.some(line => line.kind === 'output' && line.text === '目录'))
  assert.equal(f.state(second).lines.at(-1).text, '[sudo] password for tester:')

  f.terminals.close(first)
  assert.equal(a.closed, true)
  assert.equal(b.closed, false)
  assert.equal(f.terminals.getState().terminals.some(tab => tab.id === first), false)
  f.terminals.disposeAll()
  assert.equal(b.closed, true)
})

test('closing during allocation releases the late channel, and a disconnected tab reopens only on request', async () => {
  const f = fixture()
  const removed = f.terminals.create().id
  f.terminals.close(removed)
  const late = await f.open(0)
  assert.equal(late.closed, true)
  const current = f.terminals.create().id
  const old = await f.open(1)
  old.emit('data', Buffer.from('old'))
  old.close()
  await f.terminals.input(current, 'do not replay')
  assert.equal(f.requests.length, 2)
  assert.equal(f.changes.at(-1).terminals[0].alive, false)

  const reopening = f.terminals.openPty(current)
  const newChannel = await f.open(2)
  await reopening
  old.emit('data', Buffer.from('stale'))
  newChannel.emit('data', Buffer.from('new'))
  assert.deepEqual(f.state(current).lines.filter(line => line.kind === 'output').map(line => line.text), ['old', 'new'])
  assert.deepEqual(newChannel.writes, [])
  f.terminals.disposeAll()
})

test('reconnecting preserves output and resetting clears only the selected tab', async () => {
  const f = fixture()
  const selected = f.terminals.create().id
  const sibling = f.terminals.create().id
  const old = await f.open(0)
  const other = await f.open(1)
  old.emit('data', Buffer.from('before reconnect\r\ntester@host:/next$ '))
  other.emit('data', Buffer.from('other tab'))

  const reconnecting = f.terminals.openPty(selected, 'reconnect')
  assert.equal(old.closed, true)
  assert.equal(f.requests[2].cwd, '/next')
  assert.equal(f.changes.at(-1).terminals.find(tab => tab.id === selected).alive, false)
  const replacement = await f.open(2)
  await reconnecting
  replacement.emit('data', Buffer.from('after reconnect'))
  assert.ok(f.state(selected).lines.some(line => line.text === 'before reconnect'))
  assert.deepEqual(replacement.writes, [])

  const resetting = f.terminals.openPty(selected, 'reset')
  assert.equal(replacement.closed, true)
  const reset = await f.open(3)
  await resetting
  reset.emit('data', Buffer.from('after reset'))
  assert.deepEqual(f.state(selected).lines.filter(line => line.kind === 'output').map(line => line.text), ['after reset'])
  assert.equal(f.state(sibling).lines.at(-1).text, 'other tab')
  assert.equal(other.closed, false)
  f.terminals.disposeAll()
})
