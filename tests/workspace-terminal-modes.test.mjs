// User-run offline regressions. No Electron launch, device connection or network.
// Run: node --test tests/workspace-terminal-modes.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const plain = value => JSON.parse(JSON.stringify(value))
const helpers = {}
new Script(compile(readFileSync(new URL('../src/main/workspace-projects.ts', import.meta.url), 'utf8')))
  .runInNewContext({ exports: helpers, require })

const main = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const declaration = main.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'showWeb2termWorkspace')
assert.ok(declaration)
const backendCode = compile(`${declaration.getText(main)}\nconst action = showWeb2termWorkspace`)
function backend({ existing = true, statuses = [], status = 'connected' } = {}) {
  const created = [], selected = []
  let reconnected = 0
  const binding = { agentId: 'device', deviceName: '设备', backendUrl: 'https://example.invalid', userId: 'owner' }
  const context = {
    web2termConnection: {
      getState: () => ({ auth: { user: { publicId: 'owner' }, backendUrl: binding.backendUrl }, agentId: 'device', deviceName: '设备', status }),
      terminals: { getState: () => ({ sessions: statuses.map(status => ({ status })) }) }
    },
    store: { listWorkspaceProjects: () => [{ id: 'project', name: '项目', directory: '/directory-that-is-not-used-remotely', createdAt: 1 }] },
    runtimes: new Map(existing ? [['old', { id: 'old', web2term: { binding, alive: false, running: false, reconnect() { reconnected++ } } }]] : []),
    workspaceSessionOptions: helpers.workspaceSessionOptions,
    platformById: () => ({ id: 'chatgpt' }), DEFAULT_PLATFORM_ID: 'chatgpt', CHATGPT_PLATFORM: { id: 'chatgpt' },
    createSession(...args) { created.push(args); return { id: 'new' } },
    selectSession(id) { selected.push(id); return true }
  }
  const action = new Script(`${backendCode}\naction`).runInNewContext(context)
  return { action, created, selected, get reconnected() { return reconnected } }
}

test('new web2term project chats keep project membership and never resume an old disconnected chat', () => {
  const app = backend()
  assert.equal(app.action({ newChat: true, projectId: 'project' }), true)
  assert.equal(app.reconnected, 0)
  assert.deepEqual(app.selected, [])
  assert.equal(app.created.length, 1)
  assert.equal(app.created[0][0], 'web2term')
  assert.equal(app.created[0][2], undefined, 'no restored conversation supplied')
  assert.deepEqual(plain(app.created[0][5]), { projectId: 'project', localCwd: '' })
})

test('global web2term chats stay unassigned while existing reconnect actions still reuse their workspace', () => {
  const fresh = backend()
  fresh.action({ newChat: true, projectId: null })
  assert.deepEqual(plain(fresh.created[0][5]), { projectId: null, localCwd: '' })
  const reconnect = backend()
  assert.equal(reconnect.action(), true)
  assert.equal(reconnect.reconnected, 1)
  assert.deepEqual(reconnect.selected, ['old'])
  assert.deepEqual(reconnect.created, [])
})

test('missing projects, the three-terminal limit and disconnected devices never create a chat', () => {
  const missing = backend()
  assert.throws(() => missing.action({ newChat: true, projectId: 'removed' }), /项目不存在/)
  assert.equal(missing.reconnected, 0)
  assert.equal(missing.created.length, 0)
  const full = backend({ statuses: ['opening', 'ready', 'closing', 'closed'] })
  assert.throws(() => full.action({ newChat: true }), /最多同时运行 3 个终端/)
  assert.equal(full.created.length, 0)
  const offline = backend({ status: 'disconnected' })
  assert.equal(offline.action({ newChat: true }), false)
  assert.equal(offline.created.length, 0)
})

const renderer = ts.createSourceFile('WorkspaceApp.tsx', readFileSync(new URL('../src/renderer/src/WorkspaceApp.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
const component = renderer.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'WorkspaceApp')
const names = ['requestNewChat', 'closeNewSessionDialog', 'createManagedSession', 'openWeb2termConnection', 'openWeb2termDeviceDialog']
const rendererCode = compile(names.map(name => {
  const statement = component.body.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(renderer) === name))
  assert.ok(statement, `${name} exists`)
  return statement.getText(renderer)
}).join('\n'))
function frontend() {
  const calls = []
  const context = {
    creatingRef: { current: false }, newSessionTrigger: { current: null }, newSessionButton: { current: null },
    web2termDeviceDialogTrigger: { current: null }, newSessionProjectId: null, web2termChatCreation: null,
    document: { activeElement: null }, requestAnimationFrame(callback) { callback() },
    window: { api: {
      setEmbedVisible() {},
      async createManagedSession(...args) { calls.push(['create', ...args]); return { id: 'new' } },
      async showWeb2termConnection(options) { calls.push(['web2term', options ? plain(options) : null]); return true }
    } },
    setCreating() {}, setNavigationError(value) { context.error = value },
    setNewSessionProjectId(value) { context.newSessionProjectId = value },
    setNewSessionOpen(value) { context.pickerOpen = value },
    setWeb2termDeviceDialogOpen(value) { context.devicesOpen = value },
    setWeb2termChatCreation(value) { context.web2termChatCreation = value }
  }
  const actions = new Script(`${rendererCode}\n({${names.join(',')}})`).runInNewContext(context)
  return { actions, context, calls }
}

test('opening and cancelling the terminal-mode picker creates no conversation', () => {
  const app = frontend()
  app.actions.requestNewChat('project')
  assert.equal(app.context.pickerOpen, true)
  assert.equal(app.context.newSessionProjectId, 'project')
  assert.deepEqual(app.calls, [])
  app.actions.closeNewSessionDialog()
  assert.equal(app.context.pickerOpen, false)
  assert.deepEqual(app.calls, [])
})

test('local and SSH selections preserve the initiating project, and global creation resets old project context', async () => {
  for (const mode of ['local', 'ssh']) {
    const app = frontend()
    app.actions.requestNewChat('project')
    await app.actions.createManagedSession(mode)
    assert.deepEqual(app.calls, [['create', mode, 'project']])
    assert.equal(app.context.pickerOpen, false)
    app.actions.requestNewChat(null)
    await app.actions.createManagedSession(mode)
    assert.deepEqual(app.calls[1], ['create', mode, null])
  }
})

test('the web2term device-selection step carries new-chat context without changing reconnect behavior', async () => {
  const app = frontend()
  app.actions.requestNewChat('project')
  app.actions.openWeb2termDeviceDialog(null, { projectId: app.context.newSessionProjectId })
  assert.equal(app.context.pickerOpen, false)
  assert.equal(app.context.devicesOpen, true)
  assert.deepEqual(app.calls, [])
  await app.actions.openWeb2termConnection()
  assert.deepEqual(app.calls, [['web2term', { newChat: true, projectId: 'project' }]])
  assert.equal(app.context.devicesOpen, false)
  app.actions.openWeb2termDeviceDialog()
  await app.actions.openWeb2termConnection()
  assert.deepEqual(app.calls[1], ['web2term', null])
})
