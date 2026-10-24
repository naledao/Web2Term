// User-run offline regressions. All filesystem and Electron operations are mocked.
// Run: node --test tests/app-identity.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/app-identity.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const root = join('synthetic', 'app-data')
const modern = join(root, 'Web2Term')
const legacyProduct = join(root, 'GPT Web to Codex Terminal')
const legacyPackage = join(root, 'gpt-web-to-codex-terminal')

function configure({ packaged = true, existing = [] } = {}) {
  const module = { exports: {} }
  const paths = new Map()
  const calls = []
  const electron = { app: {
    isPackaged: packaged,
    getPath(name) { assert.equal(name, 'appData'); return root },
    setName(name) { calls.push(['name', name]) },
    setPath(name, path) {
      assert.deepEqual(calls[0], ['mkdir', path, true])
      calls.push(['path', name, path])
      paths.set(name, path)
    }
  } }
  const modules = {
    electron,
    'node:path': { join },
    'node:fs': {
      existsSync(path) { return existing.includes(path) },
      mkdirSync(path, options) { calls.push(['mkdir', path, options.recursive]) }
    }
  }
  new Script(code).runInNewContext({ module, exports: module.exports, require(name) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`)
    return modules[name]
  } })
  module.exports.configureAppIdentity()
  assert.deepEqual(calls[1], ['name', 'Web2Term'])
  assert.equal(paths.get('sessionData'), paths.get('userData'), 'cookies and the database must share the selected profile')
  return paths.get('userData')
}

test('a fresh installation uses the Web2Term profile', () => {
  assert.equal(configure(), modern)
})

test('an existing Web2Term database takes precedence over legacy databases', () => {
  assert.equal(configure({ existing: [modern, legacyProduct, legacyPackage,
    join(modern, 'conversations.db'), join(legacyProduct, 'conversations.db'),
    join(legacyPackage, 'conversations.db')] }), modern)
})

test('an empty new profile does not hide a previous installed database', () => {
  assert.equal(configure({ existing: [modern, legacyProduct,
    join(legacyProduct, 'conversations.db')] }), legacyProduct)
})

test('when both legacy databases exist, retain the profile for the current run mode', () => {
  const existing = [legacyProduct, legacyPackage, join(legacyProduct, 'conversations.db'),
    join(legacyPackage, 'conversations.db')]
  assert.equal(configure({ existing }), legacyProduct)
  assert.equal(configure({ packaged: false, existing }), legacyPackage)
})

test('a legacy development database remains available after the package rename', () => {
  assert.equal(configure({ packaged: false, existing: [modern, legacyPackage,
    join(legacyPackage, 'conversations.db')] }), legacyPackage)
})

test('a legacy profile without a database is retained for its existing cookies', () => {
  assert.equal(configure({ existing: [legacyProduct] }), legacyProduct)
})
