// User-run only: node --test tests/ssh-file-editor-state.test.mjs tests/ssh-file-edit.test.mjs
// Actual editor callbacks with synthetic React refs/bridge responses; no UI, Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/components/SshFileEditor.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('SshFileEditor.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
function callback(name, context) {
  function find(node) {
    if (name === 'mount' && ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0]?.getText(ast).includes('alive.current = true')) return node.arguments[0]
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) return node.initializer
    return ts.forEachChild(node, find)
  }
  const node = find(ast)
  assert.ok(node, name)
  return new Script(ts.transpileModule('(' + node.getText(ast) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText).runInContext(context)
}
const target = { sessionId: 'workspace-a', hostId: 'host-a', path: '/project/.env' }
const original = { ...target, content: 'PORT=8080\n', revision: 'a'.repeat(64), size: 10, bom: false, lineEnding: 'LF' }
function fixture() {
  const state = { file: null, value: '', loading: true, saving: false, error: '', message: '', confirmation: null }
  const reads = [], saves = []
  let closed = 0, refreshed = 0
  const context = createContext({ Error, target, alive: { current: false }, revision: { current: 0 }, operation: { current: null },
    connectedRef: { current: true }, useCallback: fn => fn,
    file: null, value: '', dirty: false,
    ...Object.fromEntries(Object.keys(state).map(key => ['set' + key[0].toUpperCase() + key.slice(1), value => { state[key] = value; context[key] = value }])),
    onClose() { closed++ }, onSaved() { refreshed++ },
    window: { api: {
      readSshTextFile: () => new Promise(resolve => reads.push(resolve)),
      saveSshTextFile: request => { saves.push(request); return Promise.resolve({ status: 'conflict' }) }
    } }
  })
  const mount = callback('mount', context), load = callback('load', context)
  context.load = load
  return { state, context, reads, saves, mount, load, close: callback('close', context), reload: callback('reload', context),
    save: callback('save', context), closed: () => closed, refreshed: () => refreshed }
}

test('StrictMode effect replay reuses the pending initial read instead of leaving the editor stuck loading', async () => {
  const f = fixture(), cleanup = f.mount()
  const first = f.load()
  cleanup()
  f.mount()
  const second = f.load()
  assert.equal(f.reads.length, 1)
  f.reads[0](original)
  await Promise.all([first, second])
  assert.equal(f.state.value, original.content)
  assert.equal(f.state.loading, false)
  assert.equal(f.context.operation.current, null)
})

test('a read finishing after the editor closes cannot restore its file or draft', async () => {
  const f = fixture(), cleanup = f.mount(), pending = f.load()
  cleanup()
  f.reads[0](original)
  await pending
  assert.equal(f.state.file, null)
  assert.equal(f.state.value, '')
})

test('closing and reloading preserve dirty content until the user explicitly discards it', () => {
  const f = fixture()
  f.context.dirty = true
  f.context.value = 'PORT=9090\n'
  f.close()
  assert.equal(f.closed(), 0)
  assert.equal(f.state.confirmation, 'close')
  f.reload()
  assert.equal(f.state.confirmation, 'reload')
  assert.equal(f.reads.length, 0)
  assert.equal(f.context.value, 'PORT=9090\n')
  f.context.operation.current = 'save'
  f.context.dirty = false
  f.close()
  assert.equal(f.closed(), 0, 'an in-progress save must be allowed to finish')
  f.context.operation.current = null
  f.close()
  assert.equal(f.closed(), 1)
})

test('a save conflict retains the draft and original revision without claiming success', async () => {
  const f = fixture()
  f.mount()
  f.context.file = original
  f.context.value = 'PORT=9090\n'
  f.context.dirty = true
  await f.save()
  assert.equal(f.saves[0].content, 'PORT=9090\n')
  assert.equal(f.context.value, 'PORT=9090\n')
  assert.equal(f.context.file.revision, original.revision)
  assert.match(f.state.error, /其他程序修改/)
  assert.equal(f.state.saving, false)
  assert.equal(f.refreshed(), 0)
})

test('a disconnected original host cannot start a save', async () => {
  const f = fixture()
  f.mount()
  Object.assign(f.context, { file: original, value: 'PORT=9090\n', dirty: true })
  f.context.connectedRef.current = false
  await f.save()
  assert.equal(f.saves.length, 0)
  assert.equal(f.context.value, 'PORT=9090\n')
})
