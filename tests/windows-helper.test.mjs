import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run: node --test tests/windows-helper.test.mjs
// Real manager + synthetic child pipes/clock. Never launches a process, Electron, or desktop action.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(file, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(file, import.meta.url), 'utf8'))).runInNewContext({
    exports, Buffer, TextDecoder, structuredClone, process: { platform: 'win32', arch: 'x64', pid: 1234 },
    require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] }
  })
  return exports
}
const forbidden = () => { throw new Error('Real IO is forbidden') }
const shared = load('../src/shared/windows-helper.ts')
const version = shared.WINDOWS_HELPER_PROTOCOL_VERSION
const { WindowsHelperManager, HUMAN_TAKEOVER_STRIKES, desktopActivityRequestsTakeover } = load('../src/main/windows-helper.ts', {
  'node:child_process': { spawn: forbidden }, 'node:fs/promises': { stat: forbidden },
  'node:path': path, 'node:crypto': { randomUUID }, '../shared/windows-helper': shared
})
const flush = async () => { for (let count = 0; count < 16; count++) await Promise.resolve() }
class Clock {
  time = 0
  sequence = 0
  events = new Map()
  schedule = (callback, delay) => {
    const id = ++this.sequence
    this.events.set(id, { at: this.time + delay, callback })
    return () => this.events.delete(id)
  }
  advance(delay) {
    const end = this.time + delay
    for (;;) {
      const due = [...this.events.entries()].filter(([, event]) => event.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.events.delete(due[0]); this.time = due[1].at; due[1].callback()
    }
    this.time = end
  }
}
class Child extends EventEmitter {
  constructor(pid) {
    super(); this.pid = pid; this.frames = []; this.kills = []; this.ended = false
    this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.stdin = new EventEmitter()
    this.stdin.write = (text, callback) => { this.frames.push(JSON.parse(text)); callback?.(null); return true }
    this.stdin.end = () => { this.ended = true }
  }
  kill(signal) { this.kills.push(signal); this.close(); return true }
  close() { this.emit('exit', 0); this.emit('close', 0) }
  reply(value) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')) }
  last(type) { return this.frames.filter(frame => frame.type === type).at(-1) }
}
function fixture(patch = {}) {
  const clock = new Clock(); const children = []; const starts = []
  const manager = new WindowsHelperManager({ executablePath: path.resolve('synthetic-helper.exe'),
    platform: 'win32', arch: 'x64', exists: async () => true, now: () => clock.time, schedule: clock.schedule,
    spawn: (file, args, options) => {
      starts.push({ file, args, options })
      const child = new Child(9000 + children.length); children.push(child); return child
    }, ...patch })
  const ready = (child = children.at(-1), actions = [], override = {}) => {
    const hello = child.last('hello')
    child.reply({ type: 'ready', version, id: hello.id, nonce: hello.nonce, pid: child.pid, arch: 'x64', apartment: 'MTA', elevated: false, actions, ...override })
  }
  const start = async (actions = []) => {
    manager.setDemand('session-A', true); await flush(); ready(children.at(-1), actions); await flush()
    assert.equal(manager.getState().phase, 'ready')
    return children.at(-1)
  }
  const response = (child, patch = {}) => {
    const request = child.last('request')
    child.reply({ type: 'result', version, id: request.id, epoch: request.epoch, ok: true, execution: 'executed', code: 'ok', message: 'synthetic', ...patch })
  }
  return { manager, clock, children, starts, ready, start, response }
}

const desktopOwner = { sessionId: 'session-A', platformId: 'deepseek', conversationId: 'chat-A', taskId: 'goal-A', generation: 1, machineId: 'local' }
const activity = (child, kind, patch = {}) => child.reply({ type: 'desktop_activity', version,
  epoch: child.last('watch_desktop').epoch, watch_id: child.last('watch_desktop').watch_id, kind,
  input: ['human-stop', 'escape-pressed'].includes(kind) ? 'keyboard' : ['human-input', 'external-input'].includes(kind) ? 'click' : null, ...patch })

test('activity carries only its input category; a missing or invented category is rejected', async () => {
  for (const [kind, input, accepted] of [['human-input', 'wheel', true], ['human-input', 'keyboard', true], ['human-input', null, false],
    ['human-input', 'KeyA', false], ['focus-changed', 'click', false], ['monitor-unavailable', null, true],
    ['escape-pressed', 'keyboard', true], ['human-stop', 'keyboard', true], ['human-stop', 'click', false],
    ['human-stop', null, false], ['escape-pressed', 'wheel', false]]) {
    const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
    f.manager.subscribeDesktopActivity(event => events.push(event))
    const child = await f.start()
    activity(child, kind, { input })
    assert.equal(events.length, accepted ? 1 : 0, `${kind} / ${input}`)
    if (accepted) assert.equal(events[0].input, input)
    else assert.equal(f.manager.getState().code, 'invalid_frame')
    f.manager.dispose()
  }
})

test('desktop watch is private, scoped to the real owner, and precedes the first action', async () => {
  const f = fixture(), events = []
  f.manager.setDesktopOwner(desktopOwner); f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(['observe'])
  const pending = f.manager.request('observe', {}); await flush()
  const watch = child.last('watch_desktop'), request = child.last('request')
  assert.equal(request.watch_id, watch.watch_id)
  assert.ok(child.frames.indexOf(watch) < child.frames.indexOf(request))
  activity(child, 'focus-changed')
  assert.equal(events[0].kind, 'focus-changed'); assert.deepEqual(JSON.parse(JSON.stringify(events[0].owner)), desktopOwner)
  assert.equal(child.last('cancel'), undefined); assert.equal(f.manager.getState().phase, 'ready')
  f.response(child); assert.equal((await pending).execution, 'executed'); f.manager.dispose()
})

test('human activity cancels without replay and retains a final actual receipt before retirement', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(['type_text']), pending = f.manager.request('type_text', {}); await flush()
  activity(child, 'human-input')
  assert.equal(events[0].kind, 'human-input'); assert.equal(events[0].input, 'click'); assert.equal(f.manager.getState().phase, 'stopping')
  assert.equal(child.last('cancel').id, child.last('request').id)
  assert.equal((await f.manager.request('type_text', {})).execution, 'not_executed')
  f.response(child, { ok: false, code: 'human_takeover', execution: 'executed', message: 'Actual partial effect' })
  assert.equal((await pending).execution, 'executed')
  assert.equal(child.frames.filter(frame => frame.type === 'request').length, 1)
  f.manager.dispose()
})

test('the first physical Escape leaves the active run and request alive without a takeover strike', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(['press_key']), pending = f.manager.request('press_key', {}); await flush()
  activity(child, 'escape-pressed')
  assert.equal(events[0].kind, 'escape-pressed')
  assert.equal(events[0].strike, null)
  assert.equal(desktopActivityRequestsTakeover(events[0]), false)
  assert.equal(f.manager.getState().phase, 'ready')
  assert.equal(child.last('cancel'), undefined)
  assert.equal(child.ended, false)
  f.response(child)
  assert.equal((await pending).execution, 'executed')
  activity(child, 'human-input')
  assert.equal(events[1].strike, 1, 'a single Escape does not consume an ordinary input strike')
  f.manager.dispose()
})

test('a native double-Escape stops the exact watch immediately and retains any accepted input receipt', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(['press_key']), pending = f.manager.request('press_key', {}); await flush()
  activity(child, 'escape-pressed'); activity(child, 'human-stop')
  assert.deepEqual(events.map(event => desktopActivityRequestsTakeover(event)), [false, true])
  assert.equal(events[1].strike, null)
  assert.deepEqual(JSON.parse(JSON.stringify(events[1].owner)), desktopOwner)
  assert.equal(f.manager.getState().phase, 'stopping')
  assert.equal(child.last('cancel').id, child.last('request').id)
  f.response(child, { ok: false, code: 'cancelled', execution: 'executed' })
  const result = await pending
  assert.equal(result.code, 'human_takeover')
  assert.equal(result.execution, 'executed')
  assert.equal(child.frames.filter(frame => frame.type === 'request').length, 1, 'the stopped step is never replayed')
  f.manager.dispose()
})

test('a double-Escape can still stop the task while an interrupted native step is draining', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(['press_key']), pending = f.manager.request('press_key', {}); await flush()
  activity(child, 'external-input')
  assert.equal(f.manager.getState().phase, 'stopping')
  activity(child, 'human-stop')
  assert.equal(desktopActivityRequestsTakeover(events.at(-1)), true)
  f.response(child, { ok: false, code: 'cancelled', execution: 'executed' })
  const result = await pending
  assert.equal(result.code, 'human_takeover')
  assert.equal(result.execution, 'executed')
  f.manager.dispose()
})

// Each strike retires the latched process; the manager restarts it after the bounded delay.
const restarted = async f => { f.clock.advance(500); await flush(); f.clock.advance(2000); await flush(); const child = f.children.at(-1); f.ready(child, ['click']); await flush(); return child }

test('only the third physical input in a row is a takeover; earlier ones interrupt the step with human_input', async () => {
  const f = fixture(), events = [], codes = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  let child = await f.start(['click'])
  for (let strike = 1; strike <= HUMAN_TAKEOVER_STRIKES; strike++) {
    if (strike > 1) child = await restarted(f)
    const pending = f.manager.request('click', {}); await flush()
    activity(child, 'human-input')
    f.response(child, { ok: false, code: 'cancelled', execution: 'executed' })
    const result = await pending
    codes.push(result.code)
    if (strike < HUMAN_TAKEOVER_STRIKES) assert.match(result.message, new RegExp(`第 ${strike}/3 次`))
  }
  assert.deepEqual(events.map(event => [event.kind, event.strike]), [['human-input', 1], ['human-input', 2], ['human-input', 3]])
  assert.deepEqual(events.map(event => desktopActivityRequestsTakeover(event)), [false, false, true])
  assert.deepEqual(codes, ['human_input', 'human_input', 'human_takeover'])
  assert.equal(f.children.length, 3, 'two warnings fit inside the restart budget')
  f.manager.dispose()
})

test('a new goal starts its own strike count, and other sources never count as strikes', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  let child = await f.start()
  activity(child, 'human-input')
  child = await restarted(f)
  f.manager.setDesktopOwner({ ...desktopOwner, taskId: 'goal-B', generation: 2 })
  activity(child, 'human-input')
  assert.deepEqual(events.map(event => event.strike), [1, 1])
  const g = fixture(), others = []; g.manager.setDesktopOwner(desktopOwner)
  g.manager.subscribeDesktopActivity(event => others.push(event))
  activity(await g.start(), 'external-input')
  assert.equal(others[0].strike, null)
  f.manager.dispose(); g.manager.dispose()
})

test('external injection is distinct from human activity; a missing final receipt remains unknown', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(['click']), pending = f.manager.request('click', {}); await flush()
  activity(child, 'external-input'); assert.equal(events[0].kind, 'external-input')
  f.clock.advance(500); assert.equal((await pending).execution, 'unknown')
  f.manager.dispose()
})

test('late activity from a previous watch cannot be attributed to a replacement goal', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(), old = child.last('watch_desktop')
  f.manager.setDesktopOwner({ ...desktopOwner, taskId: 'replacement', generation: 2 })
  activity(child, 'focus-changed', { watch_id: old.watch_id }); assert.equal(events.length, 0)
  activity(child, 'human-input', { watch_id: old.watch_id })
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'external-input'); assert.equal(events[0].owner.taskId, 'replacement')
  assert.equal(child.ended, true, 'the native latch still retires, without pausing the new goal')
  f.manager.dispose()
})

test('a double-Escape from a replaced watch cannot stop the replacement task', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(), old = child.last('watch_desktop')
  f.manager.setDesktopOwner({ ...desktopOwner, taskId: 'replacement', generation: 2 })
  activity(child, 'escape-pressed', { watch_id: old.watch_id })
  assert.equal(events.length, 0)
  activity(child, 'human-stop', { watch_id: old.watch_id })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'external-input')
  assert.equal(desktopActivityRequestsTakeover(events[0]), false)
  assert.equal(events[0].owner.taskId, 'replacement')
  assert.equal(child.ended, true, 'an interrupted old helper still retires')
  f.manager.dispose()
})

test('a matching-watch event with the wrong helper generation is rejected', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start()
  activity(child, 'human-input', { epoch: f.manager.getState().generation + 1 })
  assert.equal(events.length, 0); assert.equal(f.manager.getState().code, 'invalid_frame'); f.manager.dispose()
})

test('monitor failure stops the process without reporting physical human takeover or losing execution facts', async () => {
  const f = fixture(), events = []; f.manager.setDesktopOwner(desktopOwner)
  f.manager.subscribeDesktopActivity(event => events.push(event))
  const child = await f.start(['click']), pending = f.manager.request('click', {}); await flush()
  activity(child, 'monitor-unavailable')
  assert.equal(events[0].kind, 'monitor-unavailable')
  f.response(child, { ok: false, code: 'cancelled', execution: 'executed' })
  const result = await pending
  assert.equal(result.code, 'input_monitor_unavailable'); assert.equal(result.execution, 'executed')
  f.manager.dispose()
})

test('unsupported hosts and absence of demand never start a child', async () => {
  for (const override of [{ platform: 'darwin' }, { platform: 'linux' }, { arch: 'arm64' }]) {
    const f = fixture(override); f.manager.setDemand('session-A', true)
    assert.equal(await f.manager.ensureStarted(), false)
    assert.equal(f.manager.getState().code, 'unsupported_host'); assert.equal(f.children.length, 0)
  }
  const f = fixture(); assert.equal(await f.manager.ensureStarted(), false); assert.equal(f.children.length, 0)
})

test('one shared hidden child, correlated handshake, isolated snapshots, no automatic action registration', async () => {
  const f = fixture()
  f.manager.setDemand('session-A', true); f.manager.setDemand('session-B', true)
  const first = f.manager.ensureStarted(); const second = f.manager.ensureStarted()
  await flush(); assert.equal(f.children.length, 1)
  assert.equal(f.manager.getState().phase, 'starting')
  f.ready(); assert.equal(await first, true); assert.equal(await second, true)
  const invocation = f.starts[0]
  assert.deepEqual([...invocation.args], ['--parent-pid', '1234'])
  assert.equal(invocation.options.windowsHide, true); assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.detached, false)
  assert.deepEqual([...invocation.options.stdio], ['pipe', 'pipe', 'pipe'])
  const state = f.manager.getState(); state.actions.push('fake')
  assert.equal(f.manager.getState().actions.length, 0)
  assert.equal((await f.manager.request('observe', {})).code, 'unknown_action')
  assert.equal(f.children[0].frames.some(frame => frame.type === 'request'), false)
  f.manager.dispose()
})

test('missing executable is an explicit state and does not spin a restart loop', async () => {
  const f = fixture({ exists: async () => false }); f.manager.setDemand('session-A', true); await flush()
  assert.equal(f.manager.getState().code, 'executable_missing'); f.clock.advance(60_000); await flush()
  assert.equal(f.children.length, 0); f.manager.dispose()
})

test('an elevated helper (UAC off, or Web2Term run as administrator) is still accepted', async () => {
  const f = fixture(); f.manager.setDemand('session-A', true); await flush()
  f.ready(f.children[0], ['observe'], { elevated: true }); await flush()
  assert.equal(f.manager.getState().phase, 'ready')
  assert.deepEqual(f.manager.getState().actions, ['observe'])
  f.manager.dispose()
})

test('handshake rejects version, process identity, nonce, architecture, and apartment', async () => {
  for (const patch of [{ version: 1 }, { version: 2 }, { version: version - 1 }, { version: version + 1 }, { pid: 1 }, { nonce: randomUUID() }, { arch: 'arm64' }, { apartment: 'STA' },
    { elevated: 'yes' }, { actions: ['command'] }, { actions: ['observe', 'observe'] }]) {
    const f = fixture(); f.manager.setDemand('session-A', true); await flush()
    f.ready(f.children[0], [], patch); await flush()
    assert.equal(f.manager.getState().phase, 'error', JSON.stringify(patch))
    assert.equal(f.manager.getState().actions.length, 0)
    f.clock.advance(500); assert.equal(f.children[0].kills.length, 1)
    f.clock.advance(60_000); await flush(); assert.equal(f.children.length, 1)
    f.manager.dispose()
  }
})

test('startup timeout terminates the old child before a bounded restart', async () => {
  const f = fixture(); f.manager.setDemand('session-A', true); await flush()
  const waiting = f.manager.ensureStarted()
  f.clock.advance(5000); assert.equal(await waiting, false)
  assert.equal(f.manager.getState().code, 'handshake_timeout')
  f.clock.advance(500); await flush(); assert.equal(f.children[0].kills.length, 1)
  f.clock.advance(500); await flush(); assert.equal(f.children.length, 2)
  f.ready(); assert.equal(await f.manager.ensureStarted(), true)
  f.manager.dispose()
})

test('UTF-8 frames can span arbitrary pipe chunks; malformed/oversized output stops the child', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  const pending = f.manager.request('observe', {}); await flush()
  const request = child.last('request')
  const bytes = Buffer.from(JSON.stringify({ type: 'result', version, id: request.id, epoch: request.epoch,
    ok: true, execution: 'executed', code: 'ok', message: '真实 UTF-8 文字' }) + '\n')
  for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]))
  assert.equal((await pending).message, '真实 UTF-8 文字'); f.manager.dispose()
  for (const bytes of [Buffer.from('{broken}\n'), Buffer.alloc(shared.WINDOWS_HELPER_MAX_FRAME_BYTES + 1, 65), Buffer.from([255, 10])]) {
    const invalid = fixture(); const peer = await invalid.start()
    peer.stdout.emit('data', bytes); assert.equal(invalid.manager.getState().code, 'invalid_frame')
    invalid.manager.dispose()
  }
})

test('registered requests have an internal id and epoch, serialize one action, and preserve literal parameters', async () => {
  const f = fixture(); const child = await f.start(['observe', 'click'])
  const pending = f.manager.request('observe', { text: '文字\n$(literal) `literal`' }); await flush()
  const request = child.last('request')
  assert.equal(request.version, version); assert.equal(request.epoch, f.manager.getState().generation)
  assert.match(request.id, /^[a-f0-9-]{36}$/)
  assert.equal(request.parameters.text, '文字\n$(literal) `literal`')
  assert.equal((await f.manager.request('click', {})).code, 'busy')
  assert.equal(child.frames.filter(frame => frame.type === 'request').length, 1)
  f.response(child, { data: { count: 2 } })
  const result = await pending; assert.equal(result.ok, true); assert.equal(result.data.count, 2)
  f.manager.dispose()
})

test('invalid request size, action, and timeout are rejected before native dispatch', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  assert.equal((await f.manager.request('command', { script: 'anything' })).code, 'invalid_request')
  assert.equal((await f.manager.request('observe', { text: 'x'.repeat(70_000) })).code, 'invalid_request')
  assert.equal((await f.manager.request('observe', {}, { timeoutMs: Infinity })).code, 'invalid_request')
  assert.equal(child.frames.some(frame => frame.type === 'request'), false)
  f.manager.dispose()
})

test('requests bound to a retired helper generation cannot dispatch into its successor', async () => {
  const f = fixture(); const child = await f.start(['list_apps'])
  const result = await f.manager.request('list_apps', {}, { expectedGeneration: f.manager.getState().generation + 1 })
  assert.equal(result.execution, 'not_executed'); assert.equal(child.frames.some(frame => frame.type === 'request'), false)
  f.manager.dispose()
})

test('abort before dispatch starts nothing; in-flight cancel bypasses the action and waits for proof', async () => {
  const cancelled = fixture(); const before = new AbortController(); before.abort()
  assert.equal((await cancelled.manager.request('observe', {}, { signal: before.signal })).execution, 'not_executed')
  assert.equal(cancelled.children.length, 0)
  const f = fixture(); const child = await f.start(['observe'])
  const abort = new AbortController()
  let resolved = false
  const pending = f.manager.request('observe', {}, { signal: abort.signal }).then(value => { resolved = true; return value })
  await flush(); abort.abort()
  const cancel = child.last('cancel'); assert.equal(cancel.id, child.last('request').id)
  child.reply({ ...cancel, type: 'cancelled' }); await flush()
  assert.equal(resolved, false); assert.equal(f.manager.getState().phase, 'ready')
  f.clock.advance(500)
  const result = await pending; assert.equal(result.code, 'cancelled'); assert.equal(result.execution, 'unknown')
  assert.equal(f.manager.getState().phase, 'error')
  f.manager.dispose()
})

test('cancelled action receipt is preserved while its input-latched child retires', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  const abort = new AbortController(); const pending = f.manager.request('observe', {}, { signal: abort.signal })
  await flush(); abort.abort(); const cancel = child.last('cancel')
  f.response(child, { ok: false, execution: 'not_executed', code: 'cancelled' })
  assert.equal((await pending).execution, 'not_executed')
  child.reply({ ...cancel, type: 'cancelled' })
  assert.equal(f.manager.getState().phase, 'error'); assert.equal(child.kills.length, 0)
  f.manager.dispose()
})

test('emergency control bypasses a blocked action; release acknowledgement is separate from actual process exit', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  const pending = f.manager.request('observe', {}); await flush()
  f.manager.emergencyStop()
  const stop = child.last('emergency_stop')
  assert.ok(stop); assert.equal(stop.epoch, child.last('request').epoch)
  assert.equal(f.manager.inputReleaseStatus(), 'pending')
  assert.equal((await f.manager.request('observe', {})).code, 'emergency_stopped')
  child.reply({ ...stop, type: 'emergency_stopped', attempted: 2, released: 2, remaining: 0 })
  assert.equal(f.manager.inputReleaseStatus(), 'released')
  assert.equal((await pending).execution, 'unknown')
  assert.equal(f.manager.resetEmergencyStop(), false)
  f.clock.advance(500); await flush()
  assert.equal(f.manager.getState().pid, null)
  f.clock.advance(10000); await flush()
  assert.equal(f.children.length, 1, 'no automatic restart while latched')
  assert.equal(f.manager.resetEmergencyStop(), true)
  f.manager.dispose()
})

test('emergency without a release acknowledgement retires then kills, and reports unknown cleanup', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  f.manager.emergencyStop()
  f.manager.setDemand('session-A', false)
  await flush()
  assert.equal(child.last('shutdown'), undefined, 'demand churn must not preempt the independent release acknowledgement')
  f.clock.advance(250)
  assert.ok(child.last('shutdown'))
  assert.equal(f.manager.inputReleaseStatus(), 'unconfirmed')
  f.clock.advance(500); await flush()
  assert.equal(child.kills.length, 1)
  assert.equal(f.manager.getState().pid, null)
  f.manager.dispose()
})

test('release failures and malformed acknowledgements never claim keys or buttons were released', async () => {
  for (const reply of [{ attempted: 1, released: 0, remaining: 1 }, { attempted: 1, released: 2, remaining: 0 }]) {
    const f = fixture(); const child = await f.start(['observe'])
    f.manager.emergencyStop()
    child.reply({ ...child.last('emergency_stop'), type: 'emergency_stopped', ...reply })
    assert.notEqual(f.manager.inputReleaseStatus(), 'released')
    f.manager.dispose()
  }
})

test('an emergency during executable lookup prevents a delayed launch and does not restore it on a late promise', async () => {
  let found
  const f = fixture({ exists: () => new Promise(resolve => { found = resolve }) })
  f.manager.setDemand('session-A', true); await flush()
  f.manager.emergencyStop(); found(true); await flush()
  assert.equal(f.children.length, 0)
  assert.equal(await f.manager.ensureStarted(), false)
  assert.equal(f.manager.getState().code, 'emergency_stopped')
  f.manager.dispose()
})

test('a responsive control channel cannot hide a blocked action; timeout is unknown and is never replayed', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  const pending = f.manager.request('observe', {}, { timeoutMs: 4000 }); await flush()
  f.clock.advance(3000); const ping = child.last('ping'); assert.ok(ping)
  child.reply({ type: 'pong', version, id: ping.id })
  f.clock.advance(1000); const result = await pending
  assert.equal(result.code, 'action_timeout'); assert.equal(result.execution, 'unknown')
  f.clock.advance(500); await flush(); f.clock.advance(500); await flush()
  assert.equal(f.children.length, 2)
  f.ready(); await flush()
  // A late response from a retired process must not complete a request in its successor.
  f.response(child)
  assert.equal(f.manager.getState().phase, 'ready')
  assert.equal(f.children[1].frames.some(frame => frame.type === 'request'), false)
  f.manager.dispose()
})

test('missing heartbeat retires a process independently of the action queue', async () => {
  const f = fixture(); const child = await f.start()
  f.clock.advance(3000); assert.ok(child.last('ping'))
  f.clock.advance(2000); assert.equal(f.manager.getState().code, 'heartbeat_timeout')
  assert.ok(child.last('shutdown')); f.manager.dispose()
})

test('crash resolves dispatched work as unknown, changes incarnation, and never replays it', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  const pending = f.manager.request('observe', {}); await flush()
  const generation = f.manager.getState().generation; child.close()
  const result = await pending; assert.equal(result.code, 'process_exited'); assert.equal(result.execution, 'unknown')
  f.clock.advance(1000); await flush(); f.ready(); await flush()
  assert.equal(f.manager.getState().generation, generation + 1)
  assert.equal(f.children[1].frames.some(frame => frame.type === 'request'), false)
  f.manager.dispose()
})

test('wrong result correlation retires the process without borrowing another request owner', async () => {
  for (const patch of [{ id: randomUUID() }, { epoch: 999 }, { ok: true, execution: 'not_executed' }]) {
    const f = fixture(); const child = await f.start(['observe'])
    const pending = f.manager.request('observe', {}); await flush(); f.response(child, patch)
    const result = await pending; assert.equal(result.code, 'invalid_frame'); assert.equal(result.execution, 'unknown')
    f.manager.dispose()
  }
})

test('pipe write failures retire once and do not recurse while trying to shut down', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  child.stdin.write = () => { throw new Error('synthetic broken pipe') }
  const result = await f.manager.request('observe', {})
  assert.equal(result.code, 'pipe_closed'); assert.equal(result.execution, 'unknown')
  f.manager.dispose()
})

test('automatic restarts stop after three launches per minute and keep the concrete error visible', async () => {
  const f = fixture(); f.manager.setDemand('session-A', true); await flush()
  for (let index = 0; index < 3; index++) {
    assert.equal(f.children.length, index + 1)
    f.children[index].close(); await flush()
    f.clock.advance((index + 1) * 1000); await flush()
  }
  f.clock.advance(120_000); await flush(); assert.equal(f.children.length, 3)
  assert.equal(f.manager.getState().code, 'process_exited')
  f.manager.setDemand('session-A', false); f.manager.setDemand('session-A', true); await flush()
  assert.equal(f.children.length, 4)
  f.manager.dispose()
})

test('releasing one owner preserves the process; last release shuts down; reacquisition waits for exit', async () => {
  const f = fixture(); const child = await f.start()
  f.manager.setDemand('session-B', true); f.manager.setDemand('session-A', false)
  assert.equal(child.ended, false)
  f.manager.setDemand('session-B', false); await flush(); assert.equal(child.ended, true)
  f.manager.setDemand('session-C', true); await flush(); assert.equal(f.children.length, 1)
  f.clock.advance(500); await flush(); f.clock.advance(1000); await flush(); assert.equal(f.children.length, 2)
  f.ready(); await flush(); assert.equal(f.manager.getState().phase, 'ready')
  f.manager.dispose(); assert.equal(f.children[1].kills.length, 1)
  f.clock.advance(60_000); await flush(); assert.equal(f.children.length, 2)
  assert.equal(await f.manager.ensureStarted(), false)
})

test('a same-turn session handover preserves the application-wide helper', async () => {
  const f = fixture(); const child = await f.start()
  f.manager.setDemand('session-A', false); f.manager.setDemand('session-B', true)
  await flush(); assert.equal(child.ended, false); assert.equal(f.children.length, 1)
  assert.equal(f.manager.getState().phase, 'ready')
  f.manager.dispose()
})

test('failed termination remains unavailable and does not indefinitely await exit or spawn a concurrent child', async () => {
  const f = fixture(); const child = await f.start(['observe'])
  child.kill = () => false
  f.manager.setDemand('session-A', false); await flush()
  f.clock.advance(500); f.manager.setDemand('session-B', true); await flush()
  assert.equal(await f.manager.ensureStarted(), false)
  assert.equal((await f.manager.request('observe', {})).execution, 'not_executed')
  assert.equal(f.children.length, 1)
  child.close(); f.clock.advance(1000); await flush(); assert.equal(f.children.length, 2)
  f.ready(); await flush(); f.manager.dispose()
})

test('synchronous launch errors also obey the restart budget', async () => {
  let launches = 0
  const f = fixture({ spawn: () => { launches++; throw new Error('synthetic spawn error') } })
  f.manager.setDemand('session-A', true); await flush(); assert.equal(launches, 1)
  f.clock.advance(1000); await flush(); assert.equal(launches, 2)
  f.clock.advance(2000); await flush(); assert.equal(launches, 3)
  f.clock.advance(120_000); await flush(); assert.equal(launches, 3)
  assert.equal(f.manager.getState().code, 'spawn_failed'); f.manager.dispose()
})

const protocol = load('../src/shared/computer-use-protocol.ts')
const capability = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const preferences = { computerUseEnabled: true, desktopControlEnabled: true }
const context = { sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }
const definition = { action: 'observe', description: 'synthetic observer', parameters: [], example: {} }
test('capabilities require both a registered adapter and the same ready helper action', () => {
  const f = fixture()
  const base = f.manager.getState()
  for (const helper of [base, { ...base, phase: 'ready', actions: [] }, { ...base, phase: 'error', actions: ['observe'] }]) {
    const result = capability.resolveComputerUseCapability(preferences, context, [definition], helper)
    assert.equal(result.available, false); assert.equal(result.actions.length, 0)
  }
  const ready = { ...base, phase: 'ready', code: 'ready', message: 'Windows helper 已就绪。', actions: ['observe'] }
  assert.equal(capability.resolveComputerUseCapability(preferences, context, [], ready).available, false)
  assert.equal(capability.resolveComputerUseCapability(preferences, context, [definition], ready).available, true)
  assert.equal(capability.resolveComputerUseCapability(preferences, { ...context, connection: 'ssh' }, [definition], ready).available, false)
})

const runtimeSource = ts.createSourceFile('session-runtime.ts', readFileSync(new URL('../src/main/session-runtime.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const runtimeClass = runtimeSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const methods = ['getComputerUseCapability', 'syncWindowsHelperDemand', 'setActive'].map(name => {
  const method = runtimeClass.members.find(member => member.name?.getText(runtimeSource) === name)
  assert.ok(method, name); return method.getText(runtimeSource)
}).join('\n')
const Runtime = new Script(compile(`class Runtime { ${methods} }; Runtime`)).runInNewContext({
  ...capability, process: { platform: 'win32', arch: 'x64' }
})
test('actual session lifecycle acquires demand only for an active enabled local DeepSeek scope', () => {
  const demands = []; let saved = preferences; let attached = false
  const runtime = Object.assign(new Runtime(), {
    id: 'session-A', activePlatformId: 'deepseek', active: false, disposed: false, web2term: null, remoteShell: null,
    options: { settings: () => saved, windowsHelper: { getState: () => fixture().manager.getState(), setDemand: (owner, enabled) => demands.push({ owner, enabled }) } },
    ssh: { getState: () => ({ attached }) }, computerUseTool: { definitions: () => [] }, applyVisibility() {}, interruptTaskControl() {}
  })
  runtime.setActive(true); assert.equal(demands.at(-1).enabled, true)
  attached = true; runtime.syncWindowsHelperDemand(); assert.equal(demands.at(-1).enabled, false)
  attached = false; runtime.web2term = {}; runtime.syncWindowsHelperDemand(); assert.equal(demands.at(-1).enabled, false)
  runtime.web2term = null; runtime.activePlatformId = 'chatgpt'; runtime.syncWindowsHelperDemand(); assert.equal(demands.at(-1).enabled, false)
  runtime.activePlatformId = 'deepseek'; saved = { ...preferences, desktopControlEnabled: false }
  runtime.syncWindowsHelperDemand(); assert.equal(demands.at(-1).enabled, false)
  saved = preferences; runtime.setActive(false); assert.equal(demands.at(-1).enabled, false)
  runtime.disposed = true; runtime.setActive(true); assert.equal(demands.at(-1).enabled, false)
})
