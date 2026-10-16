// User-run offline regressions. No Electron, Git subprocesses, SSH or network.
// Run: node --test tests/git-reader.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({
    exports, Buffer, performance, Error,
    require(name) {
      assert.ok(name in dependencies, `unexpected dependency ${name}`)
      return dependencies[name]
    }
  })
  return exports
}

const diagnostics = []
let sequence = 0
const { readGitLog, readGitDiff } = load('../src/main/git.ts', {
  'node:child_process': { execFile() { throw new Error('Git subprocesses forbidden in this test') } },
  'node:fs/promises': { readFile() { throw new Error('real working file reads forbidden in this test') } },
  'node:path': path,
  './git-diagnostic': {
    createGitDiagnostic(backend, operation) { return { backend, operation, requestId: `test-${++sequence}` } },
    writeGitDiagnostic(context, details) { diagnostics.push({ ...context, ...details }) }
  }
})
const plain = (value) => JSON.parse(JSON.stringify(value))
const neverRead = async () => { throw new Error('overview must not read working files') }

test('file overview starts its independent requests together and never reads history or file contents', async () => {
  const pending = new Map()
  let reads = 0
  const backend = {
    kind: 'ssh',
    runGit(cwd, args, diagnostic) {
      assert.equal(cwd, '/example')
      assert.equal(diagnostic.operation, 'files')
      return new Promise((resolve) => pending.set(args[0], { resolve, args }))
    },
    async readWorkingFile() { reads++; throw new Error('unexpected file download') }
  }
  const read = readGitLog('/example', backend, 'files')
  assert.deepEqual([...pending.keys()], ['rev-parse', 'branch', 'status'])
  pending.get('rev-parse').resolve('true\n')
  pending.get('branch').resolve('main\n')
  pending.get('status').resolve(' M src/中文.ts\0?? unread.txt\0')
  const result = await read
  assert.equal(result.isRepo, true)
  assert.equal(result.statusLoaded, true)
  assert.equal(result.currentBranch, 'main')
  assert.deepEqual(plain(result.indexStatus), { modified: 1, added: 1, deleted: 0 })
  assert.equal(result.entries.length, 0)
  assert.equal(result.fileStats, undefined)
  assert.equal(result.files.every((file) => file.statsLoaded === false), true)
  assert.equal(reads, 0)
  assert.ok(pending.get('status').args.includes('-z'))
})

test('history mode reads commits without scanning status, counting lines or downloading files', async () => {
  const commands = []
  const fields = ['abcdef', '', 'Author', 'private@example.test', '2026-10-16T12:00:00Z', '2026-10-16T12:00:00Z', 'subject', 'HEAD -> main']
  const backend = {
    async runGit(_cwd, args) {
      commands.push(args[0])
      if (args[0] === 'rev-parse') return 'true\n'
      if (args[0] === 'branch') return 'main\n'
      if (args[0] === 'log') return fields.join('\x1f') + '\x1e'
      throw new Error('unexpected command')
    },
    readWorkingFile: neverRead
  }
  const result = await readGitLog('/example', backend, 'history')
  assert.deepEqual(commands, ['rev-parse', 'branch', 'log'])
  assert.equal(result.entries[0].message, 'subject')
  assert.equal(result.statusLoaded, false)
  assert.equal(result.files.length, 0)
})

test('line counts preserve NUL-delimited Chinese, tab and newline paths, including renames', async () => {
  const commands = []
  const newPath = '目录/新\t文件\n.txt'
  const result = await readGitLog('/example', {
    async runGit(_cwd, args) {
      commands.push(args)
      return `3\t1\t\0old.txt\0${newPath}\0-\t-\timage.png\0`
    },
    readWorkingFile: neverRead
  }, 'stats')
  assert.equal(commands.length, 1)
  assert.deepEqual(plain(commands[0]), ['diff', 'HEAD', '--numstat', '-z'])
  assert.deepEqual(plain(result.fileStats), [
    { path: newPath, additions: 3, deletions: 1 },
    { path: 'image.png', additions: 0, deletions: 0 }
  ])
})

test('legacy all mode preserves rename metadata and leaves untracked line counts unknown without file reads', async () => {
  let reads = 0
  const result = await readGitLog('/example', {
    async runGit(_cwd, args) {
      if (args[0] === 'rev-parse') return 'true\n'
      if (args[0] === 'branch') return 'main\n'
      if (args[0] === 'status') return 'R  目录/新.txt\0old.txt\0?? new.txt\0'
      if (args[0] === 'diff') return '3\t1\t\0old.txt\0目录/新.txt\0'
      if (args[0] === 'log') return ''
      throw new Error('unexpected command')
    },
    async readWorkingFile() { reads++; return 'must not be downloaded' }
  })
  const renamed = result.files.find((file) => file.kind === 'renamed')
  assert.equal(renamed.path, '目录/新.txt')
  assert.equal(renamed.oldPath, 'old.txt')
  assert.equal(renamed.additions, 3)
  assert.equal(renamed.deletions, 1)
  assert.equal(renamed.statsLoaded, true)
  assert.equal(result.files.find((file) => file.kind === 'untracked').statsLoaded, false)
  assert.equal(reads, 0)
})

test('status failures and SSH failures remain distinguishable from a clean or absent repository', async () => {
  for (const failedCommand of ['rev-parse', 'status']) {
    const result = await readGitLog('/example', {
      kind: 'ssh',
      async runGit(_cwd, args) {
        if (args[0] === failedCommand) throw new Error('SSH connection changed')
        if (args[0] === 'rev-parse') return 'true\n'
        if (args[0] === 'branch') return 'main\n'
        return ''
      },
      readWorkingFile: neverRead
    }, 'files')
    assert.equal(result.isRepo, failedCommand !== 'rev-parse')
    assert.equal(result.statusLoaded, false)
    assert.match(result.error, /SSH connection changed/)
  }
})

test('an unborn branch can display the file list even when diff HEAD and history cannot run', async () => {
  const result = await readGitLog('/example', {
    async runGit(_cwd, args) {
      if (args[0] === 'rev-parse') return 'true\n'
      if (args[0] === 'branch') return 'new-branch\n'
      if (args[0] === 'status') return 'A  first.txt\0'
      throw new Error('unborn HEAD')
    },
    readWorkingFile: neverRead
  }, 'files')
  assert.equal(result.statusLoaded, true)
  assert.equal(result.currentBranch, 'new-branch')
  assert.equal(result.error, undefined)
})

test('selected-file contents, current diff and old revision start in parallel; failures propagate', async () => {
  const requests = new Map()
  const backend = {
    runGit(_cwd, args) { return new Promise((resolve, reject) => requests.set(args[0], { resolve, reject })) },
    readWorkingFile() { return new Promise((resolve) => requests.set('working-file', { resolve })) }
  }
  const read = readGitDiff('/example', 'new.txt', backend)
  assert.deepEqual([...requests.keys()], ['working-file', 'diff', 'show'])
  requests.get('working-file').resolve('one\ntwo\n')
  requests.get('diff').resolve('')
  requests.get('show').reject(new Error('new file is absent from HEAD'))
  const diff = await read
  assert.equal(diff.additions, 2)
  assert.equal(diff.newContent, 'one\ntwo\n')
  assert.match(diff.rawHunks[0], /\+one\n\+two/)

  await assert.rejects(readGitDiff('/example', 'new.txt', {
    async runGit() { throw new Error('SSH timeout') },
    async readWorkingFile() { return '' }
  }), /SSH timeout/)
})

test('request and stage diagnostics correlate without command text, paths, contents or author data', () => {
  assert.ok(diagnostics.some((entry) => entry.event === 'request-finish' && entry.status === 'error'))
  const first = diagnostics.find((entry) => entry.event === 'request-start')
  const related = diagnostics.filter((entry) => entry.requestId === first.requestId)
  assert.equal(related.filter((entry) => entry.event === 'stage-start').length, 3)
  assert.equal(related.filter((entry) => entry.event === 'stage-finish').length, 3)
  assert.equal(related.at(-1).event, 'request-finish')
  assert.equal(related.at(-1).backend, 'ssh')
  assert.equal(related.at(-1).files, 2)
  assert.doesNotMatch(JSON.stringify(diagnostics), /private@example|目录|中文|\/example|subject|must not/)
})
