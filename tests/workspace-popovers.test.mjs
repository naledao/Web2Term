// User-run offline regression. Does not launch Electron or access the network.
// Run: node --test tests/workspace-popovers.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = ts.createSourceFile('WorkspaceApp.tsx', readFileSync(new URL('../src/renderer/src/WorkspaceApp.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'WorkspaceApp')
assert.ok(component)
const blocker = component.body.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find(node => node.name.getText(source) === 'workspaceModalOpen')?.initializer
assert.ok(blocker)

function evaluate(node, context) {
  const code = ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Script(code).runInNewContext(context)
}

function navigationAction(name) {
  let action
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'WorkspaceNavigation') {
      action = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === name)?.initializer?.expression
    }
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(action, name)
  return action
}

function updateNoticeHandler() {
  let handler
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'notice') handler = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(component)
  assert.ok(handler)
  return handler
}

function fixture() {
  const visibilityCalls = []
  const context = {
    transfersOpen: false, newSessionOpen: false, web2termDeviceDialogOpen: false,
    updateNotice: null, projectEditor: null, movingSession: null, releaseNotesOpen: false,
    noticedVersion: { current: '' }, updateLive: null,
    pendingDelete: null, pendingProjectDelete: null,
    deleteSessionTrigger: { current: null }, removeProjectTrigger: { current: null },
    setPendingDelete(value) { context.pendingDelete = value },
    setPendingProjectDelete(value) { context.pendingProjectDelete = value },
    setUpdateNotice(value) { context.updateNotice = value },
    setUpdateLive(value) { context.updateLive = value },
    setNavigationError() {},
    window: { api: { setEmbedVisible(value) { visibilityCalls.push(value) } } }
  }
  return { context, visibilityCalls, blocked: () => evaluate(blocker, context) }
}

for (const [action, state, trigger] of [
  ['onDeleteSession', 'pendingDelete', 'deleteSessionTrigger'],
  ['onRemoveProject', 'pendingProjectDelete', 'removeProjectTrigger']
]) {
  test(`${action} opens an anchored confirmation without hiding the native chat`, () => {
    const app = fixture()
    const item = { id: 'selected', title: '当前对话', name: '当前项目' }
    const anchor = { id: 'more-button' }
    assert.equal(app.blocked(), false)
    evaluate(navigationAction(action), app.context)(item, anchor)
    assert.equal(app.context[state], item)
    assert.equal(app.context[trigger].current, anchor)
    assert.deepEqual(app.visibilityCalls, [], 'opening a sidebar confirmation must not send a hide command')
    assert.equal(app.blocked(), false, 'the renderer must also keep the chat visible after the state update')
    app.context[state] = null
    assert.equal(app.blocked(), false)
  })
}

test('update notices and download progress leave the native chat and tool windows usable', () => {
  const app = fixture()
  const notice = evaluate(updateNoticeHandler(), app.context)
  for (const [phase, percent] of [['available', 0], ['downloading', 35], ['downloaded', 100]]) {
    notice({ phase, version: '0.1.201', percent })
    assert.equal(app.context.updateNotice.version, '0.1.201')
    assert.equal(app.context.updateLive.phase, phase)
    assert.equal(app.context.updateLive.percent, percent)
    assert.deepEqual(app.visibilityCalls, [], `${phase} must not hide the native chat`)
    assert.equal(app.blocked(), false, `${phase} must not block the chat or tool windows`)
  }

  app.context.updateNotice = null
  notice({ phase: 'available', version: '0.1.201', percent: 0 })
  assert.equal(app.context.updateNotice, null, 'a dismissed version must not reopen on the next check')
  notice({ phase: 'available', version: '0.1.202', percent: 0 })
  assert.equal(app.context.updateNotice.version, '0.1.202')
  assert.deepEqual(app.visibilityCalls, [])
  assert.equal(app.blocked(), false)
})

test('workspace surfaces that overlap the native chat still hide it', () => {
  for (const [name, value] of [
    ['transfersOpen', true], ['newSessionOpen', true], ['web2termDeviceDialogOpen', true],
    ['projectEditor', {}], ['movingSession', {}], ['releaseNotesOpen', true]
  ]) {
    const app = fixture()
    app.context.pendingDelete = { id: 'chat' }
    app.context.pendingProjectDelete = { id: 'project' }
    app.context[name] = value
    assert.equal(app.blocked(), true, name)
  }
})
