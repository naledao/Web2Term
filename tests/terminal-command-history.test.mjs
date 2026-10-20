// User-run offline regression: node --test tests/terminal-command-history.test.mjs
// No Electron startup, UI automation or network access.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const exports = {}
const source = readFileSync(new URL('../src/renderer/src/terminal-command-history.ts', import.meta.url), 'utf8')
new Script(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports })
const { TerminalCommandHistory, terminalCommandHistory, navigateCommandHistory, canNavigateCommandHistory } = exports
const commands = (...texts) => texts.map((text) => ({ kind: 'command', text }))

test('keeps complete multiline input, skips blank input and consecutive duplicates', () => {
  const history = new TerminalCommandHistory()
  history.remember('  ')
  history.remember('git status')
  history.remember('git status')
  history.remember('printf first\r\nprintf second')
  assert.deepEqual(Array.from(history.snapshot()), ['git status', 'printf first\nprintf second'])
  const snapshot = history.snapshot()
  snapshot.push('not executed')
  assert.equal(history.snapshot().length, 2)
})

test('output updates and transcript trimming do not duplicate or reorder commands', () => {
  const history = new TerminalCommandHistory()
  history.observe(commands('pwd', 'ls'))
  history.observe([...commands('pwd', 'ls'), { kind: 'output', text: '/root' }])
  assert.deepEqual(Array.from(history.snapshot()), ['pwd', 'ls'])
  history.remember('git status')
  history.observe(commands('ls', 'git status'))
  assert.deepEqual(Array.from(history.snapshot()), ['pwd', 'ls', 'git status'])
  history.observe(commands('git status', 'pwd'))
  assert.deepEqual(Array.from(history.snapshot()), ['pwd', 'ls', 'git status', 'pwd'])
  history.observe([])
  history.observe(commands('whoami'))
  assert.equal(history.snapshot().at(-1), 'whoami')
})

test('bounds retained input by count and characters', () => {
  const history = new TerminalCommandHistory()
  for (let index = 0; index < 205; index++) history.remember(`command ${index}`)
  assert.equal(history.snapshot().length, 200)
  assert.equal(history.snapshot()[0], 'command 5')
  const large = new TerminalCommandHistory()
  large.remember('x'.repeat(120_000))
  large.remember('y'.repeat(120_000))
  large.remember('z'.repeat(200_001))
  assert.equal(large.snapshot().length, 1)
  assert.equal(large.snapshot()[0], 'y'.repeat(120_000))
})

test('retains history across a session remount and isolates connections and sessions', () => {
  const local = terminalCommandHistory('history-test-session', 'local')
  local.remember('local command')
  assert.equal(terminalCommandHistory('history-test-session', 'local'), local)
  assert.equal(terminalCommandHistory('history-test-session', 'ssh:host-a').snapshot().length, 0)
  assert.equal(terminalCommandHistory('history-test-session', 'web2term:device-a').snapshot().length, 0)
  assert.equal(terminalCommandHistory('history-test-other-session', 'local').snapshot().length, 0)
})

test('Up traverses newest to oldest, Down restores the unsent draft', () => {
  assert.equal(navigateCommandHistory(null, [], 'draft', 'up'), null)
  assert.equal(navigateCommandHistory(null, ['one'], 'draft', 'down'), null)
  let recalled = navigateCommandHistory(null, ['one', 'two'], 'unsent draft', 'up')
  assert.equal(recalled.value, 'two')
  recalled = navigateCommandHistory(recalled.cursor, ['one', 'two'], recalled.value, 'up')
  assert.equal(recalled.value, 'one')
  recalled = navigateCommandHistory(recalled.cursor, ['one', 'two'], recalled.value, 'up')
  assert.equal(recalled.value, 'one')
  recalled = navigateCommandHistory(recalled.cursor, ['one', 'two'], recalled.value, 'down')
  assert.equal(recalled.value, 'two')
  recalled = navigateCommandHistory(recalled.cursor, ['one', 'two'], recalled.value, 'down')
  assert.equal(recalled.value, 'unsent draft')
  assert.equal(recalled.cursor, null)
})

test('new AI commands cannot shift the history being browsed', () => {
  const entries = ['one', 'two']
  let recalled = navigateCommandHistory(null, entries, '', 'up')
  entries.push('AI command')
  recalled = navigateCommandHistory(recalled.cursor, entries, recalled.value, 'up')
  assert.equal(recalled.value, 'one')
  recalled = navigateCommandHistory(recalled.cursor, entries, recalled.value, 'down')
  assert.equal(recalled.value, 'two')
  recalled = navigateCommandHistory(recalled.cursor, entries, recalled.value, 'down')
  assert.equal(recalled.value, '')
  assert.equal(navigateCommandHistory(null, entries, '', 'up').value, 'AI command')
})

test('multiline cursor movement and selection are preserved except at history boundaries', () => {
  const text = 'first\nsecond\nthird'
  assert.equal(canNavigateCommandHistory(text, 3, 3, 'up'), true)
  assert.equal(canNavigateCommandHistory(text, 8, 8, 'up'), false)
  assert.equal(canNavigateCommandHistory(text, 8, 8, 'down'), false)
  assert.equal(canNavigateCommandHistory(text, 16, 16, 'down'), true)
  assert.equal(canNavigateCommandHistory(text, 0, 3, 'up'), false)
  assert.equal(canNavigateCommandHistory('', 0, 0, 'up'), true)
  assert.equal(canNavigateCommandHistory('pwd', 3, 3, 'down'), true)
})
