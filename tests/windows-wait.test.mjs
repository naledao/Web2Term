import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run: node --test tests/windows-wait.test.mjs
// Real validators and scheduler, synthetic time and frames only; no Electron/helper/desktop.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
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
const catalog = load('../src/main/windows-window-catalog.ts', { 'node:crypto': {}, '../shared/windows-desktop': load('../src/shared/windows-desktop.ts'), './computer-use-tool': registry, './windows-app-catalog': apps })
const controlMetadata = load('../src/shared/windows-controls.ts')
const controls = load('../src/main/windows-control-tree.ts', { '../shared/windows-controls': controlMetadata })
const metadata = load('../src/shared/windows-wait.ts', { './windows-controls': controlMetadata })
const implementation = load('../src/main/windows-wait.ts', { 'node:perf_hooks': { performance }, 'node:timers/promises': { setTimeout },
  '../shared/windows-wait': metadata, './windows-window-catalog': catalog, './windows-control-tree': controls })
const id = (prefix, digit = 'a') => prefix + digit.repeat(32)
const at = Date.parse('2026-10-26T00:00:00Z'), waitId = '11111111-1111-4111-8111-111111111111'
const window = { window_id: id('win_'), hwnd: '0x1234', pid: 42, process_started_at: new Date(at - 10000).toISOString(), thread_id: 100,
  class_name: 'ExampleWindow', title: 'Report', application: { name: 'Editor', executable_path: 'C:\\Apps\\Editor.exe', app_user_model_id: null },
  visible: true, minimized: false, foreground: false, enabled: true, cloaked: false, owner_hwnd: null, owner_window_id: null, identity_verified: true, identity_status: 'verified', bounds: { x: 0, y: 0, width: 800, height: 600 } }
const probe = (patch = {}) => ({ wait_id: waitId, condition: 'window_present', snapshot_id: id('wset_'), scope_collected_at: new Date(at).toISOString(),
  scope_expires_at: new Date(at + 120000).toISOString(), before_at: new Date(at).toISOString(), checked_at: new Date(at + 10).toISOString(),
  window, controls: null, status: 'met', matches: 1, complete: true, limitations: [], revision: '1:2', input_ready: false, goal_verified: false, ...patch })
const plain = value => JSON.parse(JSON.stringify(value))

test('public conditions have strict mutually exclusive selectors and bounded deadlines', () => {
  for (const p of [{ condition: 'window_present', query: '报表', pid: 42 }, { condition: 'text_present', window_id: window.window_id, text: '完成' },
    { condition: 'control_available', window_id: window.window_id, selector: { name: '保存', role: 'button' }, timeout_ms: 30000, observation: 'window' },
    { condition: 'control_present', window_id: window.window_id, selector: { name: '保存' }, timeout_ms: 180000 }]) {
    assert.equal(metadata.validateWaitParameters(p), null)
    assert.equal(protocol.computerUseProtocol.check(JSON.stringify({ type: 'computer', version: 1, action: 'wait_for', description: '等待界面更新', step_token: id('cu_'), ...p }), [metadata.WAIT_FOR_DEFINITION]).ok, true)
  }
  for (const p of [{ condition: 'script', code: 'true' }, { condition: 'window_present', query: ' ' }, { condition: 'window_present', query: 'x', text: 'x' },
    { condition: 'window_present', query: 'x', window_id: window.window_id }, { condition: 'window_present', query: 'x', pid: 0 },
    { condition: 'text_present', window_id: window.window_id, text: '' }, { condition: 'text_present', window_id: window.window_id, text: 'x', regex: true },
    { condition: 'control_available', window_id: window.window_id, selector: { name: 'Save', role: 'invented' } },
    { condition: 'control_available', window_id: window.window_id, selector: { name: 'Save', element_id: id('el_') } },
    ...[null, 0, 99, 3600001, 100.5].map(timeout_ms => ({ condition: 'window_present', query: 'x', timeout_ms }))]) assert.ok(metadata.validateWaitParameters(p))
})

test('UIA presence, uniqueness, visibility and partial reads have different evidence requirements', () => {
  const text = { condition: 'text_present', text: 'Done' }, control = { condition: 'control_available', selector: { name: 'Done', role: 'button' } }
  const row = { name: 'Done', role: 'button', name_truncated: false, properties_complete: true, password: false, offscreen: false, bounds: {}, enabled: true }
  const check = (p, elements, complete = true, w = window) => plain(metadata.evaluateWaitControls(p, w, { elements, complete }))
  assert.deepEqual(check(text, [row], false), { status: 'met', matches: 1 })
  assert.equal(check({ ...text, text: 'done' }, [row]).status, 'not_met')
  assert.equal(check(text, [], false).status, 'unavailable')
  assert.equal(check(control, [row], false).status, 'unavailable')
  assert.equal(check(control, [row, row]).status, 'ambiguous')
  assert.equal(check(control, [row]).status, 'met')
  assert.equal(check(control, [row], true, { ...window, enabled: false }).status, 'not_met')
  for (const patch of [{ password: true }, { password: null }, { offscreen: true }, { bounds: null }]) assert.equal(check(text, [{ ...row, ...patch }]).matches, 0)
  assert.equal(check(text, [{ ...row, properties_complete: false }]).matches, 1)
  assert.equal(check({ ...control, condition: 'control_present' }, [row, row], false).status, 'met')
  assert.equal(check(control, [{ ...row, name_truncated: true }]).matches, 0)
  assert.equal(check(text, [row], true, { ...window, minimized: true }).status, 'unavailable')
})

test('native window evidence is independently checked for identity, source, query, ambiguity and read-only claims', () => {
  const p = { condition: 'window_present', query: 'editor', pid: 42 }
  assert.equal(implementation.validateWaitProbe(probe(), p, waitId, null, at + 20), true)
  for (const patch of [{ wait_id: 'other' }, { condition: 'text_present' }, { status: 'met', matches: 2 }, { input_ready: true }, { goal_verified: true },
    { extra: 'field' }, { window: { ...window, minimized: true } }, { window: { ...window, pid: 43 } }, { window: { ...window, class_name: '#32768' } },
    { scope_expires_at: new Date(at + 16 * 60000).toISOString() }, { complete: true, limitations: ['state_changed'] }]) assert.equal(implementation.validateWaitProbe(probe(patch), p, waitId, null, at + 20), false)
  assert.equal(implementation.validateWaitProbe(probe({ status: 'ambiguous', matches: 2, window: null }), p, waitId, null, at + 20), true)
  assert.equal(implementation.validateWaitProbe(probe({ status: 'not_met', matches: 0, window: null }), p, waitId, null, at + 20), true)
})

function scheduler() {
  let time = 0, live = true
  const sleeps = [], budgets = []
  return { clock: { now: () => time, sleep: async ms => { sleeps.push(ms); time += ms } }, current: () => live, sleeps, budgets,
    stop: () => { live = false }, advance: ms => { time += ms }, check: fn => async budget => { budgets.push(budget); return probe(fn(budgets.length)) } }
}
test('polling backs off for unchanged or unavailable events and resets when revision changes', async () => {
  for (const revision of ['1:2', null]) {
    const f = scheduler(), result = await implementation.pollWindowsWait({ timeout_ms: 10000 }, f.check(n => ({ status: n === 5 ? 'met' : 'not_met', revision: n >= 4 ? 'changed' : revision })), f.clock, f.current)
    assert.equal(result.status, 'met'); assert.equal(result.checks, 5)
    assert.deepEqual(f.sleeps, [250, 500, 1000, 250]); assert.ok(f.budgets.every(n => n <= 4000))
  }
})
test('deadline is monotonic and bounded; even a positive result arriving late is a timeout', async () => {
  const f = scheduler()
  const result = await implementation.pollWindowsWait({ timeout_ms: 1000 }, f.check(() => ({ status: 'not_met' })), f.clock, f.current)
  assert.equal(result.status, 'timeout'); assert.equal(result.elapsed_ms, 1000); assert.deepEqual(f.sleeps, [250, 500, 250])
  const late = scheduler(), deadline = await implementation.pollWindowsWait({ timeout_ms: 100 }, late.check(() => { late.advance(101); return { status: 'met' } }), late.clock, late.current)
  assert.equal(deadline.status, 'timeout'); assert.equal(deadline.checks, 1)
})
test('a bounded long business wait is not truncated after 128 local checks', async () => {
  const f = scheduler()
  const result = await implementation.pollWindowsWait({ timeout_ms: 180000 }, f.check(n => ({ status: n === 140 ? 'met' : 'not_met' })), f.clock, f.current)
  assert.equal(result.status, 'met'); assert.equal(result.checks, 140); assert.ok(result.elapsed_ms < 180000)
})
test('ambiguity stops immediately and cancellation or task replacement stops further checks', async () => {
  const f = scheduler(), result = await implementation.pollWindowsWait({}, f.check(() => ({ status: 'ambiguous' })), f.clock, f.current)
  assert.equal(result.status, 'ambiguous'); assert.equal(result.checks, 1); assert.equal(f.sleeps.length, 0)
  const stale = scheduler()
  await assert.rejects(implementation.pollWindowsWait({}, stale.check(() => { stale.stop(); return { status: 'met' } }), stale.clock, stale.current), /wait_context_inactive/)
  const cancelled = scheduler()
  await assert.rejects(implementation.pollWindowsWait({}, cancelled.check(() => ({})), cancelled.clock, cancelled.current, { aborted: true }), /wait_context_inactive/)
  assert.equal(cancelled.budgets.length, 0)
})

test('fractional monotonic time is rounded down to the integer helper timeout contract', async () => {
  const f = scheduler(), result = await implementation.pollWindowsWait({ timeout_ms: 1000 }, f.check(n => {
    f.advance(0.125); return { status: n === 3 ? 'met' : 'not_met' }
  }), f.clock, f.current)
  assert.equal(result.status, 'met'); assert.deepEqual(f.budgets, [1000, 749, 249])
  assert.ok(f.budgets.every(Number.isSafeInteger))
})
