// User-run only: node --test tests/long-task-performance.test.mjs
// Actual history reducer, grouping, lazy details and output window. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/focus-chat.ts')
const { mergeFocusChatUpdate, groupFocusExecutions } = load('../src/shared/focus-history.ts', { './focus-chat': shared })
const { outputWindow, OUTPUT_WINDOW_CHARS } = load('../src/shared/output-window.ts')
const owner = { sessionId: 'workspace', platformId: 'chatgpt', conversationId: 'chat' }
const cursor = (turns = 1, executions = '[1]') => ({ ownerKey: shared.focusOwnerKey(owner), turns, executions })
const metadata = () => ({ ...owner, ready: true, nativeDraft: false, generating: 'idle', waiting: false,
  historyCursor: cursor(), smartReplies: [], contextUsage: { requestSourceIds: [] } })

test('unchanged polling never serializes history and preserves references even as page controls change', () => {
  const heavy = { toJSON() { assert.fail('Historical text must not be serialized for snapshot comparison') } }
  const initial = { ...metadata(), turns: [heavy], executions: [heavy], hiddenMessageIds: [] }
  assert.equal(mergeFocusChatUpdate(initial, metadata()), initial)
  const changed = mergeFocusChatUpdate(initial, { ...metadata(), nativeDraft: true })
  assert.equal(changed.nativeDraft, true)
  for (const key of ['turns', 'executions', 'hiddenMessageIds', 'smartReplies', 'contextUsage']) assert.equal(changed[key], initial[key], key)
})

test('changed page controls serialize each metadata object at most once', () => {
  let serialized = 0
  const replies = () => ({ toJSON() { serialized++; return [] } })
  const initial = { ...metadata(), smartReplies: replies(), turns: [], executions: [], hiddenMessageIds: [] }
  const changed = mergeFocusChatUpdate(initial, { ...metadata(), smartReplies: replies(), nativeDraft: true })
  assert.equal(serialized, 2, 'previous and next replies, once each')
  assert.equal(changed.smartReplies, initial.smartReplies)
})

test('changed execution or turn snapshots replace only their own collection, including empty replacements', () => {
  const initial = { ...metadata(), turns: [{ id: 'turn' }], executions: [{ messageId: 'command' }], hiddenMessageIds: [] }
  const executions = [{ messageId: 'command', status: 'done', output: '完整结果' }]
  const changed = mergeFocusChatUpdate(initial, { ...metadata(), historyCursor: cursor(1, '[2]'), executions })
  assert.equal(changed.turns, initial.turns)
  assert.equal(changed.executions, executions)
  const revised = mergeFocusChatUpdate(changed, { ...metadata(), historyCursor: cursor(2, '[3]'), turns: [], executions: [], hiddenMessageIds: ['old'] })
  assert.equal(revised.turns.length, 0)
  assert.equal(revised.executions.length, 0)
  assert.deepEqual(Array.from(revised.hiddenMessageIds), ['old'])
})

test('omitted collections cannot initialize a transcript or cross a conversation boundary', () => {
  assert.equal(mergeFocusChatUpdate(null, metadata()), null)
  const initial = { ...metadata(), turns: [{ id: 'private-turn' }], executions: [] }
  assert.equal(mergeFocusChatUpdate(initial, { ...metadata(), conversationId: 'other' }), null)
  const next = mergeFocusChatUpdate(initial, { ...metadata(), conversationId: 'other', historyCursor: undefined, turns: [], executions: [] })
  assert.equal(next.conversationId, 'other')
  assert.equal(next.turns.length, 0)
})

test('thousands of process steps take one execution lookup each and preserve order and legacy unassigned steps', () => {
  const count = 5000, ids = Array.from({ length: count }, (_, index) => 'command-' + index)
  const turn = { segments: ids.map((_, cycle) => ({ cycle })), executionIds: [...ids, 'legacy', 'missing'],
    executionCycles: Object.fromEntries(ids.map((id, cycle) => [id, cycle])) }
  const rows = new Map([...ids, 'legacy'].map(messageId => [messageId, { messageId }]))
  let lookups = 0
  const result = groupFocusExecutions(turn, { get(id) { lookups++; return rows.get(id) } })
  assert.equal(lookups, count + 2)
  assert.equal(result.executions.length, count + 1)
  assert.equal(result.byCycle.size, count)
  for (let index = 0; index < count; index++) assert.equal(result.byCycle.get(index)[0].messageId, ids[index])
  assert.deepEqual(Array.from(result.unassigned, row => row.messageId), ['legacy'])
})

test('long output stays bounded initially, expands without losing text, and never splits surrogate pairs', () => {
  for (const text of ['', 'short\n完整输出', 'prefix'.repeat(10000) + '\n尾部']) {
    const preview = outputWindow(text)
    assert.ok(preview.text.length <= OUTPUT_WINDOW_CHARS + 1)
    assert.equal(text.slice(0, preview.start) + preview.text, text)
    assert.equal(outputWindow(text, 0).text, text)
  }
  const text = 'start😀' + 'x'.repeat(OUTPUT_WINDOW_CHARS - 1)
  const preview = outputWindow(text)
  assert.ok(preview.text.startsWith('😀'))
  assert.equal(text.slice(0, preview.start) + preview.text, text)
  const expanded = outputWindow(text + '\nnew output', preview.start)
  assert.equal(expanded.start, preview.start, 'explicitly expanded text remains anchored as output appends')
})

test('closed process details do not evaluate their body and remember open/closed choices after remount', () => {
  const source = readFileSync(new URL('../src/renderer/src/components/FocusChatView.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('focus.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'FocusDetails')
  assert.ok(declaration)
  let value, bodyReads = 0
  const exports = {}, states = new Map()
  new Script(ts.transpileModule('export ' + declaration.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: 'details.tsx'
  }).outputText).runInNewContext({ exports, require: createRequire(import.meta.url), detailStates: states,
    useState(initial) { if (value === undefined) value = initial(); return [value, next => { value = next }] } })
  const props = { ownerKey: 'owner', stateKey: 'output', summary: '查看输出', children() { bodyReads++; return '完整输出' } }
  let tree = exports.FocusDetails(props)
  assert.equal(bodyReads, 0)
  const event = { open: true }
  tree.props.onToggle({ target: event, currentTarget: event })
  tree = exports.FocusDetails(props)
  assert.equal(bodyReads, 1)
  event.open = false
  tree.props.onToggle({ target: event, currentTarget: event })
  value = undefined
  tree = exports.FocusDetails({ ...props, defaultOpen: true })
  assert.equal(tree.props.open, false)
  assert.equal(bodyReads, 1)
})
