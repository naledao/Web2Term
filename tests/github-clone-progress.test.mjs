// User-run only: node --test tests/github-clone-progress.test.mjs
// Pure output parsing: no Electron, network, filesystem mutation or child processes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/github.ts')
const { parseGithubCloneProgress: parse, createGithubCloneProgressReader: reader } = load('../src/main/github-clone-progress.ts', { '../shared/github': shared })
const plain = value => JSON.parse(JSON.stringify(value))

test('parses all clone phases and transfer sizes without treating a phase percentage as overall completion', () => {
  const fixtures = [
    ['remote: Counting objects: 100% (99/99), done.', 'counting'],
    ['remote: Compressing objects: 100% (76/76), done.', 'compressing'],
    ['Receiving objects: 100% (21160/21160), 57.93 MiB | 10.82 MiB/s, done.', 'receiving'],
    ['Resolving deltas: 100% (16051/16051), done.', 'resolving'],
    ['Updating files: 100% (20/20), done.', 'checkout'],
    ['Checking out files: 100% (20/20), done.', 'checkout'],
    ['Filtering content: 100% (2/2), 8.00 MiB | 2.00 MiB/s, done.', 'filtering']
  ]
  for (const [line, stage] of fixtures) {
    assert.equal(parse(line).stage, stage)
    assert.equal(parse(line).percent, 100)
  }
  assert.deepEqual(plain(parse(fixtures[2][0])), {
    stage: 'receiving', percent: 100, completed: 21160, total: 21160, transferred: '57.93 MiB', speed: '10.82 MiB/s'
  })
  assert.equal(parse('remote: Enumerating objects: 99, done.').percent, null)
  assert.equal(parse('remote: Enumerating objects: 99, done.').completed, 99)
})

test('handles CR updates, arbitrary chunk boundaries, ANSI and a final unterminated line without duplicates', () => {
  const updates = []
  const stream = reader(progress => updates.push(plain(progress)))
  const first = '\u001b[32mReceiving objects:  12% (12/100), 1.00 MiB | 500.00 KiB/s\u001b[0m'
  stream.write(first.slice(0, 15))
  assert.equal(updates.length, 0)
  stream.write(first.slice(15) + '\r')
  stream.write(first + '\r\n')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].percent, 12)
  stream.write('Resolving deltas:  50% (5/')
  stream.write('10), done.')
  stream.end()
  assert.equal(updates.length, 2)
  assert.equal(updates.at(-1).percent, 50)
  assert.equal(updates.at(-1).stage, 'resolving')
})

test('rejects malformed numeric progress and never forwards paths, credentials or arbitrary remote output', () => {
  for (const line of ['Receiving objects: 101% (10/10)', 'Receiving objects: 20% (11/10)',
    'Counting objects: 20% (9007199254740992/9007199254740992)',
    'remote: Enumerating objects: 9007199254740992, done.',
    "fatal: could not read Username for 'https://private-sentinel@github.com'", 'unknown-stage: 50% (1/2)']) {
    assert.equal(parse(line), null)
  }
  const progress = parse('Receiving objects: 50% (1/2), https://private-sentinel@github.com')
  assert.equal(progress.transferred, null)
  assert.equal(progress.speed, null)
  assert.equal(JSON.stringify(progress).includes('private-sentinel'), false)
})

test('bounds an unterminated diagnostic line and recovers for later valid progress', () => {
  const updates = []
  const stream = reader(progress => updates.push(progress))
  for (let i = 0; i < 20; i++) stream.write('x'.repeat(8192))
  stream.write('\nReceiving objects:  0% (0/100)\r')
  stream.end()
  assert.equal(updates.length, 1)
  assert.equal(updates[0].percent, 0)
})
