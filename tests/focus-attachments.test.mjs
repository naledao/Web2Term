// User-run only: node --test tests/focus-attachments.test.mjs
// Actual staging code, synthetic bytes and mocked filesystem. No Electron/network/disk writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(code).runInNewContext({ exports, Buffer, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/focus-chat.ts')
function fixture() {
  const writes = [], removals = []
  let directory
  const api = load('../src/main/focus-attachments.ts', {
    'node:fs/promises': {
      async mkdtemp(prefix) { directory = prefix + 'fixture'; return directory },
      async mkdir() {},
      async writeFile(...args) { writes.push(args) },
      async rm(...args) { removals.push(args) }
    },
    'node:path': path, 'node:os': { tmpdir }, 'node:crypto': { createHash },
    '../shared/focus-chat': shared
  })
  return { api, writes, removals, directory: () => directory }
}
const file = { fileName: 'image.png', mimeType: 'image/png', sizeBytes: 3, dataBase64: 'YWJj' }

test('stages supplied bytes, retains duplicate names in separate directories, and cleans only its generated directory', async () => {
  const f = fixture()
  const staged = await f.api.stageFocusAttachments([file, file])
  assert.equal(f.writes.length, 2)
  assert.equal(f.writes[0][1].toString(), 'abc')
  assert.equal(f.writes[0][2].flag, 'wx')
  assert.equal(path.basename(staged.attachments[0].path), 'image.png')
  assert.notEqual(staged.attachments[0].path, staged.attachments[1].path)
  for (const item of staged.attachments) assert.ok(item.path.startsWith(f.directory() + path.sep))
  await staged.cleanup()
  assert.equal(f.removals.length, 1)
  assert.equal(f.removals[0][0], f.directory())
  assert.equal(path.dirname(f.removals[0][0]), path.resolve(tmpdir()))
  assert.equal(f.removals[0][1].recursive, true)
})

test('rejects renderer paths before creating files and cleans malformed encoded data', async () => {
  const f = fixture()
  await assert.rejects(f.api.stageFocusAttachments([{ ...file, fileName: '../private.txt' }]))
  assert.equal(f.directory(), undefined)
  assert.equal(f.writes.length, 0)
  await assert.rejects(f.api.stageFocusAttachments([{ ...file, dataBase64: 'YWJ=' }]))
  assert.equal(f.writes.length, 0)
  assert.equal(f.removals.length, 1)
})

test('normalizes Windows device names only in its own temporary copies', async () => {
  const f = fixture()
  const staged = await f.api.stageFocusAttachments([{ ...file, fileName: 'CON.png' }])
  assert.equal(staged.attachments[0].fileName, '_CON.png')
  assert.equal(file.fileName, 'image.png')
  await staged.cleanup()
})
