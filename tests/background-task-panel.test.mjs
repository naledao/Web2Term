// User-run offline regressions: node --test tests/background-task-panel.test.mjs
// Actual renderer effect with fake IPC/state/storage; no Electron, browser or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App')
const effect = component.body.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect'
  && node.expression.arguments[0].getText(source).includes('onBackgroundTasksChanged'))
assert.ok(effect, 'background registration effect exists')
const compiled = ts.transpileModule('const action = ' + effect.expression.arguments[0].getText(source) + '; action', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
const settle = () => new Promise(setImmediate)
const snapshot = (...ids) => ({ tasks: ids.map(id => ({ id, status: 'running' })) })

function fixture(storage = new Map()) {
  const state = { open: false, collapsed: true, tab: 'terminal', selections: 0 }
  let listener, finish
  const action = new Script(compiled).runInNewContext({
    sessionId: 'session-a', STORAGE_BACKGROUND_TASK_LATEST: 'latest', sessionLayoutKey: (key, id) => `${key}.${id}`,
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      api: { onBackgroundTasksChanged(callback) { listener = callback; return () => { listener = null } },
        getBackgroundTasks: () => new Promise(resolve => { finish = resolve }) } },
    setBackgroundTasksOpen: value => { state.open = value }, setPanelCollapsed: value => { state.collapsed = value },
    setPanelTab: value => { state.tab = value; state.selections++ }
  })
  const cleanup = action()
  return { state, storage, cleanup, finish: value => finish(value),
    push: (value, owner = 'session-a') => listener?.(value, owner) }
}

test('a new task automatically opens, expands and selects the background tab', async () => {
  const f = fixture()
  f.finish(snapshot())
  await settle()
  assert.equal(f.state.selections, 0)
  f.push(snapshot('task-a'))
  assert.equal(f.state.open, true)
  assert.equal(f.state.collapsed, false)
  assert.equal(f.state.tab, 'background')
  assert.equal(f.state.selections, 1)
  f.cleanup()
})

test('logs and status pushes do not reopen a closed tab, while another new task does', async () => {
  const f = fixture()
  f.finish(snapshot())
  await settle()
  f.push(snapshot('task-a'))
  f.state.open = false
  f.state.tab = 'terminal'
  f.push({ tasks: [{ id: 'task-a', status: 'completed', output: 'new log output', creationDeliveryStatus: 'sent' }] })
  assert.equal(f.state.open, false)
  assert.equal(f.state.tab, 'terminal')
  assert.equal(f.state.selections, 1)
  f.push(snapshot('task-a', 'task-b'))
  assert.equal(f.state.open, true)
  assert.equal(f.state.tab, 'background')
  assert.equal(f.state.selections, 2)
  f.cleanup()
})

test('session remounts remember already opened tasks and reveal tasks registered while away', async () => {
  const storage = new Map([['latest.session-a', 'task-a']])
  const known = fixture(storage)
  known.finish(snapshot('task-a'))
  await settle()
  assert.equal(known.state.selections, 0)
  known.cleanup()
  const newer = fixture(storage)
  newer.finish(snapshot('task-a', 'task-b'))
  await settle()
  assert.equal(newer.state.tab, 'background')
  assert.equal(storage.get('latest.session-a'), 'task-b')
  newer.cleanup()
})

test('a newer registration push wins over a stale initial snapshot', async () => {
  const f = fixture()
  f.push(snapshot('task-a', 'task-b'))
  f.finish(snapshot('task-a'))
  await settle()
  assert.equal(f.storage.get('latest.session-a'), 'task-b')
  f.state.tab = 'terminal'
  f.push(snapshot('task-a', 'task-b'))
  assert.equal(f.state.selections, 1)
  assert.equal(f.state.tab, 'terminal')
  f.cleanup()
})

test('other session pushes and late snapshots after unmount cannot change the visible tab', async () => {
  const f = fixture()
  f.push(snapshot('foreign-task'), 'session-b')
  assert.equal(f.state.selections, 0)
  f.cleanup()
  f.finish(snapshot('task-a'))
  await settle()
  assert.equal(f.state.selections, 0)
})
