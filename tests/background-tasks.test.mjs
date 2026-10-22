// User-run offline regressions. Fake observer shells/timers; no Electron, processes or network.
// Run: node --test tests/background-tasks.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({ exports, Buffer, AbortController, ...globals, require(name) {
    if (name.startsWith('node:')) return nodeRequire(name)
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}

const protocol = load('../src/shared/background-tasks.ts')
const marker = protocol.BACKGROUND_TASK_MARKER
const registration = (overrides = {}) => marker + JSON.stringify({ pid: 12345, name: '开发服务', log_path: '/tmp/service.log', ...overrides })
const record = { messageId: 'start-a', conversationId: 'conversation-a', command: 'start service' }
const log = (text, stamp = 'v1', bytes = Buffer.byteLength(text)) => ({ data: Buffer.from(text).toString('base64'), bytes, stamp, error: '' })
const emptyLog = () => ({ data: null, bytes: 0, stamp: '', error: '' })
const sample = (overrides = {}) => ({ alive: true, identity: 'process-start-a', exitCode: null, stdout: log('ready\n'), stderr: emptyLog(), ...overrides })
const frame = (value) => '__W2T_BACKGROUND_SAMPLE__' + JSON.stringify(value)
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  const timers = new Set()
  const exports = load('../src/main/background-tasks.ts', { '../shared/background-tasks': protocol }, {
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer) }
  })
  const pending = []
  const calls = { commands: [], opens: 0, disposes: 0 }
  const pushes = []
  let available = true
  const target = {
    key: 'ssh:machine-a', label: '主机 A', transport: 'ssh', kind: 'posix', cwd: '/project',
    available: () => available,
    open: async () => {
      calls.opens += 1
      return {
        alive: true, running: false, kind: 'posix', cwd: '/project', probeCommand: '',
        async run(command) {
          calls.commands.push(command)
          const next = pending.shift()
          if (next instanceof Error) throw next
          assert.ok(next, 'fixture needs a sample')
          return { output: frame(next), exitCode: 0, rejected: false, interrupted: false, timedOut: false, sessionLost: false, cwd: '/project' }
        },
        dispose() { this.alive = false; calls.disposes += 1 }
      }
    }
  }
  const manager = new exports.BackgroundTasks(state => pushes.push(state))
  t.after(() => manager.dispose())
  return {
    manager, target, pending, calls, pushes, timers, exports,
    setAvailable(value) { available = value },
    async tick() { const callbacks = [...timers]; timers.clear(); for (const timer of callbacks) timer.callback(); await flush() }
  }
}

test('only explicit complete output lines register; ordinary prose, fabricated JSON and partial lines do not', () => {
  const result = protocol.parseBackgroundTaskRegistrations([
    'PID 12345 started', JSON.stringify({ pid: 12345, name: '任务', log_path: '/tmp/log' }),
    'example: ' + registration(), marker + '{"pid":12345', registration(),
    registration({ pid: 0 }), registration({ pid: '12345' }), registration({ pid: 2.5 }),
    registration({ name: '' }), registration({ log_path: '/tmp/a\nmalformed' }),
    registration({ stderr_path: null }), registration({ exit_code_path: 99 }), marker + 'null'
  ].join('\r\n'))
  assert.equal(result.length, 1)
  assert.equal(result[0].pid, 12345)
  assert.equal(result[0].name, '开发服务')
})

test('registration runs without a mounted view, deduplicates reports and retains its original owner', async t => {
  const f = fixture(t)
  f.pending.push(sample())
  assert.equal(f.manager.register(registration(), record, f.target), 1)
  assert.equal(f.pushes[0].tasks[0].status, 'checking')
  assert.equal(f.manager.register(registration(), record, f.target), 0)
  assert.equal(f.manager.register(registration(), { ...record, messageId: 'report-again' }, f.target), 0)
  await flush()
  const [task] = f.manager.getState().tasks
  assert.equal(task.status, 'running')
  assert.equal(task.output, 'ready\n')
  assert.equal(task.targetLabel, '主机 A')
  assert.equal(task.conversationId, 'conversation-a')
  assert.equal(f.calls.opens, 1)
})

test('paths must be absolute for the task machine, independently of the desktop OS', async t => {
  const f = fixture(t)
  assert.equal(f.manager.register(registration({ log_path: 'relative.log' }), record, f.target), 0)
  assert.equal(f.manager.register(registration({ log_path: 'C:\\logs\\service.log' }), record, f.target), 0)
  assert.equal(f.manager.register(registration({ stderr_path: 'relative.err' }), record, f.target), 0)
  f.pending.push(sample())
  assert.equal(f.manager.register(registration({ log_path: 'C:\\logs\\service.log' }), record, { ...f.target, kind: 'windows' }), 1)
  await flush()
})

test('stdout/stderr refresh separately and a log rotation replaces old output', async t => {
  const f = fixture(t)
  f.pending.push(sample({ stdout: log('a\nb\n'), stderr: log('warning\n') }))
  f.manager.register(registration({ stderr_path: '/tmp/service.err' }), record, f.target)
  await flush()
  f.pending.push(sample({ stdout: log('新日志\n', 'rotated'), stderr: { ...emptyLog(), stamp: 'v1' } }))
  await f.tick()
  const [task] = f.manager.getState().tasks
  assert.equal(task.output, '新日志\n')
  assert.equal(task.errorOutput, 'warning\n')
  assert.ok(f.calls.commands[1].includes("'v1'"))
})

test('a bounded display reports truncation and strips terminal formatting', async t => {
  const f = fixture(t)
  f.pending.push(sample({ stdout: log('\uFEFF\x1b[31m失败\x1b[0m\r\n', 'v1', 100000) }))
  f.manager.register(registration(), record, f.target)
  await flush()
  const [task] = f.manager.getState().tasks
  assert.equal(task.output, '失败\n')
  assert.equal(task.outputTruncated, true)
})

test('a missing PID is exited with unknown exit code, followed by a final log read', async t => {
  const f = fixture(t)
  f.pending.push(sample({ alive: false, identity: '', stdout: log('last output\n') }))
  f.manager.register(registration(), record, f.target)
  await flush()
  assert.equal(f.manager.getState().tasks[0].status, 'exited')
  assert.equal(f.manager.getState().tasks[0].exitCode, null)
  f.pending.push(sample({ alive: false, identity: '', stdout: log('last output\nflushed\n', 'v2') }))
  await f.tick()
  assert.equal(f.manager.getState().tasks[0].output, 'last output\nflushed\n')
  assert.equal(f.timers.size, 0)
  assert.equal(f.calls.disposes, 1)
})

test('an exit-code file distinguishes success and failure; its value survives a later missing file', async t => {
  const f = fixture(t)
  f.pending.push(sample({ alive: false, identity: '', exitCode: 7 }))
  f.manager.register(registration({ exit_code_path: '/tmp/service.exit' }), record, f.target)
  await flush()
  assert.equal(f.manager.getState().tasks[0].status, 'failed')
  f.pending.push(sample({ alive: false, identity: '', exitCode: null }))
  await f.tick()
  assert.equal(f.manager.getState().tasks[0].status, 'failed')
  assert.equal(f.manager.getState().tasks[0].exitCode, 7)
  const success = fixture(t)
  success.pending.push(sample({ alive: false, identity: '', exitCode: 0 }))
  success.manager.register(registration({ exit_code_path: '/tmp/service.exit' }), record, success.target)
  await flush()
  assert.equal(success.manager.getState().tasks[0].status, 'completed')
})

test('PID reuse does not revive the original background task', async t => {
  const f = fixture(t)
  f.pending.push(sample())
  f.manager.register(registration(), record, f.target)
  await flush()
  f.pending.push(sample({ identity: 'a-different-process' }))
  await f.tick()
  assert.equal(f.manager.getState().tasks[0].status, 'exited')
  assert.match(f.manager.getState().tasks[0].message, /复用/)
})

test('disconnect keeps logs and unknown state; reconnect resumes only the original target', async t => {
  const f = fixture(t)
  f.pending.push(sample())
  f.manager.register(registration(), record, f.target)
  await flush()
  f.setAvailable(false)
  await f.tick()
  assert.equal(f.manager.getState().tasks[0].status, 'unknown')
  assert.equal(f.manager.getState().tasks[0].output, 'ready\n')
  assert.equal(f.calls.commands.length, 1)
  f.setAvailable(true)
  f.pending.push(sample({ stdout: log('reconnected\n', 'v2') }))
  await f.tick()
  assert.equal(f.manager.getState().tasks[0].status, 'running')
  assert.equal(f.manager.getState().tasks[0].targetLabel, '主机 A')
  assert.equal(f.manager.getState().tasks[0].output, 'reconnected\n')
})

test('disposing the task observer releases timers and shells and never sends a process termination command', async t => {
  const f = fixture(t)
  f.pending.push(sample())
  f.manager.register(registration(), record, f.target)
  await flush()
  f.manager.dispose()
  assert.equal(f.timers.size, 0)
  assert.equal(f.calls.disposes, 1)
  assert.equal(f.manager.register(registration({ pid: 23456 }), record, f.target), 0)
  assert.ok(f.calls.commands.every(command => !/Stop-Process|taskkill|kill -[159]/.test(command)))
})

test('sample frames reject malformed/oversized data and safely quote task paths', t => {
  const f = fixture(t)
  assert.throws(() => f.exports.parseBackgroundSample('no sample'), /有效结果/)
  assert.throws(() => f.exports.parseBackgroundSample(frame(sample({ stdout: log('x'.repeat(65537)) }))), /格式不正确/)
  assert.throws(() => f.exports.parseBackgroundSample(frame(sample({ alive: 'yes' }))), /格式不正确/)
  const task = { pid: 12345, logPath: "/tmp/中文 ' $(touch should-not-run).log", stderrPath: null, exitCodePath: null }
  const command = f.exports.backgroundSampleCommand(task, 'posix')
  assert.ok(command.includes("'/tmp/中文 '\\'' $(touch should-not-run).log'"))
  const windows = f.exports.backgroundSampleCommand({ ...task, logPath: "C:\\中文\\it's.log" }, 'windows')
  assert.ok(windows.includes("'C:\\中文\\it''s.log'"))
})
