import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run: node --test tests/windows-window-catalog.test.mjs
// Real protocol, tool registry and main adapter; synthetic helper/clock/task only. No Electron/helper or desktop is started.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Script(source).runInNewContext({ exports, Buffer, URL, structuredClone, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] } })
  return exports
}
const protocol = load('../src/shared/computer-use-protocol.ts')
const computer = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const registry = load('../src/main/computer-use-tool.ts', { '../shared/computer-use': computer })
const appMetadata = load('../src/shared/windows-apps.ts')
const apps = load('../src/main/windows-app-catalog.ts', { 'node:fs/promises': {}, 'node:path': { win32 }, '../shared/windows-apps': appMetadata, './computer-use-tool': registry })
const metadata = load('../src/shared/windows-desktop.ts')
const catalog = load('../src/main/windows-window-catalog.ts', { 'node:crypto': { randomUUID: () => { throw new Error('fixture must inject ids') } },
  '../shared/windows-desktop': metadata, './computer-use-tool': registry, './windows-app-catalog': apps })
const id = (prefix, digit = 'a') => prefix + digit.repeat(32)
const at = Date.parse('2026-10-25T00:00:00.000Z')
const row = (patch = {}) => ({ window_id: id('win_'), hwnd: '0x1234', pid: 42, process_started_at: new Date(at - 10000).toISOString(), thread_id: 100,
  class_name: 'ExampleWindow', title: 'Report', application: { name: 'Editor', executable_path: 'C:\\Apps\\Editor.exe', app_user_model_id: null },
  visible: true, minimized: false, foreground: false, enabled: true, cloaked: false, owner_hwnd: null, owner_window_id: null, identity_verified: true, identity_status: 'verified', ...patch })
const page = (patch = {}) => ({ snapshot_id: id('wset_'), collected_at: new Date(at).toISOString(), expires_at: new Date(at + 120000).toISOString(),
  query: '', pid: null, include_hidden: false, windows: [row()], total_matches: 1, has_more: false, next_cursor: null, complete: true, limitations: [], ...patch })
const success = data => ({ ok: true, execution: 'executed', code: 'ok', message: 'Actual window snapshot', data })
const focusTarget = (patch = {}) => {
  const { hwnd, pid, process_started_at, thread_id, class_name, title, visible, minimized, foreground, enabled, cloaked, owner_hwnd } = row({ foreground: true, ...patch })
  return { hwnd, pid, process_started_at, thread_id, class_name, title, visible, minimized, foreground, enabled, cloaked, owner_hwnd }
}
const focusResult = (patch = {}) => ({ snapshot_id: id('wset_'), window_id: id('win_'), status: 'focused', before_at: new Date(at).toISOString(), observed_at: new Date(at + 100).toISOString(),
  restore: { attempted: false, accepted: null }, activation_attempts: [true], target: focusTarget(), identity_verified: true,
  observation: { foreground_hwnd: '0x1234', active_hwnd: '0x1234', focus_hwnd: '0x5678', focus_root_hwnd: '0x1234', win32_focus: 'confirmed',
    uia_focus: { status: 'confirmed', root_hwnd: '0x1234', has_keyboard_focus: true } }, blocking_window_hwnd: null, focus_confirmed: true, input_ready: false, goal_verified: false, ...patch })
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  let now = at, active = true, enabled = true, answer = success(page()), serial = 0
  const listeners = new Set(), requests = []
  const state = { phase: 'ready', code: 'ready', generation: 1, actions: ['list_windows'], pid: 9000, protocolVersion: 3, message: 'Ready' }
  const helper = { getState: () => structuredClone(state), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    request: async (action, parameters, options) => { requests.push({ action, parameters, options }); return typeof answer === 'function' ? answer() : answer } }
  const tool = new registry.ComputerUseTool()
  const service = new catalog.WindowsWindowCatalog(helper, () => now, () => (++serial).toString(16).padStart(32, '0'))
  const unregister = service.register(tool)
  const context = { lease: { sessionId: 'session-A', platformId: 'deepseek', conversationId: 'conversation-A', taskId: 'task-A', generation: 1 },
    isCurrent: () => active, capability: () => computer.resolveComputerUseCapability({ computerUseEnabled: enabled, desktopControlEnabled: true },
      { sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }, tool.definitions(), state) }
  return { service, tool, context, state, requests, unregister,
    invoke: (parameters = {}, patch = {}) => tool.invoke({ action: 'list_windows', parameters }, { ...context, ...patch }),
    focus: (parameters = { window_id: id('win_') }, patch = {}) => tool.invoke({ action: 'focus_window', parameters }, { ...context, ...patch }),
    inspect: (parameters = { window_id: id('win_') }, patch = {}) => tool.invoke({ action: 'inspect_interactions', parameters }, { ...context, ...patch }),
    lookup: (windowId = id('win_'), ctx = context, selectedTool = tool) => service.lookup(selectedTool, windowId, ctx),
    setAnswer: value => { answer = value }, setActive: value => { active = value }, setEnabled: value => { enabled = value }, setNow: value => { now = value },
    changed: () => { for (const listener of listeners) listener() } }
}

test('wait discovery admits scoped references without replacing existing list references', async () => {
  const f = fixture(); await f.invoke()
  const lease = f.service.beginWait(f.tool, f.context), second = row({ window_id: id('win_', 'b'), hwnd: '0x2234' })
  const probe = { snapshot_id: id('wset_'), scope_expires_at: new Date(at + 120000).toISOString(), window: second }
  assert.equal(lease.publish(probe), true); assert.ok(f.lookup()); assert.ok(f.lookup(second.window_id))
  second.title = 'mutated'; assert.equal(f.lookup(second.window_id).window.title, 'Report')
  assert.equal(lease.publish({ ...probe, window: { ...second, pid: 43 } }), false)
  assert.equal(lease.publish({ ...probe, snapshot_id: id('wset_', 'b') }), false)
  assert.equal(lease.publish({ ...probe, scope_expires_at: new Date(at + 120001).toISOString() }), false)
  const newer = f.service.beginWait(f.tool, f.context)
  assert.equal(lease.isCurrent(), false); assert.equal(lease.publish(probe), false); assert.equal(newer.isCurrent(), true)
  f.service.dispose()
})

test('wait discovery may initialize a scope but cannot revive expired or other-task results', async () => {
  const f = fixture(), lease = f.service.beginWait(f.tool, f.context)
  assert.match(lease.scope_id, /^ws_[a-f0-9]{32}$/)
  assert.equal(lease.publish({ snapshot_id: id('wset_'), scope_expires_at: new Date(at + 120000).toISOString(), window: row() }), true)
  assert.ok(f.lookup()); f.setNow(at + 120000); assert.equal(lease.isCurrent(), false)
  const newer = f.service.beginWait(f.tool, f.context); assert.notEqual(newer.scope_id, lease.scope_id)
  f.context.lease.taskId = 'task-B'; assert.equal(newer.isCurrent(), false)
  const active = f.service.beginWait(f.tool, f.context); f.state.generation++; assert.equal(active.isCurrent(), false)
  f.service.dispose()
})

test('window capability is advertised only when the real helper supports it and cleans up on unregister', () => {
  const f = fixture()
  assert.match(computer.computerUseCapabilityPrompt(f.context.capability(), id('cu_')), /list_windows/)
  f.state.actions = []; assert.equal(f.context.capability().available, false)
  assert.doesNotMatch(computer.computerUseCapabilityPrompt(f.context.capability(), id('cu_')), /"action":"list_windows"/)
  f.unregister(); assert.equal(f.tool.definitions().length, 0); f.service.dispose()
})

test('page protocol and mandatory main validation reject overrides and invalid window filters', async () => {
  const f = fixture(), base = { type: 'computer', version: 1, action: 'list_windows', step_token: id('cu_') }
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify(base), [metadata.LIST_WINDOWS_DEFINITION]).ok, true)
  for (const parameters of [{ hwnd: '0x1234' }, { window_id: id('win_') }, { scope_id: id('ws_') }, { task_id: 'forged' }, { command: 'text' },
    { limit: 0 }, { limit: 51 }, { pid: 0 }, { pid: 0x100000000 }, { pid: 1.5 }, { include_hidden: 1 }, { cursor: 'guessed' }, { query: 'x'.repeat(201) }]) {
    assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ ...base, ...parameters }), [metadata.LIST_WINDOWS_DEFINITION]).ok, false)
    assert.equal((await f.invoke(parameters)).code, 'invalid_parameters')
  }
  assert.equal(f.requests.length, 0)
})

test('fresh list injects a private task scope and registers only independently checked rows', async () => {
  const f = fixture(); const result = await f.invoke()
  assert.equal(result.ok, true); assert.equal(f.requests.length, 1)
  assert.deepEqual(plain(f.requests[0].parameters), { query: '', pid: null, include_hidden: false, limit: 25, scope_id: 'ws_' + '1'.padStart(32, '0') })
  assert.equal(f.requests[0].options.expectedGeneration, 1); assert.equal(f.requests[0].action, 'list_windows')
  assert.equal(f.lookup().window.process_started_at, row().process_started_at)
  result.data.windows[0].title = 'mutated'; assert.equal(f.lookup().window.title, 'Report')
  f.lookup().window.title = 'mutated again'; assert.equal(f.lookup().window.title, 'Report')
})

test('task lease is required and cannot be replaced by a model-supplied scope', async () => {
  const f = fixture()
  assert.equal((await f.invoke({}, { lease: undefined })).code, 'inactive_context')
  assert.equal((await f.invoke({}, { lease: { ...f.context.lease, sessionId: 'other' } })).code, 'inactive_context')
  assert.equal(f.requests.length, 0)
})

test('partial metadata has no actionable ID and never implies that no other windows exist', async () => {
  const f = fixture()
  f.setAnswer(success(page({ complete: false, limitations: ['metadata_unavailable'], windows: [row({ window_id: null, process_started_at: null, identity_verified: false, identity_status: 'process_unavailable' })] })))
  const result = await f.invoke(); assert.equal(result.ok, true); assert.equal(result.data.complete, false); assert.equal(f.lookup(), null)
  f.setAnswer(success(page({ windows: [], total_matches: 0 }))); assert.equal((await f.invoke()).data.windows.length, 0)
})

test('same-title windows and verified owner relationships remain distinct', async () => {
  const f = fixture(), owner = row(), dialog = row({ window_id: id('win_', 'b'), hwnd: '0x2234', owner_hwnd: owner.hwnd, owner_window_id: owner.window_id, enabled: false })
  f.setAnswer(success(page({ windows: [owner, dialog], total_matches: 2 })))
  assert.equal((await f.invoke()).ok, true)
  assert.equal(f.lookup(id('win_', 'b')).window.owner_window_id, owner.window_id)
  assert.notEqual(f.lookup().window.hwnd, f.lookup(id('win_', 'b')).window.hwnd)
})

test('pagination keeps the original snapshot and merges learned rows while a fresh list revokes them', async () => {
  const f = fixture(); f.setAnswer(success(page({ has_more: true, next_cursor: id('wcur_'), total_matches: 2 })))
  assert.equal((await f.invoke({ limit: 1 })).ok, true)
  f.setAnswer(success(page({ windows: [row({ window_id: id('win_', 'b'), hwnd: '0x2234' })], total_matches: 2 })))
  assert.equal((await f.invoke({ cursor: id('wcur_'), limit: 1 })).ok, true)
  assert.ok(f.lookup()); assert.ok(f.lookup(id('win_', 'b')))
  f.setAnswer(success(page({ snapshot_id: id('wset_', 'c'), windows: [row({ window_id: id('win_', 'c') })] })))
  assert.equal((await f.invoke()).ok, true); assert.equal(f.lookup(), null); assert.equal(f.lookup(id('win_', 'b')), null); assert.ok(f.lookup(id('win_', 'c')))
})

test('new task generations, helper restarts and TTL expiry revoke learned references', async () => {
  for (const revoke of [f => { f.context.lease.generation++ }, f => { f.state.generation++; f.changed() }, f => f.setNow(at + 120000), f => f.setEnabled(false)]) {
    const f = fixture(); await f.invoke(); assert.ok(f.lookup()); revoke(f); assert.equal(f.lookup(), null)
  }
  const f = fixture(); await f.invoke(); f.context.lease.taskId = 'task-B'
  assert.equal((await f.invoke({ cursor: id('wcur_') })).code, 'stale_window'); assert.equal(f.requests.length, 1)
})

test('window references are isolated across tool registrations and conversation ownership', async () => {
  const f = fixture(); await f.invoke()
  const other = new registry.ComputerUseTool(); const removeOther = f.service.register(other)
  assert.equal(f.lookup(id('win_'), f.context, other), null)
  const changedContext = { ...f.context, lease: { ...f.context.lease, conversationId: 'conversation-B' } }
  assert.equal(f.lookup(id('win_'), changedContext), null)
  removeOther(); f.service.dispose(); assert.equal(f.lookup(), null)
})

test('late cancelled, old-task and old-helper results never populate window references', async () => {
  for (const revoke of [(f, abort) => abort.abort(), f => f.setActive(false), f => { f.state.generation++; f.changed() }]) {
    const f = fixture(), waiting = deferred(), abort = new AbortController()
    f.setAnswer(() => waiting.promise)
    const work = f.invoke({}, { signal: abort.signal }); revoke(f, abort); waiting.resolve(success(page()))
    const result = await work; assert.equal(result.ok, false); assert.equal(f.lookup(), null)
  }
})

test('malformed identities, falsely verified rows and dangling owner links never register', async () => {
  for (const patch of [{ window_id: 'guessed' }, { hwnd: '0x0' }, { pid: 0 }, { thread_id: 0 }, { process_started_at: null }, { class_name: '' },
    { identity_verified: false }, { identity_status: 'changed' }, { owner_hwnd: '0x2234', owner_window_id: id('win_', 'b') }, { owner_hwnd: '0x1234' },
    { application: { name: 'App', executable_path: 'C:\\run.cmd', app_user_model_id: null } }, { window_id: id('win_'), goal_verified: true }]) {
    const f = fixture(); f.setAnswer(success(page({ windows: [row(patch)] })))
    const result = await f.invoke(); assert.equal(result.code, 'invalid_result', JSON.stringify(patch)); assert.equal(f.lookup(), null)
  }
})

test('expired pages, altered filters, duplicate handles and contradictory result envelopes are rejected', async () => {
  for (const data of [page({ expires_at: new Date(at).toISOString() }), page({ expires_at: new Date(at + 121000).toISOString() }), page({ pid: 99 }),
    page({ query: 'other' }), page({ include_hidden: true }), page({ windows: [row(), row({ window_id: id('win_', 'b') })], total_matches: 2 }),
    page({ complete: true, limitations: ['window_changed'] }), page({ has_more: true, next_cursor: null }), page({ windows: [row({ visible: false, minimized: false })] })]) {
    const f = fixture(); f.setAnswer(success(data)); assert.equal((await f.invoke()).code, 'invalid_result'); assert.equal(f.lookup(), null)
  }
  const f = fixture(); f.setAnswer({ ...success(page()), execution: 'not_executed' }); assert.equal((await f.invoke()).code, 'invalid_result')
})

test('native stale pagination, failure and unavailable helpers preserve their execution semantics', async () => {
  const f = fixture(); await f.invoke()
  f.setAnswer({ ok: false, execution: 'not_executed', code: 'stale_window', message: 'expired' })
  assert.equal((await f.invoke({ cursor: id('wcur_') })).code, 'stale_window'); assert.equal(f.lookup(), null)
  f.setAnswer(() => { f.state.phase = 'error'; f.changed(); return { ok: false, execution: 'unknown', code: 'process_exited', message: 'disconnected' } })
  const result = await f.invoke(); assert.equal(result.execution, 'unknown'); assert.equal(f.lookup(), null)
})

test('changed snapshot on a continuation cannot replace the learned snapshot', async () => {
  const f = fixture(); f.setAnswer(success(page({ has_more: true, next_cursor: id('wcur_'), total_matches: 2 }))); await f.invoke()
  f.setAnswer(success(page({ snapshot_id: id('wset_', 'b') })))
  assert.equal((await f.invoke({ cursor: id('wcur_') })).code, 'invalid_result'); assert.equal(f.lookup(), null)
})

test('an old context cannot erase the current task references and a superseded response cannot restore old rows', async () => {
  const f = fixture(), oldLease = { ...f.context.lease }
  await f.invoke(); f.context.lease = { ...oldLease, taskId: 'task-B', generation: 2 }
  f.setAnswer(success(page({ windows: [row({ window_id: id('win_', 'b') })], snapshot_id: id('wset_', 'b') }))); await f.invoke()
  assert.equal(f.lookup(id('win_', 'b'), { ...f.context, lease: oldLease }), null)
  assert.equal((await f.invoke({}, { lease: oldLease, isCurrent: () => false })).code, 'inactive_context')
  assert.ok(f.lookup(id('win_', 'b')))
  const waiting = deferred(); f.setAnswer(() => waiting.promise); const first = f.invoke()
  f.setAnswer(success(page({ windows: [row({ window_id: id('win_', 'c') })], snapshot_id: id('wset_', 'c') }))); await f.invoke()
  waiting.resolve(success(page())); assert.equal((await first).ok, false)
  assert.ok(f.lookup(id('win_', 'c'))); assert.equal(f.lookup(), null)
})

test('focus_window is advertised only after the helper declares its registered action', () => {
  const f = fixture()
  assert.doesNotMatch(computer.computerUseCapabilityPrompt(f.context.capability(), id('cu_')), /"action":"focus_window"/)
  f.state.actions.push('focus_window')
  assert.match(computer.computerUseCapabilityPrompt(f.context.capability(), id('cu_')), /"action":"focus_window"/)
  f.unregister(); assert.equal(f.tool.definitions().length, 0)
})

test('focus page protocol and main adapter reject guessed handles, scope overrides and invalid parameters', async () => {
  const f = fixture(); f.state.actions.push('focus_window')
  const base = { type: 'computer', version: 1, action: 'focus_window', step_token: id('cu_'), window_id: id('win_') }
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify(base), [metadata.FOCUS_WINDOW_DEFINITION]).ok, true)
  for (const parameters of [{ hwnd: '0x1234' }, { window_id: '0x1234' }, { window_id: id('win_'), scope_id: id('ws_') },
    { window_id: id('win_'), pid: 42 }, { window_id: id('win_'), restore: 1 }, { window_id: id('win_'), wait_ms: -1 },
    { window_id: id('win_'), wait_ms: 3001 }, { window_id: id('win_'), command: 'activate' }]) {
    assert.equal((await f.focus(parameters)).code, 'invalid_parameters')
  }
  assert.equal(f.requests.length, 0)
})

test('unlearned, other-task, expired and restarted window references never reach native focus', async () => {
  for (const prepare of [async () => {}, async f => { await f.invoke(); f.context.lease.taskId = 'new-task' },
    async f => { await f.invoke(); f.setNow(at + 120000) }, async f => { await f.invoke(); f.state.generation++; f.changed() }]) {
    const f = fixture(); f.state.actions.push('focus_window'); await prepare(f)
    assert.equal((await f.focus()).code, 'stale_window'); assert.equal(f.requests.some(request => request.action === 'focus_window'), false)
  }
})

test('a learned focus reference injects the private scope once and updates metadata without granting input', async () => {
  const f = fixture(); f.state.actions.push('focus_window'); await f.invoke()
  f.setAnswer(success(focusResult({ target: focusTarget({ title: 'Current report' }) })))
  const result = await f.focus()
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed'); assert.equal(result.data.focus_confirmed, true)
  assert.equal(result.data.input_ready, false); assert.equal(result.data.goal_verified, false); assert.equal(f.lookup().window.title, 'Current report')
  const request = f.requests[1]
  assert.deepEqual(plain(request.parameters), { scope_id: 'ws_' + '1'.padStart(32, '0'), window_id: id('win_'), restore: true, wait_ms: 1500 })
  assert.equal(request.options.expectedGeneration, 1); assert.equal(f.requests.filter(request => request.action === 'focus_window').length, 1)
  result.data.target.title = 'mutated'; assert.equal(f.lookup().window.title, 'Current report')
})

test('already-focused success may have no activation calls and still requires future input revalidation', async () => {
  const f = fixture(); f.state.actions.push('focus_window'); await f.invoke(); f.setAnswer(success(focusResult({ activation_attempts: [] })))
  const result = await f.focus({ window_id: id('win_'), restore: false, wait_ms: 0 })
  assert.equal(result.ok, true); assert.equal(result.data.activation_attempts.length, 0); assert.equal(result.data.input_ready, false)
  assert.equal(f.requests[1].parameters.restore, false); assert.equal(f.requests[1].parameters.wait_ms, 0)
})

test('foreground-only focus with unavailable UIA returns unconfirmed evidence without becoming successful', async () => {
  const f = fixture(); f.state.actions.push('focus_window'); await f.invoke()
  const data = focusResult({ status: 'foreground_only', focus_confirmed: false,
    observation: { ...focusResult().observation, uia_focus: { status: 'unavailable', root_hwnd: null, has_keyboard_focus: null } } })
  f.setAnswer({ ok: false, execution: 'executed', code: 'focus_unconfirmed', message: 'UIA unavailable', data })
  const result = await f.focus(); assert.equal(result.ok, false); assert.equal(result.code, 'focus_unconfirmed'); assert.equal(result.data.focus.input_ready, false)
  assert.equal(f.requests.filter(request => request.action === 'focus_window').length, 1)
})

test('OS denial, hidden-window requirements and blocking popup evidence are returned without a fallback', async () => {
  for (const [status, code, target] of [['denied', 'focus_denied', focusTarget({ foreground: false })],
    ['restore_required', 'restore_required', focusTarget({ visible: false, minimized: true, foreground: false })],
    ['blocked', 'window_blocked', focusTarget({ enabled: false, foreground: false })]]) {
    const f = fixture(); f.state.actions.push('focus_window'); await f.invoke()
    const attempted = status === 'denied'
    const data = focusResult({ status, target, focus_confirmed: false, activation_attempts: attempted ? [false, false] : [], blocking_window_hwnd: status === 'blocked' ? '0x9999' : null,
      observation: { foreground_hwnd: '0x9999', active_hwnd: '0x9999', focus_hwnd: '0x9999', focus_root_hwnd: '0x9999', win32_focus: 'outside_target', uia_focus: { status: 'not_checked', root_hwnd: null, has_keyboard_focus: null } } })
    f.setAnswer({ ok: false, execution: attempted ? 'executed' : 'not_executed', code, message: 'actual state', data })
    const result = await f.focus(); assert.equal(result.code, code); assert.equal(result.ok, false)
    assert.equal(f.requests.filter(request => request.action === 'focus_window').length, 1)
  }
})

test('stale native focus revokes only the affected reference', async () => {
  const f = fixture(); f.state.actions.push('focus_window')
  f.setAnswer(success(page({ windows: [row(), row({ window_id: id('win_', 'b'), hwnd: '0x2234' })], total_matches: 2 }))); await f.invoke()
  f.setAnswer({ ok: false, execution: 'not_executed', code: 'stale_window', message: 'reused HWND' })
  assert.equal((await f.focus()).code, 'stale_window'); assert.equal(f.lookup(), null); assert.ok(f.lookup(id('win_', 'b')))
})

test('post-dispatch cancellation and old task completions preserve execution without writing new task metadata', async () => {
  const f = fixture(); f.state.actions.push('focus_window'); await f.invoke(); const abort = new AbortController()
  f.setAnswer(() => { abort.abort(); return success(focusResult()) })
  const cancelled = await f.focus(undefined, { signal: abort.signal }); assert.equal(cancelled.code, 'cancelled'); assert.equal(cancelled.execution, 'executed')
  const waiting = deferred(); f.setAnswer(() => waiting.promise)
  const old = f.focus(); f.context.lease = { ...f.context.lease, taskId: 'task-B' }
  f.setAnswer(success(page({ snapshot_id: id('wset_', 'b'), windows: [row({ window_id: id('win_', 'b'), title: 'New task' })] }))); await f.invoke()
  waiting.resolve(success(focusResult({ target: focusTarget({ title: 'Old task' }) })))
  assert.equal((await old).code, 'inactive_context'); assert.equal(f.lookup(id('win_', 'b')).window.title, 'New task')
})

test('malformed focus evidence and invented readiness are unknown failures and invalidate the affected ID', async () => {
  for (const patch of [{ window_id: id('win_', 'b') }, { snapshot_id: id('wset_', 'b') }, { input_ready: true }, { goal_verified: true },
    { target: focusTarget({ pid: 99 }) }, { target: focusTarget({ minimized: true }) }, { target: null }, { identity_verified: false }, { focus_confirmed: false },
    { activation_attempts: [true, false, false] }, { restore: { attempted: false, accepted: true } },
    { observation: { ...focusResult().observation, focus_root_hwnd: '0x9999' } },
    { observation: { ...focusResult().observation, uia_focus: { status: 'confirmed', root_hwnd: '0x9999', has_keyboard_focus: true } } },
    { observation: { ...focusResult().observation, uia_focus: { status: 'unavailable', root_hwnd: null, has_keyboard_focus: null } } }]) {
    const f = fixture(); f.state.actions.push('focus_window'); await f.invoke(); f.setAnswer(success(focusResult(patch)))
    const result = await f.focus(); assert.equal(result.code, 'invalid_result', JSON.stringify(patch)); assert.equal(result.execution, 'unknown'); assert.equal(f.lookup(), null)
  }
})

test('native result code and execution must agree with its focus evidence', async () => {
  for (const answer of [{ ...success(focusResult()), execution: 'not_executed' }, { ...success(focusResult()), code: 'focus_denied' },
    { ok: false, execution: 'executed', code: 'focus_denied', message: 'contradictory', data: focusResult() }]) {
    const f = fixture(); f.state.actions.push('focus_window'); await f.invoke(); f.setAnswer(answer)
    assert.equal((await f.focus()).code, 'invalid_result')
  }
})

function interactions(patch = {}) {
  const parent = row({ foreground: true }), dialog = row({ window_id: id('win_', 'b'), hwnd: '0x2234', class_name: '#32770', owner_hwnd: parent.hwnd, owner_window_id: parent.window_id })
  return { snapshot_id: id('wset_'), parent_window_id: parent.window_id, before_at: new Date(at).toISOString(), observed_at: new Date(at + 1).toISOString(), expires_at: new Date(at + 30000).toISOString(),
    parent, windows: [{ kind: 'dialog', is_modal: true, owner_chain: [parent.hwnd], window: dialog }],
    menu: { active: false, mode: 'none', flags: 0, owner_hwnd: null, root_hwnd: null, owner_window_id: null, keyboard_window_id: null },
    complete: true, limitations: [], snapshot_atomic: false, input_ready: false, goal_verified: false, ...patch }
}
function menuInteractions(mode = 'popup') {
  const parent = row({ foreground: true }), menu = row({ window_id: id('win_', 'b'), hwnd: '0x3234', class_name: '#32768' })
  return interactions({ windows: mode === 'popup' ? [{ kind: 'menu', is_modal: null, owner_chain: [], window: menu }] : [],
    menu: { active: true, mode, flags: 0x14, owner_hwnd: parent.hwnd, root_hwnd: parent.hwnd, owner_window_id: parent.window_id,
      keyboard_window_id: mode === 'popup' ? menu.window_id : parent.window_id } })
}
async function interactionFixture() {
  const f = fixture(); f.state.actions.push('inspect_interactions'); assert.equal((await f.invoke()).ok, true); return f
}
test('interaction protocol rejects handles confirmation directives and unbounded discovery without invoking helper', async () => {
  const f = fixture(); f.state.actions.push('inspect_interactions')
  for (const p of [{}, { window_id: '0x1234' }, { window_id: id('win_'), limit: 0 }, { window_id: id('win_'), limit: 17 },
    { window_id: id('win_'), hwnd: '0x1234' }, { window_id: id('win_'), confirm: true }, { window_id: id('win_'), path: 'C:\secret' }, { window_id: id('win_'), scope_id: 'forged' }]) {
    assert.equal((await f.inspect(p)).code, 'invalid_parameters')
    assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'inspect_interactions', step_token: id('cu_'), ...p }), [metadata.INSPECT_INTERACTIONS_DEFINITION]).ok, false)
  }
  assert.equal(f.requests.length, 0); assert.equal((await f.inspect()).code, 'stale_window'); assert.equal(f.requests.length, 0)
})
test('interaction discovery preserves the source and learns verified nested dialog references with private scope', async () => {
  const f = await interactionFixture(), data = interactions(), dialog = data.windows[0].window
  data.windows.push({ kind: 'dialog', is_modal: true, owner_chain: [dialog.hwnd, data.parent.hwnd],
    window: row({ window_id: id('win_', 'c'), hwnd: '0x3334', class_name: '#32770', pid: 43, owner_hwnd: dialog.hwnd, owner_window_id: dialog.window_id }) })
  f.setAnswer(success(data)); const result = await f.inspect()
  assert.equal(result.ok, true); assert.ok(f.lookup()); assert.ok(f.lookup(id('win_', 'b'))); assert.ok(f.lookup(id('win_', 'c')))
  assert.equal(f.lookup().scope_id, f.lookup(id('win_', 'c')).scope_id); assert.equal(f.requests[1].parameters.scope_id, f.requests[0].parameters.scope_id)
  assert.equal(f.requests[1].parameters.limit, 8); assert.equal(f.requests[1].options.expectedGeneration, 1)
  assert.equal(f.service.interactionContext(f.tool, id('win_', 'b'), f.context).parent_window_id, id('win_'))
  result.data.windows[0].window.title = 'mutated'; assert.equal(f.lookup(id('win_', 'b')).window.title, 'Report')
  assert.equal(f.requests.some(r => r.action === 'focus_window'), false)
})
test('popup and owner menu routes are advertised without focus or automatic confirmation', async () => {
  for (const mode of ['popup', 'owner']) {
    const f = await interactionFixture(); f.setAnswer(success(menuInteractions(mode)))
    const result = await f.inspect(); assert.equal(result.ok, true); assert.equal(result.data.menu.mode, mode)
    const idForMenu = result.data.menu.keyboard_window_id
    assert.ok(f.lookup(idForMenu)); assert.equal(f.service.interactionContext(f.tool, idForMenu, f.context).kind, mode === 'popup' ? 'menu' : 'menu_owner')
    if (mode === 'popup') { assert.equal((await f.inspect({ window_id: idForMenu })).code, 'invalid_parameters'); assert.equal(f.requests.length, 2) }
    assert.deepEqual(f.requests.map(r => r.action), ['list_windows', 'inspect_interactions'])
  }
})
test('interaction refresh replaces only its derived IDs and expiry leaves original business windows usable', async () => {
  const f = await interactionFixture(); f.setAnswer(success(interactions())); assert.equal((await f.inspect()).ok, true)
  const next = interactions(); next.windows[0].window.window_id = id('win_', 'c'); f.setAnswer(success(next))
  assert.equal((await f.inspect()).ok, true); assert.equal(f.lookup(id('win_', 'b')), null); assert.ok(f.lookup(id('win_', 'c'))); assert.ok(f.lookup())
  f.setNow(at + 31000); assert.equal(f.lookup(id('win_', 'c')), null); assert.ok(f.lookup())
  const g = await interactionFixture(); g.setAnswer(success(menuInteractions('owner'))); await g.inspect(); g.setNow(at + 31000)
  assert.equal(g.service.interactionContext(g.tool, id('win_'), g.context), null); assert.ok(g.lookup())
})
test('unknown modality and unavailable foreign menu remain explicit partial observations', async () => {
  const f = await interactionFixture(), unknown = interactions({ complete: false, limitations: ['modality_unavailable'] }); unknown.windows[0].is_modal = null
  f.setAnswer(success(unknown)); const result = await f.inspect(); assert.equal(result.ok, true); assert.equal(result.data.windows[0].is_modal, null); assert.equal(result.data.complete, false)
  const foreign = interactions({ windows: [], complete: false, limitations: ['menu_unavailable'],
    menu: { active: true, mode: 'unavailable', flags: 0x14, owner_hwnd: '0x9999', root_hwnd: '0x9999', owner_window_id: null, keyboard_window_id: null } })
  f.setAnswer(success(foreign)); assert.equal((await f.inspect()).ok, true); assert.equal(f.lookup(id('win_', 'b')), null); assert.ok(f.lookup())
})
test('main rejects forged interaction identities owner chains modality and stale or invented menu routing', async () => {
  for (const change of [v => { v.parent.pid++ }, v => { v.snapshot_id = id('wset_', 'f') }, v => { v.parent_window_id = id('win_', 'f') },
    v => { v.windows[0].owner_chain = ['0x9999'] }, v => { v.windows[0].window.owner_hwnd = '0x9999' }, v => { v.windows[0].window.owner_window_id = null },
    v => { v.windows[0].kind = 'menu' }, v => { v.windows[0].is_modal = 'maybe' }, v => { v.windows[0].is_modal = null },
    v => { v.windows[0].window.identity_verified = false }, v => { v.windows[0].window.window_id = id('win_') }, v => { v.windows[0].window.cloaked = true },
    v => { v.menu.keyboard_window_id = id('win_', 'b') }, v => { v.menu.mode = 'owner' }, v => { v.input_ready = true }, v => { v.goal_verified = true },
    v => { v.snapshot_atomic = true }, v => { v.expires_at = new Date(at + 31000).toISOString() }, v => { v.complete = false }, v => { v.confirm = true }]) {
    const f = await interactionFixture(), value = interactions(); change(value); f.setAnswer(success(value))
    assert.equal((await f.inspect()).code, 'invalid_result'); assert.equal(f.lookup(id('win_', 'b')), null); assert.ok(f.lookup())
  }
  for (const change of [v => { v.windows[0].window.pid++ }, v => { v.windows[0].window.thread_id++ }, v => { v.menu.root_hwnd = '0x9999' },
    v => { v.menu.owner_window_id = v.windows[0].window.window_id }, v => { v.parent.foreground = false }, v => { v.menu.flags = 0 },
    v => { v.menu.mode = 'none' }, v => { v.menu.keyboard_window_id = v.parent_window_id }]) {
    const f = await interactionFixture(), value = menuInteractions(); change(value); f.setAnswer(success(value))
    assert.equal((await f.inspect()).code, 'invalid_result'); assert.equal(f.lookup(id('win_', 'b')), null)
  }
})
test('late interaction responses cannot register references in another task or helper generation', async () => {
  for (const scenario of ['task', 'helper', 'disabled']) {
    const f = await interactionFixture()
    f.setAnswer(() => { if (scenario === 'task') f.setActive(false); else if (scenario === 'helper') f.state.generation++; else f.setEnabled(false); return success(interactions()) })
    const result = await f.inspect(); assert.equal(result.ok, false); assert.equal(f.lookup(id('win_', 'b')), null)
    assert.equal(f.requests.length, 2)
  }
  const f = await interactionFixture(); f.setAnswer(success(interactions())); await f.inspect()
  f.unregister(); assert.equal(f.lookup(), null); assert.equal(f.tool.definitions().length, 0)
})
