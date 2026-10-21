// User-run offline regressions for the real workspace lifecycle functions.
// Run: node --test tests/workspace-empty.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true)
const functions = ['showEmptyWorkspace', 'showWorkspaceManager', 'restoreWorkspaceSelection', 'destroySession']
const code = functions.map(name => {
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(declaration, `${name} exists`)
  return declaration.getText(ast)
}).join('\n')
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fixture(ids = [], current = ids[0] ?? null) {
  const disposed = []
  const snapshots = []
  const persisted = []
  const selected = []
  const removed = []
  let splashCloses = 0
  let shown = 0
  const runtimes = new Map(ids.map(id => [id, { web2term: null, dispose() { disposed.push(id) }, setActive() {} }]))
  const context = {
    runtimes, currentSessionId: current, workspaceOpenSshDialog: true,
    managerWindow: { isDestroyed: () => false, isMinimized: () => false, show() { shown++ }, focus() {}, restore() {} },
    nacosViews: new Map(), pendingQuestionsBySession: new Map(), web2termConnection: null,
    splashWindow: null, splashClosing: false,
    store: { removeManagedSession(id) { removed.push(id) }, setSetting() {} },
    persistWorkspaceState() { persisted.push({ id: context.currentSessionId, sshDialog: context.workspaceOpenSshDialog }) },
    broadcastWorkspaceState() { snapshots.push({ id: context.currentSessionId, sshDialog: context.workspaceOpenSshDialog }) },
    closeSplashWindow() { splashCloses++ }, showManagerWhenReady() {}, markSessionViewed() {}, refreshTaskbarCount() {},
    broadcastManagedSessions() {}, broadcastSshTransfers() {},
    createSession() { throw new Error('An implicit chat must never be created') },
    disconnectUnusedWeb2term() { throw new Error('Unexpected remote disconnect') },
    selectSession(id, sshDialog = false) { selected.push(id); context.currentSessionId = id; context.workspaceOpenSshDialog = sshDialog; return true }
  }
  const actions = new Script(`${compiled}\n({ showEmptyWorkspace, showWorkspaceManager, restoreWorkspaceSelection, destroySession })`).runInNewContext(context)
  return { actions, context, runtimes, disposed, snapshots, persisted, selected, removed, get splashCloses() { return splashCloses }, get shown() { return shown } }
}

test('deleting the last chat disposes it and persists/broadcasts an empty workspace without a replacement', () => {
  const app = fixture(['last'])
  assert.equal(app.actions.destroySession('last'), true)
  assert.equal(app.runtimes.size, 0)
  assert.equal(app.context.currentSessionId, null)
  assert.deepEqual(app.disposed, ['last'])
  assert.deepEqual(app.removed, ['last'])
  assert.deepEqual(app.persisted, [{ id: null, sshDialog: false }])
  assert.deepEqual(app.snapshots, [{ id: null, sshDialog: false }])
  assert.deepEqual(app.selected, [])
})

test('restoring zero chats, including a stale last selection, stays empty and releases the splash', () => {
  for (const savedId of ['', 'deleted-chat']) {
    const app = fixture()
    app.actions.restoreWorkspaceSelection(savedId, true)
    assert.equal(app.runtimes.size, 0)
    assert.equal(app.context.currentSessionId, null)
    assert.equal(app.context.workspaceOpenSshDialog, false)
    assert.equal(app.splashCloses, 1)
    assert.deepEqual(app.persisted, [{ id: null, sshDialog: false }])
  }
})

test('showing an empty workspace does not create a chat', () => {
  const app = fixture()
  assert.equal(app.actions.showWorkspaceManager(), true)
  assert.equal(app.runtimes.size, 0)
  assert.equal(app.shown, 1)
})

test('deleting an active chat selects an existing chat when one remains', () => {
  const app = fixture(['first', 'second'])
  assert.equal(app.actions.destroySession('first'), true)
  assert.deepEqual(app.selected, ['second'])
  assert.equal(app.context.currentSessionId, 'second')
  assert.equal(app.snapshots.length, 0)
})

test('deleting a background chat does not change the active chat', () => {
  const app = fixture(['active', 'background'])
  assert.equal(app.actions.destroySession('background'), true)
  assert.equal(app.context.currentSessionId, 'active')
  assert.deepEqual(app.selected, [])
  assert.deepEqual(app.snapshots, [])
})

test('startup restores an existing selection and SSH dialog, or falls back to an existing chat', () => {
  const app = fixture(['first', 'saved'])
  app.actions.restoreWorkspaceSelection('saved', true)
  assert.equal(app.context.currentSessionId, 'saved')
  assert.equal(app.context.workspaceOpenSshDialog, true)
  app.actions.restoreWorkspaceSelection('missing', false)
  assert.equal(app.context.currentSessionId, 'first')
  assert.equal(app.splashCloses, 0)
})
