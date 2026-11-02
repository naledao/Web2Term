// User-run only: node --test tests/completion-unread.test.mjs tests/autonomous-task-entry.test.mjs
// Actual main-process unread handlers with synthetic settings/windows; no Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const ast = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const names = ['restoreUnseenCompletedCount', 'setUnseenCompletedCount', 'markSessionViewed', 'recordCompletedTask']
const code = names.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(node, name)
  return node.getText(ast)
}).join('\n')
const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
function fixture(saved = new Map()) {
  const counts = new Map(), snapshots = [], badges = [], warnings = []
  const context = { unseenCompletedTasks: counts, currentSessionId: null,
    managerWindow: { isDestroyed: () => false, isFocused: () => false },
    store: { getSetting: key => saved.get(key) ?? null, setSetting: (key, value) => saved.set(key, value) },
    console: { warn: message => warnings.push(message) },
    refreshTaskbarCount: () => badges.push([...counts.values()].reduce((a, b) => a + b, 0)),
    broadcastManagedSessions: () => snapshots.push(Object.fromEntries(counts)) }
  const actions = new Script(compiled + '\n({ ' + names.join(',') + ' })').runInNewContext(context)
  return { actions, context, counts, saved, snapshots, badges, warnings }
}

test('viewing a chat clears its sidebar and taskbar count durably without clearing other chats', () => {
  const f = fixture()
  f.actions.recordCompletedTask('chat-a')
  f.actions.recordCompletedTask('chat-a')
  f.actions.recordCompletedTask('chat-b')
  assert.equal(f.badges.at(-1), 3)
  f.actions.markSessionViewed('chat-a')
  assert.equal(f.counts.has('chat-a'), false)
  assert.equal(f.counts.get('chat-b'), 1)
  assert.equal(f.badges.at(-1), 1)
  assert.equal(f.saved.get('unseenCompletedCount:chat-a'), '0')
  const restarted = fixture(f.saved)
  restarted.actions.restoreUnseenCompletedCount('chat-a')
  restarted.actions.restoreUnseenCompletedCount('chat-b')
  assert.equal(restarted.counts.has('chat-a'), false)
  assert.equal(restarted.counts.get('chat-b'), 1, 'a genuinely unread completion survives restart')
  restarted.actions.markSessionViewed('chat-b')
  assert.equal(restarted.badges.at(-1), 0)
  const again = fixture(f.saved)
  for (const id of ['chat-a', 'chat-b']) again.actions.restoreUnseenCompletedCount(id)
  assert.equal(again.counts.size, 0)
})

test('new completions still count, while a task completed in the focused conversation does not become unread', () => {
  const f = fixture()
  f.context.currentSessionId = 'chat-a'
  f.context.managerWindow.isFocused = () => true
  f.actions.recordCompletedTask('chat-a')
  assert.equal(f.counts.size, 0)
  f.actions.recordCompletedTask('chat-b')
  assert.equal(f.counts.get('chat-b'), 1)
  f.context.managerWindow.isFocused = () => false
  f.actions.recordCompletedTask('chat-a')
  assert.equal(f.counts.get('chat-a'), 1)
  f.actions.markSessionViewed('chat-a')
  f.actions.recordCompletedTask('chat-a')
  assert.equal(f.counts.get('chat-a'), 1, 'reading an earlier result cannot suppress a later completion')
})

test('missing and corrupt persisted counts cannot recreate phantom unread badges', () => {
  for (const value of [undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    const f = fixture(new Map(value === undefined ? [] : [['unseenCompletedCount:chat-a', value]]))
    f.actions.restoreUnseenCompletedCount('chat-a')
    assert.equal(f.counts.size, 0)
  }
})

test('an unread-state storage failure cannot break task completion or prevent clearing the current badge', () => {
  const f = fixture()
  f.context.store.setSetting = () => { throw new Error('private storage failure') }
  assert.doesNotThrow(() => f.actions.recordCompletedTask('chat-a'))
  assert.equal(f.counts.get('chat-a'), 1)
  assert.doesNotThrow(() => f.actions.markSessionViewed('chat-a'))
  assert.equal(f.counts.size, 0)
  assert.equal(f.warnings.length, 2)
  assert.ok(f.warnings.every(message => !message.includes('private storage failure')))
})
