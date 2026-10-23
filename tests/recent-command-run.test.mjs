// User-run offline regression: node --test tests/recent-command-run.test.mjs
// In-memory records and fake shells only; no Electron, user database, processes or network.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/commands.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const protocol = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/background-tasks.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: protocol })

function fixture(t, options = {}) {
  const original = {
    messageId: 'original', conversationId: 'chat-a', kind: 'command', fileRequest: null,
    deliveryStatus: null, command: "Write-Output '历史命令'\nGet-Location", description: '检查状态',
    timeoutSeconds: 30, status: 'done', exitCode: 0, output: 'original output',
    createdAt: 10, startedAt: 11, finishedAt: 12, ...options.original
  }
  const records = new Map([[original.messageId, original]])
  const recent = [{ messageId: original.messageId, payloadJson: JSON.stringify({
    command: original.command, description: original.description, timeout_seconds: original.timeoutSeconds
  }), createdAt: 10 }]
  const events = []
  const sent = []
  const calls = []
  let currentConversationId = 'chat-a'
  let terminalMode = true
  let localShell
  const result = {
    output: 'fresh output', exitCode: 0, timedOut: false, interrupted: false,
    sessionLost: false, cwd: 'C:\\current-workspace', ...options.result
  }
  class FakeShell {
    constructor(shellOptions) {
      this.kind = options.remote ? 'posix' : 'windows'
      this.label = options.remote ? 'Shell' : 'PowerShell'
      this.cwd = shellOptions.initialCwd
      this.alive = true
      this.running = false
      if (!options.remote) localShell = this
    }
    async run(command, timeoutMs) {
      calls.push({ command, timeoutMs, cwd: this.cwd, shell: this })
      events.push('run')
      this.running = true
      const outcome = options.pending ? await options.pending : result
      this.running = false
      this.cwd = outcome.cwd
      events.push('finished')
      return outcome
    }
    async interrupt() { this.running = false; events.push('interrupt'); return true }
    dispose() {}
  }
  const remoteShell = options.remote ? new FakeShell({ initialCwd: '/remote/current' }) : null
  const exports = {}
  new Script(compiled, { filename: 'commands.cjs' }).runInNewContext({
    exports, process, console, setTimeout, clearTimeout,
    require(id) {
      if (id === 'node:crypto') return crypto
      if (id === './shell') return { ConversationShell: FakeShell, IDLE_TIMEOUT_MS: 300000, MAX_RUNTIME_MS: 1800000 }
      if (id === '../shared/file-requests') return { parseReadFilesRequest: () => assert.fail('no file request expected') }
      if (id === '../shared/background-tasks') return protocol
      assert.fail(`unexpected dependency: ${id}`)
    }
  })
  const runner = new exports.CommandRunner({
    store: {
      listRecentCommandJson: () => recent,
      getExecution: (id) => records.get(id) ?? null,
      createExecution(record) {
        if (records.has(record.messageId)) return false
        records.set(record.messageId, {
          ...record, kind: 'command', fileRequest: null, deliveryStatus: null,
          exitCode: null, output: '', startedAt: null, finishedAt: null
        })
        return true
      },
      listExecutions: (id) => [...records.values()].filter((record) => record.conversationId === id),
      setExecutionStatus: (id, status) => { records.get(id).status = status },
      finishExecution: (id, outcome) => Object.assign(records.get(id), outcome),
      interruptRunningCommands() {}
    },
    currentConversationId: () => currentConversationId,
    terminalModeEnabled: () => terminalMode,
    remoteShell: () => remoteShell,
    onTaskStarted: () => events.push('task-started'),
    captureBackgroundTasks: options.captureBackgroundTasks,
    startBackgroundTask: options.startBackgroundTask,
    onTaskCompleted() {}, onExecutionChanged() {}, onTerminalChanged() {},
    onRemoteLine() {}, onRemoteOutput() {},
    async sendRawToPage(text) { events.push('send'); sent.push(text); return options.delivery ?? 'ok' }
  }, 'C:\\current-workspace')
  runner.restoreMode(options.mode ?? 'manual')
  t.after(() => runner.disposeAll())
  return {
    runner, records, original, recent, sent, events, calls, remoteShell,
    get localShell() { return localShell },
    switchConversation(id) { currentConversationId = id },
    setTerminalMode(enabled) { terminalMode = enabled },
    async settled() {
      await new Promise(setImmediate)
      assert.equal(runner.inFlight.size, 0, 'replay should have completed')
    }
  }
}

test('background history replay keeps its execution mode and goes through the software launcher', async t => {
  const starts = []
  const f = fixture(t, { original: { background: true }, startBackgroundTask: async (record, shell, run) => {
    starts.push({ record, shell })
    return { result: await run('software-generated launcher'), registered: 1 }
  } })
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
  await f.settled()
  assert.equal(starts.length, 1)
  assert.equal(starts[0].record.background, true)
  assert.equal(f.calls[0].command, 'software-generated launcher')
  assert.equal(f.calls[0].timeoutMs, 30000)
  assert.equal(f.sent.length, 0, 'the background notification queue owns creation and completion')
})

test('captures background task ownership before execution and registers raw results after a conversation switch', async t => {
  let finish
  const captured = []
  const registrations = []
  const f = fixture(t, {
    pending: new Promise(resolve => { finish = resolve }),
    captureBackgroundTasks(record, shell) {
      captured.push({ conversationId: record.conversationId, shell })
      return output => { registrations.push(output); return 1 }
    }
  })
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
  await new Promise(setImmediate)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].conversationId, 'chat-a')
  assert.equal(captured[0].shell, f.calls[0].shell)
  assert.equal(registrations.length, 0)
  f.switchConversation('chat-b')
  const output = 'x'.repeat(12000) + '\n__W2T_BACKGROUND_TASK__{"pid":12345,"name":"后台任务","log_path":"C:\\\\logs\\\\task.log"}'
  finish({ output, exitCode: 0, cwd: 'C:\\current-workspace', timedOut: false, interrupted: false, sessionLost: false })
  await f.settled()
  assert.equal(registrations[0], output, 'registration must receive untruncated actual output')
  assert.equal(f.sent.length, 0, 'a different conversation must not receive the old result')
})

test('registered background startups are archived while dedicated notifications replace ordinary output', async t => {
  const f = fixture(t, { captureBackgroundTasks: () => () => 1 })
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
  await f.settled()
  assert.equal(f.calls.length, 1)
  assert.equal(f.sent.length, 0, 'creation and final notifications use the background delivery queue')
  assert.equal([...f.records.values()].at(-1).status, 'done')
  assert.equal([...f.records.values()].at(-1).output, 'fresh output')
  assert.equal(f.runner.canSendAutomaticResult(), true)
  f.runner.setPaused(true)
  assert.equal(f.runner.canSendAutomaticResult(), false)
  f.runner.setPaused(false)
  f.setTerminalMode(false)
  assert.equal(f.runner.canSendAutomaticResult(), false)
})

test('split-line background registration is captured and its startup output is not sent to AI', async t => {
  const output = '__W2T_BACKGROUND_TASK__\r\n' + JSON.stringify({ pid: 33464, name: '6分钟性能监控',
    log_path: 'C:\\Temp\\perf-monitor-fixture\\stdout.log', exit_code_path: 'C:\\Temp\\perf-monitor-fixture\\exit_code.txt' })
  const captured = []
  const f = fixture(t, { result: { output }, captureBackgroundTasks: () => text => {
    const parsed = protocol.parseBackgroundTaskRegistrations(text)
    captured.push(...parsed)
    return parsed.length
  } })
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
  await f.settled()
  assert.equal(captured.length, 1)
  assert.equal(captured[0].pid, 33464)
  assert.equal(f.sent.length, 0)
  assert.equal([...f.records.values()].at(-1).output, output)
})

test('an invalid registration still returns the startup result for the model to diagnose', async t => {
  const f = fixture(t, { captureBackgroundTasks: () => () => 0 })
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
  await f.settled()
  assert.equal(f.sent.length, 1)
})

for (const mode of ['manual', 'auto']) {
  test(`executes in the current terminal then returns command and fresh result in ${mode} mode`, async (t) => {
    let finish
    const f = fixture(t, { mode, pending: new Promise((resolve) => { finish = resolve }) })
    const originalSnapshot = { ...f.original }
    assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
    assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'busy')
    await new Promise(setImmediate)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].command, f.original.command)
    assert.equal(f.calls[0].cwd, 'C:\\current-workspace')
    assert.equal(f.calls[0].timeoutMs, 30000)
    assert.equal(f.sent.length, 0, 'no JSON or message is sent before the shell finishes')
    finish({ output: '\u001b[32mfresh output\u001b[0m\r\n', exitCode: 0, cwd: 'C:\\current-workspace', timedOut: false, interrupted: false, sessionLost: false })
    await f.settled()
    assert.deepEqual(f.events, ['task-started', 'run', 'finished', 'send'])
    assert.equal(f.sent.length, 1)
    assert.match(f.sent[0], /【历史指令重新执行结果】/)
    assert.ok(f.sent[0].includes(f.original.command))
    assert.match(f.sent[0], /结果: 成功/)
    assert.match(f.sent[0], /退出码: 0/)
    assert.ok(f.sent[0].includes('目录: C:\\current-workspace'))
    assert.match(f.sent[0], /fresh output/)
    assert.doesNotMatch(f.sent[0], /original output|\u001b|\r/)
    assert.deepEqual(f.original, originalSnapshot)
    const replay = [...f.records.values()].find((record) => record.messageId !== 'original')
    assert.match(replay.messageId, /^rerun:/)
    assert.equal(replay.status, 'done')
    assert.equal(f.recent.length, 1, 'replays must not crowd the three saved choices')

    assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
    await f.settled()
    assert.equal(f.calls.length, 2)
    assert.equal(f.records.size, 3, 'another explicit replay receives a fresh identity')
    assert.equal(f.runner.handleDetected({ ...f.original, live: true }), true)
    assert.equal(f.calls.length, 2, 'page history remains deduplicated')
  })
}

for (const [name, result, status, expected] of [
  ['failure', { exitCode: 7, output: 'failure detail' }, 'failed', /失败（退出码 7）/],
  ['timeout', { exitCode: null, timedOut: 'ceiling', timeoutMs: 30000, output: 'partial output' }, 'timeout', /已强制终止/],
  ['empty output', { output: '' }, 'done', /命令没有任何输出/]
]) {
  test(`automatically returns a ${name} with its status and output`, async (t) => {
    const f = fixture(t, { result })
    assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
    await f.settled()
    assert.equal(f.sent.length, 1)
    assert.match(f.sent[0], expected)
    assert.equal([...f.records.values()].at(-1).status, status)
    if (result.output) assert.ok(f.sent[0].includes(result.output))
  })
}

test('uses the attached remote terminal and its current directory', async (t) => {
  const f = fixture(t, { remote: true, result: { cwd: '/remote/current' } })
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
  await f.settled()
  assert.equal(f.calls[0].shell, f.remoteShell)
  assert.equal(f.calls[0].cwd, '/remote/current')
  assert.equal(f.localShell, undefined, 'must not create a local shell while remote is attached')
  assert.match(f.sent[0], /目录: \/remote\/current/)
})

test('rejects stale selections, mismatched conversations, disabled mode, pause and busy terminal', (t) => {
  const f = fixture(t, { remote: true })
  assert.equal(f.runner.runRecentCommand('chat-b', 'original'), 'unavailable')
  assert.equal(f.runner.runRecentCommand('chat-a', 'missing'), 'unavailable')
  f.original.conversationId = 'chat-b'
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'unavailable')
  f.original.conversationId = 'chat-a'
  f.setTerminalMode(false)
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'terminal-mode-off')
  f.setTerminalMode(true)
  f.runner.restorePaused(true)
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'paused')
  f.runner.restorePaused(false)
  f.remoteShell.running = true
  assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'busy')
  assert.equal(f.records.size, 1)
  assert.equal(f.calls.length, 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.events.length, 0)
})

for (const command of ['', '...', 'TODO']) {
  test(`rejects a saved empty or placeholder command: ${JSON.stringify(command)}`, (t) => {
    const f = fixture(t, { original: { command } })
    assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'invalid')
    assert.equal(f.records.size, 1)
    assert.equal(f.calls.length, 0)
  })
}

for (const action of ['switch', 'pause', 'disable', 'end']) {
  test(`does not send a late result after ${action}`, async (t) => {
    let finish
    const f = fixture(t, { pending: new Promise((resolve) => { finish = resolve }) })
    assert.equal(f.runner.runRecentCommand('chat-a', 'original'), 'ok')
    await new Promise(setImmediate)
    if (action === 'switch') f.switchConversation('chat-b')
    if (action === 'pause') f.runner.setPaused(true)
    if (action === 'disable') f.setTerminalMode(false)
    if (action === 'end') await f.runner.endTask()
    finish({ output: 'late output', exitCode: 0, cwd: 'C:\\current-workspace', timedOut: false, interrupted: false, sessionLost: false })
    await f.settled()
    assert.equal(f.sent.length, 0)
    assert.equal([...f.records.values()].at(-1).output, 'late output')
  })
}
