// User-run offline regressions: node --test tests/side-chat-create.test.mjs
// Uses the renderer's actual callback with fake IPC and state; no Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App')
const declaration = component.body.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find(node => node.name.getText(source) === 'createSideChat')
assert.ok(declaration, 'sidebar creation callback exists')
const compiled = ts.transpileModule('const action = ' + declaration.initializer.arguments[0].getText(source) + '; action', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText

function fixture() {
  const refs = {
    questionChatKnownId: { current: 'old-chat' }, questionChatDismissedId: { current: '' },
    questionChatCreatingRef: { current: false }, questionChatRequest: { current: 1 }
  }
  const state = { chat: { id: 'old-chat', selectedText: 'old selection', contextPath: '/old-context.md' }, open: false,
    creating: false, error: '', tab: 'terminal', width: 407 }
  const calls = [], pending = []
  const setChat = value => { state.chat = typeof value === 'function' ? value(state.chat) : value }
  const action = new Script(compiled).runInNewContext({
    ...refs, sessionId: 'session-a', platformId: 'deepseek', supportsSelectionQuestion: id => id === 'deepseek',
    setQuestionChat: setChat, setQuestionChatCreating: value => { state.creating = value },
    setQuestionChatCreateError: value => { state.error = value }, setQuestionChatOpen: value => { state.open = value },
    setPanelTab: value => { state.tab = value }, setSshPickerOpen() {},
    window: { api: { createQuestionChat(sessionId, platformId) {
      calls.push({ sessionId, platformId })
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    } } }
  })
  return { action, refs, state, calls, pending, push(chat) { refs.questionChatKnownId.current = chat.id; state.chat = chat } }
}
const fresh = (id = 'fresh-chat') => ({ id, platformId: 'deepseek', selectedText: '', contextPath: '', status: 'opening', error: false })

test('each menu action requests a new blank instance and keeps the selected sidebar width', async () => {
  const f = fixture()
  const first = f.action()
  assert.equal(f.state.chat, null, 'old content is hidden while the new instance is created')
  assert.equal(f.state.tab, 'question')
  assert.equal(f.refs.questionChatDismissedId.current, 'old-chat')
  f.pending[0].resolve(fresh())
  await first
  assert.equal(f.state.chat.id, 'fresh-chat')
  const second = f.action()
  f.pending[1].resolve(fresh('another-chat'))
  await second
  assert.equal(f.calls.length, 2)
  assert.equal(f.state.chat.id, 'another-chat')
  assert.equal(f.state.chat.contextPath, '')
  assert.equal(f.state.width, 407)
})

test('rapid repeated clicks cannot create overlapping sidebar instances', async () => {
  const f = fixture()
  const first = f.action()
  await f.action()
  assert.equal(f.calls.length, 1)
  f.pending[0].resolve(fresh())
  await first
  assert.equal(f.state.creating, false)
})

test('a late create result after a session/platform switch does not restore the previous chat', async () => {
  const f = fixture()
  const request = f.action()
  f.refs.questionChatRequest.current++
  f.refs.questionChatCreatingRef.current = false
  f.state.creating = false
  f.state.open = false
  f.state.tab = 'control'
  f.pending[0].resolve(fresh())
  await request
  assert.equal(f.state.chat, null)
  assert.equal(f.state.open, false)
  assert.equal(f.state.tab, 'control')
})

test('the IPC snapshot cannot overwrite a newer ready state from the same new instance', async () => {
  const f = fixture()
  const request = f.action()
  f.push({ ...fresh(), status: '' })
  f.pending[0].resolve(fresh())
  await request
  assert.equal(f.state.chat.status, '')
})

test('a newer selection chat is not replaced by an older blank-create response', async () => {
  const f = fixture()
  const request = f.action()
  f.push({ ...fresh('new-selection'), selectedText: 'new selection', contextPath: '/new-context.md' })
  f.pending[0].resolve(fresh())
  await request
  assert.equal(f.state.chat.id, 'new-selection')
  assert.equal(f.state.chat.contextPath, '/new-context.md')
})

test('creation failure shows an error without falling back to old chat content', async () => {
  const f = fixture()
  const request = f.action()
  f.pending[0].resolve(null)
  await request
  assert.equal(f.state.chat, null)
  assert.ok(f.state.error.length > 0)
  assert.equal(f.state.creating, false)
})
