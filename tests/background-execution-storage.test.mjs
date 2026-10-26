import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/background-execution-storage.test.mjs
// Real SQL and store methods against in-memory SQLite; no user DB, Electron or processes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const source = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
const schema = source.match(/CREATE TABLE IF NOT EXISTS executions \([\s\S]*?\);/)[0]
const createStart = source.indexOf('  createExecution(record:')
const createEnd = source.indexOf('  /** Persist a complete command', createStart)
const mapStart = source.indexOf('function toExecutionRecord(')
const mapEnd = source.indexOf('\n}\n', mapStart) + 2
const migrationStart = source.indexOf("    for (const [name, definition] of [['kind'")
const migrationEnd = source.indexOf('    const conversationColumns', migrationStart)
const isolated = `
${source.slice(mapStart, mapEnd)}
class Store {
  constructor(db) { this.db = db }
  migrate() { const executionColumns = this.db.prepare('PRAGMA table_info(executions)').all(); ${source.slice(migrationStart, migrationEnd)} }
  ${source.slice(createStart, createEnd)}
  read(id) { return toExecutionRecord(this.db.prepare('SELECT * FROM executions WHERE message_id = ?').get(id)) }
}
module.exports = Store
`
const shared = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/background-tasks.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: shared, URL, require(name) { assert.equal(name, './autonomous-task'); return taskContextModule } })
const taskShared = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/autonomous-task.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: taskShared, structuredClone, require: name => progressVmModules[name] })
const context = { module: { exports: null }, parseReadFilesRequest: () => null, parseBackgroundOptions: shared.parseBackgroundOptions, parseTaskToolContext: taskShared.parseTaskToolContext }
new Script(ts.transpileModule(isolated, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext(context)
const Store = context.module.exports
const record = (messageId, background) => ({ messageId, conversationId: 'chat-a', command: 'gh auth login --web',
  description: '登录', timeoutSeconds: 30, status: 'pending', createdAt: 1, background })

test('desktop and unknown tool discriminators cannot be inserted or reconstructed as shell commands', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema); const store = new Store(db)
    for (const patch of [{ kind: 'computer' }, { kind: 'future-tool' }, { type: 'computer' }, { type: 'read_files' }]) {
      assert.throws(() => store.createExecution({ ...record('invalid', false), ...patch }), /invalid-execution-kind/)
    }
    store.createExecution(record('legacy-row', false))
    db.prepare('UPDATE executions SET kind = ? WHERE message_id = ?').run('computer', 'legacy-row')
    assert.equal(store.read('legacy-row').kind, 'invalid')
  } finally { db.close() }
})

test('software background mode persists through SQL storage and record reconstruction', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema)
    const store = new Store(db)
    assert.equal(store.createExecution(record('background', true)), true)
    assert.equal(store.createExecution(record('foreground', false)), true)
    assert.equal(store.read('background').background, true)
    assert.equal(store.read('foreground').background, false)
    assert.equal(store.createExecution(record('background', true)), false)
  } finally { db.close() }
})

test('service readiness metadata survives storage and replay while old records remain compatible', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema)
    const store = new Store(db)
    const backgroundOptions = { kind: 'service', readiness: { type: 'tcp', port: 44301, timeout_seconds: 180 } }
    assert.equal(store.createExecution({ ...record('service', true), backgroundOptions }), true)
    assert.deepEqual(JSON.parse(JSON.stringify(store.read('service').backgroundOptions)), backgroundOptions)
    assert.equal(store.createExecution(record('legacy', true)), true)
    assert.equal(store.read('legacy').backgroundOptions, undefined)
  } finally { db.close() }
})

test('old execution tables migrate with foreground defaults without modifying their records', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema.replace(/\s*background\s+INTEGER NOT NULL DEFAULT 0,/, '').replace(/\s*background_options\s+TEXT,/, ''))
    const store = new Store(db)
    store.migrate()
    store.migrate()
    assert.equal(store.createExecution(record('old', undefined)), true)
    assert.equal(store.read('old').background, false)
    assert.equal(store.createExecution(record('new', true)), true)
    assert.equal(store.read('new').background, true)
  } finally { db.close() }
})

test('task tool provenance survives SQL and corrupt or conflicting provenance stays explicitly unusable', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema.replace(/\s*task_context\s+TEXT,/, ''))
    const store = new Store(db); store.migrate(); store.migrate()
    const taskContext = { sessionId: 'session-a', platformId: 'deepseek', conversationId: 'chat-a', taskId: 'task-a', generation: 1,
      stepId: '11111111-1111-4111-8111-111111111111', sourceMessageId: 'reply-a', tool: 'command',
      machine: { id: 'machine-a', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\work' } }
    assert.equal(store.createExecution({ ...record('owned', false), taskContext }), true)
    assert.deepEqual(JSON.parse(JSON.stringify(store.read('owned').taskContext)), taskContext)
    assert.equal(store.createExecution(record('unbound', false)), true); assert.equal(store.read('unbound').taskContext, undefined)
    db.prepare('UPDATE executions SET task_context = ? WHERE message_id = ?').run('{bad', 'owned')
    assert.equal(store.read('owned').taskContext, null)
    db.prepare('UPDATE executions SET task_context = ? WHERE message_id = ?').run(JSON.stringify({ ...taskContext, conversationId: 'other-chat' }), 'owned')
    assert.equal(store.read('owned').taskContext, null)
    assert.throws(() => store.createExecution({ ...record('conflict', false), taskContext: { ...taskContext, tool: 'read_files' } }), /Invalid task/)
  } finally { db.close() }
})
