// User-run only: node --test tests/embed-permissions.test.mjs tests/desktop-notifications.test.mjs
// Mocked Electron permission handlers; no application, real sessions or network access.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function fixture() {
  const partitions = []
  let check, request
  const geminiSession = {
    setPermissionCheckHandler(handler) { check = handler },
    setPermissionRequestHandler(handler) { request = handler }
  }
  const dependencies = {
    electron: { session: { fromPartition(partition) {
      partitions.push(partition)
      assert.equal(partition, 'persist:gemini', 'other chat sessions must retain their permissions')
      return geminiSession
    } } },
    '../shared/platforms': { GEMINI_PLATFORM: { partition: 'persist:gemini' } }
  }
  const exports = {}
  const source = readFileSync(new URL('../src/main/embed-permissions.ts', import.meta.url), 'utf8')
  new Script(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText).runInNewContext({ exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  exports.blockGeminiWebNotifications()
  return { partitions, check, request }
}

test('Gemini reply notifications are denied for pages and service workers', () => {
  const f = fixture()
  assert.deepEqual(f.partitions, ['persist:gemini'])
  for (const contents of [null, { getURL: () => 'https://gemini.google.com/app' }]) {
    assert.equal(f.check(contents, 'notifications', 'https://gemini.google.com', {}), false)
    const decisions = []
    f.request(contents, 'notifications', granted => decisions.push(granted), {})
    assert.deepEqual(decisions, [false])
  }
})

test('microphone, clipboard and storage permissions retain their existing behavior', () => {
  const f = fixture()
  for (const permission of ['media', 'clipboard-read', 'clipboard-sanitized-write', 'persistent-storage', 'storage-access']) {
    assert.equal(f.check(null, permission, 'https://gemini.google.com', {}), true)
    const decisions = []
    f.request(null, permission, granted => decisions.push(granted), {})
    assert.deepEqual(decisions, [true])
  }
})
