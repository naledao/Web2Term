// User-run only: node --test tests/renderer-throttle-probe.test.mjs
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Script } from 'node:vm'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../tools/diag/renderer-throttle-probe.cjs', import.meta.url), 'utf8')

function fixture() {
  const events = [], metrics = [], owners = new Map(), targets = new Map()
  let now = 0
  let onWrite = () => {}
  const contentTracing = { startRecording: async () => {}, stopRecording: async () => {},
    getTraceBufferUsage: async () => ({ percentage: 0.1 }) }
  const modules = {
    electron: { app: { getAppMetrics: () => metrics }, contentTracing },
    'node:fs/promises': { mkdtemp: async () => 'fixture-trace-dir', unlink: async () => {}, rmdir: async () => {} },
    'node:timers/promises': { setTimeout: async (ms, value, { signal } = {}) => {
      signal?.throwIfAborted()
      now += ms
      return value
    } },
    './renderer-timeline-probe.cjs': { analyze: async ({ phases }) => ({ phases: phases.map(({ name }) => ({
      name, aligned: true, frameTasks: name === 'throttled' ? 0 : 250, traceMs: 10_000
    })) }) }
  }
  const module = { exports: {} }
  new Script(source).runInNewContext({ module, require: id => modules[id] ?? require(id), AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, performance: { now: () => now } })
  const probe = module.exports.createThrottleProbe({
    write: (event, fields) => { events.push({ event, ...fields }); onWrite(event, fields) }, getOwners: () => owners,
    throttleTarget: contents => targets.get(contents),
    command: async (_debugger, method) => method === 'Runtime.evaluate'
      ? { result: { value: { idle: true, visibility: 'visible' } } } : { nodes: 100 }
  })
  function addView(id, percentCPUUsage) {
    const state = { reason: null, throttled: false, changes: [] }
    let attached = false
    const debuggerApi = Object.assign(new EventEmitter(), { isAttached: () => attached,
      attach() { attached = true }, detach() { attached = false } })
    const contents = Object.assign(new EventEmitter(), { id, debugger: debuggerApi, getOSProcessId: () => id,
      isDestroyed: () => false, isDevToolsOpened: () => false, getBackgroundThrottling: () => state.throttled })
    metrics.push({ pid: id, creationTime: 1, cpu: { percentCPUUsage, cumulativeCPUUsage: 1 }, memory: { privateBytes: 1024 } })
    owners.set(id, [{ isMain: true, view: { page: 'chatgpt', id, contents } }])
    targets.set(contents, { blockReason: () => state.reason, apply() {
      state.changes.push(true)
      state.throttled = true
      return () => { state.changes.push(false); state.throttled = false }
    } })
    return state
  }
  return { probe, events, addView, onWrite: callback => { onWrite = callback },
    async consider(tick) { probe.consider(metrics, owners, tick); await setImmediate() } }
}

test('a view that becomes busy during baseline leaves the comparison open for another eligible view', async () => {
  const f = fixture()
  const first = f.addView(1, 10), second = f.addView(2, 8)
  f.onWrite((event, { viewId }) => {
    if (event === 'THROTTLE-TARGET' && viewId === 1) first.reason = 'workspace-work-active'
  })
  f.probe.begin()
  try {
    await f.consider(1)
    const retry = f.events.find(row => row.event === 'THROTTLE-RETRY')
    assert.equal(retry.viewId, 1)
    assert.equal(retry.stage, 'baseline')
    assert.equal(retry.outcome, 'workspace-work-active')
    assert.deepEqual(first.changes, [])
    assert.equal(f.events.some(row => row.event === 'THROTTLE-DONE'), false)

    await f.consider(2)
    const done = f.events.find(row => row.event === 'THROTTLE-DONE')
    assert.equal(done.viewId, 2)
    assert.equal(done.attempt, 2)
    assert.equal(done.frameRateRatio, 0)
    assert.deepEqual(second.changes, [true, false])
  } finally {
    f.probe.stop()
  }
})
