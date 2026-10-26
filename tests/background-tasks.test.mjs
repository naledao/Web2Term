// User-run offline regressions. Fake observer shells/timers; no Electron, processes or network.
// Run: node --test tests/background-tasks.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const nodeRequire = createRequire(import.meta.url)
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({ exports, Buffer, AbortController, URL, structuredClone, ...globals, require(name) {
    if (name.startsWith('node:')) return nodeRequire(name)
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`)
    return dependencies[name]
  } })
  return exports
}

const protocol = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const readiness = load('../src/main/background-readiness.ts')
const marker = protocol.BACKGROUND_TASK_MARKER
const registration = (overrides = {}) => marker + JSON.stringify({ pid: 12345, name: '开发服务', log_path: '/tmp/service.log', ...overrides })
const record = { messageId: 'start-a', conversationId: 'conversation-a', command: 'start service' }
const log = (text, stamp = 'v1', bytes = Buffer.byteLength(text)) => ({ data: Buffer.from(text).toString('base64'), bytes, stamp, error: '' })
const emptyLog = () => ({ data: null, bytes: 0, stamp: '', error: '' })
const sample = (overrides = {}) => ({ alive: true, identity: 'process-start-a', exitCode: null, stdout: log('ready\n'), stderr: emptyLog(), ...overrides })
const frame = (value) => '__W2T_BACKGROUND_SAMPLE__' + JSON.stringify(value)
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, { observeStartup = false } = {}) {
  const timers = new Set()
  let clock = Date.now()
  const exports = load('../src/main/background-tasks.ts', { '../shared/background-tasks': protocol, './background-readiness': readiness }, {
    Date: class extends Date { static now() { return clock } },
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
          const queued = pending.shift()
          const next = typeof queued === 'function' ? await queued(command) : queued
          if (next instanceof Error) throw next
          assert.ok(next, 'fixture needs a sample')
          return { output: typeof next === 'string' ? next : frame(next), exitCode: 0, rejected: false, interrupted: false, timedOut: false, sessionLost: false, cwd: '/project' }
        },
        dispose() { this.alive = false; calls.disposes += 1 }
      }
    }
  }
  const startupEvents = []
  const manager = new exports.BackgroundTasks(state => pushes.push(state), undefined,
    observeStartup ? () => (task, kind) => startupEvents.push({ task: JSON.parse(JSON.stringify(task)), kind }) : undefined)
  t.after(() => manager.dispose())
  return {
    manager, target, pending, calls, pushes, timers, exports, startupEvents,
    setAvailable(value) { available = value },
    advance(ms) { clock += ms },
    async tick() { const callbacks = [...timers]; timers.clear(); for (const timer of callbacks) timer.callback(); await flush() }
  }
}

test('manual stop shares the observer shell, deduplicates clicks, and settles with final logs', async t => {
  const f = fixture(t), completed = []
  f.pending.push(sample())
  f.manager.register(registration(), record, f.target, task => completed.push(task))
  await flush()
  const id = f.manager.getState().tasks[0].id
  f.pending.push(sample(), '__W2T_BACKGROUND_STOP__signalled', sample({ alive: false, stdout: log('shutdown\n', 'v2') }))
  const results = await Promise.all([f.manager.stop(id), f.manager.stop(id)])
  assert.ok(results.every(result => result.ok))
  assert.equal(f.calls.commands.filter(command => command.includes('__W2T_BACKGROUND_STOP__')).length, 1)
  assert.equal(f.calls.opens, 1, 'stop and polling must serialize on the same observer')
  assert.equal(f.manager.getState().tasks[0].status, 'stopped')
  assert.equal(typeof f.manager.getState().tasks[0].stopRequestedAt, 'number')
  assert.equal(completed.length, 0, 'wait for the final log read before publishing')
  f.pending.push(sample({ alive: false, stdout: log('shutdown complete\n', 'v3') }))
  await f.tick()
  assert.equal(completed.length, 1)
  assert.equal(completed[0].status, 'stopped')
  assert.equal(completed[0].output, 'shutdown complete\n')
  const count = f.calls.commands.length
  assert.equal((await f.manager.stop(id)).ok, true)
  assert.equal(f.calls.commands.length, count, 'finished tasks never receive another kill command')
})

test('a stop waits for an in-flight observation rather than running commands concurrently', async t => {
  const f = fixture(t)
  let release
  f.pending.push(() => new Promise(resolve => { release = resolve }))
  f.manager.register(registration(), record, f.target)
  await flush()
  const pendingStop = f.manager.stop(f.manager.getState().tasks[0].id)
  await flush()
  assert.equal(f.calls.commands.length, 1)
  f.pending.push(sample(), '__W2T_BACKGROUND_STOP__signalled', sample({ alive: false }))
  release(sample())
  assert.equal((await pendingStop).ok, true)
  assert.equal(f.calls.opens, 1)
})

test('a reused PID or missing process is observed as ended without sending a stop', async t => {
  const f = fixture(t)
  f.pending.push(sample())
  f.manager.register(registration(), record, f.target)
  await flush()
  f.pending.push(sample({ identity: 'another-process-start' }))
  assert.equal((await f.manager.stop(f.manager.getState().tasks[0].id)).ok, true)
  assert.equal(f.manager.getState().tasks[0].status, 'exited')
  assert.ok(f.calls.commands.every(command => !command.includes('__W2T_BACKGROUND_STOP__')))
  assert.equal(f.manager.getState().tasks[0].stopRequestedAt, undefined)
})

test('disconnects, unconfirmed identities and denied stops remain actionable instead of claiming success', async t => {
  const f = fixture(t)
  f.pending.push(sample({ identity: '' }))
  f.manager.register(registration(), record, f.target)
  await flush()
  const id = f.manager.getState().tasks[0].id
  f.setAvailable(false)
  assert.equal((await f.manager.stop(id)).ok, false)
  f.setAvailable(true)
  f.pending.push(sample({ identity: '' }))
  assert.equal((await f.manager.stop(id)).ok, false)
  assert.ok(f.calls.commands.every(command => !command.includes('__W2T_BACKGROUND_STOP__')))
  f.pending.push(sample(), '__W2T_BACKGROUND_STOP__failed')
  const denied = await f.manager.stop(id)
  assert.equal(denied.ok, false)
  assert.match(denied.message, /权限/)
  assert.equal(f.manager.getState().tasks[0].stopRequestedAt, undefined)
  assert.equal(f.manager.getState().tasks[0].status, 'running')
})

test('stop commands reject unsafe PIDs and guard process trees with the captured start identity', t => {
  const f = fixture(t)
  for (const pid of [0, 1, -2, 2.5, '12345', 2147483648]) {
    assert.throws(() => f.exports.backgroundStopCommand(pid, 'identity', 'windows'))
  }
  assert.throws(() => f.exports.backgroundStopCommand(12345, '', 'posix'))
  const windows = f.exports.backgroundStopCommand(12345, '123456789', 'windows')
  assert.ok(windows.indexOf('StartTime.ToUniversalTime().Ticks') < windows.indexOf('taskkill.exe'))
  assert.match(windows, /\/PID 12345 \/T \/F/)
  const posix = f.exports.backgroundStopCommand(12345, 'captured-start', 'posix')
  assert.ok(posix.indexOf('captured-start') < posix.indexOf('kill -TERM'))
  assert.match(posix, /kill -KILL "\$w2t_child"/)
  assert.doesNotMatch(posix, /kill -\w+ -[0-9]/, 'legacy jobs may share a process group with the terminal')
  assert.equal(f.exports.parseBackgroundStop('__W2T_BACKGROUND_STOP__signalled'), 'signalled')
  assert.throws(() => f.exports.parseBackgroundStop('ordinary output'))
})

test('software registration survives an occupied log and includes later stderr in its creation notification', async t => {
  const f = fixture(t), created = []
  const item = protocol.parseBackgroundTaskRegistrations(registration())[0]
  f.pending.push(new Error('log file is being used by another process'))
  assert.equal(f.manager.registerTasks([item], record, f.target, undefined, task => created.push(task), undefined, true), 1)
  await flush()
  assert.equal(f.manager.getState().tasks.length, 1, 'log access failure must not remove the registered task')
  assert.equal(created.length, 0)
  f.pending.push(sample({ stdout: log(''), stderr: log('First copy your one-time code: TEST-CODE\nOpen this URL: https://github.com/login/device') }))
  await f.tick()
  assert.equal(created.length, 1)
  assert.match(created[0].errorOutput, /TEST-CODE/)
  assert.equal(created[0].status, 'running')
})

test('silent software tasks get creation confirmation after the bounded startup wait', async t => {
  const f = fixture(t), created = []
  const item = protocol.parseBackgroundTaskRegistrations(registration())[0]
  f.pending.push(sample({ stdout: log('\n'), stderr: log('') }))
  f.manager.registerTasks([item], record, f.target, undefined, task => created.push(task), undefined, true)
  await flush()
  assert.equal(created.length, 0, 'an initial blank stderr/stdout line is not authorization information')
  f.advance(16000)
  f.pending.push(sample({ stdout: log(''), stderr: log('') }))
  await f.tick()
  assert.equal(created.length, 1)
})

test('a fast software task publishes creation before its final result even without startup output', async t => {
  const f = fixture(t), notifications = []
  const item = protocol.parseBackgroundTaskRegistrations(registration())[0]
  f.pending.push(sample({ alive: false, exitCode: 7, stdout: log(''), stderr: log('') }))
  f.manager.registerTasks([item], record, f.target, task => notifications.push(['finished', task]),
    task => notifications.push(['created', task]), undefined, true)
  await flush()
  f.pending.push(sample({ alive: false, exitCode: 7, stdout: log(''), stderr: log('') }))
  await f.tick()
  assert.deepEqual(notifications.map(([kind]) => kind), ['created', 'finished'])
  assert.equal(notifications[1][1].exitCode, 7)
})

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

test('two Write-Output calls with a marker then compact JSON register on both LF and CRLF', () => {
  const value = { pid: 33464, name: '6分钟性能监控', log_path: 'C:\\Temp\\perf-monitor-fixture\\stdout.log',
    stderr_path: 'C:\\Temp\\perf-monitor-fixture\\stderr.log', exit_code_path: 'C:\\Temp\\perf-monitor-fixture\\exit_code.txt' }
  for (const newline of ['\n', '\r\n']) {
    for (const padding of ['', '  ']) {
      const output = `startup output${newline}${marker}${padding}${newline}  ${JSON.stringify(value)}${newline}`
      const parsed = protocol.parseBackgroundTaskRegistrations(output)
      assert.equal(parsed.length, 1)
      assert.deepEqual(JSON.parse(JSON.stringify(parsed[0])), value)
    }
  }
})

test('split markers never search past a blank or unrelated line, and still reject malformed or oversized JSON', () => {
  const json = JSON.stringify({ pid: 33464, name: '任务', log_path: '/tmp/task.log' })
  for (const output of [
    marker, json, `${marker}\n\n${json}`, `${marker}\nordinary output\n${json}`,
    `${marker}\n{"pid":33464`, `${marker}\n${JSON.stringify({ pid: '33464', name: '任务', log_path: '/tmp/task.log' })}`,
    `${marker}\n${JSON.stringify({ pid: 33464, name: '任务', log_path: '/tmp/task.log', unused: 'x'.repeat(16384) })}`
  ]) {
    assert.equal(protocol.parseBackgroundTaskRegistrations(output).length, 0)
  }
  assert.equal(protocol.parseBackgroundTaskRegistrations(`${marker}\n${registration()}`).length, 1,
    'an empty marker must not consume the next complete marked record')
})

test('split-line registration enters software monitoring and publishes the final result', async t => {
  const f = fixture(t), completed = []
  const value = { pid: 33464, name: '6分钟性能监控', log_path: 'C:\\Temp\\perf-monitor-fixture\\stdout.log',
    stderr_path: 'C:\\Temp\\perf-monitor-fixture\\stderr.log', exit_code_path: 'C:\\Temp\\perf-monitor-fixture\\exit_code.txt' }
  f.pending.push(sample())
  assert.equal(f.manager.register(`${marker}\r\n${JSON.stringify(value)}`, record, { ...f.target, kind: 'windows' }, task => completed.push(task)), 1)
  await flush()
  assert.equal(f.manager.getState().tasks[0].pid, 33464)
  assert.equal(f.manager.getState().tasks[0].status, 'running')
  assert.equal(completed.length, 0)
  f.pending.push(sample({ alive: false, exitCode: 0 }))
  await f.tick()
  f.pending.push(sample({ alive: false, exitCode: 0, stdout: log('final sample\n', 'final') }))
  await f.tick()
  assert.equal(completed.length, 1)
  assert.equal(completed[0].status, 'completed')
  assert.equal(completed[0].output, 'final sample\n')
})

test('registration runs without a mounted view, deduplicates reports and retains its original owner', async t => {
  const f = fixture(t)
  const created = []
  f.pending.push(sample())
  assert.equal(f.manager.register(registration(), record, f.target, undefined, task => created.push(task)), 1)
  assert.equal(created.length, 1)
  assert.equal(created[0].status, 'checking')
  assert.equal(created[0].pid, 12345)
  assert.equal(f.pushes[0].tasks[0].status, 'checking')
  assert.equal(f.manager.register(registration(), record, f.target, undefined, task => created.push(task)), 0)
  assert.equal(f.manager.register(registration(), { ...record, messageId: 'report-again' }, f.target, undefined, task => created.push(task)), 0)
  assert.equal(created.length, 1, 'duplicate reports must not notify the model again')
  f.manager.setDelivery(created[0].id, 'sent', '创建确认已发送', 'created')
  assert.equal(f.manager.getState().tasks[0].creationDeliveryStatus, 'sent')
  assert.equal(f.manager.getState().tasks[0].deliveryStatus, undefined, 'creation confirmation is not the final result')
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

test('completion is published exactly once, after exit and the final log read, never during running or disconnect', async t => {
  const f = fixture(t), completed = []
  f.pending.push(sample())
  f.manager.register(registration(), record, f.target, task => completed.push(task))
  await flush()
  assert.equal(completed.length, 0)
  f.setAvailable(false)
  await f.tick()
  assert.equal(completed.length, 0)
  f.setAvailable(true)
  f.pending.push(sample({ alive: false, exitCode: 0, stdout: log('ending\n') }))
  await f.tick()
  assert.equal(completed.length, 0, 'wait for the final flush')
  f.pending.push(sample({ alive: false, exitCode: 0, stdout: log('ending\nfinal output\n', 'final') }))
  await f.tick()
  assert.equal(completed.length, 1)
  assert.equal(completed[0].status, 'completed')
  assert.equal(completed[0].output, 'ending\nfinal output\n')
  await f.tick()
  assert.equal(completed.length, 1)
  f.manager.setDelivery(completed[0].id, 'sent', '已发送')
  assert.equal(f.manager.getState().tasks[0].deliveryStatus, 'sent')
  assert.equal(completed[0].deliveryStatus, undefined, 'completion snapshots cannot be mutated by later UI updates')
})

test('failure and unknown exit codes both notify once without reporting success', async t => {
  for (const exitCode of [7, null]) {
    const f = fixture(t), completed = []
    f.pending.push(sample({ alive: false, exitCode }))
    f.manager.register(registration(), record, f.target, task => completed.push(task))
    await flush()
    f.pending.push(sample({ alive: false, exitCode }))
    await f.tick()
    assert.equal(completed.length, 1)
    assert.equal(completed[0].status, exitCode === null ? 'exited' : 'failed')
    assert.equal(completed[0].exitCode, exitCode)
  }
})

test('a failed final read retries before notifying, and disposal suppresses late completion', async t => {
  const f = fixture(t), completed = []
  f.pending.push(sample({ alive: false, exitCode: 0 }))
  f.manager.register(registration(), record, f.target, task => completed.push(task))
  await flush()
  f.pending.push(new Error('temporary observer failure'))
  await f.tick()
  assert.equal(completed.length, 0)
  f.pending.push(sample({ alive: false, exitCode: 0 }))
  await f.tick()
  assert.equal(completed.length, 1)
  const disposed = fixture(t)
  disposed.pending.push(sample({ alive: false, exitCode: 0 }))
  disposed.manager.register(registration(), record, disposed.target, () => assert.fail('disposed completion'))
  await flush()
  disposed.manager.dispose()
  await disposed.tick()
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

const descriptor = { transport: 'ssh', key: 'ssh:machine-a', label: '主机 A', kind: 'posix', cwd: '/project', ssh: { hostId: 'machine-a', address: 'a.example' } }
const owner = { platformId: 'deepseek', conversationId: 'conversation-a' }
const plain = value => JSON.parse(JSON.stringify(value))
function persisted(t, f) {
  const saved = []
  const manager = new f.exports.BackgroundTasks(() => {}, stored => saved.push(plain(stored)))
  t.after(() => manager.dispose())
  return { manager, saved, latest: () => saved.at(-1) }
}

test('a registered task is saved with its target, owner and start identity; logs only once it has ended', async t => {
  const f = fixture(t)
  const { manager, saved, latest } = persisted(t, f)
  f.pending.push(sample({ stdout: log('running output\n') }))
  assert.equal(manager.register(registration(), record, { ...f.target, descriptor }, () => {}, undefined, owner), 1)
  await flush()
  assert.ok(saved.length >= 2, 'saved on registration and again when its status changed')
  assert.deepEqual(latest().target, descriptor)
  assert.deepEqual(latest().owner, owner)
  assert.equal(latest().messageId, 'start-a')
  assert.equal(latest().identity, 'process-start-a')
  assert.equal(latest().settled, false)
  assert.equal(latest().task.status, 'running')
  assert.equal(latest().task.output, '', 'a running task re-reads its log files after a restart')
  f.pending.push(sample({ alive: false, exitCode: 0, stdout: log('done\n', 'v2') }))
  await f.tick()
  f.pending.push(sample({ alive: false, exitCode: 0, stdout: log('final\n', 'v3') }))
  await f.tick()
  assert.equal(latest().settled, true)
  assert.equal(latest().task.output, 'final\n', 'an ended task keeps the output its result notification carries')
  // A target without a descriptor (or a task without an owner) is never persisted.
  const count = saved.length
  f.pending.push(sample())
  assert.equal(manager.register(registration({ pid: 222 }), { ...record, messageId: 'other' }, f.target, () => {}), 1)
  await flush()
  assert.equal(saved.length, count)
})

test('restored tasks: a running one is observed again, an ended one is history, a reused PID is not the task', async t => {
  const f = fixture(t)
  const settledTasks = []
  const base = (overrides = {}) => ({
    id: 'task-1', name: '开发服务', pid: 12345, transport: 'ssh', targetLabel: '主机 A', conversationId: 'conversation-a',
    command: 'start service', logPath: '/tmp/service.log', stderrPath: null, exitCodePath: null, status: 'running', exitCode: null,
    createdAt: 1, checkedAt: 1, message: '', output: '', errorOutput: '', outputTruncated: false, errorOutputTruncated: false, ...overrides
  })
  const stored = [
    { task: base(), target: descriptor, messageId: 'start-a', identity: 'process-start-a', settled: false, owner },
    { task: base({ id: 'task-2', pid: 333, logPath: '/tmp/old.log', status: 'completed', exitCode: 0, output: 'old output\n', deliveryStatus: 'sent' }),
      target: descriptor, messageId: 'start-b', identity: 'x', settled: true, owner }
  ]
  for (const item of stored) assert.ok(protocol.parseStoredBackgroundTask(JSON.stringify(item)), 'the stored shape parses back')
  const targets = []
  f.pending.push(sample({ identity: 'another-process' }))
  f.manager.restore(stored, d => { targets.push(d); return f.target }, item => item.settled ? undefined : task => settledTasks.push(task))
  assert.deepEqual(plain(targets), [descriptor, descriptor])
  const before = f.manager.getState().tasks
  assert.equal(before[0].status, 'checking')
  assert.equal(before[1].status, 'completed')
  assert.equal(before[1].output, 'old output\n')
  await flush()
  assert.equal(f.calls.commands.length, 1, 'only the running task is sampled')
  assert.equal(f.manager.getState().tasks[0].status, 'exited')
  assert.match(f.manager.getState().tasks[0].message, /复用/)
  f.pending.push(sample({ identity: 'another-process' }))
  await f.tick()
  assert.equal(settledTasks.length, 1, 'it settles once and its result goes out as usual')
  // Restoring the same rows again does not duplicate them.
  f.manager.restore(stored, () => f.target, () => undefined)
  assert.equal(f.manager.getState().tasks.length, 2)
})

test('monitor state exposes frozen launch provenance and confirms final results only after the last log read', async t => {
  const f = fixture(t), context = { sessionId: 'session-a', platformId: 'deepseek', conversationId: record.conversationId,
    taskId: 'goal-a', generation: 1, stepId: 'startup-a', sourceMessageId: 'source-a', tool: 'command',
    machine: { id: 'machine-a', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\work' } }
  const bound = { ...record, taskContext: context, backgroundOptions: { kind: 'job' } }
  f.pending.push(sample())
  f.manager.register(registration(), bound, f.target)
  await flush()
  let observed = f.manager.getState().tasks[0]
  assert.equal(observed.resultSettled, false)
  assert.equal(observed.taskContext.stepId, 'startup-a')
  assert.equal(observed.launchOptions.kind, 'job')
  observed.taskContext.machine.id = 'modified-external-copy'
  assert.equal(f.manager.getState().tasks[0].taskContext.machine.id, 'machine-a')
  context.machine.id = 'modified-original'
  assert.equal(f.manager.getState().tasks[0].taskContext.machine.id, 'machine-a')
  f.pending.push(sample({ alive: false, exitCode: 0, stdout: log('first final', 'v2') }))
  await f.tick()
  observed = f.manager.getState().tasks[0]
  assert.equal(observed.status, 'completed'); assert.equal(observed.resultSettled, false)
  f.pending.push(sample({ alive: false, exitCode: 0, stdout: log('last final', 'v3') }))
  await f.tick()
  observed = f.manager.getState().tasks[0]
  assert.equal(observed.resultSettled, true); assert.equal(observed.output, 'last final')
})

test('stored rows that do not describe a usable task are rejected', () => {
  const good = { task: { id: 't', name: 'n', pid: 2, transport: 'local', targetLabel: '本机', conversationId: 'c', command: 'x', logPath: '/l',
    stderrPath: null, exitCodePath: null, status: 'running', exitCode: null, createdAt: 1, checkedAt: null, message: '', output: '', errorOutput: '',
    outputTruncated: false, errorOutputTruncated: false }, target: { transport: 'local', key: 'local', label: '本机', kind: 'windows', cwd: 'C:\\' },
    messageId: 'm', identity: '', settled: false, owner: { platformId: 'chatgpt', conversationId: 'c' } }
  assert.ok(protocol.parseStoredBackgroundTask(JSON.stringify(good)))
  assert.ok(protocol.parseStoredBackgroundTask(JSON.stringify({ ...good, task: { ...good.task, status: 'stopped', stopRequestedAt: 10 } })))
  for (const bad of [
    'not json', '{}',
    { ...good, owner: { platformId: 'chatgpt', conversationId: '' } },
    { ...good, target: { ...good.target, transport: 'ssh' } },
    { ...good, task: { ...good.task, transport: 'ssh' } },
    { ...good, task: { ...good.task, status: 'weird' } },
    { ...good, task: { ...good.task, deliveryStatus: 'maybe' } },
    { ...good, task: { ...good.task, stopRequestedAt: 'yesterday' } },
    { ...good, settled: 'yes' }
  ]) assert.equal(protocol.parseStoredBackgroundTask(typeof bad === 'string' ? bad : JSON.stringify(bad)), null)
})

test('a manual stop awaiting confirmation survives restart and settles as stopped', async t => {
  const f = fixture(t), { manager, latest } = persisted(t, f)
  f.pending.push(sample())
  manager.register(registration(), record, { ...f.target, descriptor }, undefined, undefined, owner)
  await flush()
  f.pending.push(sample(), '__W2T_BACKGROUND_STOP__signalled', sample({ alive: true }))
  assert.equal((await manager.stop(manager.getState().tasks[0].id)).ok, true)
  const stored = latest()
  assert.equal(stored.settled, false)
  assert.equal(typeof stored.task.stopRequestedAt, 'number')
  manager.dispose()
  const completed = []
  f.pending.push(sample({ alive: false, exitCode: 143 }))
  f.manager.restore([stored], () => f.target, () => task => completed.push(task))
  await flush()
  assert.equal(f.manager.getState().tasks[0].status, 'stopped')
  f.pending.push(sample({ alive: false, exitCode: 143 }))
  await f.tick()
  assert.equal(completed.length, 1)
  assert.equal(completed[0].status, 'stopped')
})
