// User-run only: node --test tests/background-task-stop.test.mjs
// Actual UI functions and IPC handler with synthetic tasks; no processes or Electron.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const file = ts.createSourceFile('BackgroundTasksPane.tsx', readFileSync(new URL('../src/renderer/src/components/BackgroundTasksPane.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(predicate, node = file) { return predicate(node) ? node : ts.forEachChild(node, child => find(predicate, child)) }
const names = ['STATUS_LABELS', 'finished', 'timeLabel', 'taskStatusLabel', 'TaskRow', 'StopTaskButton']
const declarations = names.map(name => {
  const node = find(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(file) === name)
  assert.ok(node, name)
  return (ts.isVariableDeclaration(node) ? 'const ' : '') + node.getText(file)
})
const exports = {}
new Script(ts.transpileModule(declarations.join('\n') + '\nexport { TaskRow, StopTaskButton }', {
  fileName: 'task-row.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText).runInNewContext({ exports, require: createRequire(import.meta.url) })

const task = (patch = {}) => ({ id: 'task-a', name: '重启 Web.Public 站点', pid: 28008, transport: 'local', targetLabel: '本机',
  status: 'running', createdAt: 1, message: '', ...patch })

test('the card shows an independent stop button and keeps its log-opening action', () => {
  const calls = [], current = task(), props = { task: current, pending: false, onOpen: value => calls.push(['open', value.id]), onStop: value => calls.push(['stop', value.id]) }
  const tree = exports.TaskRow(props)
  assert.equal(tree.type, 'article', 'the stop button must not be nested in a clickable button')
  assert.equal(tree.props.onClick, undefined)
  const open = tree.props.children[0]
  open.props.onClick()
  const stop = exports.StopTaskButton(props)
  stop.props.onClick()
  assert.deepEqual(calls, [['open', 'task-a'], ['stop', 'task-a']])
  const html = renderToStaticMarkup(React.createElement(exports.TaskRow, props))
  assert.match(html, /停止重启 Web.Public 站点，PID 28008/)
  assert.equal((html.match(/<button\b/g) || []).length, 2)
  assert.match(html, /运行中/)
})

test('pending stops are disabled and finished tasks retain logs without another stop control', () => {
  for (const props of [{ pending: true, task: task() }, { pending: false, task: task({ stopRequestedAt: 10 }) }]) {
    const stop = exports.StopTaskButton({ ...props, onStop() {} })
    assert.equal(stop.props.disabled, true)
    assert.equal(stop.props.children, '停止中…')
  }
  for (const status of ['completed', 'failed', 'exited', 'stopped']) {
    const props = { task: task({ status }), pending: false, onOpen() {}, onStop() {} }
    assert.equal(exports.StopTaskButton(props), null)
    const html = renderToStaticMarkup(React.createElement(exports.TaskRow, props))
    assert.equal((html.match(/<button\b/g) || []).length, 1)
    if (status === 'stopped') assert.match(html, /已停止/)
  }
})

test('ready services show running availability and keep their manual stop control', () => {
  const html = renderToStaticMarkup(React.createElement(exports.TaskRow, { task: task({ backgroundOptions: { kind: 'service' }, startup: { state: 'ready' } }), pending: false, onOpen() {}, onStop() {} }))
  assert.match(html, /已就绪 · 运行中/)
  assert.match(html, /停止重启 Web.Public 站点/)
})

test('the stop IPC is limited to the sending workspace and registered task id', async () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const search = node => ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' &&
    node.arguments[0]?.getText(ast) === 'IpcChannels.backgroundTaskStop' ? node : ts.forEachChild(node, search)
  const call = search(ast)
  assert.ok(call, 'Missing actual stop IPC handler')
  let handler
  const stopped = []
  const runtime = { id: 'workspace-a', backgroundTasks: { async stop(id) { stopped.push(id); return { ok: true, message: 'stopped' } } } }
  new Script(ts.transpileModule(call.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({
    ipcMain: { handle(_channel, callback) { handler = callback } }, IpcChannels: { backgroundTaskStop: 'stop' }, runtimeForEvent: event => event.runtime
  })
  for (const [event, session, id] of [[{}, 'workspace-a', 'task-a'], [{ runtime }, 'workspace-b', 'task-a'],
    [{ runtime }, 'workspace-a', 123], [{ runtime }, 'workspace-a', 'x'.repeat(129)]]) {
    assert.equal((await handler(event, session, id)).ok, false)
  }
  assert.deepEqual(stopped, [])
  assert.equal((await handler({ runtime }, 'workspace-a', 'task-a')).ok, true)
  assert.deepEqual(stopped, ['task-a'])
})
