// User-run offline regressions. Fake SSH streams only; no shell, network or Electron.
// Run: node --test tests/ssh-directory.test.mjs
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as stringDecoder from 'node:string_decoder'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({
    exports, Buffer, Error, URL, performance, setTimeout, clearTimeout,
    require(name) {
      assert.ok(name in dependencies, `unexpected dependency ${name}`)
      return dependencies[name]
    }
  })
  return exports
}

const directory = load('../src/shared/ssh-directory.ts')
const remote = load('../src/main/remote-shell.ts', {
  'node:crypto': crypto,
  'node:string_decoder': stringDecoder,
  './shell': { IDLE_TIMEOUT_MS: 5000, MAX_RUNTIME_MS: 10000 },
  './environment': { REMOTE_DETECT_COMMAND: 'fixture probe' }
})
const forbidden = () => { throw new Error('real I/O is forbidden in this test') }
const { SshManager } = load('../src/main/ssh.ts', {
  ssh2: { Client: class { constructor() { forbidden() } } },
  'node:crypto': crypto,
  'node:fs/promises': { stat: forbidden, unlink: forbidden },
  'node:http': { request: forbidden },
  'node:https': { request: forbidden },
  'node:path': path,
  './remote-shell': remote,
  './git-diagnostic': { writeGitDiagnostic() {} },
  './ssh-pdf-preview': { SshPdfPreviewReader: class { cancel() {} } },
  '../shared/ssh-directory': directory
})

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
  writes = []
  write(text) { this.writes.push(text) }
  close() { this.emit('close') }
  signal() {}
  finish(cwd, exitCode = 0, output = '') {
    const envelope = this.writes.at(-1)
    const token = envelope.match(/__CT_DONE_([a-f0-9]+)_%s__/)[1]
    const seq = envelope.match(/'(\d+)' "\$\?" "\$PWD"/)[1]
    this.emit('data', Buffer.from(`${output}__CT_DONE_${token}_${seq}__ ${exitCode} ${cwd}\n`))
  }
}

test('workbench follows the live execution cwd and falls back to the PTY before exec is ready', () => {
  const state = { remoteExec: true, modelCwd: '/root/简历', ptyCwd: '/root' }
  assert.equal(directory.sshWorkingDirectory(state), '/root/简历')
  assert.equal(directory.sshWorkingDirectory({ ...state, remoteExec: false }), '/root')
  assert.equal(directory.sshWorkingDirectory({ ...state, modelCwd: '' }), '/root')
  assert.equal(directory.sshWorkingDirectory({ ...state, ptyCwd: '' }), '/root/简历')
  assert.equal(directory.sshWorkingDirectory(null), '')
  assert.equal(directory.sshWorkingDirectory(undefined), '')
})

test('silent directory changes notify immediately, while unchanged cwd and failed cd do not', async (t) => {
  const channel = new FakeChannel()
  const directories = []
  const output = []
  const shell = new remote.RemoteShell(channel, {
    onOutput: (chunk) => output.push(chunk),
    onCwdChanged: (cwd) => directories.push(cwd)
  })
  t.after(() => shell.dispose())
  shell.noteCwd('/root')
  const cd = shell.run("cd '/root/简历'", undefined, true)
  channel.finish('/root/简历')
  assert.deepEqual(directories, ['/root/简历'])
  assert.equal((await cd).cwd, '/root/简历')
  assert.deepEqual(output, [])

  const unchanged = shell.run('true', undefined, true)
  channel.finish('/root/简历')
  await unchanged
  const failed = shell.run("cd '/does-not-exist'", undefined, true)
  channel.finish('/root/简历', 1)
  assert.equal((await failed).exitCode, 1)
  assert.deepEqual(directories, ['/root/简历'])
})

test('cwd is taken only from the matching completion marker, including when a later command fails', async (t) => {
  const channel = new FakeChannel()
  const directories = []
  const shell = new remote.RemoteShell(channel, { onCwdChanged: (cwd) => directories.push(cwd) })
  t.after(() => shell.dispose())
  shell.noteCwd('/root')
  const request = shell.run("cd '/root/简历'; false", undefined, true)
  channel.emit('data', Buffer.from('CWD=/untrusted-output\n__CT_DONE_wrong_1__ 0 /wrong-directory\n'))
  assert.equal(shell.cwd, '/root')
  assert.deepEqual(directories, [])
  channel.finish('/root/简历', 1)
  assert.equal((await request).exitCode, 1)
  assert.equal(shell.cwd, '/root/简历')
  assert.deepEqual(directories, ['/root/简历'])
})

test('SshManager publishes model cwd changes without moving the interactive PTY', async (t) => {
  const states = []
  const channel = new FakeChannel()
  const client = { exec(_command, callback) { callback(null, channel) }, end() {} }
  const manager = new SshManager((state) => states.push(state), () => {}, () => {})
  t.after(() => manager.dispose())
  // Attach a fake client directly; never call connect or open any socket.
  manager.client = client
  manager.state = { status: 'connected', attached: true, hostId: 'fixture-host' }
  manager.ptyCwd = '/root'
  manager.openExecChannel(client)
  channel.finish('/root', 0, '/root\n')
  await Promise.resolve()
  await Promise.resolve()
  const shell = manager.execShell()
  assert.ok(shell)
  states.length = 0
  const request = shell.run("cd '/root/简历'", undefined, true)
  channel.finish('/root/简历')
  await request
  assert.equal(states.length, 1)
  assert.equal(states[0].modelCwd, '/root/简历')
  assert.equal(states[0].ptyCwd, '/root')
  assert.equal(directory.sshWorkingDirectory(states[0]), '/root/简历')

  states.length = 0
  const oldRequest = shell.run('cd /old-session', undefined, true)
  manager.client = { end() {} }
  channel.finish('/old-session')
  await oldRequest
  assert.equal(states.length, 0, 'an old SSH channel must not update a replacement connection')
})
