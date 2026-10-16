// User-run offline regressions; no Electron startup, real SSH or databases.
// Run: node --test tests/tool-windows.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({ exports, Error, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}

const { toolWindowReducer: reduce } = load('../src/renderer/src/tool-window-state.ts')
const channels = new Proxy({}, { get(_target, name) { return `fixture:${String(name)}` } })
const shared = load('../src/shared/toolbox.ts', { './types': { IpcChannels: channels } })
const { ToolboxRouter } = load('../src/main/toolbox-router.ts', { '../shared/toolbox': shared })
const { createToolSessionApi } = load('../src/renderer/src/tool-session-api.ts', { '@shared/toolbox': shared })

test('minimize/restore and reopening a toolbox entry keep its original identity and repository', () => {
  let state = reduce([], { type: 'open', sessionId: 'a', kind: 'git', cwd: '/root/简历' })
  const id = state[0].id
  state = reduce(state, { type: 'minimize', id })
  assert.equal(state[0].minimized, true)
  state = reduce(state, { type: 'open', sessionId: 'a', kind: 'git', cwd: '/different' })
  assert.equal(state.length, 1)
  assert.equal(state[0].id, id)
  assert.equal(state[0].cwd, '/root/简历')
  assert.equal(state[0].minimized, false)
  state = reduce(state, { type: 'minimize', id })
  state = reduce(state, { type: 'restore', id })
  assert.equal(state[0].minimized, false)
})

test('tool windows are independent per session; restoring one hides only its siblings', () => {
  let state = []
  for (const [sessionId, kind] of [['a', 'mysql'], ['a', 'redis'], ['b', 'mysql'], ['b', 'nacos']]) {
    state = reduce(state, { type: 'open', sessionId, kind })
  }
  assert.equal(state.filter((item) => item.sessionId === 'a' && !item.minimized).length, 1)
  const bBefore = JSON.stringify(state.filter((item) => item.sessionId === 'b'))
  state = reduce(state, { type: 'restore', id: 'a:mysql' })
  assert.equal(state.find((item) => item.id === 'a:mysql').minimized, false)
  assert.equal(state.find((item) => item.id === 'a:redis').minimized, true)
  assert.equal(JSON.stringify(state.filter((item) => item.sessionId === 'b')), bBefore)
  state = reduce(state, { type: 'close', id: 'a:mysql' })
  assert.equal(state.some((item) => item.id === 'a:mysql'), false)
  state = reduce(state, { type: 'retain', sessionIds: ['b'] })
  assert.equal(state.length, 2)
  assert.ok(state.every((item) => item.sessionId === 'b'))
  const unchanged = reduce(state, { type: 'restore', id: 'deleted' })
  assert.equal(unchanged, state)
})

test('pending follow-up reads and writes always use their source session, even after selection changes', async () => {
  const sessions = new Map([['a', { id: 'a' }], ['b', { id: 'b' }]])
  const router = new ToolboxRouter((id) => sessions.get(id))
  const calls = []
  let release
  const wait = new Promise((resolve) => { release = resolve })
  router.register('getGitLog', async (runtime, cwd, mode) => {
    if (mode === 'files') await wait
    calls.push([runtime.id, cwd, mode])
    return { isRepo: true }
  })
  router.register('executeMysqlSql', (runtime, draft, database, sql) => {
    calls.push([runtime.id, draft.host, database, sql])
    return { ok: true }
  })
  const api = Object.freeze({ invokeToolbox: (request) => Promise.resolve(router.invoke(request)) })
  const a = createToolSessionApi(api, 'a')
  const b = createToolSessionApi(api, 'b')
  const pending = a.getGitLog('/repo-a', 'files').then(() => a.getGitLog('/repo-a', 'stats'))
  await b.getGitLog('/repo-b', 'files-no-wait')
  release()
  await pending
  await a.executeMysqlSql({ host: 'db-a' }, 'a_db', 'SELECT 1')
  assert.deepEqual(calls, [
    ['b', '/repo-b', 'files-no-wait'], ['a', '/repo-a', 'files'], ['a', '/repo-a', 'stats'],
    ['a', 'db-a', 'a_db', 'SELECT 1']
  ])
  sessions.delete('a')
  assert.throws(() => a.getGitLog('/repo-a'), /原会话已关闭/)
  assert.equal(calls.length, 4)
})

test('native Nacos visibility and event subscriptions carry the original session; frozen bridge is supported', () => {
  const calls = []
  const listener = () => {}
  const original = Object.freeze({
    setNacosVisible: (...args) => calls.push(['visible', ...args]),
    setNacosBounds: (...args) => calls.push(['bounds', ...args]),
    sendNacosCommand: (...args) => calls.push(['command', ...args]),
    onNacosState: (...args) => { calls.push(['listen', ...args]); return listener },
    onMysqlConnectionChanged: (...args) => { calls.push(['mysql-listen', ...args]); return listener },
    onRedisConnectionChanged: (...args) => { calls.push(['redis-listen', ...args]); return listener },
    onNacosConnectionChanged: (...args) => { calls.push(['nacos-listen', ...args]); return listener },
    unrelated: () => 42
  })
  const a = createToolSessionApi(original, 'a')
  const b = createToolSessionApi(original, 'b')
  a.setNacosVisible(false)
  b.setNacosVisible(true)
  a.setNacosBounds({ x: 1, y: 2, width: 100, height: 100 })
  b.sendNacosCommand('reload')
  assert.equal(a.onNacosState(listener), listener)
  assert.equal(a.onMysqlConnectionChanged(listener), listener)
  assert.equal(b.onRedisConnectionChanged(listener), listener)
  assert.equal(a.onNacosConnectionChanged(listener), listener)
  assert.equal(a.unrelated(), 42)
  assert.deepEqual(calls.map((call) => [call[0], call.at(-1)]), [
    ['visible', 'a'], ['visible', 'b'], ['bounds', 'a'], ['command', 'b'], ['listen', 'a'],
    ['mysql-listen', 'a'], ['redis-listen', 'b'], ['nacos-listen', 'a']
  ])
  assert.equal(original.setNacosVisible, Object.getOwnPropertyDescriptor(original, 'setNacosVisible').value)
})

test('router rejects missing sessions, invalid args and operations outside the toolbox allowlist', () => {
  const router = new ToolboxRouter((id) => id === 'a' ? { id } : undefined)
  let calls = 0
  router.register('listRedisConnections', () => { calls++; return [] })
  const request = { sessionId: 'a', method: 'listRedisConnections', args: [] }
  for (const bad of [null, { ...request, method: 'runTerminalCommand' }, { ...request, method: '__proto__' },
    { ...request, args: null }, { ...request, args: Array(9).fill('x') }, { ...request, sessionId: '' }]) {
    assert.throws(() => router.invoke(bad), /工具请求无效/)
  }
  assert.throws(() => router.invoke({ ...request, sessionId: 'missing' }), /原会话已关闭/)
  assert.equal(calls, 0)
  router.invoke(request)
  assert.equal(calls, 1)
})
