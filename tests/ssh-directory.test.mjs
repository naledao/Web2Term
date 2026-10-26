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
    exports, Buffer, Error, URL, performance, AbortController, setTimeout, clearTimeout,
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
  './ssh-command-stop': load('../src/main/ssh-command-stop.ts'),
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
  identify() {
    const token = this.writes.at(-1).match(/__CT_SHELL_([a-f0-9]+)__/)[1]
    const started = Buffer.from('Sun Oct 25 20:00:00 2026').toString('base64')
    this.emit('data', Buffer.from(`__CT_SHELL_${token}__ 2301 ${started}\n`))
  }
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

test('SshManager stops through a separate control channel and reopens only its command shell at the same cwd', async t => {
  const channels = [], commands = []
  let connectionsClosed = 0
  const client = { exec(command, callback) {
    commands.push(command)
    const channel = new FakeChannel()
    channels.push(channel)
    callback(null, channel)
  }, end() { connectionsClosed++ } }
  const manager = new SshManager(() => {}, () => {}, () => {})
  t.after(() => manager.dispose())
  manager.client = client
  manager.state = { status: 'connected', attached: true, hostId: 'fixture-host' }
  manager.openExecChannel(client)
  channels[0].identify()
  channels[0].finish('/work/demo', 0, '/home/test\n')
  for (let i = 0; i < 8; i++) await Promise.resolve()
  const shell = manager.execShell()
  assert.ok(shell)
  const running = shell.run('long command')
  const stopping = shell.interrupt()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(channels.length, 2, 'a busy command uses another channel on the same SSH connection')
  assert.match(commands[1], /__CT_REMOTE_STOP__/)
  channels[0].emit('close')
  assert.equal(channels.length, 2, 'parent close alone must not start a replacement')
  channels[1].emit('data', Buffer.from('__CT_REMOTE_STOP__stopped\n'))
  channels[1].emit('close', 0)
  assert.equal(await stopping, true)
  assert.equal((await running).interrupted, true)
  assert.equal(channels.length, 3)
  assert.match(commands[2], /cd '\/work\/demo'/)
  channels[2].identify()
  channels[2].finish('/work/demo', 0, '/home/test\n')
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.notEqual(manager.execShell(), shell)
  assert.equal(manager.execShell().cwd, '/work/demo')
  assert.equal(manager.getState().status, 'connected')
  assert.equal(connectionsClosed, 0, 'manual PTY, transfers and other SSH channels retain their connection')
})

test('Up recalls submitted input while SSH prompt echoes remain visible', async (t) => {
  const { TerminalCommandHistory, navigateCommandHistory } = load('../src/renderer/src/terminal-command-history.ts')
  for (const splitPrompt of [false, true]) {
    await t.test(splitPrompt ? 'prompt and echo arrive in separate packets' : 'complete prompt echo arrives together', async (t) => {
      const manager = new SshManager(() => {}, () => {}, () => {})
      t.after(() => manager.dispose())
      manager.state = { status: 'connected', attached: true, hostId: 'history-fixture' }
      manager.stream = new FakeChannel()
      const history = new TerminalCommandHistory()
      const draft = 'web2term help'
      if (splitPrompt) manager.consume('\x1b[32msiyaoer@412:~$ \x1b[0m')
      history.remember(draft) // same submit path as the input box
      await manager.write(draft)
      manager.consume(splitPrompt ? `${draft}\r\n` : `siyaoer@412:~$ ${draft}\r\n`)
      const lines = manager.getState().lines
      const echo = lines.find((line) => line.kind === 'command')
      assert.equal(echo.text, 'siyaoer@412:~$ web2term help', 'display must retain the remote prompt')
      assert.equal(echo.inputEcho, true)
      history.observe(lines)
      assert.deepEqual(Array.from(history.snapshot()), [draft])
      assert.equal(navigateCommandHistory(null, history.snapshot(), '', 'up').value, draft)

      manager.pushModelLine({ kind: 'command', text: 'pwd' })
      history.observe(manager.getState().lines)
      assert.deepEqual(Array.from(history.snapshot()), [draft, 'pwd'], 'real model commands remain available')
    })
  }
})
