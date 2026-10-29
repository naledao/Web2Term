import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run: node --test tests/windows-app-catalog.test.mjs
// Real registry/protocol/adapter/verifier; synthetic helper, files and task context only.
// No process, Electron, Windows discovery, file access, desktop input, or network is started.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(file, dependencies = {}) {
  const exports = {}
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(source).runInNewContext({ exports, Buffer, URL, structuredClone, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name];
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]
  } })
  return exports
}
const protocol = load('../src/shared/computer-use-protocol.ts')
const computer = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const metadata = load('../src/shared/windows-apps.ts')
const registry = load('../src/main/computer-use-tool.ts', { '../shared/computer-use': computer })
let simulatedFiles
const catalog = load('../src/main/windows-app-catalog.ts', {
  'node:fs/promises': { realpath: (...args) => simulatedFiles.realpath(...args), open: (...args) => simulatedFiles.open(...args), stat: (...args) => simulatedFiles.stat(...args) },
  'node:path': { win32 }, '../shared/windows-apps': metadata, './computer-use-tool': registry
})
const plain = value => JSON.parse(JSON.stringify(value))
const identity = (prefix, digit = 'a') => prefix + digit.repeat(32)
const app = (patch = {}) => ({ app_id: identity('app_'), name: 'Example', aliases: ['Example'], sources: ['app_paths'],
  executable_path: 'C:\\Apps\\Example.exe', launch_references: [{ reference_id: identity('launch_'), kind: 'executable', verified: true }], processes: [], ...patch })
const page = (patch = {}) => ({ catalog_id: identity('cat_'), collected_at: '2026-10-25T00:00:00.0000000Z', query: '', apps: [app()], total_matches: 1,
  has_more: false, next_cursor: null, complete: true, sources: ['applications_folder', 'start_menu', 'app_paths', 'running_process', 'registered_path']
    .map(source => ({ source, status: 'complete', checked: 1, errors: 0 })), registered_app_id: null, ...patch })
const success = data => ({ ok: true, execution: 'executed', code: 'ok', message: '实际目录结果', data })
const launchParameters = () => ({ app_id: identity('app_'), launch_reference_id: identity('launch_') })
const launchResult = (patch = {}) => ({ catalog_id: identity('cat_'), ...launchParameters(), dispatch_status: 'dispatched', method: 'shell_execute',
  native_error: null, returned_process: null, before_at: '2026-10-25T00:00:00.000Z', observed_at: '2026-10-25T00:00:00.100Z',
  observation_complete: true, candidate_windows: [], target_window_confirmed: false, goal_verified: false, ...patch })
const openResult = (patch = {}) => ({ ...launchResult(), catalog_id: null, app_id: null, launch_reference_id: null,
  kind: 'url', target: 'https://example.com/', handler: 'system_association', application: null, control_conversation_preserved: true, content_verified: false, ...patch })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

function fixture() {
  const state = { phase: 'ready', code: 'ready', message: 'ready', generation: 1, actions: ['list_apps'], pid: 9000, protocolVersion: 3 }
  const listeners = new Set(), requests = [], verifications = [], resourceVerifications = []
  let active = true, preferences = { computerUseEnabled: true, desktopControlEnabled: true }, answer = success(page())
  let verify = async path => path
  let verifyResource = async (_kind, path) => path
  const helper = { getState: () => structuredClone(state), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    request: async (action, parameters, options) => { requests.push({ action, parameters, options }); return typeof answer === 'function' ? answer() : answer } }
  const service = new catalog.WindowsAppCatalog(helper, async path => { verifications.push(path); return verify(path) },
    async (kind, path) => { resourceVerifications.push({ kind, path }); return verifyResource(kind, path) })
  const tool = new registry.ComputerUseTool()
  const unregister = service.register(tool)
  const context = { lease: { sessionId: 'session-A', platformId: 'deepseek', conversationId: 'chat-A', taskId: 'goal-A', generation: 1 },
    isCurrent: () => active, capability: () => computer.resolveComputerUseCapability(preferences,
    { sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }, tool.definitions(), state) }
  return { service, tool, context, state, requests, verifications, resourceVerifications, unregister,
    invoke: (parameters = {}, patch = {}) => tool.invoke({ action: 'list_apps', parameters }, { ...context, ...patch }),
    launch: (parameters, patch = {}) => tool.invoke({ action: 'launch_app', parameters }, { ...context, ...patch }),
    open: (parameters, patch = {}) => tool.invoke({ action: 'open', parameters }, { ...context, ...patch }),
    setActive: value => { active = value }, setPreferences: value => { preferences = value }, setAnswer: value => { answer = value },
    setVerify: value => { verify = value }, setVerifyResource: value => { verifyResource = value }, changed: () => { for (const listener of listeners) listener() } }
}

test('registered application actions are published only when also provided by the real helper', () => {
  const f = fixture()
  assert.deepEqual(plain(f.tool.definitions().map(definition => definition.action)), ['list_apps', 'launch_app', 'open'])
  const description = computer.computerUseCapabilityPrompt(f.context.capability(), identity('cu_'))
  assert.match(description, /list_apps/); assert.match(description, /发现本机应用及真实启动引用/)
  assert.doesNotMatch(description, /"action":"launch_app"|"action":"click"/)
  f.state.actions = []; assert.equal(f.context.capability().available, false)
  f.unregister(); assert.equal(f.tool.definitions().length, 0); f.service.dispose()
})

test('strict page protocol validates the actual discovery schema and rejects mixed or out-of-bounds requests', () => {
  const base = { type: 'computer', version: 1, action: 'list_apps', description: '查找 Excel 应用', step_token: identity('cu_'), query: 'Excel', limit: 12 }
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify(base), [metadata.LIST_APPS_DEFINITION]).ok, true)
  for (const patch of [{ limit: 0 }, { limit: 26 }, { limit: 1.5 }, { query: 'x'.repeat(201) }, { command: 'anything' }, { path: 'guess' }]) {
    assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ ...base, ...patch }), [metadata.LIST_APPS_DEFINITION]).ok, false)
  }
})

test('main-process registration validates real parameters before dispatch, including cursor conflicts', async () => {
  const f = fixture()
  for (const parameters of [{ limit: 26 }, { refresh: 'true' }, { cursor: 'forged' }, { cursor: identity('apc_'), refresh: true },
    { cursor: identity('apc_'), register_path: 'C:\\App.exe' }, { register_path: 'app.exe' }, { register_path: '\\\\server\\share\\app.exe' },
    { register_path: 'C:\\App.exe:stream.exe' }, { register_path: 'C:\\run.cmd' }, { script: 'text' }]) {
    const result = await f.invoke(parameters); assert.equal(result.code, 'invalid_parameters', JSON.stringify(parameters)); assert.equal(result.execution, 'not_executed')
  }
  assert.equal(f.requests.length, 0); assert.equal(f.verifications.length, 0); f.service.dispose()
})

test('a discovery result flows through the real tool, is cloned, and registers only learned references', async () => {
  const f = fixture(); const result = await f.invoke()
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed')
  assert.deepEqual(plain(f.requests[0].parameters), { query: '', limit: 12 })
  assert.equal(f.requests[0].options.expectedGeneration, 1); assert.equal(f.requests[0].options.timeoutMs, 30_000)
  assert.ok(f.service.lookup(identity('app_'), identity('launch_')))
  assert.equal(f.service.lookup(identity('app_'), identity('launch_', 'b')), null)
  result.data.apps[0].launch_references.length = 0
  const learned = f.service.lookup(identity('app_'), identity('launch_')); assert.ok(learned)
  learned.name = 'forged'; assert.equal(f.service.lookup(identity('app_'), identity('launch_')).name, 'Example')
  f.service.dispose()
})

test('query trimming and pagination preserve the returned cursor, and stale cursor remains not_executed', async () => {
  const f = fixture(); f.setAnswer(success(page({ query: 'Excel', has_more: true, total_matches: 2, next_cursor: identity('apc_') })))
  const first = await f.invoke({ query: ' Excel ', limit: 1 }); assert.equal(first.ok, true)
  assert.equal(f.requests[0].parameters.query, 'Excel')
  f.setAnswer({ ok: false, execution: 'not_executed', code: 'stale_catalog', message: '请重新查询' })
  const second = await f.invoke({ query: 'Excel', cursor: first.data.next_cursor })
  assert.equal(second.code, 'stale_catalog'); assert.equal(second.execution, 'not_executed')
  assert.equal(f.requests[1].parameters.cursor, identity('apc_')); f.service.dispose()
})

test('main process verifies the discovered portable path before passing the canonical path to native verification', async () => {
  const f = fixture(); f.setVerify(async () => 'C:\\Canonical\\Portable.exe')
  f.setAnswer(success(page({ apps: [app({ executable_path: 'C:\\Canonical\\Portable.exe', sources: ['registered_path'] })], registered_app_id: identity('app_') })))
  const result = await f.invoke({ register_path: 'C:\\Located\\Portable.exe' })
  assert.equal(result.ok, true); assert.deepEqual(f.verifications, ['C:\\Located\\Portable.exe'])
  assert.equal(f.requests[0].parameters.register_path, 'C:\\Canonical\\Portable.exe')
  f.service.dispose()
})

test('failed portable verification makes no helper request and does not turn into an unknown execution', async () => {
  const f = fixture(); f.setVerify(async () => { throw new Error('not a PE') })
  const result = await f.invoke({ register_path: 'C:\\Missing.exe' })
  assert.equal(result.code, 'invalid_parameters'); assert.equal(result.execution, 'not_executed'); assert.equal(f.requests.length, 0)
  f.service.dispose()
})

test('new task or revoked preferences during asynchronous path verification prevents native dispatch', async () => {
  for (const revoke of [f => f.setActive(false), f => f.setPreferences({}), (f, controller) => controller.abort()]) {
    const f = fixture(); const wait = deferred(); const controller = new AbortController(); f.setVerify(() => wait.promise)
    const pending = f.invoke({ register_path: 'C:\\Located\\Portable.exe' }, { signal: controller.signal }); await flush()
    revoke(f, controller); wait.resolve('C:\\Located\\Portable.exe')
    const result = await pending; assert.equal(result.ok, false); assert.equal(result.execution, 'not_executed'); assert.equal(f.requests.length, 0)
    f.service.dispose()
  }
})

test('late results from an old task or helper incarnation cannot register references', async () => {
  for (const revoke of [f => f.setActive(false), f => { f.state.generation = 2; f.changed() }]) {
    const f = fixture(); const wait = deferred(); f.setAnswer(() => wait.promise)
    const pending = f.invoke(); await flush(); revoke(f); wait.resolve(success(page()))
    const result = await pending; assert.equal(result.ok, false); assert.equal(f.service.lookup(identity('app_'), identity('launch_')), null)
    f.service.dispose()
  }
})

test('helper failures preserve uncertainty and are not masked by the now unavailable capability', async () => {
  const f = fixture(); f.setAnswer(() => {
    f.state.phase = 'error'; f.state.actions = []; f.changed()
    return { ok: false, code: 'action_timeout', execution: 'unknown', message: 'native timeout' }
  })
  const result = await f.invoke(); assert.equal(result.code, 'executor_error'); assert.equal(result.execution, 'unknown')
  assert.equal(result.data.helper_code, 'action_timeout'); f.service.dispose()
})

test('malformed result identities, paths, counts, and false completeness never populate the catalog', async () => {
  const variants = [page({ apps: [app(), app()], total_matches: 2 }), page({ apps: [app({ app_id: 'forged' })] }),
    page({ apps: [app({ executable_path: 'guessed.exe' })] }), page({ apps: [app({ launch_references: [{ reference_id: identity('launch_'), kind: 'command', verified: true }] })] }),
    page({ total_matches: 0 }), page({ has_more: true, next_cursor: 'forged' }), page({ query: 'different' }), page({ command: 'unexpected' }),
    page({ sources: page().sources.map(source => ({ ...source, status: 'partial' })) }),
    page({ apps: [app({ processes: [{ pid: 0, started_at: null, identity_verified: true, windows: [] }] })] })]
  for (const invalid of variants) {
    const f = fixture(); f.setAnswer(success(invalid)); const result = await f.invoke()
    assert.equal(result.code, 'invalid_result'); assert.equal(f.service.lookup(identity('app_'), identity('launch_')), null); f.service.dispose()
  }
})

test('running process identity and window summaries remain discovery metadata, without creating window input IDs', async () => {
  const f = fixture()
  f.setAnswer(success(page({ apps: [app({ sources: ['running_process'], processes: [{ pid: 42, started_at: new Date().toISOString(),
    identity_verified: true, windows: [{ hwnd: '0x1234', title: '真实窗口', visible: true, minimized: false }] }] })] })))
  const result = await f.invoke(); assert.equal(result.ok, true)
  assert.equal(result.data.apps[0].processes[0].windows[0].title, '真实窗口')
  assert.equal(Object.hasOwn(result.data.apps[0].processes[0].windows[0], 'window_id'), false)
  f.service.dispose()
})

test('partial and zero-match discoveries remain truthful results, not a claim that an application is absent', async () => {
  const f = fixture(); f.setAnswer(success(page({ apps: [], total_matches: 0, complete: false,
    sources: page().sources.map(source => source.source === 'applications_folder' ? { ...source, status: 'unavailable', errors: 1 } : source) })))
  const result = await f.invoke(); assert.equal(result.ok, true); assert.equal(result.data.complete, false); assert.equal(result.data.apps.length, 0)
  f.service.dispose()
})

test('the same goal can discover another application and still use its previously learned reference', async () => {
  const f = fixture(); f.state.actions.push('launch_app')
  await f.invoke()
  const other = app({ app_id: identity('app_', 'b'), name: 'Other application', executable_path: 'C:\\Apps\\Other.exe',
    launch_references: [{ reference_id: identity('launch_', 'b'), kind: 'executable', verified: true }] })
  f.setAnswer(success(page({ query: 'Other', apps: [other] })))
  await f.invoke({ query: 'Other' })
  f.setAnswer(success(launchResult()))
  const launched = await f.launch(launchParameters())
  assert.equal(launched.ok, true); assert.equal(f.requests.at(-1).action, 'launch_app')
  f.service.dispose()
})

test('application, selected-open and cursor references cannot cross tasks or tool registrations', async () => {
  const f = fixture(); f.state.actions.push('launch_app', 'open')
  f.setAnswer(success(page({ has_more: true, total_matches: 2, next_cursor: identity('apc_') })))
  await f.invoke()
  const otherLease = { ...f.context.lease, taskId: 'goal-B', generation: 2 }
  const before = f.requests.length
  assert.equal((await f.launch(launchParameters(), { lease: otherLease })).code, 'stale_catalog')
  assert.equal((await f.open({ kind: 'file', target: 'C:\\reports\\result.xlsx', ...launchParameters() }, { lease: otherLease })).code, 'stale_catalog')
  assert.equal((await f.invoke({ cursor: identity('apc_') }, { lease: otherLease })).code, 'stale_catalog')
  const otherTool = new registry.ComputerUseTool(), remove = f.service.register(otherTool)
  assert.equal((await otherTool.invoke({ action: 'launch_app', parameters: launchParameters() }, f.context)).code, 'stale_catalog')
  assert.equal(f.requests.length, before)
  const missing = await f.launch(launchParameters(), { lease: undefined })
  assert.equal(missing.execution, 'not_executed'); assert.equal(f.requests.length, before)
  remove(); f.service.dispose()
})

test('refresh, process restart, and helper shutdown discard old learned references', async () => {
  const f = fixture(); await f.invoke(); assert.ok(f.service.lookup(identity('app_'), identity('launch_')))
  f.setAnswer(success(page({ catalog_id: identity('cat_', 'b'), apps: [], total_matches: 0 }))); await f.invoke({ refresh: true })
  assert.equal(f.service.lookup(identity('app_'), identity('launch_')), null)
  f.setAnswer(success(page())); await f.invoke()
  f.state.generation++; f.changed(); assert.equal(f.service.lookup(identity('app_'), identity('launch_')), null)
  await f.invoke(); f.state.phase = 'stopping'; f.changed(); assert.equal(f.service.lookup(identity('app_'), identity('launch_')), null)
  f.service.dispose()
})

test('launch_app becomes callable only when the helper advertises the registered launch adapter', () => {
  const f = fixture()
  assert.deepEqual(plain(f.context.capability().actions), ['list_apps'])
  f.state.actions.push('launch_app')
  assert.deepEqual(plain(f.context.capability().actions), ['list_apps', 'launch_app'])
  assert.match(computer.computerUseCapabilityPrompt(f.context.capability(), identity('cu_')), /启动后继续核对窗口/)
  f.service.dispose()
})

test('strict protocol and mandatory executor validation reject arbitrary launch paths, commands, arguments and invalid ids', async () => {
  const f = fixture(); f.state.actions.push('launch_app')
  const base = { type: 'computer', version: 1, action: 'launch_app', description: '启动目标应用', step_token: identity('cu_'), ...launchParameters() }
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify(base), f.tool.definitions()).ok, true)
  for (const patch of [{ path: 'C:\\app.exe' }, { command: 'anything' }, { arguments: ['text'] }, { catalog_id: identity('cat_') },
    { wait_ms: -1 }, { wait_ms: 5001 }, { wait_ms: 0.5 }, { app_id: 'x'.repeat(36) }, { launch_reference_id: 'x'.repeat(39) }]) {
    const result = await f.launch({ ...launchParameters(), ...patch })
    assert.equal(result.code, 'invalid_parameters'); assert.equal(result.execution, 'not_executed')
    if (patch.app_id === undefined && patch.launch_reference_id === undefined)
      assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ ...base, ...patch }), f.tool.definitions()).ok, false)
  }
  assert.equal(f.requests.length, 0); f.service.dispose()
})

test('unknown or cross-app references never reach the native launcher', async () => {
  const f = fixture(); f.state.actions.push('launch_app')
  assert.equal((await f.launch(launchParameters())).code, 'stale_catalog')
  await f.invoke()
  const before = f.requests.length
  for (const parameters of [{ ...launchParameters(), app_id: identity('app_', 'b') }, { ...launchParameters(), launch_reference_id: identity('launch_', 'b') }]) {
    const result = await f.launch(parameters); assert.equal(result.execution, 'not_executed'); assert.equal(result.code, 'stale_catalog')
  }
  assert.equal(f.requests.length, before); f.service.dispose()
})

test('a learned reference dispatches once with the main-process snapshot and original task signal', async () => {
  const f = fixture(); f.state.actions.push('launch_app'); await f.invoke(); f.setAnswer(success(launchResult()))
  const abort = new AbortController()
  const result = await f.launch(launchParameters(), { signal: abort.signal })
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed')
  const request = f.requests.at(-1)
  assert.equal(request.action, 'launch_app'); assert.equal(request.parameters.catalog_id, identity('cat_')); assert.equal(request.parameters.wait_ms, 1500)
  assert.equal(request.options.signal, abort.signal); assert.equal(request.options.expectedGeneration, 1)
  assert.equal(result.data.returned_process, null); assert.equal(result.data.target_window_confirmed, false); assert.equal(result.data.goal_verified, false)
  assert.equal(f.requests.filter(request => request.action === 'launch_app').length, 1); f.service.dispose()
})

test('single-instance or proxy launch results retain candidate evidence without declaring a target window', async () => {
  const f = fixture(); f.state.actions.push('launch_app'); await f.invoke()
  const candidate = { hwnd: '0x1234', title: 'Business window', visible: true, minimized: false, pid: 777,
    process_started_at: '2026-10-25T00:00:00Z', foreground: true, match_basis: 'executable_path', change: 'changed' }
  f.setAnswer(success(launchResult({ returned_process: { pid: 99, started_at: null }, candidate_windows: [candidate] })))
  const result = await f.launch({ ...launchParameters(), wait_ms: 0 })
  assert.equal(result.ok, true); assert.equal(result.data.candidate_windows[0].pid, 777)
  assert.equal(result.data.target_window_confirmed, false)
  assert.equal(Object.hasOwn(result.data.candidate_windows[0], 'window_id'), false); f.service.dispose()
})

test('stale native catalog is a not-executed result and clears old learned references', async () => {
  const f = fixture(); f.state.actions.push('launch_app'); await f.invoke()
  f.setAnswer({ ok: false, execution: 'not_executed', code: 'stale_catalog', message: 'target changed' })
  const result = await f.launch(launchParameters()); assert.equal(result.code, 'stale_catalog'); assert.equal(result.execution, 'not_executed')
  assert.equal(f.service.lookup(identity('app_'), identity('launch_')), null); f.service.dispose()
})

test('failed activation preserves unknown dispatch and does not retry with Shell or another reference', async () => {
  const f = fixture(); f.state.actions.push('launch_app'); await f.invoke()
  f.setAnswer({ ok: false, execution: 'unknown', code: 'launch_failed', message: 'activation failed',
    data: launchResult({ dispatch_status: 'unknown', method: 'application_activation', native_error: -2147467259 }) })
  const result = await f.launch(launchParameters()); assert.equal(result.code, 'launch_failed'); assert.equal(result.execution, 'unknown')
  assert.equal(result.data.launch.dispatch_status, 'unknown'); assert.equal(f.requests.filter(request => request.action === 'launch_app').length, 1)
  f.service.dispose()
})

test('helper crash or timeout after launch dispatch stays unknown even when capability is no longer available', async () => {
  const f = fixture(); f.state.actions.push('launch_app'); await f.invoke()
  f.setAnswer(() => { f.state.phase = 'error'; f.state.actions = []; f.changed(); return { ok: false, code: 'process_exited', execution: 'unknown', message: 'helper exited' } })
  const result = await f.launch(launchParameters()); assert.equal(result.execution, 'unknown'); assert.equal(result.code, 'executor_error')
  assert.equal(f.requests.filter(request => request.action === 'launch_app').length, 1); f.service.dispose()
})

test('cancellation after a successful dispatch cannot rewrite that operation as not_executed', async () => {
  const f = fixture(); f.state.actions.push('launch_app'); await f.invoke(); const wait = deferred(); f.setAnswer(() => wait.promise)
  const abort = new AbortController(); const pending = f.launch(launchParameters(), { signal: abort.signal }); await flush()
  abort.abort(); wait.resolve(success(launchResult()))
  const result = await pending; assert.equal(result.code, 'cancelled'); assert.equal(result.execution, 'executed'); f.service.dispose()
})

test('revoked task, settings, or an already cancelled signal prevent launch dispatch', async () => {
  for (const revoke of [(f) => f.setActive(false), (f) => f.setPreferences({}), (f, abort) => abort.abort()]) {
    const f = fixture(); f.state.actions.push('launch_app'); await f.invoke(); const abort = new AbortController(); revoke(f, abort)
    const result = await f.launch(launchParameters(), { signal: abort.signal })
    assert.equal(result.ok, false); assert.equal(result.execution, 'not_executed')
    assert.equal(f.requests.some(request => request.action === 'launch_app'), false); f.service.dispose()
  }
})

test('launch results with mismatched identities, invented completion, or inconsistent execution are unknown failures', async () => {
  for (const patch of [{ app_id: identity('app_', 'b') }, { catalog_id: identity('cat_', 'b') }, { target_window_confirmed: true }, { goal_verified: true },
    { native_error: 5 }, { returned_process: { pid: 0, started_at: null } }, { observed_at: 'invalid' }, { method: 'command' }]) {
    const f = fixture(); f.state.actions.push('launch_app'); await f.invoke(); f.setAnswer(success(launchResult(patch)))
    const result = await f.launch(launchParameters()); assert.equal(result.code, 'invalid_result'); assert.equal(result.execution, 'unknown'); f.service.dispose()
  }
})

test('refresh or helper restart revokes old launch references before an action can be dispatched', async () => {
  for (const revoke of [async f => { f.setAnswer(success(page({ catalog_id: identity('cat_', 'b'), apps: [], total_matches: 0 }))); await f.invoke({ refresh: true }) },
    async f => { f.state.generation++; f.changed() }]) {
    const f = fixture(); f.state.actions.push('launch_app'); await f.invoke(); await revoke(f)
    const result = await f.launch(launchParameters()); assert.equal(result.execution, 'not_executed')
    assert.equal(f.requests.some(request => request.action === 'launch_app'), false); f.service.dispose()
  }
})

function imageFixture(patch = {}) {
  const image = Buffer.alloc(512)
  image.writeUInt16LE(0x5a4d, 0); image.writeUInt32LE(64, 60); image.writeUInt32LE(0x4550, 64)
  image.writeUInt16LE(0x8664, 68); image.writeUInt16LE(1, 70); image.writeUInt16LE(240, 84); image.writeUInt16LE(2, 86)
  image.writeUInt16LE(0x20b, 88); image.writeUInt16LE(2, 156)
  let closed = 0, stats = 0
  const file = { stat: async () => ({ isFile: () => true, size: image.length, mtimeMs: 1, ...((stats++ > 0 && patch.changed) ? { mtimeMs: 2 } : {}), ...patch.stat }),
    read: async (buffer, offset, length, position) => ({ bytesRead: image.copy(buffer, offset, position, position + length) }), close: async () => { closed++ } }
  simulatedFiles = { realpath: async () => patch.canonical ?? 'C:\\Actual\\Program.exe', open: async () => file }
  return { image, closed: () => closed }
}
test('open is advertised only with the live helper action and unregisters with its siblings', () => {
  const f = fixture()
  assert.doesNotMatch(computer.computerUseCapabilityPrompt(f.context.capability(), identity('cu_')), /^open：/m)
  f.state.actions.push('open')
  assert.match(computer.computerUseCapabilityPrompt(f.context.capability(), identity('cu_')), /^open：/m)
  f.unregister(); assert.equal(f.tool.definitions().length, 0)
})

test('open protocol rejects commands, unknown fields and invalid kind or target types', () => {
  const request = { type: 'computer', version: 1, action: 'open', description: '打开目标网页', step_token: identity('cu_'), kind: 'url', target: 'https://example.com/' }
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify(request), [metadata.OPEN_RESOURCE_DEFINITION]).ok, true)
  for (const patch of [{ command: 'start' }, { arguments: '--new-window' }, { catalog_id: identity('cat_') }, { kind: 'script' }, { target: 9 }, { wait_ms: 5001 }])
    assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ ...request, ...patch }), [metadata.OPEN_RESOURCE_DEFINITION]).ok, false)
})

test('open validates literal local paths and http URLs without probing the network', async () => {
  const f = fixture(); f.state.actions.push('open')
  const invalid = [
    { kind: 'url', target: 'file:///C:/report.txt' }, { kind: 'url', target: 'javascript:alert(1)' },
    { kind: 'url', target: 'https://user:secret@example.com/' }, { kind: 'url', target: 'https://example.com/%0dtext' },
    { kind: 'url', target: 'https:\\example.com' }, { kind: 'url', target: 'https://example.com/" --flag' },
    { kind: 'file', target: '\\\\server\\share\\report.txt' }, { kind: 'file', target: 'C:report.txt' },
    { kind: 'file', target: 'C:\\report.txt:stream' }, { kind: 'file', target: 'C:\\NUL.txt' },
    { kind: 'file', target: 'C:\\report.txt ' }, { kind: 'directory', target: '%TEMP%' },
    { kind: 'file', target: 'C:\\run.cmd' }, { kind: 'file', target: 'C:\\shortcut.url' },
    { kind: 'url', target: 'https://example.com/', app_id: identity('app_') },
    { kind: 'url', target: 'https://example.com/', ...launchParameters(), wait_ms: -1 }
  ]
  for (const parameters of invalid) { const result = await f.open(parameters); assert.equal(result.code, 'invalid_parameters', JSON.stringify(parameters)); assert.equal(result.execution, 'not_executed') }
  assert.equal(f.requests.length, 0); assert.equal(f.resourceVerifications.length, 0)
})

test('default URL opens without an application catalog and sends a canonical URL once to native', async () => {
  const f = fixture(); f.state.actions.push('open'); f.setAnswer(success(openResult({ application: { executable_path: 'C:\\Browser\\browser.exe', app_user_model_id: null, basis: 'association_query' } })))
  const result = await f.open({ kind: 'url', target: 'HTTPS://EXAMPLE.COM:443' })
  assert.equal(result.ok, true); assert.equal(result.data.control_conversation_preserved, true); assert.equal(result.data.content_verified, false)
  assert.equal(result.data.application.basis, 'association_query')
  assert.equal(f.resourceVerifications.length, 0); assert.equal(f.requests.length, 1)
  assert.deepEqual(plain(f.requests[0].parameters), { kind: 'url', target: 'https://example.com/', wait_ms: 1500 })
  assert.equal(f.requests[0].action, 'open'); assert.equal(f.requests[0].options.expectedGeneration, 1)
})

test('file and directory opens pass only verified canonical resources to the helper', async () => {
  const f = fixture(); f.state.actions.push('open')
  const target = 'C:\\Real Documents\\report.xlsx'
  f.setVerifyResource(async (kind, path) => { assert.equal(kind, 'file'); assert.equal(path, 'C:\\Alias\\report.xlsx'); return target })
  f.setAnswer(success(openResult({ kind: 'file', target })))
  assert.equal((await f.open({ kind: 'file', target: 'C:\\Alias\\report.xlsx', wait_ms: 0 })).ok, true)
  assert.equal(f.requests[0].parameters.target, target)
  f.setVerifyResource(async (_kind, path) => path); f.setAnswer(success(openResult({ kind: 'directory', target: 'C:\\' })))
  assert.equal((await f.open({ kind: 'directory', target: 'C:\\' })).ok, true)
})

test('failed resource verification and resolved executable aliases never dispatch', async () => {
  const f = fixture(); f.state.actions.push('open')
  for (const verify of [async () => { throw new Error('missing-or-wrong-kind') }, async () => '\\\\server\\report.txt', async () => 'C:\\Actual.exe']) {
    f.setVerifyResource(verify)
    const result = await f.open({ kind: 'file', target: 'C:\\report.txt' }); assert.equal(result.code, 'invalid_parameters'); assert.equal(result.execution, 'not_executed')
  }
  assert.equal(f.requests.length, 0)
})

test('resource opens require learned app references and inject the original catalog for a chosen app', async () => {
  const f = fixture(); f.state.actions.push('open')
  const parameters = { kind: 'file', target: 'C:\\report.txt', ...launchParameters() }
  assert.equal((await f.open(parameters)).code, 'stale_catalog'); assert.equal(f.requests.length, 0)
  await f.invoke()
  f.setAnswer(success(openResult({ ...parameters, handler: 'discovered_app', catalog_id: identity('cat_') })))
  assert.equal((await f.open(parameters)).ok, true)
  assert.equal(f.requests[1].parameters.catalog_id, identity('cat_')); assert.equal(f.requests[1].parameters.target, parameters.target)
})

test('task revocation, cancellation or helper restart during path verification blocks dispatch', async () => {
  for (const mutate of [(f) => f.setActive(false), (f) => f.setPreferences({ computerUseEnabled: false, desktopControlEnabled: true }),
    (f) => { f.state.generation++; f.changed() }]) {
    const f = fixture(); f.state.actions.push('open'); const pending = deferred()
    f.setVerifyResource(() => pending.promise)
    const work = f.open({ kind: 'file', target: 'C:\\report.txt' }); await flush(); mutate(f); pending.resolve('C:\\report.txt')
    assert.equal((await work).execution, 'not_executed'); assert.equal(f.requests.length, 0)
  }
  const f = fixture(); f.state.actions.push('open'); const abort = new AbortController(); abort.abort()
  assert.equal((await f.open({ kind: 'url', target: 'https://example.com/' }, { signal: abort.signal })).code, 'cancelled'); assert.equal(f.requests.length, 0)
})

test('open cancellation after native dispatch preserves the already executed result', async () => {
  const f = fixture(); f.state.actions.push('open'); const abort = new AbortController()
  f.setAnswer(() => { abort.abort(); return success(openResult()) })
  const result = await f.open({ kind: 'url', target: 'https://example.com/' }, { signal: abort.signal })
  assert.equal(result.code, 'cancelled'); assert.equal(result.execution, 'executed'); assert.equal(f.requests.length, 1)
})

test('open failures preserve uncertainty and never fall back to a second app or command', async () => {
  const f = fixture(); f.state.actions.push('open')
  f.setAnswer({ ok: false, execution: 'unknown', code: 'open_failed', message: 'No association confirmed', data: openResult({ dispatch_status: 'unknown', native_error: 1155 }) })
  const result = await f.open({ kind: 'url', target: 'https://example.com/' })
  assert.equal(result.code, 'open_failed'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.open.native_error, 1155); assert.equal(f.requests.length, 1)
})

test('open rejects altered resources, false content verification and contradictory native status', async () => {
  for (const patch of [{ target: 'https://other.example/' }, { kind: 'file' }, { handler: 'discovered_app' }, { catalog_id: identity('cat_') },
    { control_conversation_preserved: false }, { content_verified: true }, { target_window_confirmed: true }, { goal_verified: true },
    { application: { executable_path: 'C:\\run.cmd', app_user_model_id: null, basis: 'association_query' } }, { application: { executable_path: null, app_user_model_id: null, basis: 'association_query' } },
    { application: { executable_path: 'C:\\Browser\\browser.exe', app_user_model_id: null, basis: 'selected_reference' } },
    { method: 'application_activation' }, { dispatch_status: 'unknown' }, { native_error: 5 }, { window_id: 'invented' }]) {
    const f = fixture(); f.state.actions.push('open'); f.setAnswer(success(openResult(patch)))
    const result = await f.open({ kind: 'url', target: 'https://example.com/' }); assert.equal(result.code, 'invalid_result', JSON.stringify(patch)); assert.equal(result.execution, 'unknown')
  }
})

test('filesystem verification checks actual type after resolving local aliases and rejects remote resolutions', async () => {
  simulatedFiles = { realpath: async () => 'C:\\Real\\report.txt', stat: async () => ({ isFile: () => true, isDirectory: () => false }) }
  assert.equal(await catalog.verifyLocalResource('file', 'C:\\Alias\\report.txt'), 'C:\\Real\\report.txt')
  await assert.rejects(catalog.verifyLocalResource('directory', 'C:\\Alias\\report.txt'), /resource-kind-mismatch/)
  simulatedFiles.realpath = async () => '\\\\server\\report.txt'
  await assert.rejects(catalog.verifyLocalResource('file', 'C:\\Alias\\report.txt'), /invalid-resource-path/)
})

test('portable verification reads PE headers from the real file handle and always closes it', async () => {
  const f = imageFixture(); assert.equal(await catalog.verifyLocalExecutable('C:\\Link\\Program.exe'), 'C:\\Actual\\Program.exe'); assert.equal(f.closed(), 1)
})
test('portable verification rejects renamed text/DLLs, unsafe paths, non-Windows images, and changed files', async () => {
  for (const edit of [f => f.image.writeUInt16LE(0, 0), f => f.image.writeUInt32LE(0xffffffff, 60),
    f => f.image.writeUInt16LE(0x2002, 86), f => f.image.writeUInt16LE(0xaa64, 68), f => f.image.writeUInt16LE(10, 156)]) {
    const f = imageFixture(); edit(f); await assert.rejects(catalog.verifyLocalExecutable('C:\\Program.exe')); assert.equal(f.closed(), 1)
  }
  const changed = imageFixture({ changed: true }); await assert.rejects(catalog.verifyLocalExecutable('C:\\Program.exe')); assert.equal(changed.closed(), 1)
  for (const canonical of ['\\\\server\\share\\Program.exe', '\\\\?\\C:\\Program.exe', 'C:\\Program.exe:other.exe']) {
    imageFixture({ canonical }); await assert.rejects(catalog.verifyLocalExecutable('C:\\Program.exe'))
  }
})
