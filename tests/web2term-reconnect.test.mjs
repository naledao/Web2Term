// User-run offline regression: node --test tests/web2term-reconnect.test.mjs
// No Electron, WebSocket, shell processes or backend calls.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as events from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const exports = {}
const source = readFileSync(new URL('../src/main/web2term-shell.ts', import.meta.url), 'utf8')
const dependencies = {
  'node:crypto': crypto, 'node:events': events,
  './remote-shell': { RemoteShell: class { constructor() { throw new Error('A real shell must not start') } } },
  './environment': { REMOTE_DETECT_COMMAND: 'fixture probe' }
}
new Script(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports, Buffer, queueMicrotask, clearTimeout, setTimeout,
  require: (name) => { assert.ok(name in dependencies, `Unexpected import ${name}`); return dependencies[name] }
})
const { Web2termShell, parseWeb2termBinding, restoreWeb2termSessions } = exports
const DEVICE_A = '00000000-1234-5678-9abc-0123456789ab'
const DEVICE_B = '00000001-1234-5678-9abc-0123456789ab'
const binding = (patch = {}) => ({ agentId: DEVICE_A, deviceName: 'Fixture device', backendUrl: 'https://example.invalid', userId: 'owner', ...patch })

function connection(patch = {}) {
  const calls = []
  const state = { status: 'idle', agentId: DEVICE_A, auth: { status: 'signed-in', backendUrl: 'https://example.invalid', user: { publicId: 'owner' } }, ...patch }
  return { state, calls, getState: () => state,
    connect(draft) { calls.push(draft); state.agentId = draft.agentId; state.status = 'connecting'; return state },
    terminals: {
      subscribe: () => () => {}, getState: () => ({ connectionId: 'route', sessions: [] }),
      open() { throw new Error('No ready transport exists in this fixture') },
      close() { throw new Error('No terminal was opened in this fixture') }
    }
  }
}

test('restores the visible device first and at most three of its sessions on one route', () => {
  const relay = connection()
  const other = new Web2termShell(binding({ agentId: DEVICE_B }), relay)
  const same = Array.from({ length: 4 }, () => new Web2termShell(binding(), relay))
  const preferred = same[3]
  assert.equal(restoreWeb2termSessions(relay, [other, ...same], preferred), 3)
  assert.equal(relay.calls.length, 3)
  assert.ok(relay.calls.every((call) => call.agentId === DEVICE_A))
  assert.equal(preferred.needsConnection, true)
  assert.equal(same[0].needsConnection, true)
  assert.equal(same[1].needsConnection, true)
  assert.equal(same[2].needsConnection, false)
  assert.equal(other.needsConnection, false)
})

test('with a local session visible, restores the saved device rather than cycling through devices', () => {
  const relay = connection({ agentId: DEVICE_B })
  const first = new Web2termShell(binding(), relay)
  const lastDevice = new Web2termShell(binding({ agentId: DEVICE_B }), relay)
  assert.equal(restoreWeb2termSessions(relay, [first, lastDevice], null), 1)
  assert.equal(relay.calls[0].agentId, DEVICE_B)
  assert.equal(first.needsConnection, false)
})

test('restored working directory and explicit close survive a save/reload cycle', () => {
  const relay = connection()
  const original = new Web2termShell(binding({ cwd: '/home/fixture/project' }), relay)
  assert.equal(original.cwd, '/home/fixture/project')
  original.reconnect()
  assert.equal(original.persistentBinding().reconnect, true)
  original.close()
  const saved = parseWeb2termBinding(JSON.stringify(original.persistentBinding()))
  assert.equal(saved.reconnect, false)
  assert.equal(saved.cwd, '/home/fixture/project')
  const afterRestart = connection()
  const restored = new Web2termShell(saved, afterRestart)
  assert.equal(restoreWeb2termSessions(afterRestart, [restored], restored), 0)
  assert.equal(afterRestart.calls.length, 0)
  restored.reconnect()
  assert.equal(restored.persistentBinding().reconnect, true)
  assert.equal(afterRestart.calls.length, 1)
})

test('normal application shutdown does not turn an open session into an explicit close', () => {
  const relay = connection()
  const shell = new Web2termShell(binding({ cwd: '/home/fixture' }), relay)
  shell.reconnect()
  shell.dispose()
  const saved = parseWeb2termBinding(JSON.stringify(shell.persistentBinding()))
  assert.equal(saved.reconnect, true)
  const afterRestart = connection()
  assert.equal(restoreWeb2termSessions(afterRestart, [new Web2termShell(saved, afterRestart)]), 1)
  assert.equal(afterRestart.calls.length, 1)
})

test('older bindings can resume and invalid working directories are not restored', () => {
  const older = parseWeb2termBinding(JSON.stringify(binding()))
  assert.equal(older.reconnect, true)
  assert.equal(older.cwd, '')
  for (const cwd of ['C:\\Users\\desktop', 'relative', '/bad\u0000path', '/' + 'x'.repeat(32768)]) {
    assert.equal(parseWeb2termBinding(JSON.stringify(binding({ cwd }))).cwd, '')
  }
  assert.equal(parseWeb2termBinding('{'), null)
})

test('login/server mismatches and existing routes never trigger an automatic replacement', () => {
  for (const state of [
    { auth: { status: 'expired', backendUrl: 'https://example.invalid', user: { publicId: 'owner' } } },
    { auth: { status: 'signed-in', backendUrl: 'https://other.invalid', user: { publicId: 'owner' } } },
    { auth: { status: 'signed-in', backendUrl: 'https://example.invalid', user: { publicId: 'other-owner' } } },
    { status: 'connecting' }, { status: 'connected' }
  ]) {
    const relay = connection(state)
    assert.equal(restoreWeb2termSessions(relay, [new Web2termShell(binding(), relay)]), 0)
    assert.equal(relay.calls.length, 0)
  }
})
