// User-run only: node --test tests/gemini-usage.test.mjs
// Recorded card shape and mock Electron objects. No application, network or real accounts.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/injected/gemini-usage.js', import.meta.url), 'utf8')
const example = { current: { usedPercent: 11, resetLabel: '22:41' }, weekly: { usedPercent: 1, resetLabel: '12月3日16:41' } }

function moduleAt(path, dependencies = {}, globals = {}) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  runInNewContext(code, { ...globals, exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), name)
    return dependencies[name]
  } })
  return exports
}

function quotaRow(name, used, reset, resetFirst = false) {
  const row = { querySelectorAll: () => [heading, percentage] }
  const node = textContent => ({ textContent, getClientRects: () => [{}], closest: selector => selector === 'li' ? row : null })
  const heading = node(name), percentage = node(used), resetNode = node(reset)
  const text = parentElement => ({ parentElement, nodeValue: parentElement.textContent })
  row.texts = [heading, ...(resetFirst ? [resetNode, percentage] : [percentage, resetNode])].map(text)
  return row
}

function readPage(rows, pathname = '/usage') {
  const main = { querySelectorAll: () => rows.flatMap(row => row.querySelectorAll()), getClientRects: () => [{}], closest: () => null }
  const document = { querySelectorAll: () => [main], createTreeWalker: row => {
    const texts = row.texts.slice()
    return { nextNode: () => texts.shift() }
  } }
  const location = { origin: 'https://gemini.google.com', pathname }
  const result = runInNewContext(source, { document, location, NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ visibility: 'visible' }) })
  return JSON.parse(JSON.stringify(result))
}

test('matches each Chinese usage value and reset time to its own list item', () => {
  const current = quotaRow('当前用量', '已使用 11%', '重置时间：22:41')
  const weekly = quotaRow('每周限额', '已使用 1%', '重置时间：12月3日16:41', true)
  const promotion = quotaRow('用量设置', '已使用 88%', '重置时间：06:00')
  assert.deepEqual(readPage([weekly, promotion, current]), example)
  assert.equal(readPage([current, weekly], '/app'), null)
  assert.equal(readPage([current, promotion]), null)
  assert.equal(readPage([current, weekly, current]), null)
})

test('supports the account usage route, English labels and a limit without a reset time', () => {
  const current = quotaRow('Current usage', '11.5% used', 'Resets at 10:41 PM')
  const weekly = quotaRow('Weekly limit', 'Used 0%', '')
  assert.deepEqual(readPage([current, weekly], '/u/1/usage'), {
    current: { usedPercent: 11.5, resetLabel: '10:41 PM' }, weekly: { usedPercent: 0, resetLabel: null }
  })
})

const shared = moduleAt('../src/shared/gemini-usage.ts')
test('validates the two limits before passing them to the application', () => {
  const result = shared.parseGeminiUsageSnapshot(example, 5)
  assert.equal(result.current.usedPercent, 11)
  assert.equal(result.weekly.resetLabel, '12月3日16:41')
  assert.equal(result.checkedAt, 5)
  for (const usedPercent of [101, -1, '11', Infinity]) {
    assert.equal(shared.parseGeminiUsageSnapshot({ ...example, current: { ...example.current, usedPercent } }, 5), null)
  }
  assert.equal(shared.parseGeminiUsageSnapshot({ ...example, weekly: { ...example.weekly, resetLabel: '<22:41>' } }, 5), null)
})

test('reuses the chat session and coalesces refreshes without leaking a reading across accounts', async () => {
  const starts = [], closed = [], readOnly = []
  let now = 20_000
  class View {
    constructor({ webPreferences: { session } }) {
      const contents = this.webContents = new EventEmitter()
      let url = '', gone = false
      Object.assign(contents, {
        session, setUserAgent() {}, setWindowOpenHandler() {}, isDestroyed: () => gone, getURL: () => url,
        async loadURL(next) {
          starts.push({ session, next })
          url = session.destination ?? next
        },
        async executeJavaScriptInIsolatedWorld() {
          return { ...example, current: { ...example.current, usedPercent: session.usedPercent } }
        },
        close() { gone = true; closed.push(contents) }
      })
    }
    setBounds() {}
  }
  const { readGeminiUsage } = moduleAt('../src/main/gemini-usage.ts', {
    electron: { WebContentsView: View }, 'node:timers/promises': { setTimeout: async () => {} },
    '../shared/gemini-usage': shared, './embed-permissions': { blockGeminiReadOnlyPagePermissions: page => readOnly.push(page) },
    './injected/gemini-usage.js?raw': { default: source }
  }, { URL, Date: { now: () => now }, setTimeout, clearTimeout })

  const account = usedPercent => Object.assign(new EventEmitter(), { usedPercent })
  const first = account(34), second = account(5)
  const page = (session, path = '/app') => ({ session, getURL: () => 'https://gemini.google.com' + path, getUserAgent: () => 'Chrome' })
  const pending = readGeminiUsage(page(first), false)
  assert.equal(readGeminiUsage(page(first), true), pending)
  assert.equal((await pending).snapshot.current.usedPercent, 34)
  assert.equal((await readGeminiUsage(page(second, '/u/1/app'), false)).snapshot.current.usedPercent, 5)
  assert.equal(starts[0].session, first)
  assert.equal(starts[1].next, 'https://gemini.google.com/u/1/usage')
  assert.equal((await readGeminiUsage(page(first), false)).snapshot.current.usedPercent, 34)
  assert.equal(starts.length, 2)

  now += 10_001
  first.destination = 'https://gemini.google.com/app'
  const signedOut = await readGeminiUsage(page(first), true)
  assert.equal(signedOut.outcome, 'redirected')
  assert.equal(signedOut.snapshot, null)
  assert.equal(closed.length, 3)
  assert.deepEqual(readOnly, closed)
  assert.equal(first.listenerCount('will-download'), 0)
  assert.equal(second.listenerCount('will-download'), 0)
})
