// User-run only: node --test tests/ai-outbound-queue.test.mjs
// The queue is tested in isolation. No Electron window, browser session, network, or AI page is started.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../src/main/ai-outbound-queue.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function loadQueue() {
  const exports = {}
  new Script(source).runInNewContext({
    exports,
    AbortController,
    Promise,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    structuredClone,
    require(name) {
      if (name === 'node:crypto') return { randomUUID }
      if (name === '../shared/focus-chat') return {}
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  return exports.AiOutboundQueue
}

const owner = { sessionId: 'session-1', platformId: 'chatgpt', conversationId: 'conversation-1' }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function request(overrides = {}) {
  return {
    kind: 'user', owner, text: 'message',
    execute: async () => 'ok', retryable: () => false,
    cancelled: () => 'cancelled', failed: () => 'unknown',
    ...overrides
  }
}

test('sends jobs in FIFO order', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  const order = []
  const first = queue.enqueue(request({ sourceId: 'first', execute: async () => { order.push('first'); return 'ok' } }))
  const second = queue.enqueue(request({ sourceId: 'second', execute: async () => { order.push('second'); return 'ok' } }))
  assert.equal(await first.completion, 'ok')
  assert.equal(await second.completion, 'ok')
  assert.deepEqual(order, ['first', 'second'])
})

test('retries a busy result on the same job before advancing', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  let attempts = 0
  const order = []
  const first = queue.enqueue(request({ retryDelayMs: 1, execute: async () => {
    attempts++
    order.push(`first:${attempts}`)
    return attempts === 1 ? 'busy' : 'ok'
  }, retryable: result => result === 'busy' }))
  const second = queue.enqueue(request({ sourceId: 'second', execute: async () => { order.push('second'); return 'ok' } }))
  assert.equal(await first.completion, 'ok')
  assert.equal(await second.completion, 'ok')
  assert.deepEqual(order, ['first:1', 'first:2', 'second'])
})

test('blocks later jobs when the result is unknown', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  let laterRan = false
  const first = queue.enqueue(request({ execute: async () => 'unknown', blockOnFailure: result => result === 'unknown' }))
  const second = queue.enqueue(request({ sourceId: 'second', execute: async () => { laterRan = true; return 'ok' } }))
  // The caller is answered at once; only the lane waits for the user.
  assert.equal(await first.completion, 'unknown')
  await settle()
  assert.equal(laterRan, false)
  assert.equal(queue.state().blocked?.id, first.item.id)
  assert.equal(queue.isBlocked(first.item.id), true)
  assert.equal(queue.acknowledgeBlocked(first.item.id), true)
  assert.equal(await second.completion, 'ok')
  assert.equal(laterRan, true)
})

test('keeps a blocked message deduplicated until it is skipped, and never re-sends it', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  let attempts = 0
  const make = () => request({ dedupeKey: 'blocked-source', execute: async () => { attempts++; return 'unknown' },
    blockOnFailure: result => result === 'unknown' })
  const first = queue.enqueue(make())
  assert.equal(await first.completion, 'unknown')
  const again = queue.enqueue(make())
  assert.equal(again.item.id, first.item.id, 'the same message cannot be queued again while unverified')
  assert.equal(await again.completion, 'unknown')
  assert.equal(attempts, 1)
  assert.equal(queue.acknowledgeBlocked(first.item.id), true)
  await settle()
  assert.equal(attempts, 1)
  assert.equal(queue.state().blocked, null)
})

test('stops retrying after maxAttempts and returns the last result without blocking', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  let attempts = 0
  const ticket = queue.enqueue(request({ retryDelayMs: 1, maxAttempts: 3, execute: async () => { attempts++; return 'busy' },
    retryable: result => result === 'busy' }))
  const later = queue.enqueue(request({ sourceId: 'later' }))
  assert.equal(await ticket.completion, 'busy')
  assert.equal(attempts, 3)
  assert.equal(await later.completion, 'ok')
  assert.equal(queue.state().blocked, null)
})

test('cancels the active job during its retry wait', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  const ticket = queue.enqueue(request({ retryDelayMs: 50, execute: async () => 'busy', retryable: result => result === 'busy' }))
  await settle()
  assert.equal(queue.cancel(ticket.item.id), true)
  assert.equal(await ticket.completion, 'cancelled')
})

test('binds unassigned jobs only while a send for the new conversation is running', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  const home = { ...owner, conversationId: null }
  let release
  const hold = new Promise(resolve => { release = resolve })
  const first = queue.enqueue(request({ owner: home, execute: async () => { await hold; return 'ok' } }))
  const second = queue.enqueue(request({ owner: home, sourceId: 'second' }))
  await settle()
  queue.bindUnassigned('chatgpt', 'created')
  assert.equal(first.item.owner.conversationId, 'created')
  assert.equal(second.item.owner.conversationId, 'created')
  release()
  await second.completion

  // The running send belongs to an existing chat, so a conversation change is a navigation, not a creation.
  let releaseExisting
  const holdExisting = new Promise(resolve => { releaseExisting = resolve })
  const existing = queue.enqueue(request({ sourceId: 'existing', execute: async () => { await holdExisting; return 'ok' } }))
  const waiting = queue.enqueue(request({ owner: home, sourceId: 'waiting' }))
  await settle()
  queue.bindUnassigned('chatgpt', 'browsed')
  assert.equal(waiting.item.owner.conversationId, null)
  releaseExisting()
  await existing.completion
  await waiting.completion
})

test('cancels a queued job when its external signal aborts', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  let release
  const hold = new Promise(resolve => { release = resolve })
  const active = queue.enqueue(request({ execute: async signal => {
    await hold
    return signal.aborted ? 'cancelled' : 'ok'
  }, cancelled: () => 'cancelled' }))
  const controller = new AbortController()
  const queued = queue.enqueue(request({ sourceId: 'queued', signal: controller.signal, cancelled: () => 'cancelled' }))
  controller.abort()
  assert.equal(await queued.completion, 'cancelled')
  release()
  assert.equal(await active.completion, 'ok')
})

test('deduplicates an active request by dedupe key', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  let executions = 0
  const make = () => request({ dedupeKey: 'same-source', execute: async () => { executions++; return 'ok' } })
  const first = queue.enqueue(make())
  const second = queue.enqueue(make())
  assert.equal(first.item.id, second.item.id)
  assert.equal(await second.completion, 'ok')
  assert.equal(executions, 1)
})

test('disposes queued jobs without sending them', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  let ran = false
  const ticket = queue.enqueue(request({ execute: async () => { ran = true; return 'ok' }, cancelled: () => 'cancelled' }))
  queue.dispose()
  assert.equal(await ticket.completion, 'cancelled')
  assert.equal(ran, false)
})

test('keeps the in-flight result when the caller aborts after a submit attempt', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  const controller = new AbortController()
  let resolveExecution
  const execution = new Promise(resolve => { resolveExecution = resolve })
  const ticket = queue.enqueue(request({ signal: controller.signal,
    execute: async signal => { await execution; return signal.aborted ? 'unknown' : 'ok' },
    cancelled: () => 'cancelled', aborted: result => result ?? 'unknown',
    blockOnFailure: result => result === 'unknown' }))
  await settle()
  controller.abort()
  resolveExecution()
  assert.equal(await ticket.completion, 'unknown')
  await settle()
  assert.equal(queue.state().blocked, null)
})

test('does not turn an aborted retry wait into a blocked queue', async () => {
  const Queue = loadQueue()
  const queue = new Queue()
  const controller = new AbortController()
  let attempts = 0
  const ticket = queue.enqueue(request({ signal: controller.signal, retryDelayMs: 50,
    execute: async () => { attempts++; return 'busy' }, retryable: result => result === 'busy',
    cancelled: () => 'cancelled', aborted: result => result ?? 'cancelled' }))
  await settle()
  controller.abort()
  assert.equal(await ticket.completion, 'busy')
  assert.equal(attempts, 1)
  assert.equal(queue.state().blocked, null)
})
