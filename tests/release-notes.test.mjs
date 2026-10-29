// User-run only: node --test tests/release-notes.test.mjs
// Mocked fetch and renderer callbacks; no Electron, UI automation, or live backend.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText).runInNewContext({ exports, Buffer, AbortSignal, URL, fetch, require: name => dependencies[name] ?? {} })
  return exports
}
const urls = load('../src/shared/backend-url.ts')
const { ReleaseNotesService } = load('../src/main/release-notes.ts', { '../shared/backend-url': urls })
const MACHINE = 'f15f800e-0123-4123-8123-123456789abc'
const BASE = 'https://example.invalid/backend'
const SOURCE = `0:${BASE}`
const note = (id = '1', read = false) => ({ id, version: '0.1.190', title: '更新说明', publishedAt: 1793145600000, isRead: read, readAt: read ? 1793145600010 : null })
const page = (items = [note()], unreadCount = 1) => ({ items, total: items.length, unreadCount, limit: 20, offset: 0 })
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(request) {
  const state = { backendUrl: BASE, machineId: MACHINE.toUpperCase() }
  return { state, service: new ReleaseNotesService(() => state, request) }
}

test('public API preserves proxy prefix, omits credentials, and marks only on explicit read', async () => {
  const calls = []
  const { service } = fixture(async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.Authorization, undefined)
    if (calls.length === 1) return response(page([{ ...note(), id: 1 }]))
    if (calls.length === 2) return response({ ...note(), id: 1, contentHtml: '<p>更新正文</p>' })
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), { machineId: MACHINE })
    return response({ id: 1, machineId: MACHINE, isRead: true, readAt: 1793145600010 })
  })
  const list = await service.list()
  assert.equal(list.ok, true)
  assert.equal(list.value.items[0].id, '1')
  assert.equal(calls[0].url, `${BASE}/api/v1/release-notes?machineId=${MACHINE}&limit=20&offset=0`)
  const detail = await service.detail({ id: '1', source: list.source })
  assert.equal(detail.value.contentHtml, '<p>更新正文</p>')
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.options.method === 'GET'))
  const read = await service.markRead({ id: '1', source: list.source })
  assert.equal(read.ok, true)
  assert.equal(calls[2].url, `${BASE}/api/v1/release-notes/1/read`)
  assert.equal(calls[2].options.method, 'POST')
})

test('empty settings, invalid pagination, IDs and stale sources do not make requests', async () => {
  let calls = 0
  const { service, state } = fixture(async () => { calls++; throw new Error('unexpected request') })
  for (const input of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }]) assert.equal((await service.list(input)).ok, false)
  for (const id of ['../1', '0', '01', '9223372036854775808']) assert.equal((await service.detail({ id, source: SOURCE })).ok, false)
  assert.equal((await service.markRead({ id: '1', source: 'old-backend' })).ok, false)
  state.backendUrl = ''
  assert.equal((await service.list()).ok, false)
  state.backendUrl = BASE; state.machineId = ''
  assert.equal((await service.list()).ok, false)
  assert.equal(calls, 0)
})

test('redirect and server error bodies are not exposed or followed', async () => {
  for (const status of [302, 404, 429, 500]) {
    let count = 0
    const { service } = fixture(async () => { count++; return new Response('private upstream body', { status, headers: { Location: 'https://other.invalid' } }) })
    const result = await service.list()
    assert.equal(result.ok, false)
    assert.ok(!result.message.includes('private upstream body'))
    assert.equal(count, 1)
  }
  const { service } = fixture(async () => { throw new Error('private transport detail') })
  assert.ok(!(await service.list()).message.includes('private transport detail'))
})

test('response validation rejects invalid timestamps, unsafe numeric IDs, malformed HTML and oversized bodies', async () => {
  for (const bad of [{ ...note(), publishedAt: 9007199254740991 }, { ...note(), id: 9007199254740992 }, { ...note(), isRead: true }, { ...note(), readAt: 'yesterday' }]) {
    const { service } = fixture(async () => response(page([bad])))
    assert.equal((await service.list()).ok, false)
  }
  for (const contentHtml of [null, '中'.repeat(400000)]) {
    const { service } = fixture(async () => response({ ...note(), contentHtml }))
    assert.equal((await service.detail({ id: '1', source: SOURCE })).ok, false)
  }
  const { service } = fixture(async () => new Response(' '.repeat(8 * 1024 * 1024 + 1)))
  assert.equal((await service.list()).ok, false)
})

test('a backend switch aborts pending requests and rejects old content even if a transport ignores abort', async () => {
  let resolve, signal
  const { service, state } = fixture(async (_url, options) => {
    signal = options.signal
    return new Promise(done => { resolve = done })
  })
  const pending = service.list()
  state.backendUrl = 'https://new.invalid'
  service.invalidate()
  assert.equal(signal.aborted, true)
  resolve(response(page()))
  assert.equal((await pending).ok, false)
  assert.equal((await service.detail({ id: '1', source: SOURCE })).ok, false)
})

const rendererPath = '../src/renderer/src/components/ReleaseNotes.tsx'
const rendererFile = ts.createSourceFile(rendererPath, readFileSync(new URL(rendererPath, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual(name, context) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(rendererFile) === name) return node.initializer
    return ts.forEachChild(node, find)
  }
  const initializer = find(rendererFile)
  assert.ok(initializer, name)
  return new Script(ts.transpileModule('(' + initializer.getText(rendererFile) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context)
}
function renderer(api) {
  const ctx = createContext({
    alive: { current: true }, visible: { current: true }, epoch: { current: 0 }, listRequest: { current: 0 }, detailRequest: { current: 0 },
    readAttempts: { current: new Set() }, inFlightReads: { current: new Set() }, confirmedReads: { current: new Map() }, readRevision: { current: 0 },
    catalog: { items: [note()], total: 1, offset: 1, source: SOURCE }, detail: { note: { ...note(), contentHtml: '<p>内容</p>' }, source: SOURCE },
    readError: null, reading: null, badgeRefreshes: 0,
    window: { api }, useCallback: fn => fn,
    EMPTY: { items: [], total: 0, offset: 0, source: '' }, select() {},
    refreshBadge() { ctx.badgeRefreshes++; return Promise.resolve() },
    setUnread() {}, setLoading() {}, setListError() {}, setSelected() {}, setDetailError() {}, setDetailLoading() {}, setFrameError() {},
    setReading(value) { ctx.reading = typeof value === 'function' ? value(ctx.reading) : value },
    setReadError(value) { ctx.readError = value },
    setDetail(value) { ctx.detail = typeof value === 'function' ? value(ctx.detail) : value },
    setCatalog(value) { ctx.catalog = typeof value === 'function' ? value(ctx.catalog) : value }
  })
  ctx.compareReleaseNotes = actual('compareReleaseNotes', ctx)
  return { ctx, markRead: actual('markRead', ctx), loadPage: actual('loadPage', ctx), selectNote: actual('select', ctx) }
}

test('loading a catalog does not mark a note; displaying it saves once and retains unread state on failure until retry', async () => {
  let writes = 0
  const f = renderer({
    async listReleaseNotes() { return { ok: true, source: SOURCE, value: page() } },
    async markReleaseNoteRead() { writes++; return writes === 1 ? { ok: false, source: SOURCE, message: '保存失败' } : { ok: true, source: SOURCE, value: { id: '1', readAt: 1793145600010 } } }
  })
  await f.loadPage({ offset: 0, source: SOURCE })
  assert.equal(writes, 0)
  const target = f.ctx.detail
  await f.markRead(target)
  assert.equal(f.ctx.catalog.items[0].isRead, false)
  assert.equal(f.ctx.readError.message, '保存失败')
  await f.markRead(target)
  assert.equal(writes, 1)
  await f.markRead(target, true)
  assert.equal(writes, 2)
  assert.equal(f.ctx.catalog.items[0].isRead, true)
  assert.equal(f.ctx.detail.note.isRead, true)
  assert.equal(f.ctx.badgeRefreshes, 1)
})

test('late list data cannot undo a confirmed read and late read cannot replace a newly selected detail', async () => {
  let resolveList
  const f = renderer({
    listReleaseNotes: () => new Promise(resolve => { resolveList = resolve }),
    async markReleaseNoteRead() { return { ok: true, source: SOURCE, value: { id: '1', readAt: 1793145600010 } } }
  })
  const target = f.ctx.detail
  const pending = f.loadPage({ offset: 0, source: SOURCE })
  f.ctx.detail = { note: { ...note('2'), contentHtml: '<p>另一个版本</p>' }, source: SOURCE }
  await f.markRead(target)
  assert.equal(f.ctx.detail.note.id, '2')
  resolveList({ ok: true, source: SOURCE, value: page() })
  await pending
  assert.equal(f.ctx.catalog.items[0].isRead, true)
  assert.equal(f.ctx.catalog.items[0].readAt, 1793145600010)
})

test('reselecting a version after a failed read allows a fresh display attempt without duplicating an in-flight write', async () => {
  let writes = 0, finishRead
  const f = renderer({
    async getReleaseNote() { return { ok: true, source: SOURCE, value: { ...note(), contentHtml: '<p>内容</p>' } } },
    markReleaseNoteRead() {
      writes++
      return writes === 1 ? Promise.resolve({ ok: false, source: SOURCE, message: '保存失败' }) : new Promise(resolve => { finishRead = resolve })
    }
  })
  await f.markRead(f.ctx.detail)
  await f.selectNote(note(), SOURCE)
  assert.equal(writes, 1)
  const pending = f.markRead(f.ctx.detail)
  await f.markRead(f.ctx.detail, true)
  assert.equal(writes, 2)
  finishRead({ ok: true, source: SOURCE, value: { id: '1', readAt: 1793145600010 } })
  await pending
  assert.equal(f.ctx.detail.note.isRead, true)
})

test('already-read, closed and invalidated views never apply a read result', async () => {
  let resolveRead, writes = 0
  const f = renderer({ markReleaseNoteRead: () => { writes++; return new Promise(resolve => { resolveRead = resolve }) } })
  const original = plain(f.ctx.catalog)
  await f.markRead({ ...f.ctx.detail, note: { ...f.ctx.detail.note, isRead: true } })
  f.ctx.visible.current = false
  await f.markRead(f.ctx.detail)
  assert.equal(writes, 0)
  f.ctx.visible.current = true
  const pending = f.markRead(f.ctx.detail)
  f.ctx.epoch.current++
  resolveRead({ ok: true, source: SOURCE, value: { id: '1', readAt: 1793145600010 } })
  await pending
  assert.deepEqual(plain(f.ctx.catalog), original)
  assert.equal(f.ctx.badgeRefreshes, 0)
})

test('release-note IPC rejects embedded frames and other windows before dispatch', async () => {
  const path = '../src/main/index.ts'
  const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  let guard
  const callbacks = []
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'isManagerEvent') guard = node
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'ipcMain.handle' &&
      ['IpcChannels.releaseNotesList', 'IpcChannels.releaseNotesDetail', 'IpcChannels.releaseNotesRead'].includes(node.arguments[0]?.getText(file))) callbacks.push(node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(guard)
  assert.equal(callbacks.length, 3)
  const mainFrame = {}, webContents = { mainFrame }, otherFrame = {}
  let dispatched = 0
  const context = createContext({ managerWindow: { isDestroyed: () => false, webContents }, deniedReleaseNotes: { ok: false },
    releaseNotes: { list() { dispatched++; return { ok: true } }, detail() { dispatched++; return { ok: true } }, markRead() { dispatched++; return { ok: true } } } })
  const evaluate = source => new Script(ts.transpileModule('(' + source + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context)
  context.isManagerEvent = evaluate(guard.getText(file))
  for (const node of callbacks) {
    const callback = evaluate(node.getText(file))
    assert.equal((await callback({ sender: webContents, senderFrame: otherFrame }, {})).ok, false)
    assert.equal((await callback({ sender: { mainFrame }, senderFrame: mainFrame }, {})).ok, false)
    assert.equal((await callback({ sender: webContents, senderFrame: mainFrame }, {})).ok, true)
  }
  assert.equal(dispatched, 3)
})
