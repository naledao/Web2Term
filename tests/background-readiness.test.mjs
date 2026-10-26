// User-run only: node --test tests/background-readiness.test.mjs
// Actual detectors/observer with fake shells, time and storage; no processes or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const require = createRequire(import.meta.url)
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(code).runInNewContext({ exports, Buffer, URL, AbortController, structuredClone, ...globals, require(name) {
    if (name.startsWith('node:')) return require(name)
    assert.ok(Object.hasOwn(dependencies, name), name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const readiness = load('../src/main/background-readiness.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const output = 'Now listening on: https://localhost:44301\nApplication started. Press Ctrl+C to shut down.\n'
const chunk = (text, offset = 0) => ({ data: Buffer.from(text).toString('base64'), offset: offset + Buffer.byteLength(text), reset: false })
const logs = (text = '', offset = 0, error = '', errorOffset = 0) => '__W2T_STARTUP_LOG__' + JSON.stringify({ stdout: chunk(text, offset), stderr: chunk(error, errorOffset) })
const sample = (patch = {}) => '__W2T_BACKGROUND_SAMPLE__' + JSON.stringify({ alive: true, identity: '123456789', exitCode: null,
  stdout: { data: '', bytes: 0, stamp: '', error: '' }, stderr: { data: '', bytes: 0, stamp: '', error: '' }, ...patch })
const settle = () => new Promise(setImmediate)
const service = () => ({ id: 'task-a', pid: 12345, command: 'dotnet run', logPath: 'C:\\Temp\\stdout.log', stderrPath: 'C:\\Temp\\stderr.log',
  backgroundOptions: { kind: 'service', readiness: { type: 'auto' } }, startup: readiness.initialBackgroundStartup(1000, { kind: 'service' }) })

function fixture(t) {
  const timers = new Set(), pending = [], commands = [], notifications = [], saved = []
  let clock = 1000, available = true
  const { BackgroundTasks } = load('../src/main/background-tasks.ts', { '../shared/background-tasks': shared, './background-readiness': readiness }, {
    Date: class extends Date { static now() { return clock } },
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer }, clearTimeout(timer) { timers.delete(timer) }
  })
  const target = { key: 'local', transport: 'local', label: '本机', kind: 'windows', cwd: 'C:\\project', available: () => available,
    descriptor: { key: 'local', transport: 'local', label: '本机', kind: 'windows', cwd: 'C:\\project' },
    async open() { return { alive: true, async run(command) {
      commands.push(command)
      const value = pending.shift()
      assert.ok(value, 'Missing synthetic observer response')
      return { output: value, exitCode: 0, rejected: false, interrupted: false, timedOut: false, sessionLost: false }
    }, dispose() { this.alive = false } } }
  }
  const manager = new BackgroundTasks(() => {}, row => saved.push(plain(row)), () => (task, kind) => notifications.push({ task: plain(task), kind }))
  t.after(() => manager.dispose())
  const register = (options = { kind: 'service', readiness: { type: 'auto' } }) => manager.registerTasks([
    { pid: 12345, name: '后端', log_path: 'C:\\Temp\\stdout.log', stderr_path: 'C:\\Temp\\stderr.log' }
  ], { messageId: 'command-a', conversationId: 'chat-a', command: 'dotnet run', backgroundOptions: options }, target,
  task => notifications.push({ task: plain(task), kind: 'finished' }), undefined, { platformId: 'deepseek', conversationId: 'chat-a' })
  return { manager, pending, commands, notifications, saved, register, target,
    advance(ms) { clock += ms }, setAvailable(value) { available = value },
    async tick() { const current = [...timers]; timers.clear(); current.forEach(timer => timer.callback()); await settle() } }
}

test('readiness options accept only bounded checks on the task machine loopback', () => {
  assert.ok(shared.parseBackgroundOptions({ kind: 'service', readiness: { type: 'http', url: 'https://localhost:44301/health', timeout_seconds: 120 } }))
  assert.ok(shared.parseBackgroundOptions({ kind: 'service', readiness: { type: 'tcp', port: 44301 } }))
  for (const readiness of [{ type: 'tcp', port: 0 }, { type: 'http', url: 'https://example.com' }, { type: 'http', url: 'http://user:pass@localhost/' },
    { type: 'auto', timeout_seconds: 0 }, { type: 'auto', timeout_seconds: 601 }, { type: 'exec', command: 'anything' }]) {
    assert.equal(shared.parseBackgroundOptions({ kind: 'service', readiness }), null)
  }
  assert.equal(shared.parseBackgroundOptions({ kind: 'job', readiness: { type: 'auto' } }), null)
})

test('the actual page command parser retains service metadata and rejects inconsistent envelopes', () => {
  const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('page.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const context = { commandParseIssue: null, commandIssue: () => null, hasBackgroundField: () => true,
    lenientCommand: () => null, recoverWindowsString: () => null, invalidCommandControls: () => false, normalizeTimeoutSeconds: value => value ?? 30 }
  const find = (name, node = ast) => ts.isVariableDeclaration(node) && node.name.getText(ast) === name ? node.initializer
    : ts.forEachChild(node, child => find(name, child))
  for (const name of ['commandEnvelope', 'toCommand']) {
    const node = find(name)
    assert.ok(node, name)
    context[name] = new Script('(' + node.getText(ast) + ')').runInNewContext(context)
  }
  const input = { command: 'dotnet run', description: '后端', background: true, background_kind: 'service', readiness: { type: 'tcp', port: 44301 } }
  const parsed = context.toCommand(JSON.stringify(input))
  assert.deepEqual(plain(parsed.backgroundOptions), { kind: 'service', readiness: { type: 'tcp', port: 44301 } })
  assert.deepEqual(JSON.parse(parsed.rawJson), input)
  assert.equal(context.toCommand(JSON.stringify({ ...input, background: false })), null)
  assert.equal(context.toCommand(JSON.stringify({ ...input, background_kind: 'job' })), null)
})

test('incremental startup scanning preserves split lines and evidence after the displayed tail changes', () => {
  const task = service(), first = 'Now listen', second = output.slice(first.length)
  readiness.applyBackgroundStartupLogs(task, logs(first))
  assert.equal(task.startup.applicationStarted, undefined)
  readiness.applyBackgroundStartupLogs(task, logs(second, first.length))
  assert.equal(task.startup.applicationStarted, true)
  assert.equal(task.startup.url, 'https://localhost:44301')
  const evidence = task.startup.evidence
  readiness.applyBackgroundStartupLogs(task, logs('other logs\n', output.length))
  assert.equal(task.startup.evidence, evidence)
  const unrelated = service()
  readiness.applyBackgroundStartupLogs(unrelated, logs('success\nhttps://example.com\n'))
  assert.equal(readiness.backgroundReadinessProbeCommand(unrelated, 'identity', 'windows'), null)
  assert.throws(() => readiness.applyBackgroundStartupLogs(task, logs('wrong offset')))
})

test('the port probe checks the captured root identity and descendant ownership on each target', () => {
  const task = service()
  readiness.applyBackgroundStartupLogs(task, logs(output))
  const windows = readiness.backgroundReadinessProbeCommand(task, '123456789', 'windows')
  assert.match(windows, /ParentProcessId/)
  assert.match(windows, /Get-NetTCPConnection -LocalPort 44301/)
  assert.match(windows, /OwningProcess/)
  assert.equal((windows.match(/StartTime.ToUniversalTime\(\).Ticks/g) || []).length, 2)
  const posix = readiness.backgroundReadinessProbeCommand(task, 'saved-start', 'posix')
  assert.match(posix, /sport = :44301/)
  assert.match(posix, /w2t_owner.*w2t_child/s)
  task.backgroundOptions.readiness = { type: 'http', url: 'https://localhost:44301/health' }
  const http = readiness.backgroundReadinessProbeCommand(task, 'saved-start', 'posix')
  assert.match(http, /--noproxy '\*'/)
  assert.doesNotMatch(http, /--insecure/)
  assert.match(readiness.backgroundReadinessProbeCommand(task, '123456789', 'windows'), /AllowAutoRedirect = \$false/)
})

test('a live service publishes ready once and remains monitored until its later exit', async t => {
  const f = fixture(t)
  f.pending.push(sample(), logs(output), '__W2T_READY__{"ok":true}')
  assert.equal(f.register(), 1)
  await settle()
  let task = f.manager.getState().tasks[0]
  assert.equal(task.status, 'running')
  assert.equal(task.startup.state, 'ready')
  assert.equal(f.notifications.filter(item => item.kind === 'ready').length, 1)
  assert.equal(f.saved.at(-1).settled, false)
  f.advance(24 * 60 * 60 * 1000)
  f.pending.push(sample())
  await f.tick()
  assert.equal(f.manager.getState().tasks[0].status, 'running', 'the readiness deadline is not a service runtime limit')
  assert.equal(f.notifications.filter(item => item.kind === 'ready').length, 1)
  assert.equal(f.commands.filter(command => command.includes('__W2T_STARTUP_LOG__')).length, 1)
  f.pending.push(sample({ alive: false, exitCode: 0 }))
  await f.tick()
  f.pending.push(sample({ alive: false, exitCode: 0 }))
  await f.tick()
  assert.equal(f.notifications.filter(item => item.kind === 'finished').length, 1)
  task = f.manager.getState().tasks[0]
  assert.equal(typeof task.startup.readyAt, 'number')
})

test('readiness timeout preserves the process and a later successful check can still publish ready', async t => {
  const f = fixture(t)
  f.pending.push(sample(), logs(output), '__W2T_READY__{"ok":false}')
  f.register()
  await settle()
  f.advance(121000)
  f.pending.push(sample(), logs('', output.length), '__W2T_READY__{"ok":false}')
  await f.tick()
  assert.equal(f.manager.getState().tasks[0].status, 'running')
  assert.equal(f.manager.getState().tasks[0].startup.state, 'timeout')
  assert.deepEqual(f.notifications.map(item => item.kind), ['startup-timeout'])
  f.pending.push(sample(), logs('', output.length), '__W2T_READY__{"ok":true}')
  await f.tick()
  assert.deepEqual(f.notifications.map(item => item.kind), ['startup-timeout', 'ready'])
  assert.ok(f.commands.every(command => !command.includes('taskkill') && !command.includes('Stop-Process')))
})

test('explicit jobs retain exit-based completion even if their output includes server examples', async t => {
  const f = fixture(t)
  f.pending.push(sample())
  f.register({ kind: 'job' })
  await settle()
  assert.equal(f.manager.getState().tasks[0].startup, undefined)
  assert.equal(f.commands.length, 1)
  assert.equal(f.notifications.length, 0)
})

test('confirmed readiness and cancelled notifications survive restoration without a second startup event', async t => {
  const first = fixture(t)
  first.pending.push(sample(), logs(output), '__W2T_READY__{"ok":true}')
  first.register()
  await settle()
  first.manager.cancelNotifications({ platformId: 'deepseek', conversationId: 'chat-a' })
  const stored = first.saved.at(-1)
  assert.equal(stored.task.readinessDeliveryStatus, 'cancelled')
  assert.equal(stored.task.deliveryStatus, 'cancelled')
  first.manager.dispose()
  const next = fixture(t)
  next.pending.push(sample())
  next.manager.restore([shared.parseStoredBackgroundTask(JSON.stringify(stored))], () => next.target, () => undefined)
  await settle()
  assert.equal(next.manager.getState().tasks[0].startup.state, 'ready')
  assert.equal(next.notifications.length, 0)
  assert.equal(next.commands.length, 1)
  stored.task.readinessDeliveryStatus = 'sending'
  const uncertain = shared.parseStoredBackgroundTask(JSON.stringify(stored))
  assert.equal(uncertain.task.readinessDeliveryStatus, 'needs-attention')
  assert.match(uncertain.task.readinessDeliveryMessage, /不会自动重复提交/)
})
