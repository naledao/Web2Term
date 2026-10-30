// User-run only: node --test tests/long-task-storage.test.mjs
// Production SQLite methods on an isolated in-memory database. No Electron or user files.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('db.ts', source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ConversationStore')
const converter = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'toExecutionRecord')
const methods = ['createExecution', 'finishExecution', 'setExecutionStatus', 'setFileDeliveryStatus', 'getExecution', 'getExecutionRevision',
  'touchExecutions', 'listExecutions', 'executionsRevision', 'executionsBaseline', 'executionRevisions']
const exports = {}
new Script(ts.transpileModule(converter.getText(ast) + '\nexport class Store {\n' +
  declaration.members.filter(node => methods.includes(node.name?.getText(ast))).map(node => node.getText(ast)).join('\n') + '\n}', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports, parseTaskToolContext: value => value, parseBackgroundOptions: value => value,
  parseReadFilesRequest: () => null })

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE executions (
    message_id TEXT PRIMARY KEY, conversation_id TEXT, command TEXT, description TEXT, timeout_seconds INTEGER,
    status TEXT, output TEXT, created_at INTEGER, kind TEXT, file_request TEXT, delivery_status TEXT,
    background INTEGER, background_options TEXT, task_context TEXT, exit_code INTEGER, started_at INTEGER, finished_at INTEGER
  )`)
  t.after(() => db.close())
  const store = new exports.Store()
  store.db = db
  return { db, store }
}
const command = (messageId = 'command', conversationId = 'chat') => ({ messageId, conversationId, command: 'original command',
  description: '原始描述', timeoutSeconds: 120, status: 'pending', createdAt: 1 })
const plain = value => JSON.parse(JSON.stringify(value))

test('UI histories omit large output while internal reads and explicit output access remain complete', t => {
  const { store } = fixture(t)
  store.createExecution(command())
  store.setExecutionStatus('command', 'running')
  const text = '完整输出\n'.repeat(200000)
  store.finishExecution('command', { status: 'done', exitCode: 0, output: text, finishedAt: 10 })
  const full = store.listExecutions('chat')[0]
  const summary = store.listExecutions('chat', false)[0]
  assert.equal(summary.output, '')
  assert.equal(summary.outputDeferred, true)
  assert.equal(full.output, text)
  assert.equal(store.getExecution('command').output, text)
  const { output, ...metadata } = plain(full)
  const { output: omitted, outputDeferred, ...summaryMetadata } = plain(summary)
  assert.deepEqual(summaryMetadata, metadata)
  assert.ok(JSON.stringify(summary).length < 2000)
  assert.equal(store.listExecutions('other', false).length, 0)
})

test('execution revisions invalidate on every lifecycle write and duplicate admission remains blocked', t => {
  const { store } = fixture(t)
  const before = store.getExecutionRevision('chat')
  assert.equal(store.createExecution(command()), true)
  assert.ok(store.getExecutionRevision('chat') > before)
  let version = store.getExecutionRevision('chat')
  assert.equal(store.createExecution(command()), false)
  assert.equal(store.getExecutionRevision('chat'), version)
  for (const write of [
    () => store.setExecutionStatus('command', 'running'),
    () => store.finishExecution('command', { status: 'done', exitCode: 0, output: 'result', finishedAt: 20 }),
    () => store.setFileDeliveryStatus('command', 'sent')
  ]) {
    write()
    assert.ok(store.getExecutionRevision('chat') > version)
    version = store.getExecutionRevision('chat')
  }
})

test('one busy conversation does not invalidate another, while bulk writes invalidate every cursor', t => {
  const { store } = fixture(t)
  store.createExecution(command('quiet', 'quiet-chat'))
  const quiet = store.getExecutionRevision('quiet-chat')
  store.createExecution(command('busy', 'busy-chat'))
  store.setExecutionStatus('busy', 'running')
  store.finishExecution('busy', { status: 'done', exitCode: 0, output: 'result', finishedAt: 20 })
  store.setExecutionStatus('missing', 'running')
  assert.equal(store.getExecutionRevision('quiet-chat'), quiet)
  const busy = store.getExecutionRevision('busy-chat')
  store.touchExecutions()
  assert.ok(store.getExecutionRevision('quiet-chat') > quiet)
  assert.ok(store.getExecutionRevision('busy-chat') > busy)
})

test('lazy focus output reads reject another conversation, replaced branches and stale owners', () => {
  const runtimeSource = readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8')
  const runtimeAst = ts.createSourceFile('runtime.ts', runtimeSource, ts.ScriptTarget.Latest, true)
  const runtime = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
  const method = runtime.members.find(node => node.name?.getText(runtimeAst) === 'readFocusExecutionOutput')
  const out = {}
  new Script(ts.transpileModule('export class Runtime {' + method.getText(runtimeAst) + '}', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports: out })
  const instance = new out.Runtime(), owner = { sessionId: 's', platformId: 'chatgpt', conversationId: 'chat' }
  let current = true, reads = 0
  const archived = new Set()
  instance.ownsFocus = () => current
  instance.focusChat = { supersededExecutionIds: () => archived }
  instance.options = { store: { getExecution(id) { reads++; return { conversationId: id === 'other' ? 'other-chat' : 'chat', output: '完整输出' } } } }
  assert.equal(instance.readFocusExecutionOutput(owner, 'command'), '完整输出')
  assert.equal(instance.readFocusExecutionOutput(owner, 'other'), null)
  archived.add('command')
  assert.equal(instance.readFocusExecutionOutput(owner, 'command'), null)
  current = false
  assert.equal(instance.readFocusExecutionOutput(owner, 'command'), null)
  assert.equal(reads, 3)
})
