// User-run only: node --test tests/github-clone.test.mjs
// Real clone orchestration with fake picker, filesystem and CLI. Never launches processes or writes files.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { isAbsolute, join, resolve } from 'node:path'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, process: { platform: process.platform }, require(name) {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/github.ts')
const progressParser = load('../src/main/github-clone-progress.ts', { '../shared/github': shared })
const home = resolve('fake-home')
function cloneModule(spawn = () => { throw new Error('Real processes must not run') }) {
  return load('../src/main/github-clone.ts', {
  '../shared/github': shared,
  './github-clone-progress': progressParser,
  './github-cli': { getGithubCliState() { throw new Error('Real auth must not run') }, resolveGithubCli() { throw new Error('Real CLI must not run') } },
  'node:child_process': { spawn },
  'node:fs': {}, 'node:os': { homedir: () => home }, 'node:path': { join, isAbsolute }
  })
}
const { cloneGithubRepository } = cloneModule()
const request = { requestId: 'clone-1', sessionId: 'session-1', account: 'alice', fullName: 'alice/project' }
function fixture(patch = {}) {
  const parent = resolve('fake-parent 中文 & spaces')
  const directories = new Set([parent, home])
  const calls = { defaults: [], clones: [], reserved: [], inspected: 0 }
  const deps = {
    cwd: parent, current: () => true,
    chooseDirectory: async path => { calls.defaults.push(path); return parent },
    inspect: async () => { calls.inspected++; return { status: 'signed-in', account: 'alice' } },
    executable: async () => 'fake gh.exe',
    clone: async (file, args, cwd) => {
      calls.clones.push({ file, args: Array.from(args), cwd })
      directories.add(join(args[3], '.git'))
      return { ok: true, stderr: '', code: 0 }
    },
    files: {
      isDirectory: path => directories.has(path), realpath: path => path,
      reserve(path) {
        if (directories.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        directories.add(path)
        calls.reserved.push(path)
      }
    }, ...patch
  }
  return { deps, parent, directories, calls }
}

test('defaults to the terminal directory and clones into a repository subfolder with separate arguments', async () => {
  const f = fixture()
  const result = await cloneGithubRepository(request, f.deps)
  const destination = join(f.parent, 'project')
  assert.equal(result.status, 'cloned')
  assert.equal(result.directory, destination)
  assert.deepEqual(f.calls.defaults, [f.parent])
  assert.deepEqual(f.calls.clones, [{ file: 'fake gh.exe', args: ['repo', 'clone', 'https://github.com/alice/project', destination, '--', '--progress'], cwd: f.parent }])
})

test('a missing terminal directory falls back to home and cancellation does not touch disk or authentication', async () => {
  const f = fixture({ cwd: resolve('missing-terminal'), chooseDirectory: async path => { assert.equal(path, home); return null } })
  assert.equal((await cloneGithubRepository(request, f.deps)).status, 'cancelled')
  assert.equal(f.calls.reserved.length, 0)
  assert.equal(f.calls.inspected, 0)
  assert.equal(f.calls.clones.length, 0)
})

test('existing destinations are not overwritten, including empty directories', async () => {
  const f = fixture()
  f.directories.add(join(f.parent, 'project'))
  const result = await cloneGithubRepository(request, f.deps)
  assert.equal(result.status, 'error')
  assert.match(result.message, /已存在同名/)
  assert.equal(f.calls.clones.length, 0)
})

test('invalid repository paths cannot open the picker or invoke gh', async () => {
  for (const fullName of ['alice/../escape', 'alice/..', 'https://evil.test/repo', 'alice/repo;command']) {
    const f = fixture()
    assert.equal((await cloneGithubRepository({ ...request, fullName }, f.deps)).status, 'error')
    assert.equal(f.calls.defaults.length, 0)
    assert.equal(f.calls.clones.length, 0)
  }
})

test('switching sessions while the picker is open prevents cloning', async () => {
  let current = true
  const f = fixture({ current: () => current })
  f.deps.chooseDirectory = async () => { current = false; return f.parent }
  assert.equal((await cloneGithubRepository(request, f.deps)).status, 'error')
  assert.equal(f.calls.clones.length, 0)
  assert.equal(f.calls.reserved.length, 0)
})

test('changed or signed-out accounts do not create a destination', async () => {
  for (const state of [{ status: 'signed-in', account: 'bob' }, { status: 'signed-out', account: null }]) {
    const f = fixture({ inspect: async () => state })
    assert.equal((await cloneGithubRepository(request, f.deps)).status, 'error')
    assert.equal(f.calls.reserved.length, 0)
    assert.equal(f.calls.clones.length, 0)
  }
})

test('concurrent clicks cannot open duplicate pickers for one session and cancellation releases the lock', async () => {
  let finishPicker
  const f = fixture({ chooseDirectory: () => new Promise(resolve => { finishPicker = resolve }) })
  const first = cloneGithubRepository(request, f.deps)
  const second = await cloneGithubRepository(request, f.deps)
  assert.equal(second.status, 'error')
  assert.match(second.message, /已有克隆/)
  finishPicker(null)
  assert.equal((await first).status, 'cancelled')
  assert.equal((await cloneGithubRepository(request, fixture().deps)).status, 'cloned')
})

test('failed clones retain their directory, redact diagnostics and never claim success without a git directory', async () => {
  const f = fixture({ clone: async () => ({ ok: false, stderr: 'proxy connection failed private-sentinel', code: 128 }) })
  const result = await cloneGithubRepository(request, f.deps)
  assert.equal(result.status, 'error')
  assert.equal(result.directory, join(f.parent, 'project'))
  assert.equal(f.directories.has(result.directory), true)
  assert.match(result.message, /网络或代理/)
  assert.equal(result.message.includes('private-sentinel'), false)
  const empty = fixture({ clone: async () => ({ ok: true, stderr: '', code: 0 }) })
  assert.equal((await cloneGithubRepository(request, empty.deps)).status, 'error')
})

test('streams real stderr progress before exit, forces progress without a TTY and verifies only after exit', async () => {
  const updates = []
  const f = fixture({ clone: undefined, onProgress: progress => updates.push(progress) })
  let child
  let complete = false
  const module = cloneModule((file, args, options) => {
    assert.equal(file, 'fake gh.exe')
    assert.deepEqual(Array.from(args).slice(-2), ['--', '--progress'])
    assert.equal(options.shell, false)
    assert.equal(options.env.LC_ALL, 'C')
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
    child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stderr.setEncoding = value => assert.equal(value, 'utf8')
    queueMicrotask(() => {
      child.stderr.emit('data', 'Receiving objects:  20% (2/10), 1.00 MiB | 500.00 KiB/s\r')
      assert.equal(complete, false)
      assert.equal(updates.at(-1).stage, 'receiving')
      assert.equal(updates.at(-1).percent, 20)
      assert.equal(updates.at(-1).speed, '500.00 KiB/s')
      child.stderr.emit('data', 'Receiving objects: 100% (10/10), 5.00 MiB | 1.00 MiB/s, done.\r')
      assert.equal(complete, false)
      assert.equal(updates.some(item => item.stage === 'verifying'), false)
      // A trailing progress line with no newline must still be consumed at close.
      child.stderr.emit('data', 'Resolving deltas: 100% (3/3), done.')
      f.directories.add(join(f.parent, 'project', '.git'))
      child.emit('close', 0)
    })
    return child
  })
  const result = await module.cloneGithubRepository(request, f.deps).then(result => { complete = true; return result })
  assert.equal(result.status, 'cloned')
  assert.deepEqual(updates.map(item => item.stage), ['selecting', 'checking', 'connecting', 'receiving', 'receiving', 'resolving', 'verifying'])
  assert.equal(updates.at(-1).percent, null)
})

test('a phase reaching 100 percent cannot turn a failing process into a successful clone', async () => {
  const updates = []
  const f = fixture({ onProgress: progress => updates.push(progress), clone: async (_file, _args, _cwd, report) => {
    report(progressParser.parseGithubCloneProgress('Receiving objects: 100% (10/10), done.'))
    return { ok: false, stderr: 'connection failed private-sentinel', code: 128 }
  } })
  const result = await cloneGithubRepository(request, f.deps)
  assert.equal(result.status, 'error')
  assert.equal(updates.at(-1).percent, 100)
  assert.equal(updates.some(item => item.stage === 'verifying'), false)
  assert.equal(JSON.stringify(updates).includes('private-sentinel'), false)
})

test('closed progress observers do not interrupt a clone or leave its session locked', async () => {
  const f = fixture({ onProgress() { throw new Error('Window was destroyed') } })
  assert.equal((await cloneGithubRepository(request, f.deps)).status, 'cloned')
  assert.equal((await cloneGithubRepository({ ...request, requestId: 'clone-2' }, fixture().deps)).status, 'cloned')
})

test('missing or invalid request IDs cannot open a picker and cause cross-operation progress', async () => {
  for (const requestId of [undefined, '', 'invalid id', '\n', 'x'.repeat(129)]) {
    const f = fixture()
    assert.equal((await cloneGithubRepository({ ...request, requestId }, f.deps)).status, 'error')
    assert.equal(f.calls.defaults.length, 0)
  }
})
