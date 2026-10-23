// User-run only: node --test tests/background-launch.test.mjs
// Pure launcher generation, fake transport responses and registration. No processes or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url), exports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/main/background-launch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports, Buffer, require(name) {
  assert.ok(['node:crypto', 'node:path'].includes(name))
  return require(name)
} })
const { backgroundLaunchPlan, startManagedBackground } = exports
const token = 'abc12345def67890', marker = '__W2T_LAUNCH_' + token + '__'
const directory = '/tmp/w2t-background-' + token + '.fixture'
const encoded = Buffer.from(directory).toString('base64')
const frame = (pid = 12345, path = directory) => marker + pid + ':' + Buffer.from(path).toString('base64')
const result = (output = '', patch = {}) => ({ output, exitCode: 0, interrupted: false, rejected: false,
  timedOut: false, sessionLost: false, cwd: '/project', ...patch })
const plan = () => backgroundLaunchPlan('printf ready', '后台服务', 'posix', '/project', token)

test('software prepares unique, private launchers without reading either log before registration', () => {
  const a = plan(), b = backgroundLaunchPlan('printf ready', '后台服务', 'posix', '/project')
  assert.notEqual(a.command, b.command)
  assert.match(a.command, /nohup \/bin\/sh/)
  assert.match(a.command, /umask 077/)
  assert.doesNotMatch(a.command, /ReadAllText|Get-Content|tail -|ReadToEnd/)
  const worker = a.command.slice(a.command.indexOf('#!/bin/sh'))
  assert.ok(worker.indexOf('> "$w2t_dir/pid"') < worker.indexOf('/bin/sh "$w2t_dir/workload.sh"'))
  assert.match(worker, /w2t_code=\$\?/)
  assert.match(worker, /exit.txt/)
})

test('Windows keeps Unicode workload and paths out of command-line quoting and size limits', () => {
  const command = "Write-Output '中文 $(literal)'; cmd /c exit 7"
  const p = backgroundLaunchPlan(command, '登录', 'windows', "C:\\a b\\it's", token)
  const payload = p.command.match(/'workload.ps1'\), \[Convert\]::FromBase64String\('([^']+)'/)[1]
  const body = Buffer.from(payload, 'base64').toString('utf16le')
  assert.ok(body.startsWith('\ufeff'))
  assert.ok(body.includes(command))
  assert.match(body, /exit \$w2tCode/)
  const worker64 = p.command.match(/'worker.ps1'\), \[Convert\]::FromBase64String\('([^']+)'/)[1]
  const worker = Buffer.from(worker64, 'base64').toString('utf8')
  assert.ok(worker.indexOf("'pid'") < worker.indexOf('Start-Process'))
  assert.match(worker, /WaitForExit\(\)/)
  assert.match(worker, /\$w2tChild.ExitCode/)
  assert.match(worker, /-WindowStyle Hidden/)
  assert.match(worker, /C:\\a b\\it''s/)
  assert.doesNotMatch(p.command + worker, /ReadAllText|Get-Content|ReadToEnd/)
})

test('only private response records for this request and its own absolute directory register', () => {
  const p = plan()
  assert.equal(p.registration(frame()).pid, 12345)
  assert.equal(p.registration(frame()).stderr_path, directory + '/stderr.log')
  for (const text of [frame(0), frame('123abc'), frame(123, '/tmp/unrelated'), frame(123, 'relative'),
    frame().replace(token, 'differenttoken'), '__W2T_BACKGROUND_TASK__{"pid":12345}', 'PID=12345']) {
    assert.equal(p.registration(text), null)
  }
})

test('a failed startup response still registers a known spawned process before any log read', async () => {
  const calls = [], registered = []
  const outcome = await startManagedBackground(plan(), async command => {
    calls.push(command)
    return result(frame() + '\nerror after spawn', { exitCode: 1 })
  }, item => { registered.push(item); return 1 })
  assert.equal(registered.length, 1)
  assert.equal(outcome.registered, 1)
  assert.equal(outcome.result.exitCode, 0)
  assert.equal(calls.length, 1)
  assert.match(outcome.result.output, /软件已启动并登记/)
})

test('a missing response recovers only its own PID manifest without starting another process', async () => {
  const calls = [], registered = []
  const outcome = await startManagedBackground(plan(), async command => {
    calls.push(command)
    return calls.length === 1 ? result(marker + 'context:' + encoded, { exitCode: 1 }) : result(frame())
  }, item => { registered.push(item); return 1 })
  assert.equal(outcome.registered, 1)
  assert.equal(registered[0].pid, 12345)
  assert.equal(calls.length, 2)
  assert.match(calls[1], /\/pid/)
  assert.doesNotMatch(calls[1], /nohup|Start-Process|workload.sh/)
})

test('missing or unreadable PID manifest never fabricates a task or retries startup', async () => {
  for (const recoveryFails of [true, false]) {
    let calls = 0, registered = 0
    const outcome = await startManagedBackground(plan(), async () => {
      calls++
      if (calls === 1) return result(marker + 'context:' + encoded, { exitCode: 1 })
      if (recoveryFails) throw new Error('channel lost')
      return result('')
    }, () => { registered++; return 1 })
    assert.equal(calls, 2)
    assert.equal(registered, 0)
    assert.equal(outcome.registered, 0)
    assert.equal(outcome.result.exitCode, 1)
    assert.match(outcome.result.output, /不要重复启动/)
  }
})

test('a rejected shell command never registers even if its diagnostic text looks like metadata', async () => {
  let registered = false, calls = 0
  const outcome = await startManagedBackground(plan(), async () => {
    calls++
    return result(frame(), { rejected: true })
  }, () => { registered = true; return 1 })
  assert.equal(outcome.registered, 0)
  assert.equal(registered, false)
  assert.equal(calls, 1)
})

test('unexpected registration failure preserves the real PID and recovery paths in the result', async () => {
  const outcome = await startManagedBackground(plan(), async () => result(frame()), () => { throw new Error('storage failure') })
  assert.equal(outcome.registered, 0)
  assert.equal(outcome.result.exitCode, 1)
  assert.match(outcome.result.output, /PID: 12345/)
  assert.ok(outcome.result.output.includes(directory + '/stdout.log'))
})

test('a lost startup channel is reported as unconfirmed without inventing an exit code or restarting', async () => {
  let calls = 0, registered = false
  const outcome = await startManagedBackground(plan(), async () => { calls++; throw new Error('connection lost') },
    () => { registered = true; return 1 })
  assert.equal(calls, 1)
  assert.equal(registered, false)
  assert.equal(outcome.result.exitCode, null)
  assert.equal(outcome.result.sessionLost, true)
  assert.match(outcome.result.output, /启动结果未确认/)
})
