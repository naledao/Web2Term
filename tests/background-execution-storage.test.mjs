// User-run only: node --test tests/background-execution-storage.test.mjs
// Real SQL and store methods against in-memory SQLite; no user DB, Electron or processes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

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
const context = { module: { exports: null }, parseReadFilesRequest: () => null }
new Script(ts.transpileModule(isolated, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext(context)
const Store = context.module.exports
const record = (messageId, background) => ({ messageId, conversationId: 'chat-a', command: 'gh auth login --web',
  description: '登录', timeoutSeconds: 30, status: 'pending', createdAt: 1, background })

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

test('old execution tables migrate with foreground defaults without modifying their records', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema.replace(/\s*background\s+INTEGER NOT NULL DEFAULT 0,/, ''))
    const store = new Store(db)
    store.migrate()
    store.migrate()
    assert.equal(store.createExecution(record('old', undefined)), true)
    assert.equal(store.read('old').background, false)
    assert.equal(store.createExecution(record('new', true)), true)
    assert.equal(store.read('new').background, true)
  } finally { db.close() }
})
