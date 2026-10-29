// User-run only: node --test tests/prompt-log.test.mjs
// Actual metadata writer with in-memory fs; no Electron, real page, network or disk writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function fixture() {
  const exports = {}, records = []
  const source = ts.transpileModule(readFileSync(new URL('../src/main/prompt-log.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(source).runInNewContext({ exports, process: { pid: 7 }, require(name) {
    if (name === 'node:fs') return { mkdirSync() {}, appendFileSync(_path, line) { records.push(JSON.parse(line.slice(line.indexOf(' ') + 1))) } }
    if (name === 'node:os') return { tmpdir: () => 'mock-temp' }
    if (name === 'node:path') return { join }
    throw new Error('Unexpected dependency: ' + name)
  } })
  return { records, write: exports.writePromptDiagnostic }
}
const state = { taskPromptInjected: true, taskPromptGeneration: 3, taskActive: true, currentPage: true }
const settled = { event: 'task-finished', live: true, completed: false, taskPromptGeneration: 3 }

test('settled prose without a marker is an observation only for the current active task', () => {
  const f = fixture()
  const main = { ...state }, before = structuredClone(main)
  assert.ok(f.write('deepseek', { ...settled, text: 'private reply', rawJson: 'private tool data' }, main))
  assert.deepEqual(main, before, 'diagnostics do not complete, reset or penalize a task')
  assert.equal(f.records[0].event, 'reply-without-completion')
  assert.equal(f.records[0].completed, false)
  assert.equal(f.records[0].taskActive, true)
  assert.ok(!JSON.stringify(f.records).includes('private'))
  for (const patch of [{ live: false }, { completed: true }, { taskPromptGeneration: 2 }]) {
    assert.equal(f.write('deepseek', { ...settled, ...patch }, state), null)
  }
  for (const patch of [{ taskActive: false }, { currentPage: false }]) {
    assert.equal(f.write('deepseek', settled, { ...state, ...patch }), null)
  }
  for (const event of ['question', 'command', 'parse-failed']) assert.equal(f.write('deepseek', { ...settled, event }, state), null)
  assert.equal(f.records.length, 1)
})

test('protocol diagnostics retain only bounded version, form and sizes from confirmed sends', () => {
  const f = fixture()
  f.write('deepseek', { event: 'sent', promptInjected: false, replyProtocolVersion: 1, replyProtocolKind: 'short',
    replyProtocolLength: 90, text: 'private goal', prefixHead: 'private prompt' }, state)
  const record = f.records[0]
  assert.equal(record.replyProtocolVersion, 1)
  assert.equal(record.replyProtocolKind, 'short')
  assert.equal(record.replyProtocolLength, 90)
  assert.equal(record.promptInjected, false)
  assert.ok(!JSON.stringify(record).includes('private'))
  f.write('deepseek', { event: 'sent', replyProtocolVersion: -1, replyProtocolKind: 'private-kind', replyProtocolLength: Infinity }, state)
  assert.equal(f.records[1].replyProtocolVersion, undefined)
  assert.equal(f.records[1].replyProtocolKind, undefined)
  assert.equal(f.records[1].replyProtocolLength, undefined)
})
