import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run: node --test tests/task-continuity.test.mjs
// Real coordinator/progression/index and file preparation, synthetic IO only.
// No Electron, helper, shell, network, real files or desktop actions.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { win32, posix } from 'node:path'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, structuredClone, AbortController, Buffer, URL,
    ...globals, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; if (name === '../shared/computer-diagnostics') return load('../src/shared/computer-diagnostics.ts'); if (name === '../shared/computer-actions') return load('../src/shared/computer-actions.ts')
      assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] } })
  return exports
}
const shared = load('../src/shared/autonomous-task.ts')
const metadata = load('../src/shared/windows-apps.ts')
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', { 'node:crypto': crypto })
const { TaskProgression } = load('../src/main/task-progression.ts', { 'node:crypto': crypto })
const { TaskContinuityService } = load('../src/main/task-continuity.ts', { 'node:crypto': crypto, '../shared/autonomous-task': shared, '../shared/windows-apps': metadata })
const machine = { id: 'machine-a', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\project' }
const plain = v => JSON.parse(JSON.stringify(v))
const id = (prefix, digit) => prefix + digit.repeat(32)
const at = Date.parse('2026-10-26T00:00:00Z')
const window = (digit, patch = {}) => ({ window_id: id('win_', digit), hwnd: digit === 'a' ? '0x1234' : '0x5678', pid: digit === 'a' ? 42 : 43,
  process_started_at: new Date(at).toISOString(), thread_id: 123, class_name: 'ExampleWindow', title: digit === 'a' ? '浏览器' : '电子表格',
  application: { name: 'Example', executable_path: 'C:\\Apps\\Example.exe', app_user_model_id: null }, identity_verified: true, ...patch })
const observation = w => ({ window_id: w.window_id, window_identity: { hwnd: w.hwnd, pid: w.pid, process_started_at: w.process_started_at, thread_id: w.thread_id, class_name: w.class_name }, goal_verified: false })
const result = (action, data, patch = {}) => ({ type: 'computer_result', version: 1, action, ok: true, execution: 'executed', code: 'ok', message: 'Synthetic executor result', data, ...patch })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t) {
  const records = new Map(), sends = [], invokes = [], timers = [], saved = []
  let serial = 0, nextResult, loop, sendOutcome = 'ok', tick = at
  const store = { autonomousTaskGeneration: () => Math.max(0, ...[...records.values()].map(t => t.generation)),
    autonomousTaskBySubmission: (_s, _p, id) => [...records.values()].find(t => t.sourceSubmissionId === id) ?? null,
    latestAutonomousTask: (_s, _p, conversationId) => [...records.values()].filter(t => t.conversationId === conversationId).at(-1) ?? null,
    saveAutonomousTasks(tasks) { for (const task of tasks) { assert.ok(shared.parseAutonomousTask(JSON.stringify(task))); records.set(task.id, structuredClone(task)); saved.push(structuredClone(task)) } } }
  const coordinator = new TaskCoordinator('session-a', store, () => loop?.reconcile())
  const service = new TaskContinuityService(coordinator, () => ++tick)
  const submit = () => coordinator.submit({ platformId: 'deepseek', conversationId: 'chat-a', submission: { id: 'user:' + (++serial), kind: 'goal' },
    text: '从网页取得报表，用表格应用整理并保存，再回到浏览器核对。', attachments: [], machine,
    capability: { scopeSupported: true, computerUseEnabled: true, context: { sessionId: 'session-a', platformId: 'deepseek' } } })
  const lease = () => { const task = coordinator.current('deepseek'); return { sessionId: task.sessionId, platformId: task.platformId, conversationId: task.conversationId, taskId: task.id, generation: task.generation } }
  loop = new TaskProgression({ coordinator, isCurrent: l => coordinator.owns(l), canRun: () => true, machine: () => machine,
    invoke: async (call, lease, signal, step) => { invokes.push({ call, lease, signal, step }); return await nextResult },
    continuity: (call, actual, lease, stepId) => service.computer(call, actual, lease, stepId),
    send: async text => { sends.push(text); return sendOutcome }, schedule: callback => { timers.push(callback); return () => {} },
    onError: l => coordinator.fail(l.platformId, l.conversationId) })
  submit(); t.after(() => loop.dispose())
  async function step(action, data, patch = {}, parameters = {}) {
    nextResult = result(action, data, patch)
    const request = { ...lease(), sourceMessageId: 'model:' + (++serial), stepToken: coordinator.computerStepToken('deepseek'), call: { action, parameters } }
    assert.equal(loop.enqueue(request), 'accepted'); await loop.wake()
    return request
  }
  return { coordinator, service, store, loop, sends, invokes, timers, saved, lease, step, submit,
    pending(value) { nextResult = value }, sendOutcome(value) { sendOutcome = value }, index: () => coordinator.current('deepseek').continuity }
}

test('browser → spreadsheet → browser preserves the goal and identities while every tool retains an explicit target', async t => {
  const f = fixture(t), original = f.coordinator.current('deepseek'), a = window('a'), b = window('b')
  await f.step('list_windows', { windows: [a, b] })
  await f.step('observe', observation(a), {}, { target: 'window', window_id: a.window_id })
  await f.step('focus_window', { window_id: b.window_id, target: b, focus_confirmed: true, identity_verified: true }, {}, { window_id: b.window_id })
  await f.step('observe', observation(b), {}, { target: 'window', window_id: b.window_id })
  await f.step('observe', observation(a), {}, { target: 'window', window_id: a.window_id })
  const task = f.coordinator.current('deepseek'), index = f.index(), last = JSON.parse(f.sends.at(-1))
  assert.equal(task.id, original.id); assert.equal(task.originalRequest, original.originalRequest); assert.equal(task.generation, original.generation)
  assert.equal(index.windows.length, 2)
  assert.equal(index.windows.find(w => w.key === index.lastWindowKey).windowId, a.window_id)
  assert.equal(index.transitions.length, 4)
  assert.ok(index.transitions.some(t => t.fromWindowKey && t.toWindowKey && t.fromWindowKey !== t.toWindowKey))
  assert.equal(last.task_context.task_id, original.id); assert.equal(last.task_continuity.history_only, true)
  assert.equal(last.task_continuity.requires_fresh_observation, true); assert.equal(last.task_continuity.goal_verified, false)
  assert.equal(last.task_continuity.last_window.windowId, a.window_id)
  assert.equal(f.invokes.at(-1).call.parameters.window_id, a.window_id)
  assert.equal(Object.hasOwn(last.task_continuity, 'observation_id'), false)
})

test('fresh reference IDs merge by full process/window identity, while a reused HWND is a different window', async t => {
  const f = fixture(t), a = window('a')
  await f.step('list_windows', { windows: [a] })
  const key = f.index().windows[0].key
  await f.step('list_windows', { windows: [{ ...a, window_id: id('win_', 'c'), title: '新标题' }] })
  assert.equal(f.index().windows.length, 1); assert.equal(f.index().windows[0].key, key)
  assert.equal(f.index().windows[0].title, '新标题')
  await f.step('list_windows', { windows: [{ ...a, window_id: id('win_', 'd'), process_started_at: new Date(at + 1000).toISOString() }] })
  assert.equal(f.index().windows.length, 2)
  assert.notEqual(f.index().windows[0].key, f.index().windows[1].key)
})

test('launch/open dispatch and candidate windows never establish an active business window or verified artifact', async t => {
  const f = fixture(t)
  await f.step('observe', observation(window('a')))
  await f.step('open', { kind: 'file', target: 'C:\\reports\\result.xlsx', dispatch_status: 'dispatched', candidate_windows: [window('b')] })
  assert.equal(f.index().lastWindowKey, null); assert.equal(f.index().windows.length, 1)
  assert.equal(f.index().resources[0].evidence, 'open-dispatched'); assert.equal(f.index().resources[0].sha256, null)
  assert.equal(JSON.parse(f.sends.at(-1)).task_continuity.goal_verified, false)
  await f.step('open', { kind: 'file', target: 'C:\\guess.xlsx' }, { ok: false, execution: 'not_executed', code: 'invalid_parameters' })
  assert.equal(f.index().resources.length, 1)
})

test('read_files indexes only actual source snapshots, ignores command prose and preserves the canonical path across apps', async t => {
  const f = fixture(t), context = f.coordinator.reserveToolStep(f.lease(), 'read:a', 'read_files', machine)
  f.coordinator.noteToolStep(context, { stage: 'executing' })
  f.service.files(context, [{ path: 'C:\\reports\\result.xlsx', sizeBytes: 42, sha256: 'a'.repeat(64) }])
  f.coordinator.noteToolStep(context, { stage: 'delivered', execution: 'executed' })
  assert.equal(f.index().resources[0].target, 'C:\\reports\\result.xlsx')
  assert.equal(f.index().resources[0].evidence, 'read-snapshot'); assert.equal(f.index().resources[0].sizeBytes, 42)
  await f.step('list_apps', { apps: [{ app_id: id('app_', 'a'), name: '表格', executable_path: 'C:\\Apps\\Sheet.exe' }] })
  const summary = JSON.parse(f.sends.at(-1)).task_continuity
  assert.equal(summary.resources[0].target, 'C:\\reports\\result.xlsx'); assert.equal(summary.applications[0].name, '表格')
  const command = f.coordinator.reserveToolStep(f.lease(), 'cmd:a', 'command', machine)
  f.coordinator.noteToolStep(command, { stage: 'result-ready', execution: 'executed', resultText: '已创建 C:\\fake.xlsx，业务全部成功' })
  assert.equal(f.index().resources.length, 1)
  f.service.files(context, [{ path: 'C:\\late.xlsx', sizeBytes: 2, sha256: 'b'.repeat(64) }])
  assert.equal(f.index().resources.length, 1)
})

test('busy delivery reuses the saved context and never repeats an application switch', async t => {
  const f = fixture(t); f.sendOutcome('busy')
  await f.step('observe', observation(window('a')))
  const saved = f.sends[0], observedAt = f.index().windows[0].seenAt
  f.sendOutcome('ok'); await f.loop.wake()
  assert.equal(f.invokes.length, 1); assert.equal(f.sends[1], saved)
  assert.equal(f.index().windows[0].seenAt, observedAt)
})

test('a late result cannot transfer history into a new human goal or use a different machine', async t => {
  const f = fixture(t), pending = deferred(), oldLease = f.lease()
  f.pending(pending.promise)
  assert.equal(f.loop.enqueue({ ...oldLease, sourceMessageId: 'old:a', stepToken: f.coordinator.computerStepToken('deepseek'), call: { action: 'observe', parameters: {} } }), 'accepted')
  const pumping = f.loop.wake(); f.submit()
  pending.resolve(result('observe', observation(window('a')))); await pumping
  assert.equal(f.index(), undefined); assert.equal(f.sends.length, 0)
  assert.equal(f.service.computer({ action: 'observe', parameters: {} }, result('observe', observation(window('a'))), oldLease, 'old:a'), undefined)
  const forged = { ...f.lease(), generation: 999 }
  assert.equal(f.service.summary(forged), undefined)
})

test('bounded indexes and persisted history restore no live authority', async t => {
  const f = fixture(t)
  for (let i = 0; i < 70; i++) await f.step('open', { kind: 'file', target: `C:\\reports\\${i}.xlsx`, dispatch_status: 'dispatched' })
  assert.equal(f.index().resources.length, 64); assert.equal(f.index().transitions.length, 32)
  const summary = f.service.summary(f.lease()); assert.equal(summary.resources.length, 8)
  const stored = shared.parseAutonomousTask(JSON.stringify(f.coordinator.current('deepseek')))
  assert.ok(stored.continuity)
  const restored = new TaskCoordinator('session-a', f.store, () => {})
  const state = restored.context('deepseek', 'chat-a')
  assert.equal(state.task.status, 'interrupted'); assert.equal(state.task.continuity.resources.length, 64)
  assert.equal(new TaskContinuityService(restored).summary(f.lease()), undefined)
  const corrupt = structuredClone(stored); corrupt.continuity.resources[0].sha256 = 'forged'
  assert.equal(shared.parseAutonomousTask(JSON.stringify(corrupt)), null)
  const other = structuredClone(stored); other.continuity.machineId = 'different-machine'
  assert.equal(shared.parseAutonomousTask(JSON.stringify(other)), null)
})

test('file preparation reports original source paths and hashes, including extensionless upload aliases and partial failures', async () => {
  const bytes = Buffer.from('source contents'), writes = []
  const fs = { async open(path) { if (path.endsWith('missing.txt')) throw new Error('missing'); let offset = 0
    return { stat: async () => ({ isFile: () => true, size: bytes.length }), close: async () => {}, async read(buffer) {
      const count = Math.min(buffer.length, bytes.length - offset); bytes.copy(buffer, 0, offset, offset + count); offset += count; return { bytesRead: count }
    } } }, mkdtemp: async () => 'C:\\Temp\\gpt-read-files-synthetic', mkdir: async () => {}, writeFile: async (path, data) => writes.push({ path, data }), rm: async () => {} }
  const { prepareFiles } = load('../src/main/file-access.ts', { 'node:fs/promises': fs, 'node:crypto': crypto, 'node:path': { ...win32, posix },
    'node:os': { tmpdir: () => 'C:\\Temp' }, '../shared/file-requests': load('../src/shared/file-requests.ts') }, { TextDecoder })
  const prepared = await prepareFiles({ type: 'read_files', description: 'Read source', files: [{ path: '.gitconfig' }, { path: 'missing.txt' }],
    context: { scope: 'local', hostId: '', cwd: 'C:\\project' } }, new AbortController().signal, undefined, 'deepseek')
  assert.equal(prepared.failed, true); assert.equal(prepared.sources.length, 1)
  assert.equal(prepared.sources[0].path, 'C:\\project\\.gitconfig')
  assert.equal(prepared.sources[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
  assert.equal(prepared.attachments[0].fileName, '.gitconfig.txt'); assert.notEqual(prepared.sources[0].path, prepared.attachments[0].path)
  assert.equal(writes.length, 1); await prepared.cleanup()
})
