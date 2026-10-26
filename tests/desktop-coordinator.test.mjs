// User-run only: node --test tests/desktop-coordinator.test.mjs
// Actual coordinator and shell retirement methods, synthetic promises/process events only.
// No Electron, helper, desktop, child process, shell command or network is started.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const exports = {}
new Script(compile(readFileSync(new URL('../src/main/desktop-coordinator.ts', import.meta.url), 'utf8'))).runInNewContext({ exports })
const { DesktopCoordinator } = exports
const tick = () => new Promise(resolve => setImmediate(resolve))
const owner = (taskId = 'goal-a', patch = {}) => ({ sessionId: 'session-a', platformId: 'deepseek', conversationId: 'chat-a', taskId, generation: 1, machineId: 'local-a', ...patch })
function enqueue(coordinator, task = owner(), kind = 'desktop', patch = {}) {
  const controller = new AbortController(), state = { current: true, eligible: true, keep: true, waiting: 0, granted: false }
  const promise = coordinator.acquire({ owner: task, kind, signal: controller.signal,
    current: () => state.current, eligible: () => state.eligible, keep: () => state.keep,
    waiting: () => state.waiting++, ...patch })
  // Attach a rejection handler immediately; individual tests still inspect the original promise.
  promise.then(() => { state.granted = true }, () => {})
  return { promise, controller, state }
}

test('desktop ownership survives model turns and admits dependent commands before foreign tasks', async () => {
  let changes = 0
  const c = new DesktopCoordinator(() => changes++)
  const first = enqueue(c), input = await first.promise
  const foreign = enqueue(c, owner('goal-b')), ownCommand = enqueue(c, owner(), 'command')
  await tick(); assert.equal(ownCommand.state.granted, false); assert.equal(foreign.state.waiting, 1)
  input.release(); const command = await ownCommand.promise
  assert.equal(c.authorizes(command, owner(), 'command'), true)
  assert.equal(foreign.state.granted, false)
  command.release(); await tick()
  assert.equal(c.getState().owner.taskId, 'goal-a', 'a model turn is not a lease release')
  const next = await enqueue(c).promise
  assert.equal(c.authorizes(next, owner(), 'desktop'), true)
  next.release(); first.state.keep = false; c.reconcile()
  const other = await foreign.promise
  assert.equal(c.getState().owner.taskId, 'goal-b'); assert.equal(changes, 3)
  other.release(); c.dispose()
})

test('desktop acquisition waits for earlier commands and forms a barrier against newer commands', async () => {
  const c = new DesktopCoordinator()
  const a = await enqueue(c, owner('command-a'), 'command').promise
  const b = await enqueue(c, owner('command-b'), 'command').promise
  assert.equal(c.getState().executing, 2)
  const desktop = enqueue(c, owner('desktop')), late = enqueue(c, owner('late-command'), 'command')
  a.release(); await tick(); assert.equal(desktop.state.granted, false); assert.equal(late.state.granted, false)
  b.release(); const active = await desktop.promise
  assert.equal(c.getState().executing, 1); assert.equal(late.state.granted, false)
  active.release(); desktop.state.keep = false; c.reconcile()
  const command = await late.promise; command.release(); c.dispose()
})

test('cancelling a queued action never grants it; cancellation of active input drains before handoff', async () => {
  const c = new DesktopCoordinator(), first = enqueue(c), active = await first.promise
  const cancelled = enqueue(c, owner('cancelled'))
  cancelled.controller.abort(); await assert.rejects(cancelled.promise, /cancelled/)
  const next = enqueue(c, owner('next'))
  first.controller.abort(); first.state.keep = false; c.reconcile()
  assert.equal(c.authorizes(active, owner(), 'desktop'), false)
  assert.equal(c.getState().draining, true); assert.equal(c.getState().executing, 1)
  await tick(); assert.equal(next.state.granted, false)
  active.release(); active.release() // idempotent release
  const replacement = await next.promise; replacement.release(); c.dispose()
})

test('paused entries remain pending without polling and resume only after eligibility changes', async () => {
  const c = new DesktopCoordinator()
  let paused = true
  const waiting = enqueue(c, owner(), 'desktop', { eligible: () => !paused })
  const command = await enqueue(c, owner('independent'), 'command').promise
  command.release(); c.reconcile(); await tick()
  assert.equal(waiting.state.granted, false); assert.equal(waiting.state.waiting, 1)
  paused = false; c.reconcile(); const permit = await waiting.promise
  permit.release(); c.dispose()
})

test('helper retirement blocks both input and local commands until confirmed process retirement', async () => {
  const c = new DesktopCoordinator(), first = enqueue(c), active = await first.promise
  c.setNativeBlocked(true); first.state.keep = false; c.reconcile(); active.release()
  const desktop = enqueue(c, owner('next')), command = enqueue(c, owner('new-command'), 'command')
  await tick(); assert.equal(desktop.state.granted, false); assert.equal(command.state.granted, false)
  assert.equal(c.getState().nativeBlocked, true)
  c.setNativeBlocked(false); const replacement = await desktop.promise
  replacement.release(); desktop.state.keep = false; c.reconcile()
  const run = await command.promise; run.release(); c.dispose()
})

test('main-process permit identity cannot be forged, reused after release, or borrowed across scopes', async () => {
  const c = new DesktopCoordinator(), first = enqueue(c), permit = await first.promise
  assert.equal(c.authorizes({ release() {} }, owner(), 'desktop'), false)
  assert.equal(c.authorizes(permit, owner(), 'command'), false)
  for (const patch of [{ sessionId: 'other' }, { platformId: 'other' }, { conversationId: 'other' }, { generation: 2 }, { taskId: 'other' }]) {
    assert.equal(c.authorizes(permit, owner('goal-a', patch), 'desktop'), false)
  }
  const otherMachine = enqueue(c, owner('goal-a', { machineId: 'local-b' }))
  permit.release(); await tick(); assert.equal(otherMachine.state.granted, false)
  assert.equal(c.authorizes(permit, owner(), 'desktop'), false)
  first.state.keep = false; c.reconcile()
  const replacement = await otherMachine.promise; replacement.release(); c.dispose()
})

test('session release cancels pending work but holds an executing command until its executor settles', async () => {
  const c = new DesktopCoordinator(), command = await enqueue(c, owner(), 'command').promise
  const queued = enqueue(c), other = enqueue(c, owner('next', { sessionId: 'session-b' }))
  c.releaseSession('session-a'); await assert.rejects(queued.promise, /cancelled/)
  await tick(); assert.equal(other.state.granted, false)
  command.release(); const next = await other.promise
  next.release(); c.dispose()
  await assert.rejects(enqueue(c).promise, /cancelled/)
})

test('stale queued work is removed, eligible desktop tasks are FIFO, and queue size is bounded', async () => {
  const c = new DesktopCoordinator(), first = enqueue(c), active = await first.promise
  const stale = enqueue(c, owner('stale')), b = enqueue(c, owner('b')), d = enqueue(c, owner('d'))
  stale.state.current = false; c.reconcile(); await assert.rejects(stale.promise, /cancelled/)
  active.release(); first.state.keep = false; c.reconcile()
  const second = await b.promise; assert.equal(d.state.granted, false)
  second.release(); b.state.keep = false; c.reconcile(); const third = await d.promise
  const pending = Array.from({ length: 256 }, (_, n) => enqueue(c, owner(`pending-${n}`)))
  await assert.rejects(enqueue(c, owner('overflow')).promise, /queue-full/)
  c.dispose(); await Promise.all(pending.map(item => assert.rejects(item.promise, /cancelled/)))
  assert.equal(c.getState().executing, 1); third.release(); assert.equal(c.getState().executing, 0)
})

test('local shell early completion does not prove its retired child has closed', async () => {
  const path = '../src/main/shell.ts', source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ConversationShell')
  const body = ['retiring', 'closedChildren', 'whenQuiescent', 'trackRetirement', 'killChild'].map(name => declaration.members.find(node => node.name?.getText(source) === name).getText(source)).join('\n')
  const signals = []
  const Subject = new Script(compile(`class Subject { ${body} }\nSubject`)).runInNewContext({ process: { platform: 'linux', kill: (...args) => signals.push(args) }, console })
  const shell = new Subject(), child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, kill: () => {} })
  shell.kind = 'posix'; shell.killChild(child)
  let retired = false
  const drain = shell.whenQuiescent().then(() => { retired = true })
  await tick(); assert.equal(retired, false)
  child.emit('exit', 0); await tick(); assert.equal(retired, false, 'only close confirms the drain')
  child.emit('close', 0); await drain; assert.equal(retired, true)
})
