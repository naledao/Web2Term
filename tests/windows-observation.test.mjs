import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run: node --test tests/windows-observation.test.mjs
// Synthetic helper frames/PNG files only. Does not start Electron/helper or capture the desktop.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { readFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const source = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Script(source).runInNewContext({ exports, Buffer, structuredClone, Date, setInterval, clearInterval,
    require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] } })
  return exports
}
const protocol = load('../src/shared/computer-use-protocol.ts')
const computer = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const registry = load('../src/main/computer-use-tool.ts', { '../shared/computer-use': computer })
const metadata = load('../src/shared/windows-observation.ts')
const controlMetadata = load('../src/shared/windows-controls.ts')
const bindingMetadata = load('../src/shared/windows-observation-binding.ts')
const coordinates = load('../src/shared/windows-coordinates.ts')
const clickMetadata = load('../src/shared/windows-click.ts')
const clickImplementation = load('../src/main/windows-click.ts', { '../shared/windows-coordinates': coordinates, '../shared/windows-observation-binding': bindingMetadata })
const typeTextMetadata = load('../src/shared/windows-type-text.ts')
const typeTextImplementation = load('../src/main/windows-type-text.ts', { 'node:crypto': crypto, '../shared/windows-type-text': typeTextMetadata })
const pressKeyMetadata = load('../src/shared/windows-press-key.ts')
const pressKeyImplementation = load('../src/main/windows-press-key.ts', { '../shared/windows-press-key': pressKeyMetadata })
const scrollMetadata = load('../src/shared/windows-scroll.ts')
const scrollImplementation = load('../src/main/windows-scroll.ts', { '../shared/windows-scroll': scrollMetadata,
  '../shared/windows-coordinates': coordinates, '../shared/windows-observation-binding': bindingMetadata })
const dragMetadata = load('../src/shared/windows-drag.ts')
const dragImplementation = load('../src/main/windows-drag.ts', { '../shared/windows-drag': dragMetadata,
  '../shared/windows-coordinates': coordinates, '../shared/windows-observation-binding': bindingMetadata })
const controlImplementation = load('../src/main/windows-control-tree.ts', { '../shared/windows-controls': controlMetadata })
const appMetadata = load('../src/shared/windows-apps.ts')
const apps = load('../src/main/windows-app-catalog.ts', { 'node:fs/promises': fs, 'node:path': path, '../shared/windows-apps': appMetadata, './computer-use-tool': registry })
const windowCatalog = load('../src/main/windows-window-catalog.ts', { 'node:crypto': crypto, '../shared/windows-desktop': load('../src/shared/windows-desktop.ts'), './computer-use-tool': registry, './windows-app-catalog': apps })
const waitMetadata = load('../src/shared/windows-wait.ts', { './windows-controls': controlMetadata })
const waitImplementation = load('../src/main/windows-wait.ts', { 'node:perf_hooks': { performance: { now: () => 0 } }, 'node:timers/promises': {},
  '../shared/windows-wait': waitMetadata, './windows-window-catalog': windowCatalog, './windows-control-tree': controlImplementation })
const implementation = load('../src/main/windows-observation.ts', { 'node:crypto': crypto, 'node:fs/promises': fs, 'node:path': path, 'node:os': os,
  'node:zlib': { inflateSync }, '../shared/windows-observation': metadata, '../shared/windows-observation-binding': bindingMetadata,
  '../shared/windows-coordinates': coordinates, '../shared/windows-click': clickMetadata, './windows-click': clickImplementation,
  '../shared/windows-type-text': typeTextMetadata, './windows-type-text': typeTextImplementation,
  '../shared/windows-press-key': pressKeyMetadata, './windows-press-key': pressKeyImplementation,
  '../shared/windows-scroll': scrollMetadata, './windows-scroll': scrollImplementation,
  '../shared/windows-drag': dragMetadata, './windows-drag': dragImplementation,
  '../shared/windows-wait': waitMetadata, './windows-wait': waitImplementation,
  './computer-use-tool': registry, './windows-control-tree': controlImplementation })
const id = (prefix, char = 'a') => prefix + char.repeat(32)
const now = Date.parse('2026-10-25T00:00:00Z')
const owner = { sessionId: 'session-A', platformId: 'deepseek', conversationId: 'conversation-A', taskId: 'task-A', generation: 1 }
const row = { window_id: id('win_'), hwnd: '0x1234', pid: 42, process_started_at: new Date(now - 10000).toISOString(), thread_id: 44, class_name: 'Example', title: 'Example window', application: { name: 'Editor', executable_path: null, app_user_model_id: null },
  visible: true, minimized: false, foreground: false, enabled: true, cloaked: false, owner_hwnd: null, owner_window_id: null, identity_verified: true, identity_status: 'verified', bounds: { x: 0, y: 0, width: 800, height: 600 } }
const bounds = { x: -1920, y: -100, width: 4, height: 2 }
const monitor = { monitor_id: id('mon_'), bounds, primary: true, dpi_x: 144, dpi_y: 144, scale_percent: 150 }
const plain = value => JSON.parse(JSON.stringify(value))
function png(width, height) {
  const chunk = (name, data) => {
    const result = Buffer.alloc(12 + data.length); result.writeUInt32BE(data.length); result.write(name, 4); data.copy(result, 8)
    let crc = 0xffffffff
    for (const value of result.subarray(4, -4)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    result.writeUInt32BE((~crc) >>> 0, result.length - 4); return result
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))])
}
function observation(p = { target: 'desktop' }) {
  const crop = p.crop ?? (p.target === 'region' ? { x: p.x, y: p.y, width: p.width, height: p.height } : { x: 0, y: 0, width: 4, height: 2 })
  const scale = Math.min(1, (p.max_dimension ?? 8192) / Math.max(crop.width, crop.height))
  const width = Math.max(1, Math.floor(crop.width * scale)), height = Math.max(1, Math.floor(crop.height * scale)), bytes = png(width, height)
  const data = { observation_id: id('obs_'), target: p.target, window_id: p.window_id ?? null, monitor_id: p.window_id ? null : p.monitor_id ?? monitor.monitor_id,
    window_identity: p.window_id ? { hwnd: row.hwnd, pid: row.pid, process_started_at: row.process_started_at, thread_id: row.thread_id, class_name: row.class_name } : null,
    before_at: new Date(now).toISOString(), captured_at: new Date(now + 10).toISOString(), observed_at: new Date(now + 20).toISOString(),
    source_bounds: bounds, source_size: { width: 4, height: 2 }, crop,
    image: { width, height, mime_type: 'image/png', size_bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    transform: { origin_x: bounds.x + crop.x, origin_y: bounds.y + crop.y, scale_x: crop.width / width, scale_y: crop.height / height, coordinate_space: 'desktop_physical_pixels',
      content_bounds: { x: 0, y: 0, width, height }, pixel_mapping: 'nearest_floor' },
    coordinate_context: { dpi_awareness: 'per_monitor_v2', virtual_bounds: bounds, window_dpi: p.window_id ? 144 : null },
    monitors: [monitor], geometry_consistent: true, content_verified: false, input_ready: false, goal_verified: false }
  return { bytes, data }
}
function controlTree(p, before = now) {
  const elements = [
    { element_id: id('el_'), parent_id: null, depth: 0, control_type: 50032, role: 'window', name: 'Example window', name_truncated: false,
      password: false, enabled: true, focused: false, offscreen: false, selected: null, bounds, patterns: ['window'], properties_complete: true },
    { element_id: id('el_', 'b'), parent_id: id('el_'), depth: 1, control_type: 50004, role: 'edit', name: 'Search', name_truncated: false,
      password: false, enabled: true, focused: true, offscreen: false, selected: null, bounds: { x: -1919, y: -100, width: 1, height: 1 }, patterns: ['text', 'value'], properties_complete: true }
  ]
  return { observation_id: id('obs_', 'c'), window_id: p.window_id, window_identity: { hwnd: row.hwnd, pid: row.pid, process_started_at: row.process_started_at, thread_id: row.thread_id, class_name: row.class_name },
    before_at: new Date(before).toISOString(), observed_at: new Date(before + 5).toISOString(), window_bounds: bounds, root_element_id: elements[0].element_id, elements,
    focus: { status: 'inside_target', element_id: elements[1].element_id },
    selection: p.include_selection === true || p.controls_options?.include_selection === true
      ? { requested: true, status: 'text', element_id: elements[1].element_id, text: 'selected text', truncated: false }
      : { requested: false, status: 'not_requested', element_id: null, text: null, truncated: false },
    complete: true, limitations: [], visited_count: 2, geometry_consistent: true, snapshot_atomic: false, content_verified: false, input_ready: false, goal_verified: false }
}
function fixture(t) {
  let interactionHint = null, waitMutate = () => {}, afterSleep = () => {}, monotonic = 0
  let active = true, known = true, time = now, mutate = () => {}, after = () => {}, failure = null, validationReason = null, validationMutate = () => {}, clickMutate = () => {}, typeMutate = () => {}, pressMutate = () => {}, scrollMutate = () => {}, dragMutate = () => {}
  const requests = [], directories = [], sleeps = [], observations = new Map()
  const state = { phase: 'ready', generation: 1, actions: ['observe', 'validate_observation', 'click', 'type_text', 'press_key', 'scroll', 'drag', 'wait_for'], message: 'Ready' }
  const helper = { getState: () => structuredClone(state), async request(action, parameters, options) {
    requests.push({ action, parameters, options }); if (parameters.output_path) directories.push(path.dirname(parameters.output_path))
    if (failure) return failure
    if (action === 'wait_for') {
      const tree = parameters.condition === 'window_present' ? null : controlTree(parameters, time)
      const evaluation = tree ? waitMetadata.evaluateWaitControls(parameters, row, tree) : { status: 'met', matches: 1 }
      const data = { wait_id: parameters.wait_id, condition: parameters.condition, snapshot_id: id('wset_'), scope_collected_at: new Date(now).toISOString(),
        scope_expires_at: new Date(now + 120000).toISOString(), before_at: new Date(time).toISOString(), checked_at: new Date(time + 5).toISOString(),
        window: structuredClone(row), controls: tree, ...evaluation, complete: true, limitations: [], revision: '1:2', input_ready: false, goal_verified: false }
      waitMutate(data); after(); return { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic condition check', data }
    }
    if (action === 'drag') {
      const observed = observations.get(parameters.observation_id), plan = dragImplementation.resolveDragPath(observed, parameters.path)
      const data = { request_id: parameters.request_id, observation_id: parameters.observation_id, source_step_id: parameters.source_step_id, window_id: observed.window_id,
        button: parameters.button, duration_ms: parameters.duration_ms, start: plan[0], end: plan.at(-1), segments_planned: plan.length - 1,
        move_attempted: true, move_accepted: 1, move_arrived: true, down_attempted: true, down_accepted: 1, down_confirmed: true,
        segments: plan.slice(1).map((_, index) => ({ index: index + 1, accepted: 1, arrived: true })), up_attempted: true, up_accepted: 1,
        release_required: false, release_attempted: false, release_accepted: null, drag_completed: true,
        before_at: new Date(time).toISOString(), completed_at: new Date(time).toISOString(), drag_verified: false, goal_verified: false, input_ready: false }
      const result = { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic drag', data }
      dragMutate(result); after(); return result
    }
    if (action === 'scroll') {
      const observed = observations.get(parameters.observation_id)
      const control = observed?.controls?.elements.find(row => row.element_id === parameters.element_id)
      const point = control ? { x: Math.ceil(control.bounds.x + (control.bounds.width - 1) / 2), y: Math.ceil(control.bounds.y + (control.bounds.height - 1) / 2) }
        : coordinates.resolveImagePoint(observed, parameters.x, parameters.y)?.desktop
      const data = { request_id: parameters.request_id, observation_id: parameters.observation_id, source_step_id: parameters.source_step_id, window_id: observed?.window_id ?? null,
        element_id: parameters.element_id, direction: parameters.direction, amount: parameters.amount, axis: scrollMetadata.scrollAxis(parameters.direction),
        wheel_delta: scrollMetadata.scrollDelta(parameters.direction, parameters.amount), move_attempted: true, move_accepted: 1,
        scroll_attempted: true, scroll_completed: true, wheel_events_requested: 1, wheel_events_accepted: 1, routing: 'focused_hit', point: point ?? null,
        before_at: new Date(time).toISOString(), completed_at: new Date(time).toISOString(), scroll_verified: false, goal_verified: false, input_ready: false }
      const result = { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic scroll', data }
      scrollMutate(result); after(); return result
    }
    if (action === 'press_key') {
      const observed = observations.get(parameters.observation_id), chord = pressKeyMetadata.parsePressKey(parameters.key)
      const data = { request_id: parameters.request_id, observation_id: parameters.observation_id, source_step_id: parameters.source_step_id, window_id: observed?.window_id ?? null,
        element_id: parameters.element_id, key: chord.key, input_attempted: true, input_completed: true, events_requested: chord.down.length * 2, events_accepted: chord.down.length * 2,
        release_keys: [], release_accepted: null, before_at: new Date(time).toISOString(), completed_at: new Date(time).toISOString(), goal_verified: false, input_ready: false }
      const result = { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic press_key', data }
      pressMutate(result); after(); return result
    }
    if (action === 'type_text') {
      const observed = observations.get(parameters.observation_id)
      let offset = 0
      const data = { request_id: parameters.request_id, observation_id: parameters.observation_id, source_step_id: parameters.source_step_id, window_id: observed?.window_id ?? null,
        element_id: parameters.element_id, mode: parameters.mode, method: parameters.mode === 'replace' ? 'uia_value' : 'unicode',
        text_utf16_length: parameters.text.length, text_sha256: crypto.createHash('sha256').update(parameters.text).digest('hex'), input_attempted: true, input_completed: true,
        batches: parameters.mode === 'replace' ? [] : typeTextMetadata.unicodeTextChunks(parameters.text).map(text => {
          const batch = { offset, length: text.length, accepted: text.length * 2, release_attempted: false, release_accepted: null }; offset += text.length; return batch
        }), verification: 'unavailable', content_verified: false, before_at: new Date(time).toISOString(), completed_at: new Date(time).toISOString(), goal_verified: false, input_ready: false }
      const result = { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic type_text', data }
      typeMutate(result); after(); return result
    }
    if (action === 'click') {
      const observed = observations.get(parameters.observation_id)
      const control = observed?.controls?.elements.find(row => row.element_id === parameters.element_id)
      const point = control ? { x: Math.ceil(control.bounds.x + (control.bounds.width - 1) / 2), y: Math.ceil(control.bounds.y + (control.bounds.height - 1) / 2) }
        : coordinates.resolveImagePoint(observed, parameters.x, parameters.y)?.desktop
      const data = { request_id: parameters.request_id, observation_id: parameters.observation_id, source_step_id: parameters.source_step_id, window_id: observed?.window_id ?? null,
        button: parameters.button, click_count: parameters.click_count, requested_method: parameters.method, method: 'mouse', move_attempted: true, move_accepted: 1,
        click_attempted: true, click_completed: true, button_events_requested: parameters.click_count * 2, button_events_accepted: parameters.click_count * 2,
        release_required: false, release_attempted: false, release_accepted: null, point: point ?? null, before_at: new Date(time).toISOString(), completed_at: new Date(time).toISOString(), goal_verified: false, input_ready: false }
      const result = { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic click', data }
      clickMutate(result); after(); return result
    }
    if (action === 'validate_observation') {
      const data = { observation_id: parameters.observation_id, source_step_id: parameters.source_step_id, checked_at: new Date(time).toISOString(),
        valid: validationReason === null, reason: validationReason, action_not_executed: true, input_ready: false, snapshot_atomic: false }
      if (data.valid && parameters.x !== null) {
        const coordinate = coordinates.resolveImagePoint(observations.get(parameters.observation_id), parameters.x, parameters.y)
        if (coordinate) data.coordinate = coordinate
        else { data.valid = false; data.reason = 'locator_unavailable' }
      }
      const valid = data.valid
      validationMutate(data); after()
      return { ok: valid, execution: 'executed', code: valid ? 'ok' : 'stale_observation', message: 'Synthetic check', data }
    }
    if (parameters.target === 'controls') {
      const tree = controlTree(parameters); tree.observation_id = 'obs_' + crypto.randomUUID().replaceAll('-', '')
      const result = { data: { observation_id: tree.observation_id, target: 'controls', window_id: parameters.window_id, controls: tree, content_verified: false, input_ready: false, goal_verified: false } }
      mutate(result); observations.set(result.data.observation_id, structuredClone(result.data)); after(); return { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic UIA', data: result.data }
    }
    const result = observation(parameters)
    result.data.observation_id = 'obs_' + crypto.randomUUID().replaceAll('-', '')
    if (parameters.controls_options) { result.data.controls = controlTree(parameters, now + 20); result.data.controls.observation_id = 'obs_' + crypto.randomUUID().replaceAll('-', '') }
    mutate(result)
    observations.set(result.data.observation_id, structuredClone(result.data))
    if (result.data.controls) observations.set(result.data.controls.observation_id, structuredClone(result.data))
    await fs.writeFile(parameters.output_path, result.bytes, { flag: 'wx' }); after()
    return { ok: true, execution: 'executed', code: 'ok', message: 'Synthetic screenshot', data: result.data }
  } }
  const tool = new registry.ComputerUseTool(), windows = { lookup: () => known ? { scope_id: id('ws_', 'b'), window: structuredClone(row) } : null,
    interactionContext: () => interactionHint,
    beginWait: () => { const generation = state.generation; return { scope_id: id('ws_', 'b'), generation,
      isCurrent: () => active && state.generation === generation && state.phase === 'ready', publish: data => { if (data.window) known = true; return true } } } }
  const clock = { now: () => monotonic, sleep: async ms => { sleeps.push(ms); monotonic += ms; time += ms; afterSleep() } }
  const service = new implementation.WindowsObservationService(helper, windows, () => time, clock), unregister = service.register(tool)
  const context = { lease: structuredClone(owner), step: { id: '11111111-1111-4111-8111-111111111111', token: id('cu_'), sourceMessageId: 'message-A' }, isCurrent: () => active, capability: () => computer.resolveComputerUseCapability({ computerUseEnabled: true, desktopControlEnabled: true },
    { sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }, tool.definitions(), state) }
  t.after(async () => { service.dispose(); for (const directory of directories) await fs.rm(directory, { recursive: true, force: true }) })
  return { service, tool, context, requests, sleeps, state, unregister,
    wait: (parameters, patch = {}) => tool.invoke({ action: 'wait_for', parameters }, { ...context, ...patch }),
    waitMutate: fn => { waitMutate = fn }, afterSleep: fn => { afterSleep = fn },
    invoke: (parameters = { target: 'desktop' }, patch = {}) => tool.invoke({ action: 'observe', parameters }, { ...context, ...patch }),
    check: (parameters, patch = {}) => tool.invoke({ action: 'validate_observation', parameters }, { ...context, step: { id: '22222222-2222-4222-8222-222222222222', token: id('cu_', 'b'), sourceMessageId: 'message-B' }, ...patch }),
    click: (parameters, patch = {}) => tool.invoke({ action: 'click', parameters }, { ...context, step: { id: '33333333-3333-4333-8333-333333333333', token: id('cu_', 'c'), sourceMessageId: 'message-C' }, ...patch }),
    clickMutate: fn => { clickMutate = fn },
    type: (parameters, patch = {}) => tool.invoke({ action: 'type_text', parameters }, { ...context, step: { id: '44444444-4444-4444-8444-444444444444', token: id('cu_', 'd'), sourceMessageId: 'message-D' }, ...patch }),
    typeMutate: fn => { typeMutate = fn },
    press: (parameters, patch = {}) => tool.invoke({ action: 'press_key', parameters }, { ...context, step: { id: '55555555-5555-4555-8555-555555555555', token: id('cu_', 'e'), sourceMessageId: 'message-E' }, ...patch }),
    pressMutate: fn => { pressMutate = fn },
    scroll: (parameters, patch = {}) => tool.invoke({ action: 'scroll', parameters }, { ...context, step: { id: '66666666-6666-4666-8666-666666666666', token: id('cu_', 'f'), sourceMessageId: 'message-F' }, ...patch }),
    scrollMutate: fn => { scrollMutate = fn },
    drag: (parameters, patch = {}) => tool.invoke({ action: 'drag', parameters }, { ...context, step: { id: '77777777-7777-4777-8777-777777777777', token: id('cu_', 'a'), sourceMessageId: 'message-G' }, ...patch }),
    dragMutate: fn => { dragMutate = fn },
    hint: value => { interactionHint = value }, stale: value => { validationReason = value }, validationMutate: fn => { validationMutate = fn },
    setKnown: value => { known = value }, setActive: value => { active = value }, setTime: value => { time = value },
    mutate: fn => { mutate = fn }, after: fn => { after = fn }, failure: value => { failure = value } }
}

test('display preview survives model attachment release without helper calls or new input bindings', async t => {
  const f = fixture(t), result = await f.invoke()
  assert.equal(result.ok, true)
  const count = f.requests.length, lease = f.context.lease, observationId = result.data.observation_id
  assert.equal(f.service.displaySummary(lease).observationId, observationId)
  const url = f.service.displayImage(lease, observationId)
  assert.ok(url.startsWith('data:image/png;base64,'))
  f.service.release(result.attachments, lease)
  assert.equal(f.service.displayImage(lease, observationId), url)
  f.service.invalidateInput(f.tool, lease)
  assert.equal(f.service.displayImage(lease, observationId), url)
  assert.equal(f.service.displayImage({ ...lease, generation: lease.generation + 1 }, observationId), null)
  assert.equal(f.requests.length, count)
  f.unregister(); assert.equal(f.service.displaySummary(lease), null)
})

test('unvalidated capture never enters the optional display cache', async t => {
  const f = fixture(t)
  f.mutate(result => { result.data.image.sha256 = '0'.repeat(64) })
  const result = await f.invoke()
  assert.equal(result.ok, false)
  assert.equal(f.service.displaySummary(f.context.lease), null)
})

test('global desktop handoff revokes all registered input bindings while preserving prepared screenshots', async t => {
  const f = fixture(t), first = await f.invoke({ target: 'window', window_id: row.window_id })
  f.service.invalidateAllInputs()
  const requests = f.requests.length
  const stale = await f.click({ observation_id: first.data.observation_id, x: 0, y: 0 })
  assert.equal(stale.code, 'stale_observation'); assert.equal(stale.execution, 'not_executed')
  assert.equal(f.requests.length, requests)
  assert.equal((await f.service.prepare(first.attachments, owner)).length, 1)
  const fresh = await f.invoke({ target: 'window', window_id: row.window_id })
  assert.equal((await f.click({ observation_id: fresh.data.observation_id, x: 0, y: 0 })).ok, true)
})

test('target switching revokes old input bindings but preserves result attachments and allows a fresh observation', async t => {
  const f = fixture(t), first = await f.invoke({ target: 'window', window_id: row.window_id })
  assert.equal(first.ok, true)
  const references = first.attachments
  f.service.invalidateInput(f.tool, { ...owner, taskId: 'other-goal' })
  assert.equal((await f.check({ observation_id: first.data.observation_id })).ok, true, 'another goal cannot revoke this binding')
  f.service.invalidateInput(f.tool, owner)
  const count = f.requests.length
  const oldInput = await f.click({ observation_id: first.data.observation_id, x: 0, y: 0 })
  assert.equal(oldInput.execution, 'not_executed'); assert.equal(oldInput.code, 'stale_observation')
  assert.equal(f.requests.length, count)
  const prepared = await f.service.prepare(references, owner)
  assert.equal(prepared.length, 1)
  const fresh = await f.invoke({ target: 'window', window_id: row.window_id })
  assert.equal(fresh.ok, true)
  const input = await f.click({ observation_id: fresh.data.observation_id, x: 0, y: 0 })
  assert.equal(input.ok, true)
})

test('background wait delegates to its session monitor without helper calls or screenshots', async t => {
  const f = fixture(t), calls = [], parameters = { condition: 'background_finished', background_id: '11111111-1111-4111-8111-111111111111', timeout_ms: 600000 }
  const result = await f.wait(parameters, { waitForBackground: async p => { calls.push(p); return { message: 'Final log read confirmed', data: { condition_met: true, goal_verified: false } } } })
  assert.equal(result.ok, true); assert.equal(result.data.condition_met, true)
  assert.equal(result.attachments, undefined); assert.equal(f.requests.length, 0)
  assert.deepEqual(plain(calls), [parameters])
  const unavailable = await f.wait(parameters)
  assert.equal(unavailable.code, 'unavailable'); assert.equal(unavailable.execution, 'not_executed')
  assert.equal(f.requests.length, 0)
})

test('wait checks locally until met, takes one final observation and binds its controls to the current step', async t => {
  const f = fixture(t); let checks = 0
  f.waitMutate(data => { if (++checks === 1) { data.controls.elements[1].name = 'Loading'; data.status = 'not_met'; data.matches = 0 } })
  const result = await f.wait({ condition: 'text_present', window_id: row.window_id, text: 'Search' })
  assert.equal(result.ok, true); assert.equal(result.data.condition_met, true); assert.equal(result.data.checks, 2)
  assert.equal(result.data.observation.binding.source_step_id, f.context.step.id)
  assert.equal(result.data.goal_verified, false); assert.equal(result.data.input_ready, false)
  assert.deepEqual(f.requests.map(r => r.action), ['wait_for', 'wait_for', 'observe']); assert.deepEqual(f.sleeps, [250])
  assert.ok(f.requests.slice(0, 2).every(r => !Object.hasOwn(r.parameters, 'output_path')))
  assert.equal(f.requests[2].parameters.target, 'controls'); assert.equal(result.attachments, undefined)
  assert.equal((await f.check({ observation_id: result.data.observation.observation_id })).ok, true)
})

test('wait window discovery can precede list_windows and returns one optional PNG with controls', async t => {
  const f = fixture(t); f.setKnown(false)
  const result = await f.wait({ condition: 'window_present', query: 'Example', observation: 'window' })
  assert.equal(result.ok, true); assert.equal(result.data.condition_met, true)
  assert.deepEqual(f.requests.map(r => r.action), ['wait_for', 'observe'])
  assert.equal(result.data.observation.window_id, row.window_id); assert.equal(result.attachments.length, 1)
  assert.ok(result.data.observation.controls); assert.equal(f.requests[1].parameters.include_controls, undefined)
  assert.equal(f.requests[1].parameters.controls_options.max_elements, 100)
})

test('timeout returns an unmet condition, last check and one latest observation without any input', async t => {
  const f = fixture(t), result = await f.wait({ condition: 'text_present', window_id: row.window_id, text: 'Never appears', timeout_ms: 1000 })
  assert.equal(result.code, 'wait_timeout'); assert.equal(result.data.condition_met, false); assert.equal(result.data.wait_elapsed_ms, 1000)
  assert.equal(result.data.last_check.status, 'not_met'); assert.ok(result.data.observation)
  assert.equal(f.requests.filter(r => r.action === 'observe').length, 1)
  assert.ok(f.requests.every(r => ['wait_for', 'observe'].includes(r.action)))
})

test('ambiguous discovery never guesses a window or captures the whole desktop', async t => {
  const f = fixture(t)
  f.waitMutate(data => { data.window = null; data.status = 'ambiguous'; data.matches = 2 })
  const result = await f.wait({ condition: 'window_present', query: 'Example' })
  assert.equal(result.code, 'wait_ambiguous'); assert.equal(result.data.condition_met, false)
  assert.equal(result.data.post_observation_error.code, 'target_unresolved'); assert.equal(f.requests.length, 1)
})

test('sampled conditions survive later changes or capture failure, while malformed samples never establish a match', async t => {
  for (const scenario of ['changed', 'failed', 'malformed']) {
    const f = fixture(t)
    if (scenario === 'changed') f.mutate(result => { result.data.controls.elements[1].name = 'Loading' })
    if (scenario === 'failed') f.after(() => f.failure({ ok: false, execution: 'not_executed', code: 'capture_failed', message: 'Synthetic blocked capture' }))
    if (scenario === 'malformed') f.waitMutate(data => { data.matches = 99 })
    const result = await f.wait({ condition: 'control_available', window_id: row.window_id, selector: { name: 'Search', role: 'edit' } })
    assert.equal(result.code, scenario === 'malformed' ? 'wait_failed' : 'ok'); assert.equal(result.data.condition_met, scenario !== 'malformed')
    if (scenario === 'changed') { assert.equal(result.data.status, 'met'); assert.equal(result.data.post_condition_met, false) }
    if (scenario === 'failed') { assert.equal(result.data.status, 'met'); assert.equal(result.data.post_condition_met, null); assert.equal(result.data.post_observation_error.code, 'capture_failed') }
    if (scenario === 'malformed') assert.equal(result.data.check_error.code, 'invalid_result')
    assert.equal(f.requests.filter(r => r.action === 'wait_for').length, 1)
    assert.equal(f.requests.filter(r => r.action === 'observe').length, 1)
  }
})

test('partial text evidence can establish presence but a partial control tree cannot establish uniqueness', async t => {
  for (const condition of ['text_present', 'control_available']) {
    const f = fixture(t)
    f.waitMutate(data => {
      data.controls.complete = false; data.controls.limitations = ['provider_error']; data.complete = false; data.limitations = ['controls_incomplete']
      // An allegedly met control predicate must be rejected by main even with otherwise valid partial UIA evidence.
    })
    const result = await f.wait({ condition, window_id: row.window_id, ...(condition === 'text_present' ? { text: 'Search' } : { selector: { name: 'Search', role: 'edit' } }) })
    assert.equal(result.ok, condition === 'text_present')
    if (condition === 'control_available') assert.equal(result.data.check_error.code, 'invalid_result')
    assert.equal(f.requests.filter(r => r.action === 'wait_for').length, 1)
  }
})

test('wait suppresses post-observation after cancellation, task replacement or helper replacement', async t => {
  for (const scenario of ['task', 'helper', 'cancel']) {
    const f = fixture(t), controller = new AbortController()
    f.afterSleep(() => { if (scenario === 'task') f.setActive(false); if (scenario === 'helper') f.state.generation++; if (scenario === 'cancel') controller.abort() })
    const result = await f.wait({ condition: 'text_present', window_id: row.window_id, text: 'Absent' }, { signal: controller.signal })
    assert.equal(result.ok, false); assert.equal(result.code, scenario === 'cancel' ? 'cancelled' : 'inactive_context')
    assert.deepEqual(f.requests.map(r => r.action), ['wait_for']); assert.equal(result.attachments, undefined)
  }
  const f = fixture(t)
  assert.equal((await f.wait({ condition: 'window_present', query: 'Example' }, { step: undefined })).code, 'inactive_context')
  assert.equal(f.requests.length, 0)
})

test('observe and wait are advertised only for the supported live helper and unregister cleans the capability', async t => {
  const f = fixture(t)
  assert.deepEqual(plain(f.context.capability().actions), ['observe', 'validate_observation', 'click', 'type_text', 'press_key', 'scroll', 'drag', 'wait_for'])
  f.state.actions = []; assert.equal((await f.invoke()).code, 'unavailable'); assert.equal(f.requests.length, 0)
  f.unregister(); assert.equal(f.tool.definitions().length, 0)
})
test('strict page/main validators reject arbitrary paths, raw handles, incomplete crops and conflicting sources', async t => {
  const f = fixture(t), base = { type: 'computer', version: 1, action: 'observe', description: '观察当前界面', step_token: id('cu_') }
  for (const parameters of [{ target: 'all' }, { target: 'desktop', output_path: 'C:\\capture.png' }, { target: 'desktop', scope_id: id('ws_') },
    { target: 'desktop', hwnd: '0x1234' }, { target: 'window' }, { target: 'desktop', window_id: row.window_id },
    { target: 'window', window_id: row.window_id, monitor_id: monitor.monitor_id }, { target: 'region', x: 0, y: 0, width: 1 },
    { target: 'desktop', x: 0 }, { target: 'region', x: -1, y: 0, width: 1, height: 1 }, { target: 'desktop', max_dimension: 2561 }]) {
    assert.equal((await f.invoke(parameters)).code, 'invalid_parameters')
    const checked = protocol.computerUseProtocol.check(JSON.stringify({ ...base, ...parameters }), [metadata.OBSERVE_DEFINITION])
    if (checked.ok) assert.ok(metadata.validateObserveParameters(checked.call.parameters))
  }
  assert.equal(f.requests.length, 0)
})
test('desktop defaults to a single source and returns only task-owned opaque attachment references', async t => {
  const f = fixture(t), result = await f.invoke()
  assert.equal(result.ok, true); assert.equal(result.data.transform.origin_x, -1920); assert.equal(result.data.input_ready, false)
  assert.equal(result.attachments.length, 1); assert.doesNotMatch(JSON.stringify(result), /output_path|AppData|base64/)
  const request = f.requests[0]; assert.equal(request.action, 'observe'); assert.equal(request.parameters.max_dimension, 8192)
  assert.match(request.parameters.scope_id, /^ws_[a-f0-9]{32}$/); assert.equal(request.parameters.monitor_id, null)
  const [image] = await f.service.prepare(result.attachments, owner)
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.sha256, result.data.image.sha256)
  // The browser names the uploaded File after the path; the page rejects any other declared name as a changed draft.
  assert.equal(image.fileName, path.basename(image.path), 'declared name matches the file the browser will upload')
  await assert.rejects(f.service.prepare(result.attachments, { ...owner, taskId: 'task-B' }))
  await assert.rejects(f.service.prepare([{ ...result.attachments[0], sha256: '0'.repeat(64) }], owner))
  f.service.release(result.attachments, { ...owner, taskId: 'task-B' }); assert.equal((await f.service.prepare(result.attachments, owner)).length, 1)
  f.service.release(result.attachments, owner); await assert.rejects(f.service.prepare(result.attachments, owner))
})
test('window and region observations use trusted window scope and exact crop/physical transform', async t => {
  const f = fixture(t), p = { target: 'region', window_id: row.window_id, x: 1, y: 0, width: 2, height: 2 }
  const result = await f.invoke(p)
  assert.equal(result.ok, true); assert.equal(f.requests[0].parameters.scope_id, id('ws_', 'b'))
  assert.deepEqual(plain(result.data.crop), { x: 1, y: 0, width: 2, height: 2 }); assert.equal(result.data.transform.origin_x, -1919)
  f.setKnown(false); assert.equal((await f.invoke({ target: 'window', window_id: row.window_id })).code, 'stale_window'); assert.equal(f.requests.length, 1)
})
test('native failures never publish an attachment and preserve capture execution facts', async t => {
  const f = fixture(t)
  for (const [code, execution] of [['capture_blocked', 'not_executed'], ['restore_required', 'not_executed'], ['stale_window', 'not_executed'], ['stale_observation', 'executed'], ['cancelled', 'executed']]) {
    f.failure({ ok: false, code, execution, message: 'Synthetic failure' }); const result = await f.invoke()
    assert.equal(result.code, code); assert.equal(result.execution, execution); assert.equal(result.attachments, undefined)
  }
})
test('old-task, helper-restart and revoked-window results cannot publish images into the current task', async t => {
  for (const scenario of ['task', 'helper', 'window']) {
    const f = fixture(t); f.after(() => { if (scenario === 'task') f.setActive(false); if (scenario === 'helper') f.state.generation++; if (scenario === 'window') f.setKnown(false) })
    const result = await f.invoke(scenario === 'window' ? { target: 'window', window_id: row.window_id } : { target: 'desktop' })
    assert.equal(result.ok, false); assert.equal(result.execution, 'executed'); assert.equal(result.attachments, undefined)
  }
})
test('independent metadata validation rejects identity, geometry, dimensions, timing and completion contradictions', () => {
  const p = { target: 'window', window_id: row.window_id }, base = observation(p)
  assert.equal(implementation.validateWindowsObservation(base.data, p, row, base.bytes, now), true)
  for (const mutate of [d => { d.window_identity.pid++ }, d => { d.window_identity.hwnd = '0x9999' }, d => { d.crop.width++ },
    d => { d.transform.scale_x = 2 }, d => { d.image.width++ }, d => { d.image.sha256 = 'f'.repeat(64) }, d => { d.input_ready = true },
    d => { d.goal_verified = true }, d => { d.geometry_consistent = false }, d => { d.captured_at = new Date(now - 10000).toISOString() },
    d => { d.source_size.width++ }, d => { d.monitors.push(d.monitors[0]) }, d => { d.image.path = 'arbitrary' }]) {
    const data = structuredClone(base.data); mutate(data); assert.equal(implementation.validateWindowsObservation(data, p, row, base.bytes, now), false)
  }
  assert.equal(implementation.validateWindowsObservation(base.data, p, row, Buffer.alloc(base.bytes.length), now), false)
  const corrupt = Buffer.from(base.bytes); corrupt[corrupt.length - 14] ^= 1
  const rehashed = structuredClone(base.data); rehashed.image.sha256 = crypto.createHash('sha256').update(corrupt).digest('hex')
  assert.equal(implementation.validateWindowsObservation(rehashed, p, row, corrupt, now), false, 'a matching hash does not replace PNG integrity checks')
})
test('expired or modified files cannot be uploaded as the original screenshot', async t => {
  const f = fixture(t), result = await f.invoke(), [image] = await f.service.prepare(result.attachments, owner)
  await fs.writeFile(image.path, png(1, 1)); await assert.rejects(f.service.prepare(result.attachments, owner))
  const g = fixture(t), second = await g.invoke(); g.setTime(now + 16 * 60_000); await assert.rejects(g.service.prepare(second.attachments, owner))
})

test('controls-only observation uses the real window scope and returns no image or output path', async t => {
  const f = fixture(t), result = await f.invoke({ target: 'controls', window_id: row.window_id, include_selection: true })
  assert.equal(result.ok, true); assert.equal(result.attachments, undefined)
  assert.equal(result.data.target, 'controls'); assert.equal(result.data.controls.selection.text, 'selected text')
  assert.equal(f.requests[0].parameters.output_path, null); assert.equal(f.requests[0].parameters.scope_id, id('ws_', 'b'))
  assert.deepEqual(plain(f.requests[0].parameters.controls_options), { max_depth: 4, max_elements: 100, timeout_ms: 1200, include_selection: true })
  assert.equal(result.data.controls.snapshot_atomic, false); assert.equal(result.data.controls.input_ready, false)
})
test('control options are strictly scoped, bounded and cannot carry arbitrary selectors or text queries', async t => {
  const f = fixture(t), base = { target: 'controls', window_id: row.window_id }
  for (const p of [{ target: 'controls' }, { ...base, monitor_id: id('mon_') }, { ...base, include_controls: true }, { ...base, max_dimension: 1600 },
    { ...base, max_depth: 9 }, { ...base, max_depth: 0 }, { ...base, max_elements: 201 }, { ...base, timeout_ms: 3001 }, { ...base, timeout_ms: 99 },
    { ...base, include_selection: 1 }, { ...base, element_id: id('el_') }, { ...base, selector: '*', script: 'query' },
    { target: 'desktop', include_controls: true }, { target: 'window', window_id: row.window_id, max_depth: 2 },
    { target: 'window', window_id: row.window_id, include_controls: false, include_selection: true }]) assert.equal((await f.invoke(p)).code, 'invalid_parameters')
  assert.equal(f.requests.length, 0)
  const checked = protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'observe', description: '观察目标窗口', step_token: id('cu_'), ...base }), [metadata.OBSERVE_DEFINITION])
  assert.equal(checked.ok, true)
})
test('image and controls are validated and delivered together with explicit non-atomic timestamps', async t => {
  const f = fixture(t), result = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
  assert.equal(result.ok, true); assert.equal(result.attachments.length, 1); assert.equal(result.data.controls.elements.length, 2)
  assert.ok(Date.parse(result.data.controls.before_at) >= Date.parse(result.data.observed_at))
  const bad = fixture(t); bad.mutate(result => { result.data.controls.window_bounds = { ...bounds, x: bounds.x + 1 } })
  assert.equal((await bad.invoke({ target: 'window', window_id: row.window_id, include_controls: true })).code, 'invalid_result')
})
test('partial UIA data remains usable evidence and does not require a screenshot or invent completion', async t => {
  const f = fixture(t); f.mutate(result => {
    const tree = result.data.controls
    tree.elements = []; tree.root_element_id = null; tree.focus = { status: 'unavailable', element_id: null }
    tree.complete = false; tree.limitations = ['provider_error']; tree.visited_count = 0
  })
  const result = await f.invoke({ target: 'controls', window_id: row.window_id })
  assert.equal(result.ok, true); assert.equal(result.data.controls.complete, false); assert.deepEqual(plain(result.data.controls.limitations), ['provider_error'])
  assert.equal(result.attachments, undefined); assert.equal(result.data.goal_verified, false)
})
test('independent UIA validator rejects forged references, leaked password names, hierarchy and selection contradictions', () => {
  const p = { target: 'controls', window_id: row.window_id, include_selection: true }, tree = controlTree(p)
  assert.equal(controlImplementation.validateControlTree(tree, p, row, now), true)
  for (const mutate of [d => { d.window_identity.pid++ }, d => { d.elements[1].element_id = d.elements[0].element_id },
    d => { d.elements[1].parent_id = id('el_', 'f') }, d => { d.elements[1].depth = 8 }, d => { d.elements[1].role = 'button' },
    d => { d.elements[1].password = true }, d => { d.elements[1].name = 'x'.repeat(257) }, d => { d.elements[1].patterns.push('arbitrary_script') },
    d => { d.elements[1].offscreen = true }, d => { d.elements[1].bounds.width = Infinity }, d => { d.elements[1].properties_complete = false },
    d => { d.focus.element_id = id('el_', 'f') }, d => { d.focus.status = 'outside_target' }, d => { d.selection.element_id = d.elements[0].element_id },
    d => { d.selection.text = 'x'.repeat(2049) }, d => { d.selection.status = 'protected' }, d => { d.input_ready = true },
    d => { d.snapshot_atomic = true }, d => { d.complete = false }, d => { d.limitations = ['unknown'] }, d => { d.visited_count = 401 },
    d => { d.elements[1].runtime_id = [1, 2, 3] }, d => { d.selection.truncated = true }]) {
    const changed = structuredClone(tree); mutate(changed)
    assert.equal(controlImplementation.validateControlTree(changed, p, row, now), false)
  }
})
test('controls-only old-task, aborted and stale-window results cannot publish references', async t => {
  for (const change of ['task', 'helper', 'window']) {
    const f = fixture(t); f.after(() => { if (change === 'task') f.setActive(false); if (change === 'helper') f.state.generation++; if (change === 'window') f.setKnown(false) })
    const result = await f.invoke({ target: 'controls', window_id: row.window_id })
    assert.equal(result.ok, false); assert.equal(result.execution, 'executed'); assert.equal(result.data, undefined)
  }
  const f = fixture(t), abort = new AbortController(); abort.abort()
  assert.equal((await f.invoke({ target: 'controls', window_id: row.window_id }, { signal: abort.signal })).code, 'cancelled'); assert.equal(f.requests.length, 0)
})

test('actual page caption sender admits bounded UIA summaries only on the owned computer attachment path', () => {
  const source = ts.createSourceFile('send-interceptor.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  let method
  function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'prepareFileSendCaption') method = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); assert.ok(method)
  const make = computer => {
    const fileSend = { computer: computer ? {} : undefined }, composer = { value: '' }
    const controller = new Script(`({ ${method} })`).runInNewContext({ fileSend, fileSendStatus: () => ({ status: 'ready' }), getComposer: () => composer,
      composerMatches: (element, text) => element.value === text, normalizeLineEndings: text => text, insertText(element, text) { element.value = text; return true } })
    return { controller, composer }
  }
  assert.equal(make(false).controller.prepareFileSendCaption('token', 'a'.repeat(60000)), false)
  const owned = make(true); assert.equal(owned.controller.prepareFileSendCaption('token', 'a'.repeat(120000)), true)
  assert.equal(owned.composer.value.length, 120000)
  assert.equal(make(true).controller.prepareFileSendCaption('token', 'a'.repeat(200001)), false)
  const drafted = make(true); drafted.composer.value = 'human draft'
  assert.equal(drafted.controller.prepareFileSendCaption('token', 'owned summary'), false); assert.equal(drafted.composer.value, 'human draft')
})

test('observations bind to consumed source-step provenance without exposing tokens or private scopes', async t => {
  const f = fixture(t), result = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
  assert.equal(result.ok, true); assert.equal(result.data.binding.source_step_id, f.context.step.id)
  assert.equal(Date.parse(result.data.binding.expires_at), now + 15 * 60000)
  assert.deepEqual(plain(result.data.controls.binding), plain(result.data.binding))
  const check = await f.check({ observation_id: result.data.observation_id, element_id: result.data.controls.elements[1].element_id, purpose: 'keyboard' })
  assert.equal(check.ok, true); assert.equal(check.data.input_ready, false); assert.equal(check.data.action_not_executed, true)
  const p = f.requests[1].parameters
  assert.equal(p.binding_scope, f.requests[0].parameters.binding_scope)
  assert.equal(p.source_step_id, f.context.step.id)
  assert.equal(p.source_token_digest, crypto.createHash('sha256').update(f.context.step.token).digest('hex'))
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(check), /source_token_digest|binding_scope|cu_[a-f0-9]{32}/)
  assert.equal((await f.invoke({ target: 'desktop' }, { step: undefined })).code, 'inactive_context')
})

test('binding validator rejects forged provenance, cross-observation controls and out-of-image coordinates', async t => {
  const f = fixture(t), image = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
  const base = { observation_id: image.data.observation_id }
  for (const p of [{ ...base, source_step_id: f.context.step.id }, { ...base, binding_scope: id('os_') },
    { ...base, element_id: id('el_', 'f') }, { ...base, x: 4, y: 0 }, { ...base, x: 0 }, { ...base, x: 0, y: 0, element_id: id('el_') },
    { ...base, purpose: 'keyboard' }, { ...base, purpose: 'pointer' }, { ...base, purpose: 'click' }]) assert.equal((await f.check(p)).code, 'invalid_parameters')
  assert.equal(f.requests.length, 1)
  const only = await f.invoke({ target: 'controls', window_id: row.window_id })
  assert.equal((await f.check({ observation_id: only.data.observation_id, x: 0, y: 0 })).code, 'invalid_parameters')
})

test('stale result refreshes exactly once and returns the new screenshot in the same error delivery', async t => {
  const f = fixture(t), image = await f.invoke({ target: 'window', window_id: row.window_id })
  f.stale('layout_changed')
  const result = await f.check({ observation_id: image.data.observation_id, x: 1, y: 1, purpose: 'pointer' })
  assert.equal(result.code, 'stale_observation'); assert.equal(result.ok, false); assert.equal(result.execution, 'executed')
  assert.equal(result.data.validation.reason, 'layout_changed'); assert.equal(result.data.validation.action_not_executed, true)
  assert.notEqual(result.data.refreshed_observation.observation_id, image.data.observation_id)
  assert.equal(result.data.refreshed_observation.binding.source_step_id, '22222222-2222-4222-8222-222222222222')
  assert.equal(result.attachments.length, 1); await f.service.prepare(result.attachments, owner)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'validate_observation', 'observe'])
  assert.equal((await f.check({ observation_id: image.data.observation_id })).code, 'stale_observation')
  assert.equal(f.requests.length, 3, 'old/unknown IDs do not trigger refresh loops')
  f.stale(null)
  assert.equal((await f.check({ observation_id: result.data.refreshed_observation.observation_id })).ok, true)
})

test('controls aliases, expiry and refresh failure preserve stale facts without input replay', async t => {
  const alias = fixture(t), combined = await alias.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
  assert.equal((await alias.check({ observation_id: combined.data.controls.observation_id, element_id: combined.data.controls.elements[1].element_id })).ok, true)
  const f = fixture(t), image = await f.invoke()
  f.setTime(now + 15 * 60000 + 1); f.failure({ ok: false, execution: 'not_executed', code: 'capture_blocked', message: 'blocked' })
  const result = await f.check({ observation_id: image.data.observation_id })
  assert.equal(result.code, 'stale_observation'); assert.equal(result.data.validation.reason, 'expired')
  assert.equal(result.data.refresh_error.code, 'capture_blocked'); assert.equal(result.attachments, undefined)
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].action, 'observe')
  assert.equal((await f.check({ observation_id: image.data.observation_id })).code, 'stale_observation'); assert.equal(f.requests.length, 2)
})

test('new capture, task generation, helper restart and unregister make old observations unusable', async t => {
  for (const scenario of ['new', 'failed', 'task', 'helper', 'unregister']) {
    const f = fixture(t), image = await f.invoke()
    if (scenario === 'new') await f.invoke()
    if (scenario === 'failed') { f.failure({ ok: false, code: 'capture_failed', execution: 'not_executed', message: 'failed' }); await f.invoke() }
    if (scenario === 'task') f.context.lease.generation++
    if (scenario === 'helper') f.state.generation++
    if (scenario === 'unregister') f.unregister()
    const count = f.requests.length, result = await f.check({ observation_id: image.data.observation_id })
    assert.equal(result.ok, false); assert.equal(f.requests.length, count)
  }
})

test('malformed and late validation results never publish success or launch automatic refresh', async t => {
  for (const mutate of [d => { d.input_ready = true }, d => { d.source_step_id = 'wrong' }, d => { d.observation_id = id('obs_', 'f') },
    d => { d.reason = 'unknown_reason'; d.valid = false }, d => { d.checked_at = 'invalid' }, d => { d.action_not_executed = false }]) {
    const f = fixture(t), image = await f.invoke(); f.validationMutate(mutate)
    assert.equal((await f.check({ observation_id: image.data.observation_id })).code, 'invalid_result'); assert.equal(f.requests.length, 2)
  }
  for (const scenario of ['task', 'helper']) {
    const f = fixture(t), image = await f.invoke(); f.stale('focus_changed')
    f.after(() => { if (scenario === 'task') f.setActive(false); else f.state.generation++ })
    const result = await f.check({ observation_id: image.data.observation_id })
    assert.equal(result.code, 'inactive_context'); assert.equal(result.attachments, undefined); assert.equal(f.requests.length, 2)
  }
})

test('coordinate results use the original upload geometry and are independently recomputed in main', async t => {
  const f = fixture(t), image = await f.invoke({ target: 'region', window_id: row.window_id, x: 1, y: 0, width: 2, height: 2 })
  assert.equal(image.ok, true)
  const result = await f.check({ observation_id: image.data.observation_id, x: 1, y: 1, purpose: 'pointer' })
  assert.equal(result.ok, true); assert.deepEqual(plain(result.data.coordinate.image), { x: 1, y: 1 })
  assert.deepEqual(plain(result.data.coordinate.desktop), { x: -1918, y: -99 })
  assert.equal(result.data.coordinate.absolute.require_virtual_desktop, true); assert.equal(result.data.input_ready, false)
  for (const mutate of [d => { d.coordinate.desktop.x++ }, d => { d.coordinate.absolute.x++ }, d => { d.coordinate.monitor_id = id('mon_', 'f') },
    d => { d.coordinate.virtual_bounds.width++ }, d => { d.coordinate.absolute.require_virtual_desktop = false }, d => { delete d.coordinate },
    d => { d.coordinate.injected = true }]) {
    const g = fixture(t), shot = await g.invoke({ target: 'window', window_id: row.window_id }); g.validationMutate(mutate)
    assert.equal((await g.check({ observation_id: shot.data.observation_id, x: 1, y: 1 })).code, 'invalid_result')
    assert.equal(g.requests.length, 2, 'malformed results do not trigger a capture loop')
  }
})

test('unknown or virtualized geometry never publishes an observation and model geometry overrides are rejected', async t => {
  const base = observation({ target: 'window', window_id: row.window_id })
  for (const mutate of [d => { delete d.coordinate_context }, d => { d.coordinate_context.window_dpi = null }, d => { d.coordinate_context.dpi_awareness = 'unaware' },
    d => { d.coordinate_context.virtual_bounds.x++ }, d => { d.transform.content_bounds = { x: 1, y: 0, width: 3, height: 2 } },
    d => { delete d.transform.pixel_mapping }, d => { d.transform.pixel_mapping = 'linear' }, d => { d.monitors[0].scale_percent = 0 },
    d => { delete d.monitors[0].scale_percent }]) {
    const changed = structuredClone(base.data); mutate(changed)
    assert.equal(implementation.validateWindowsObservation(changed, { target: 'window', window_id: row.window_id }, row, base.bytes, now), false)
  }
  const f = fixture(t), image = await f.invoke()
  for (const extra of [{ desktop_x: 1, desktop_y: 1 }, { coordinate_context: {} }, { dpi: 144 }, { absolute: { x: 1, y: 1 } }, { transform: {} }])
    assert.equal((await f.check({ observation_id: image.data.observation_id, x: 0, y: 0, ...extra })).code, 'invalid_parameters')
  assert.equal(f.requests.length, 1)
})

test('DPI or display changes use the existing single-refresh path without returning old physical coordinates', async t => {
  const f = fixture(t), image = await f.invoke({ target: 'window', window_id: row.window_id }); f.stale('desktop_changed')
  const result = await f.check({ observation_id: image.data.observation_id, x: 0, y: 0 })
  assert.equal(result.code, 'stale_observation'); assert.equal(result.data.validation.reason, 'desktop_changed')
  assert.equal(result.data.validation.coordinate, undefined); assert.ok(result.data.refreshed_observation.coordinate_context)
  assert.equal(f.requests.length, 3); assert.equal(result.attachments.length, 1)
})

test('click metadata enforces one observed locator and rejects scripts native handles modifiers and arbitrary counts', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true }), base = { observation_id: shot.data.observation_id }
  for (const p of [{ ...base }, { ...base, x: 1 }, { ...base, x: 1, y: 1, element_id: id('el_') }, { ...base, x: 4, y: 0 },
    { ...base, element_id: id('el_', 'f') }, { ...base, x: 0, y: 0, button: 'primary' }, { ...base, x: 0, y: 0, click_count: 3 },
    { ...base, x: 0, y: 0, click_count: 0 }, { ...base, x: 0, y: 0, method: 'script' }, { ...base, x: 0, y: 0, hwnd: '0x1234' },
    { ...base, x: 0, y: 0, desktop_x: -1920 }, { ...base, x: 0, y: 0, modifiers: ['Control'] }, { ...base, x: 0, y: 0, request_id: 'override' }])
    assert.equal((await f.click(p)).code, 'invalid_parameters')
  assert.equal(f.requests.length, 1)
  const checked = protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'click', description: '双击目标位置', step_token: id('cu_'), ...base, x: 0, y: 0, click_count: 2 }), [clickMetadata.CLICK_DEFINITION])
  assert.equal(checked.ok, true)
  const g = fixture(t), overview = await g.invoke(); assert.equal((await g.click({ observation_id: overview.data.observation_id, x: 0, y: 0 })).code, 'click_blocked')
  assert.equal(g.requests.length, 1)
})

test('desktop coordinate clicks are off by default; enabled, they click a desktop image point and observe the same area again', async t => {
  const f = fixture(t), desktop = await f.invoke({ target: 'desktop' })
  const off = await f.click({ observation_id: desktop.data.observation_id, x: 1, y: 1 })
  assert.equal(off.code, 'click_blocked'); assert.match(off.message, /允许点击桌面任意位置/)
  assert.equal(f.requests.some(request => request.action === 'click'), false, 'a disabled desktop click never reaches the helper')

  const enabled = { capability: () => ({ ...f.context.capability(), desktopPointClickEnabled: true }) }
  assert.equal((await f.click({ observation_id: desktop.data.observation_id, element_id: id('el_') }, enabled)).code, 'invalid_parameters', 'desktop images have no controls')
  const result = await f.click({ observation_id: desktop.data.observation_id, x: 1, y: 1, button: 'right', click_count: 2 }, enabled)
  assert.equal(result.ok, true); assert.equal(result.data.click.window_id, null); assert.equal(result.data.click.click_completed, true)
  assert.deepEqual(f.requests.map(request => request.action), ['observe', 'click', 'observe'])
  const sent = f.requests[1].parameters
  assert.equal(sent.x, 1); assert.equal(sent.button, 'right'); assert.equal(sent.click_count, 2); assert.equal(sent.element_id, null)
  assert.equal(result.data.observation.target, 'desktop', 'the same desktop source is observed after the click')
  assert.equal(result.data.interaction_hint, undefined)
  assert.equal(result.attachments.length, 1)

  const g = fixture(t), region = await g.invoke({ target: 'region', x: 0, y: 0, width: 2, height: 2 })
  const regional = await g.click({ observation_id: region.data.observation_id, x: 1, y: 1 }, { capability: () => ({ ...g.context.capability(), desktopPointClickEnabled: true }) })
  assert.equal(regional.ok, true); assert.equal(regional.data.observation.target, 'region')
})

test('an input waits for the screen to settle, and observes the desktop when it closed its own window', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.clickMutate(() => f.setKnown(false)) // e.g. picking a Chrome profile closes the picker window
  const result = await f.click({ observation_id: shot.data.observation_id, x: 1, y: 1 })
  assert.equal(result.ok, true); assert.equal(result.data.click.click_completed, true)
  assert.deepEqual(f.sleeps, [500], 'one settle pause before the follow-up observation')
  assert.equal(result.data.post_observation_target_gone, true); assert.equal(result.data.post_observation_error, undefined)
  assert.equal(result.data.observation.target, 'desktop'); assert.equal(result.attachments.length, 1)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'click', 'observe'], 'the closed window is never captured; the input is never replayed')
  assert.match(result.message, /原窗口已关闭/)
})

test('mouse click dispatches once with trusted provenance and returns one new task-bound observation', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  const result = await f.click({ observation_id: shot.data.observation_id, x: 1, y: 1, button: 'right', click_count: 2 })
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed'); assert.equal(result.data.click.click_completed, true)
  assert.equal(result.data.goal_verified, false); assert.equal(result.data.click.goal_verified, false)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'click', 'observe']); assert.equal(result.attachments.length, 1)
  assert.notEqual(result.data.observation.observation_id, shot.data.observation_id)
  const p = f.requests[1].parameters
  assert.equal(p.source_step_id, f.context.step.id); assert.equal(p.request_id, '33333333-3333-4333-8333-333333333333')
  assert.equal(p.binding_scope, f.requests[0].parameters.binding_scope); assert.equal(p.request_token_digest, crypto.createHash('sha256').update(id('cu_', 'c')).digest('hex'))
  assert.equal(result.data.observation.binding.source_step_id, p.request_id)
  assert.doesNotMatch(JSON.stringify(result), /source_token_digest|request_token_digest|binding_scope/)
  await f.service.prepare(result.attachments, owner)
  assert.equal((await f.click({ observation_id: shot.data.observation_id, x: 1, y: 1 })).code, 'stale_observation'); assert.equal(f.requests.length, 3)
})

test('uncertain partial input preserves its receipt and refreshed image without replaying the click', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.clickMutate(result => {
    result.ok = false; result.execution = 'unknown'; result.code = 'click_failed'
    Object.assign(result.data, { click_completed: false, button_events_accepted: 1, release_required: true, release_attempted: true, release_accepted: 1 })
  })
  const result = await f.click({ observation_id: shot.data.observation_id, x: 1, y: 1, click_count: 2 })
  assert.equal(result.code, 'click_failed'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.click.button_events_accepted, 1)
  assert.equal(result.data.click.release_accepted, 1); assert.equal(result.attachments.length, 1); assert.equal(f.requests.filter(r => r.action === 'click').length, 1)
  assert.ok(result.data.observation)
})

test('native hover invalidation reports movement separately from an unattempted click and refreshes once', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.clickMutate(r => {
    r.ok = false; r.code = 'stale_observation'
    Object.assign(r.data, { click_attempted: false, click_completed: false, button_events_requested: 0, button_events_accepted: null,
      validation: { observation_id: r.data.observation_id, source_step_id: r.data.source_step_id, checked_at: new Date(now).toISOString(), valid: false,
        reason: 'image_changed', action_not_executed: true, input_ready: false, snapshot_atomic: false } })
  })
  const result = await f.click({ observation_id: shot.data.observation_id, x: 1, y: 1 })
  assert.equal(result.code, 'stale_observation'); assert.equal(result.execution, 'executed')
  assert.equal(result.data.click.move_accepted, 1); assert.equal(result.data.click.click_attempted, false)
  assert.equal(result.attachments.length, 1); assert.equal(f.requests.filter(r => r.action === 'click').length, 1)
})

test('main accepts role-compatible semantic evidence and rejects a forged semantic method for an edit control', async t => {
  for (const scenario of ['button', 'edit']) {
    const f = fixture(t)
    if (scenario === 'button') f.mutate(r => { const row = r.data.controls.elements[1]; Object.assign(row, { role: 'button', control_type: 50000, patterns: ['invoke'] }) })
    const shot = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
    f.clickMutate(r => { Object.assign(r.data, { method: 'uia_invoke', move_attempted: false, move_accepted: null, button_events_requested: 0, button_events_accepted: null }) })
    const result = await f.click({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id })
    assert.equal(result.code, scenario === 'button' ? 'ok' : 'invalid_result'); assert.equal(f.requests.filter(r => r.action === 'click').length, 1)
  }
})

test('a thrown click transport is uncertain and is followed only by one observation', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.clickMutate(() => { throw new Error('synthetic pipe lost') })
  const result = await f.click({ observation_id: shot.data.observation_id, x: 0, y: 0 })
  assert.equal(result.execution, 'unknown'); assert.equal(result.code, 'invalid_result'); assert.ok(result.data.observation)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'click', 'observe'])
})

test('a successful click is not rerun or marked failed when the one post-observation is blocked', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.clickMutate(() => f.failure({ ok: false, execution: 'not_executed', code: 'capture_blocked', message: 'post-capture blocked' }))
  const result = await f.click({ observation_id: shot.data.observation_id, x: 0, y: 0 })
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed'); assert.equal(result.data.click.click_completed, true)
  assert.equal(result.data.post_observation_error.code, 'capture_blocked'); assert.equal(result.attachments, undefined)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'click', 'observe'])
})

test('controls-only click returns a fresh controls observation without requiring a PNG', async t => {
  const f = fixture(t), observed = await f.invoke({ target: 'controls', window_id: row.window_id })
  const result = await f.click({ observation_id: observed.data.observation_id, element_id: observed.data.controls.elements[1].element_id })
  assert.equal(result.ok, true); assert.equal(result.attachments, undefined); assert.equal(result.data.observation.target, 'controls')
  assert.notEqual(result.data.observation.observation_id, observed.data.observation_id)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'click', 'observe'])
})

test('forged click receipts cannot publish dispatch success and still trigger only a read afterward', async t => {
  for (const change of [r => { r.data.point.x++ }, r => { r.data.request_id = 'wrong' }, r => { r.data.window_id = id('win_', 'f') },
    r => { r.data.click_count = 2 }, r => { r.data.goal_verified = true }, r => { r.data.button_events_accepted = 99 },
    r => { r.data.move_accepted = 0 }, r => { r.data.release_required = true }, r => { r.execution = 'not_executed' },
    r => { r.data.method = 'uia_invoke' }, r => { r.data.injected = 'override' }]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id }); f.clickMutate(change)
    const result = await f.click({ observation_id: shot.data.observation_id, x: 1, y: 1 })
    assert.equal(result.code, 'invalid_result'); assert.equal(result.ok, false); assert.equal(result.data.click.result_unconfirmed, true)
    assert.equal(result.execution, 'unknown', 'an invalid receipt cannot establish that no input occurred')
    assert.equal(f.requests.filter(r => r.action === 'click').length, 1); assert.ok(result.data.observation)
  }
})

test('stale known windows skip click dispatch and late old-task or restarted-helper receipts cannot publish', async t => {
  const stale = fixture(t), shot = await stale.invoke({ target: 'window', window_id: row.window_id }); stale.setKnown(false)
  const changed = await stale.click({ observation_id: shot.data.observation_id, x: 0, y: 0 })
  assert.equal(changed.code, 'stale_observation'); assert.equal(changed.execution, 'not_executed'); assert.equal(changed.data.action_not_executed, true)
  assert.equal(stale.requests.filter(r => r.action === 'click').length, 0)
  for (const scenario of ['task', 'helper']) {
    const f = fixture(t), image = await f.invoke({ target: 'window', window_id: row.window_id })
    f.clickMutate(() => { if (scenario === 'task') f.setActive(false); else f.state.generation++ })
    const result = await f.click({ observation_id: image.data.observation_id, x: 0, y: 0 })
    assert.equal(result.ok, false); assert.equal(result.attachments, undefined); assert.equal(f.requests.length, 2)
  }
})

test('type_text rejects unsafe text syntax and publishes a strict focus-bound definition', async t => {
  const f = fixture(t), base = { observation_id: id('obs_'), element_id: id('el_', 'b'), text: '中文😀' }
  for (const patch of [{ text: '' }, { text: '\u0000' }, { text: '\u001b' }, { text: '\ud800' }, { text: '\udc00' }, { text: 'x'.repeat(8193) },
    { mode: 'keys' }, { x: 1, y: 1 }, { keys: 'Ctrl+A' }, { script: 'code' }, { element_id: 'hwnd' }]) {
    assert.equal((await f.type({ ...base, ...patch })).code, 'invalid_parameters')
  }
  assert.equal(f.requests.length, 0)
  const request = { type: 'computer', version: 1, action: 'type_text', description: '替换输入框内容', step_token: id('cu_'), ...base, text: '', mode: 'replace' }
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify(request), [typeTextMetadata.TYPE_TEXT_DEFINITION]).ok, true)
  const chunks = typeTextMetadata.unicodeTextChunks('x'.repeat(31) + '😀\r\n中文\t{ENTER}^%')
  assert.equal(chunks[0].length, 31); assert.equal(chunks.join(''), 'x'.repeat(31) + '😀\r中文\t{ENTER}^%')
})
test('window text insertion accepts no UIA target but cannot fabricate content verification', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.typeMutate(r => { r.data.verification = 'unavailable'; r.data.content_verified = false })
  const result = await f.type({ observation_id: shot.data.observation_id, text: '自绘编辑区😀' })
  assert.equal(result.ok, true); assert.equal(result.data.type_text.element_id, null)
  assert.equal(result.data.type_text.content_verified, false)
  const g = fixture(t), current = await g.invoke({ target: 'window', window_id: row.window_id })
  assert.equal((await g.type({ observation_id: current.data.observation_id, text: 'replace', mode: 'replace' })).code, 'invalid_parameters')
  assert.equal(g.requests.some(r => r.action === 'type_text'), false)
})

test('type_text sends original literal text once with private provenance and one fresh observation', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
  const text = 'x'.repeat(31) + '😀\r\n中文\t{ENTER}^%'
  const result = await f.type({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, text })
  assert.equal(result.ok, true); assert.equal(result.data.type_text.input_completed, true); assert.equal(result.data.type_text.content_verified, false)
  assert.equal(result.data.goal_verified, false); assert.deepEqual(f.requests.map(r => r.action), ['observe', 'type_text', 'observe'])
  const input = f.requests[1]
  assert.equal(input.parameters.text, text); assert.equal(input.parameters.mode, 'insert'); assert.equal(input.options.timeoutMs, 60000)
  assert.equal(input.parameters.source_step_id, f.context.step.id); assert.equal(input.parameters.request_id, '44444444-4444-4444-8444-444444444444')
  assert.equal(input.parameters.request_token_digest, crypto.createHash('sha256').update(id('cu_', 'd')).digest('hex'))
  assert.equal(Object.hasOwn(input.parameters, 'x'), false); assert.equal(Object.hasOwn(input.parameters, 'hwnd'), false)
  assert.equal(result.attachments.length, 1); assert.notEqual(result.data.observation.observation_id, shot.data.observation_id)
  assert.equal((await f.type({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, text })).code, 'stale_observation')
})

test('text replacement including empty clear is explicit and controls-only refresh needs no image', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'controls', window_id: row.window_id })
  f.typeMutate(r => { r.data.verification = 'matched'; r.data.content_verified = true })
  const result = await f.type({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, text: '', mode: 'replace' })
  assert.equal(result.ok, true); assert.equal(result.data.type_text.method, 'uia_value'); assert.equal(result.data.type_text.content_verified, true)
  assert.equal(result.attachments, undefined); assert.equal(result.data.observation.target, 'controls'); assert.deepEqual(f.requests.map(r => r.action), ['observe', 'type_text', 'observe'])
})

test('a nonfocused observed control is blocked in main without dispatching text', async t => {
  const f = fixture(t)
  f.mutate(r => { r.data.controls.elements[1].focused = false; r.data.controls.focus = { status: 'outside_target', element_id: null } })
  const shot = await f.invoke({ target: 'controls', window_id: row.window_id })
  assert.equal(shot.ok, true)
  const result = await f.type({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, text: 'literal' })
  assert.equal(result.code, 'type_text_blocked'); assert.equal(result.execution, 'not_executed'); assert.equal(f.requests.length, 1)
})

test('partial text preserves uncertainty and one post-image without retyping', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
  f.typeMutate(r => {
    r.ok = false; r.execution = 'unknown'; r.code = 'type_text_failed'; r.data.input_completed = false
    Object.assign(r.data.batches[0], { accepted: 1, release_attempted: true, release_accepted: 1 })
  })
  const result = await f.type({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, text: '中文😀' })
  assert.equal(result.code, 'type_text_failed'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.type_text.batches[0].accepted, 1)
  assert.equal(result.attachments.length, 1); assert.equal(f.requests.filter(r => r.action === 'type_text').length, 1)
})

test('contradictory type receipts are unknown even if they claim no execution', async t => {
  for (const change of [r => { r.data.text_sha256 = '0'.repeat(64) }, r => { r.data.element_id = id('el_', 'f') }, r => { r.data.mode = 'replace' },
    r => { r.data.batches[0].length++ }, r => { r.data.batches[0].accepted = 999 }, r => { r.data.batches[0].release_attempted = true },
    r => { r.execution = 'not_executed' }, r => { r.data.content_verified = true }, r => { r.data.goal_verified = true }, r => { r.data.text = 'leak' }]) {
    const f = fixture(t), shot = await f.invoke({ target: 'controls', window_id: row.window_id }); f.typeMutate(change)
    const result = await f.type({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, text: '中文😀' })
    assert.equal(result.code, 'invalid_result'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.type_text.result_unconfirmed, true)
    assert.equal(f.requests.filter(r => r.action === 'type_text').length, 1); assert.ok(result.data.observation)
  }
})

test('post-capture failure preserves completed text and late task results cannot publish', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id, include_controls: true })
  f.typeMutate(() => f.failure({ ok: false, execution: 'not_executed', code: 'capture_blocked', message: 'after image blocked' }))
  const result = await f.type({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, text: '中文😀' })
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed'); assert.equal(result.data.type_text.input_completed, true)
  assert.equal(result.data.post_observation_error.code, 'capture_blocked'); assert.equal(f.requests.filter(r => r.action === 'type_text').length, 1)
  for (const scenario of ['task', 'helper', 'transport']) {
    const g = fixture(t), observed = await g.invoke({ target: 'controls', window_id: row.window_id })
    g.typeMutate(() => { if (scenario === 'task') g.setActive(false); else if (scenario === 'helper') g.state.generation++; else throw new Error('synthetic pipe failure') })
    const late = await g.type({ observation_id: observed.data.observation_id, element_id: observed.data.controls.elements[1].element_id, text: '中文' })
    assert.equal(late.ok, false); assert.equal(g.requests.filter(r => r.action === 'type_text').length, 1)
    if (scenario === 'transport') { assert.equal(late.execution, 'unknown'); assert.ok(late.data.observation) }
    else assert.equal(late.attachments, undefined)
  }
})

test('keyboard fixtures match canonical aliases virtual keys and extended flags in the shared parser', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/windows-key-cases.json', import.meta.url), 'utf8'))
  for (const row of cases.valid) {
    const chord = pressKeyMetadata.parsePressKey(row.input)
    assert.equal(chord.key, row.key); assert.deepEqual(plain(chord.down.map(s => [s.name, s.vk, s.extended])), row.down)
  }
  for (const key of cases.invalid) assert.equal(pressKeyMetadata.parsePressKey(key), null, key)
  const chord = pressKeyMetadata.parsePressKey('Control+Alt+Shift+S')
  const pending = [[], ['Control'], ['Alt', 'Control'], ['Shift', 'Alt', 'Control'], ['S', 'Shift', 'Alt', 'Control'], ['Shift', 'Alt', 'Control'], ['Alt', 'Control'], ['Control'], []]
  for (let i = 0; i <= 8; i++) assert.deepEqual(plain(pressKeyMetadata.pressKeyReleaseNames(chord, i)), pending[i])
  assert.deepEqual(plain(pressKeyMetadata.pressKeyReleaseNames(chord, null)), ['S', 'Shift', 'Alt', 'Control'])
})

test('press_key metadata rejects raw codes scripts holds repeats and unsupported combinations', async t => {
  const f = fixture(t), base = { observation_id: id('obs_'), key: 'Control+S' }
  for (const patch of [{ key: 'Ctrl+Alt+Delete' }, { key: 'Ctrl+Ctrl+S' }, { key: '{ENTER}' }, { key: 'Ctrl+S,Enter' }, { key: 'Enter\n' },
    { vk: 13 }, { scan_code: 28 }, { text: 'literal' }, { repeat: 2 }, { hold_ms: 100 }, { script: 'code' }, { x: 1, y: 1 }])
    assert.equal((await f.press({ ...base, ...patch })).code, 'invalid_parameters')
  assert.equal(f.requests.length, 0)
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'press_key', description: '发送目标按键', step_token: id('cu_'), ...base }), [pressKeyMetadata.PRESS_KEY_DEFINITION]).ok, true)
  f.state.actions = f.state.actions.filter(action => action !== 'press_key')
  assert.equal(f.context.capability().actions.includes('press_key'), false)
  assert.equal((await f.press(base)).ok, false); assert.equal(f.requests.length, 0)
})

test('window shortcut needs no exposed UIA element and returns exactly one fresh image with trusted provenance', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  const result = await f.press({ observation_id: shot.data.observation_id, key: 'shift+ctrl+s' })
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed'); assert.equal(result.data.press_key.key, 'Control+Shift+S')
  assert.equal(result.data.press_key.events_accepted, 6); assert.equal(result.data.press_key.element_id, null); assert.equal(result.data.goal_verified, false)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'press_key', 'observe']); assert.equal(result.attachments.length, 1)
  const key = f.requests[1]
  assert.equal(key.parameters.element_id, null); assert.equal(key.parameters.key, 'shift+ctrl+s'); assert.equal(key.options.timeoutMs, 20000)
  assert.equal(key.parameters.source_step_id, f.context.step.id); assert.equal(key.parameters.request_id, '55555555-5555-4555-8555-555555555555')
  assert.equal(key.parameters.request_token_digest, crypto.createHash('sha256').update(id('cu_', 'e')).digest('hex'))
  assert.equal(Object.hasOwn(key.parameters, 'vk'), false); assert.equal(Object.hasOwn(key.parameters, 'x'), false)
  assert.equal((await f.press({ observation_id: shot.data.observation_id, key: 'Control+S' })).code, 'stale_observation')
})

test('control shortcuts require actual focus but accept focused noneditable controls and controls-only post-observation', async t => {
  const f = fixture(t)
  f.mutate(r => Object.assign(r.data.controls.elements[1], { control_type: 50000, role: 'button', patterns: ['invoke'] }))
  const shot = await f.invoke({ target: 'controls', window_id: row.window_id })
  const result = await f.press({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, key: 'Space' })
  assert.equal(result.ok, true); assert.equal(result.data.press_key.element_id, shot.data.controls.elements[1].element_id)
  assert.equal(result.attachments, undefined); assert.equal(result.data.observation.target, 'controls')
  const g = fixture(t)
  g.mutate(r => { r.data.controls.elements[1].focused = false; r.data.controls.focus = { status: 'outside_target', element_id: null } })
  const observed = await g.invoke({ target: 'controls', window_id: row.window_id })
  const blocked = await g.press({ observation_id: observed.data.observation_id, element_id: observed.data.controls.elements[1].element_id, key: 'Enter' })
  assert.equal(blocked.code, 'press_key_blocked'); assert.equal(blocked.execution, 'not_executed'); assert.equal(g.requests.length, 1)
})

test('partial and unknown chords retain ordered releases without replaying a primary key', async t => {
  for (const count of [0, 1, 2, 3, 4, 5, null]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
    f.pressMutate(r => {
      r.ok = false; r.code = 'press_key_failed'; r.execution = count === 0 ? 'not_executed' : 'unknown'; r.data.input_completed = false; r.data.events_accepted = count
      r.data.release_keys = plain(pressKeyMetadata.pressKeyReleaseNames(pressKeyMetadata.parsePressKey('Control+Shift+S'), count))
      r.data.release_accepted = r.data.release_keys.length ? 0 : null
    })
    const result = await f.press({ observation_id: shot.data.observation_id, key: 'Control+Shift+S' })
    assert.equal(result.code, 'press_key_failed'); assert.equal(result.execution, count === 0 ? 'not_executed' : 'unknown')
    assert.equal(result.data.press_key.events_accepted, count); assert.equal(result.attachments.length, 1)
    assert.equal(f.requests.filter(r => r.action === 'press_key').length, 1)
  }
})

test('contradictory key receipts cannot claim no execution or publish success', async t => {
  for (const change of [r => { r.data.key = 'Control+O' }, r => { r.data.events_requested = 2 }, r => { r.data.events_accepted = 999 },
    r => { r.data.element_id = id('el_', 'f') }, r => { r.data.release_keys = ['Alt'] }, r => { r.data.release_accepted = 1 },
    r => { r.data.input_completed = false }, r => { r.execution = 'not_executed' }, r => { r.data.goal_verified = true }, r => { r.data.vk = 13 }]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id }); f.pressMutate(change)
    const result = await f.press({ observation_id: shot.data.observation_id, key: 'Control+S' })
    assert.equal(result.code, 'invalid_result'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.press_key.result_unconfirmed, true)
    assert.ok(result.data.observation); assert.equal(f.requests.filter(r => r.action === 'press_key').length, 1)
  }
})

test('key post-capture failure and stale contexts preserve dispatch facts and cannot repeat the chord', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.pressMutate(() => f.failure({ ok: false, execution: 'not_executed', code: 'capture_blocked', message: 'after image blocked' }))
  const result = await f.press({ observation_id: shot.data.observation_id, key: 'Alt+F4' })
  assert.equal(result.ok, true); assert.equal(result.execution, 'executed'); assert.equal(result.data.press_key.input_completed, true)
  assert.equal(result.data.post_observation_error.code, 'capture_blocked'); assert.equal(f.requests.filter(r => r.action === 'press_key').length, 1)
  const overview = fixture(t), desktop = await overview.invoke()
  assert.equal((await overview.press({ observation_id: desktop.data.observation_id, key: 'Enter' })).code, 'press_key_blocked'); assert.equal(overview.requests.length, 1)
  for (const scenario of ['task', 'helper', 'transport']) {
    const g = fixture(t), observed = await g.invoke({ target: 'controls', window_id: row.window_id })
    g.pressMutate(() => { if (scenario === 'task') g.setActive(false); else if (scenario === 'helper') g.state.generation++; else throw new Error('synthetic pipe failure') })
    const late = await g.press({ observation_id: observed.data.observation_id, key: 'Tab' })
    assert.equal(late.ok, false); assert.equal(g.requests.filter(r => r.action === 'press_key').length, 1)
    if (scenario === 'transport') { assert.equal(late.execution, 'unknown'); assert.ok(late.data.observation) }
    else assert.equal(late.attachments, undefined)
  }
})

test('scroll requires an explicit exclusive locator and one bounded direction with no native overrides', async t => {
  const f = fixture(t), base = { observation_id: id('obs_'), x: 1, y: 1, direction: 'down' }
  for (const patch of [{ direction: 'diagonal' }, { direction: null }, { amount: 0 }, { amount: 11 }, { amount: 1.5 }, { amount: '3' }, { amount: null },
    { element_id: id('el_') }, { x: undefined }, { y: undefined }, { x: -1 }, { y: 8192 }, { delta: -120 }, { pixels: 300 },
    { repeat: 3 }, { hwnd: '0x1234' }, { modifiers: ['Shift'] }, { script: 'code' }, { binding_scope: id('ws_') }])
    assert.equal((await f.scroll({ ...base, ...patch })).code, 'invalid_parameters')
  assert.equal((await f.scroll({ observation_id: id('obs_'), direction: 'down' })).code, 'invalid_parameters')
  assert.equal(f.requests.length, 0)
  for (const p of [base, { observation_id: id('obs_'), element_id: id('el_'), direction: 'right', amount: 10 }]) {
    assert.equal(scrollMetadata.validateScrollParameters(p), null)
    assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'scroll', description: '滚动目标页面', step_token: id('cu_'), ...p }), [scrollMetadata.SCROLL_DEFINITION]).ok, true)
  }
  f.state.actions = f.state.actions.filter(action => action !== 'scroll')
  assert.equal(f.context.capability().actions.includes('scroll'), false)
  assert.equal((await f.scroll(base)).ok, false); assert.equal(f.requests.length, 0)
})

test('four wheel directions use detents and trusted observation provenance followed by exactly one image', async t => {
  for (const [direction, axis, delta] of [['up', 'vertical', 120], ['down', 'vertical', -120], ['left', 'horizontal', -120], ['right', 'horizontal', 120]]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
    const result = await f.scroll({ observation_id: shot.data.observation_id, x: 1, y: 1, direction })
    assert.equal(result.ok, true); assert.equal(result.execution, 'executed')
    assert.equal(result.data.scroll.axis, axis); assert.equal(result.data.scroll.wheel_delta, delta * 3); assert.equal(result.data.scroll.amount, 3)
    assert.equal(result.data.scroll.wheel_events_accepted, 1); assert.equal(result.data.scroll.scroll_verified, false); assert.equal(result.data.goal_verified, false)
    assert.deepEqual(f.requests.map(r => r.action), ['observe', 'scroll', 'observe']); assert.equal(result.attachments.length, 1)
    const request = f.requests[1]
    assert.equal(request.parameters.source_step_id, f.context.step.id); assert.equal(request.parameters.request_id, '66666666-6666-4666-8666-666666666666')
    assert.equal(request.parameters.binding_scope, f.requests[0].parameters.binding_scope)
    assert.equal(request.parameters.request_token_digest, crypto.createHash('sha256').update(id('cu_', 'f')).digest('hex'))
    assert.equal(request.parameters.amount, 3); assert.equal(request.parameters.element_id, null); assert.equal(request.options.timeoutMs, 20000)
    assert.equal(result.data.observation.binding.source_step_id, request.parameters.request_id)
    assert.doesNotMatch(JSON.stringify(result), /request_token_digest|source_token_digest|binding_scope/)
    assert.equal((await f.scroll({ observation_id: shot.data.observation_id, x: 1, y: 1, direction })).code, 'stale_observation')
    assert.equal(f.requests.filter(r => r.action === 'scroll').length, 1)
  }
})

test('scroll cannot use a desktop overview, an outside image point or a foreign control', async t => {
  const f = fixture(t), desktop = await f.invoke()
  assert.equal((await f.scroll({ observation_id: desktop.data.observation_id, x: 0, y: 0, direction: 'down' })).code, 'scroll_blocked')
  const shot = await f.invoke({ target: 'window', window_id: row.window_id })
  assert.equal((await f.scroll({ observation_id: shot.data.observation_id, x: 4, y: 0, direction: 'down' })).code, 'invalid_parameters')
  assert.equal((await f.scroll({ observation_id: shot.data.observation_id, element_id: id('el_', 'f'), direction: 'down' })).code, 'invalid_parameters')
  assert.equal(f.requests.filter(r => r.action === 'scroll').length, 0)
})

test('controls-only scroll locates a noneditable unfocused region and returns a fresh tree without a PNG', async t => {
  const f = fixture(t)
  f.mutate(r => {
    Object.assign(r.data.controls.elements[1], { control_type: 50033, role: 'pane', patterns: ['scroll'], focused: false })
    r.data.controls.focus = { status: 'outside_target', element_id: null }
  })
  const shot = await f.invoke({ target: 'controls', window_id: row.window_id })
  const result = await f.scroll({ observation_id: shot.data.observation_id, element_id: shot.data.controls.elements[1].element_id, direction: 'right', amount: 10 })
  assert.equal(result.ok, true); assert.equal(result.data.scroll.element_id, shot.data.controls.elements[1].element_id)
  assert.equal(result.data.scroll.wheel_delta, 1200); assert.equal(result.attachments, undefined)
  assert.equal(result.data.observation.target, 'controls'); assert.notEqual(result.data.observation.observation_id, shot.data.observation_id)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'scroll', 'observe'])
  assert.equal(f.requests[1].parameters.x, null); assert.equal(f.requests[1].parameters.y, null)
})

test('zero and uncertain wheel acceptance preserve movement facts and never replay input', async t => {
  for (const count of [0, null]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
    f.scrollMutate(r => { r.ok = false; r.code = 'scroll_failed'; r.execution = count === 0 ? 'executed' : 'unknown'
      Object.assign(r.data, { scroll_completed: false, wheel_events_accepted: count }) })
    const result = await f.scroll({ observation_id: shot.data.observation_id, x: 1, y: 1, direction: 'down' })
    assert.equal(result.code, 'scroll_failed'); assert.equal(result.execution, count === 0 ? 'executed' : 'unknown')
    assert.equal(result.data.scroll.move_accepted, 1); assert.equal(result.data.scroll.wheel_events_accepted, count)
    assert.equal(result.attachments.length, 1); assert.equal(f.requests.filter(r => r.action === 'scroll').length, 1)
  }
})

test('hover invalidation records movement but no wheel and obtains one new observation', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.scrollMutate(r => {
    r.ok = false; r.code = 'stale_observation'
    Object.assign(r.data, { scroll_attempted: false, scroll_completed: false, wheel_events_requested: 0, wheel_events_accepted: null,
      validation: { observation_id: r.data.observation_id, source_step_id: r.data.source_step_id, checked_at: new Date(now).toISOString(), valid: false,
        reason: 'image_changed', action_not_executed: true, input_ready: false, snapshot_atomic: false } })
  })
  const result = await f.scroll({ observation_id: shot.data.observation_id, x: 0, y: 0, direction: 'up' })
  assert.equal(result.code, 'stale_observation'); assert.equal(result.execution, 'executed'); assert.equal(result.data.scroll.scroll_attempted, false)
  assert.equal(result.data.scroll.move_accepted, 1); assert.equal(result.attachments.length, 1)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'scroll', 'observe'])
})

test('main independently rejects contradictory scroll intent geometry routing counts and execution receipts', async t => {
  for (const change of [r => { r.data.direction = 'up' }, r => { r.data.amount++ }, r => { r.data.axis = 'horizontal' }, r => { r.data.wheel_delta = 120 },
    r => { r.data.request_id = 'wrong' }, r => { r.data.window_id = id('win_', 'f') }, r => { r.data.element_id = id('el_') }, r => { r.data.point.x++ },
    r => { r.data.move_accepted = 0 }, r => { r.data.wheel_events_accepted = 2 }, r => { r.data.wheel_events_requested = 2 }, r => { r.data.routing = null },
    r => { r.data.scroll_verified = true }, r => { r.data.goal_verified = true }, r => { r.data.input_ready = true }, r => { r.execution = 'not_executed' },
    r => { r.data.scroll_completed = false }, r => { r.data.extra = 'override' }]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id }); f.scrollMutate(change)
    const result = await f.scroll({ observation_id: shot.data.observation_id, x: 1, y: 1, direction: 'down' })
    assert.equal(result.code, 'invalid_result'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.scroll.result_unconfirmed, true)
    assert.ok(result.data.observation); assert.equal(f.requests.filter(r => r.action === 'scroll').length, 1)
  }
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.scrollMutate(r => { r.data.routing = 'mouse_position' })
  assert.equal((await f.scroll({ observation_id: shot.data.observation_id, x: 0, y: 0, direction: 'right' })).code, 'invalid_result')
})

test('scroll post-capture failure keeps the wheel acknowledgement and late contexts cannot publish or replay', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.scrollMutate(() => f.failure({ ok: false, execution: 'not_executed', code: 'capture_blocked', message: 'after image blocked' }))
  const result = await f.scroll({ observation_id: shot.data.observation_id, x: 0, y: 0, direction: 'down' })
  assert.equal(result.ok, true); assert.equal(result.data.scroll.scroll_completed, true); assert.equal(result.execution, 'executed')
  assert.equal(result.data.post_observation_error.code, 'capture_blocked'); assert.equal(result.attachments, undefined)
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'scroll', 'observe'])
  for (const scenario of ['task', 'helper', 'transport']) {
    const g = fixture(t), observed = await g.invoke({ target: 'controls', window_id: row.window_id })
    g.scrollMutate(() => { if (scenario === 'task') g.setActive(false); else if (scenario === 'helper') g.state.generation++; else throw new Error('synthetic pipe failure') })
    const late = await g.scroll({ observation_id: observed.data.observation_id, element_id: observed.data.controls.elements[1].element_id, direction: 'left' })
    assert.equal(late.ok, false); assert.equal(g.requests.filter(r => r.action === 'scroll').length, 1)
    if (scenario === 'transport') { assert.equal(late.execution, 'unknown'); assert.ok(late.data.observation) }
    else assert.equal(late.attachments, undefined)
  }
})

const smallDragPath = [{ x: 0, y: 0 }, { x: 3, y: 1 }]
test('drag metadata requires complete bounded original-image paths and rejects raw or persistent input', async t => {
  const f = fixture(t), base = { observation_id: id('obs_'), path: smallDragPath }
  for (const patch of [{ path: [] }, { path: [{ x: 0, y: 0 }] }, { path: Array.from({ length: 34 }, (_, i) => ({ x: i, y: 0 })) },
    { path: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }, { path: [{ x: 0, y: 0 }, { x: 2 }] }, { path: [{ x: 0, y: 0 }, { x: -1, y: 0 }] },
    { path: [{ x: 0, y: 0 }, { x: 1, y: 0, pressure: 1 }] }, { path: [{ x: 0, y: 0 }, { x: 8192, y: 0 }] }, { path: '0,0;1,1' },
    { path: [{ x: 0, y: 0 }, { x: 1.5, y: 0 }] }, { duration_ms: 99 }, { duration_ms: 3001 }, { duration_ms: null }, { button: null }, { button: 'pen' },
    { repeat: 2 }, { hwnd: '0x1234' }, { script: 'code' }, { element_id: id('el_') }, { x: 1, y: 1 }, { modifiers: ['Shift'] }, { hold: true }])
    assert.equal((await f.drag({ ...base, ...patch })).code, 'invalid_parameters')
  assert.equal(f.requests.length, 0)
  assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'drag', description: '拖动目标控件', step_token: id('cu_'), ...base }), [dragMetadata.DRAG_DEFINITION]).ok, true)
  f.state.actions = f.state.actions.filter(action => action !== 'drag')
  assert.equal(f.context.capability().actions.includes('drag'), false); assert.equal((await f.drag(base)).ok, false); assert.equal(f.requests.length, 0)
})

test('drag subdivision shares native golden vectors including negative coordinates and canvas waypoints', () => {
  for (const c of JSON.parse(readFileSync(new URL('./fixtures/windows-drag-cases.json', import.meta.url), 'utf8')))
    assert.deepEqual(plain(dragMetadata.interpolateDragPath(c.anchors)), c.points, c.name)
  assert.equal(dragMetadata.interpolateDragPath([{ x: 0, y: 0 }, { x: 4096, y: 0 }]).length, 257)
  assert.equal(dragMetadata.interpolateDragPath([{ x: 0, y: 0 }, { x: 4097, y: 0 }]), null)
  assert.equal(dragMetadata.interpolateDragPath([{ x: 1, y: 1 }, { x: 1, y: 1 }]), null)
})

test('drag maps a bounded physical route and refuses a thin display gap anywhere between anchors', () => {
  const shot = observation({ target: 'window', window_id: row.window_id }).data
  assert.deepEqual(plain(dragImplementation.resolveDragPath(shot, smallDragPath)), [{ x: -1920, y: -100 }, { x: -1917, y: -99 }])
  const gap = structuredClone(shot)
  gap.monitors = [{ ...monitor, bounds: { x: -1920, y: -100, width: 1, height: 2 } },
    { ...monitor, monitor_id: id('mon_', 'b'), primary: false, bounds: { x: -1918, y: -100, width: 2, height: 2 } }]
  assert.equal(dragImplementation.resolveDragPath(gap, smallDragPath), null)
})

test('drag sends one balanced gesture with trusted provenance and returns exactly one new image', async t => {
  for (const button of ['left', 'right', 'middle']) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
    const result = await f.drag({ observation_id: shot.data.observation_id, path: smallDragPath, button })
    assert.equal(result.ok, true); assert.equal(result.execution, 'executed'); assert.equal(result.data.drag.drag_completed, true)
    assert.equal(result.data.drag.drag_verified, false); assert.equal(result.data.goal_verified, false)
    assert.deepEqual(plain(result.data.drag.start), { x: -1920, y: -100 }); assert.deepEqual(plain(result.data.drag.end), { x: -1917, y: -99 })
    assert.deepEqual(f.requests.map(r => r.action), ['observe', 'drag', 'observe']); assert.equal(result.attachments.length, 1)
    const p = f.requests[1].parameters
    assert.equal(p.duration_ms, 600); assert.equal(p.source_step_id, f.context.step.id); assert.equal(p.request_id, '77777777-7777-4777-8777-777777777777')
    assert.equal(p.request_token_digest, crypto.createHash('sha256').update(id('cu_')).digest('hex')); assert.equal(p.binding_scope, f.requests[0].parameters.binding_scope)
    assert.equal(Object.hasOwn(p, 'element_id'), false); assert.equal(f.requests[1].options.timeoutMs, 30000)
    assert.equal(result.data.observation.binding.source_step_id, p.request_id)
    assert.equal((await f.drag({ observation_id: shot.data.observation_id, path: smallDragPath })).code, 'stale_observation')
    assert.equal(f.requests.filter(r => r.action === 'drag').length, 1)
  }
})

test('drag requires a window image and valid route, with no default desktop or controls-only conversion', async t => {
  for (const target of ['desktop', 'controls', 'window']) {
    const f = fixture(t), shot = await f.invoke(target === 'desktop' ? { target } : { target, window_id: row.window_id })
    const result = await f.drag({ observation_id: shot.data.observation_id, path: target === 'window' ? [{ x: 0, y: 0 }, { x: 4, y: 0 }] : smallDragPath })
    assert.equal(result.code, 'drag_blocked'); assert.equal(result.execution, 'not_executed'); assert.equal(f.requests.length, 1)
  }
})

test('partial drag preserves uncertain path and necessary release without repeating the gesture', async t => {
  for (const accepted of [0, null]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
    f.dragMutate(r => {
      r.ok = false; r.code = 'drag_failed'; r.execution = 'unknown'
      Object.assign(r.data, { segments: [{ index: 1, accepted, arrived: false }], up_attempted: false, up_accepted: null,
        release_required: true, release_attempted: true, release_accepted: 1, drag_completed: false })
    })
    const result = await f.drag({ observation_id: shot.data.observation_id, path: smallDragPath })
    assert.equal(result.code, 'drag_failed'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.drag.release_accepted, 1)
    assert.equal(result.data.drag.segments[0].accepted, accepted); assert.equal(result.attachments.length, 1)
    assert.deepEqual(f.requests.map(r => r.action), ['observe', 'drag', 'observe'])
  }
})

test('drag hover invalidation and zero down separate cursor movement from an unstarted gesture', async t => {
  for (const scenario of ['hover', 'zero_down']) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
    f.dragMutate(r => {
      r.ok = false; r.code = scenario === 'hover' ? 'stale_observation' : 'drag_failed'
      Object.assign(r.data, { down_attempted: scenario !== 'hover', down_accepted: scenario === 'hover' ? null : 0, down_confirmed: false,
        segments: [], up_attempted: false, up_accepted: null, drag_completed: false })
      if (scenario === 'hover') r.data.validation = { observation_id: r.data.observation_id, source_step_id: r.data.source_step_id,
        checked_at: new Date(now).toISOString(), valid: false, reason: 'image_changed', action_not_executed: true, input_ready: false, snapshot_atomic: false }
    })
    const result = await f.drag({ observation_id: shot.data.observation_id, path: smallDragPath })
    assert.equal(result.code, scenario === 'hover' ? 'stale_observation' : 'drag_failed'); assert.equal(result.execution, 'executed')
    assert.equal(result.data.drag.release_attempted, false); assert.equal(result.data.drag.move_accepted, 1); assert.ok(result.data.observation)
  }
})

test('main rejects forged drag geometry accepted prefixes cleanup and success claims', async t => {
  for (const change of [r => { r.data.start.x++ }, r => { r.data.end.y++ }, r => { r.data.segments_planned++ }, r => { r.data.button = 'middle' },
    r => { r.data.duration_ms++ }, r => { r.data.request_id = 'wrong' }, r => { r.data.window_id = id('win_', 'f') }, r => { r.data.move_arrived = false },
    r => { r.data.down_accepted = 0 }, r => { r.data.down_confirmed = false }, r => { r.data.segments[0].index = 2 }, r => { r.data.segments[0].accepted = 2 },
    r => { r.data.segments[0].arrived = false }, r => { r.data.up_accepted = 0 }, r => { r.data.release_required = true }, r => { r.data.release_attempted = true },
    r => { r.data.release_accepted = 1 }, r => { r.data.drag_completed = false }, r => { r.data.drag_verified = true }, r => { r.data.goal_verified = true },
    r => { r.execution = 'not_executed' }, r => { r.data.script = 'override' }]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id }); f.dragMutate(change)
    const result = await f.drag({ observation_id: shot.data.observation_id, path: smallDragPath })
    assert.equal(result.code, 'invalid_result'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.drag.result_unconfirmed, true)
    assert.ok(result.data.observation); assert.equal(f.requests.filter(r => r.action === 'drag').length, 1)
  }
})

test('unknown down or failed normal up require one recorded cleanup and remain uncertain even when released', async t => {
  for (const stage of ['down', 'up']) for (const cleanup of [0, 1, null]) {
    const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
    f.dragMutate(r => {
      r.ok = false; r.code = 'drag_failed'; r.execution = 'unknown'
      Object.assign(r.data, { release_required: true, release_attempted: true, release_accepted: cleanup, drag_completed: false })
      if (stage === 'down') Object.assign(r.data, { down_accepted: null, down_confirmed: false, segments: [], up_attempted: false, up_accepted: null })
      else r.data.up_accepted = 0
    })
    const result = await f.drag({ observation_id: shot.data.observation_id, path: smallDragPath })
    assert.equal(result.code, 'drag_failed'); assert.equal(result.execution, 'unknown'); assert.equal(result.data.drag.release_accepted, cleanup)
    assert.equal(result.data.drag.drag_completed, false); assert.equal(f.requests.filter(r => r.action === 'drag').length, 1)
    assert.ok(result.data.observation)
  }
})

test('menu closure after a key preserves input facts and provides its parent discovery hint without replay', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.hint({ parent_window_id: id('win_', 'b'), kind: 'menu' })
  f.pressMutate(() => f.failure({ ok: false, execution: 'not_executed', code: 'stale_window', message: 'menu closed after action' }))
  const result = await f.press({ observation_id: shot.data.observation_id, key: 'Enter' })
  assert.equal(result.ok, true); assert.equal(result.data.press_key.input_completed, true); assert.equal(result.data.post_observation_error.code, 'stale_window')
  assert.deepEqual(plain(result.data.interaction_hint), { parent_window_id: id('win_', 'b'), kind: 'menu', next_action: 'inspect_interactions' })
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'press_key', 'observe'])
})

test('drag post-capture failure retains input facts and stale contexts or transport loss never replay', async t => {
  const f = fixture(t), shot = await f.invoke({ target: 'window', window_id: row.window_id })
  f.dragMutate(() => f.failure({ ok: false, execution: 'not_executed', code: 'capture_blocked', message: 'after image blocked' }))
  const result = await f.drag({ observation_id: shot.data.observation_id, path: smallDragPath })
  assert.equal(result.ok, true); assert.equal(result.data.drag.drag_completed, true); assert.equal(result.data.post_observation_error.code, 'capture_blocked')
  assert.deepEqual(f.requests.map(r => r.action), ['observe', 'drag', 'observe'])
  for (const scenario of ['task', 'helper', 'transport']) {
    const g = fixture(t), observed = await g.invoke({ target: 'window', window_id: row.window_id })
    g.dragMutate(() => { if (scenario === 'task') g.setActive(false); else if (scenario === 'helper') g.state.generation++; else throw new Error('synthetic pipe failure') })
    const late = await g.drag({ observation_id: observed.data.observation_id, path: smallDragPath })
    assert.equal(late.ok, false); assert.equal(g.requests.filter(r => r.action === 'drag').length, 1)
    if (scenario === 'transport') { assert.equal(late.execution, 'unknown'); assert.ok(late.data.observation) }
    else assert.equal(late.attachments, undefined)
  }
})
