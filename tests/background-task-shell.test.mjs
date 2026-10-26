// User-run shell checks: temporary files and the test runner's PID only.
// This does not launch Electron, start background tasks, use the app profile or access the network.
// Run: node --test tests/background-task-shell.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const nodeRequire = createRequire(import.meta.url)
function load(path, dependencies = {}) {
  const exports = {}
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({ exports, Buffer, AbortController, setTimeout, clearTimeout, require(name) {
    if (name.startsWith('node:')) return nodeRequire(name)
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}
const protocol = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const { backgroundSampleCommand, parseBackgroundSample, BACKGROUND_LOG_BYTES } = load('../src/main/background-tasks.ts', {
  '../shared/background-tasks': protocol, './background-readiness': load('../src/main/background-readiness.ts') })

function run(task, stdoutStamp = '', stderrStamp = '') {
  const windows = process.platform === 'win32'
  const command = backgroundSampleCommand(task, windows ? 'windows' : 'posix', stdoutStamp, stderrStamp)
  const output = windows
    ? execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding;\n$Error.Clear()\n' + command + '\nif ($Error.Count -gt 0) { exit 1 }', 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    : execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 15000 })
  return parseBackgroundSample(output)
}

test('real observer commands read bounded UTF-8 tails, quote paths and retain unchanged-file metadata', t => {
  const directory = mkdtempSync(join(tmpdir(), 'w2t-background-shell-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const task = {
    pid: process.pid, logPath: join(directory, "中文 it's $(must-not-expand).log"),
    stderrPath: join(directory, 'service.err'), exitCodePath: join(directory, 'service.exit')
  }
  writeFileSync(task.logPath, 'a'.repeat(70000) + '\n末尾输出\n', 'utf8')
  writeFileSync(task.stderrPath, '错误输出\n', 'utf8')
  writeFileSync(task.exitCodePath, '7\n', 'utf8')
  const first = run(task)
  assert.equal(first.alive, true)
  assert.ok(first.identity.length > 0)
  assert.equal(first.exitCode, 7)
  assert.equal(Buffer.from(first.stdout.data, 'base64').length, BACKGROUND_LOG_BYTES)
  assert.ok(Buffer.from(first.stdout.data, 'base64').toString('utf8').endsWith('末尾输出\n'))
  assert.equal(Buffer.from(first.stderr.data, 'base64').toString('utf8'), '错误输出\n')
  const unchanged = run(task, first.stdout.stamp, first.stderr.stamp)
  assert.equal(unchanged.stdout.data, null)
  assert.equal(unchanged.stderr.data, null)
  assert.equal(unchanged.stdout.bytes, first.stdout.bytes)
  writeFileSync(task.logPath, 'rotated\n', 'utf8')
  const rotated = run(task, first.stdout.stamp, first.stderr.stamp)
  assert.equal(Buffer.from(rotated.stdout.data, 'base64').toString('utf8'), 'rotated\n')
})

test('empty/missing logs and malformed exit markers do not fabricate completion', t => {
  const directory = mkdtempSync(join(tmpdir(), 'w2t-background-shell-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const task = { pid: process.pid, logPath: join(directory, 'empty.log'), stderrPath: null, exitCodePath: join(directory, 'bad.exit') }
  writeFileSync(task.logPath, '', 'utf8')
  writeFileSync(task.exitCodePath, 'not-an-exit-code', 'utf8')
  const empty = run(task)
  assert.equal(empty.stdout.data, '')
  assert.equal(empty.stdout.bytes, 0)
  assert.equal(empty.exitCode, null)
  const missing = run({ ...task, logPath: join(directory, 'missing.log') })
  assert.equal(missing.stdout.data, null)
  assert.ok(missing.stdout.error.length > 0)
})
