// User-run only. Synthetic SQLite and file metadata; no Electron, real database or network.
// Run: node --test tests/startup-splash.test.mjs tests/startup-theme.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../src/main/startup-theme.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText
function fixture({ exists = true, value, failure } = {}) {
  const calls = [], warnings = [], exports = {}
  class Database {
    constructor(path, options) {
      calls.push(['open', path, options])
      if (failure === 'open') throw new Error('private database details')
    }
    prepare(sql) {
      calls.push(['prepare', sql])
      if (failure === 'query') throw new Error('private database details')
      return { get(key) { calls.push(['get', key]); return value === undefined ? undefined : { value } } }
    }
    close() { calls.push(['close']) }
  }
  new Script(source).runInNewContext({ exports, console: { warn: (...args) => warnings.push(args.join(' ')) }, require(name) {
    if (name === 'node:fs') return { existsSync: () => exists }
    if (name === 'node:sqlite') return { DatabaseSync: Database }
    assert.fail('Unexpected dependency: ' + name)
  } })
  return { read: exports.readStartupTheme, calls, warnings }
}

test('bootstrap reads the saved theme through a read-only connection and closes it before full initialization', () => {
  for (const [value, expected] of [['dark', 'dark'], ['light', 'light'], [undefined, 'light'], ['invalid', 'light']]) {
    const f = fixture({ value })
    assert.equal(f.read('/profile/conversations.db'), expected)
    assert.equal(f.calls[0][1], '/profile/conversations.db')
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0][2])), { readOnly: true })
    assert.deepEqual(f.calls.slice(1), [['prepare', 'SELECT value FROM settings WHERE key = ?'], ['get', 'theme'], ['close']])
    assert.deepEqual(f.warnings, [])
  }
})

test('first launch uses the application default without creating a database', () => {
  const f = fixture({ exists: false })
  assert.equal(f.read('/profile/conversations.db'), 'light')
  assert.deepEqual(f.calls, [])
})

test('a failed bootstrap read leaves database error reporting to normal startup and closes any open connection', () => {
  for (const failure of ['open', 'query']) {
    const f = fixture({ failure })
    assert.equal(f.read('/profile/conversations.db'), 'light')
    assert.equal(f.warnings.length, 1)
    assert.doesNotMatch(f.warnings[0], /private database details/)
    assert.equal(f.calls.some(call => call[0] === 'close'), failure === 'query')
  }
})
