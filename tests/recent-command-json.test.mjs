import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
const schema = source.match(/CREATE TABLE IF NOT EXISTS recent_command_json \([\s\S]*?\);\s*CREATE INDEX IF NOT EXISTS idx_recent_command_json_conversation\s+ON recent_command_json \(conversation_id, created_at DESC\);/)?.[0]
assert.ok(schema, 'recent command schema exists')
const start = source.indexOf('  saveRecentCommandJson(')
const end = source.indexOf('  /** Persist one clean chat turn', start)
assert.ok(start >= 0 && end > start, 'recent command persistence method exists')
// The payload check lives in shared/types.ts; bring just those two functions along.
const types = readFileSync(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
const helpersStart = types.indexOf('export function isQuestionPayload(')
const helpersEnd = types.indexOf('\n}', types.indexOf('export function isRecentCommandPayload(')) + 2
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'recent command payload helpers exist')
const helpers = types.slice(helpersStart, helpersEnd).replace(/^export /gm, '')
const isolated = `${helpers}\nclass Store { constructor(db) { this.db = db } ${source.slice(start, end)} }; module.exports = Store`
const compiled = ts.transpileModule(isolated, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const context = { module: { exports: null } }
new Script(compiled).runInNewContext(context)
const Store = context.module.exports

test('stores the complete JSON of only the latest three commands per conversation', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema)
    const store = new Store(db)
    const payload = (n) => JSON.stringify({ command: `Write-${n}`, description: `command ${n}`, timeout_seconds: 120, extra: { index: n } }, null, 2)
    for (let n = 1; n <= 4; n++) store.saveRecentCommandJson('chat-A', `message-${n}`, payload(n))
    store.saveRecentCommandJson('chat-B', 'message-1', payload(8))
    const rows = db.prepare('SELECT message_id, payload_json FROM recent_command_json WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC').all('chat-A')
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((r) => r.message_id).sort(), ['message-2', 'message-3', 'message-4'])
    for (const row of rows) assert.equal(row.payload_json, payload(Number(row.message_id.split('-')[1])))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_command_json WHERE conversation_id = ?').get('chat-B').n, 1)
    store.saveRecentCommandJson('chat-A', 'message-4', payload(99))
    assert.equal(db.prepare('SELECT payload_json FROM recent_command_json WHERE conversation_id = ? AND message_id = ?').get('chat-A', 'message-4').payload_json, payload(4))
    assert.throws(() => store.saveRecentCommandJson('chat-A', 'bad', '{invalid'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_command_json WHERE conversation_id = ?').get('chat-A').n, 3)
  } finally {
    db.close()
  }
})

test('a question JSON is kept alongside commands, and other objects are still refused', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema)
    const store = new Store(db)
    const question = JSON.stringify({ type: 'questions', questions: [{ question: '下一步？', options: [{ label: 'A', description: '继续' }] }] })
    store.saveRecentCommandJson('chat-A', 'command-1', JSON.stringify({ command: 'Get-Location' }))
    store.saveRecentCommandJson('chat-A', 'question-1', question)
    assert.equal(store.listRecentCommandJson('chat-A')[0].payloadJson, question)
    assert.throws(() => store.saveRecentCommandJson('chat-A', 'other', JSON.stringify({ type: 'note', text: 'x' })))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recent_command_json WHERE conversation_id = ?').get('chat-A').n, 2)
  } finally {
    db.close()
  }
})
