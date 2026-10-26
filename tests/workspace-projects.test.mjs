import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run offline regressions. No Electron launch or network.
// Run: node --test tests/workspace-projects.test.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(path, overrides = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(code, { filename: path }).runInNewContext({
    module, exports: module.exports, Buffer, console,
    require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; if (Object.hasOwn(overrides, name)) return overrides[name]; return require(name) }
  })
  return module.exports
}
const { workspaceProjectDraft, workspaceSessionOptions } = load('../src/main/workspace-projects.ts')
const { ConversationStore } = load('../src/main/db.ts', {
  './computer-action-storage': load('../src/main/computer-action-storage.ts'),
  './computer-recovery': load('../src/main/computer-recovery.ts', { '../shared/autonomous-task': load('../src/shared/autonomous-task.ts') }),
  '../shared/computer-actions': load('../src/shared/computer-actions.ts'),
  '../shared/autonomous-task': load('../src/shared/autonomous-task.ts'),
  electron: { nativeImage: {} },
  '../shared/file-requests': { parseReadFilesRequest() { throw new Error('Unexpected file request') } },
  './terminal-notes': { normalizeTerminalNotesDirectory() { throw new Error('Unexpected terminal note') } },
  './execution-recovery': { recoverInterruptedExecutions() { return 0 }, interruptRunningCommands() { return 0 } }
})
const plain = value => JSON.parse(JSON.stringify(value))
const session = (id, options = {}) => ({
  id, title: '', url: 'https://chat.deepseek.com/', conversationId: null, platformId: 'deepseek',
  paused: false, promptInjectionEnabled: true, localCwd: '', sshHostId: '', sshAttached: false,
  sshReconnect: false, sshCwd: '', sendDelaySeconds: 3, createdAt: Date.now(), ...options
})
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'gpt-workspace-projects-test-'))
  const file = join(directory, 'test.db')
  let store = new ConversationStore(file)
  try { run({ directory, file, get store() { return store }, reopen() { store.close(); store = new ConversationStore(file) } }) }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
}

test('global chats and projects without a directory use the normal default without inheriting an active project', () => {
  const projects = [{ id: 'project-a', name: '设备管理', directory: '', createdAt: 1 }]
  assert.deepEqual(plain(workspaceSessionOptions('local', undefined, projects)), { projectId: null, localCwd: '' })
  assert.deepEqual(plain(workspaceSessionOptions('local', null, projects)), { projectId: null, localCwd: '' })
  assert.deepEqual(plain(workspaceSessionOptions('local', 'project-a', projects)), { projectId: 'project-a', localCwd: '' })
  assert.throws(() => workspaceSessionOptions('local', 'deleted', projects), /项目不存在/)
})

test('project directory applies only to new local chats and missing directories fail before creation', () => fixture(({ directory }) => {
  const project = { id: randomUUID(), name: '项目', directory, createdAt: 1 }
  assert.deepEqual(plain(workspaceSessionOptions('local', project.id, [project])), { projectId: project.id, localCwd: resolve(directory) })
  assert.deepEqual(plain(workspaceSessionOptions('ssh', project.id, [project])), { projectId: project.id, localCwd: '' })
  assert.deepEqual(plain(workspaceSessionOptions('web2term', project.id, [project])), { projectId: project.id, localCwd: '' })
  project.directory = join(directory, 'removed')
  assert.throws(() => workspaceSessionOptions('local', project.id, [project]), /项目目录不存在/)
  assert.equal(workspaceSessionOptions('web2term', project.id, [project]).localCwd, '')
  assert.equal(workspaceSessionOptions('local', null, [project]).localCwd, '')
}))

test('project input allows an optional directory and rejects invalid names, files and relative paths', () => fixture(({ directory }) => {
  assert.deepEqual(plain(workspaceProjectDraft({ name: '  面试  ', directory: '' })), { name: '面试', directory: '' })
  for (const name of ['', '  ', 'x'.repeat(121)]) assert.throws(() => workspaceProjectDraft({ name, directory: '' }), /项目名称/)
  assert.throws(() => workspaceProjectDraft({ name: 'test', directory: 'relative' }), /完整目录/)
  const file = join(directory, 'document.txt')
  writeFileSync(file, 'fixture')
  assert.throws(() => workspaceProjectDraft({ name: 'test', directory: file }), /项目目录不存在/)
}))

test('empty manually-created projects survive restart and execution-directory projects never become sidebar projects', () => fixture(context => {
  const project = context.store.saveWorkspaceProject({ name: '面试', directory: '' })
  context.store.upsert({ id: randomUUID(), title: '旧聊天', url: 'https://chat.deepseek.com/a/chat/s/old' }, {
    machineScope: 'local', hostId: 'machine', machineLabel: '本机', name: '自动目录', path: context.directory
  })
  context.reopen()
  assert.deepEqual(plain(context.store.listWorkspaceProjects()), [plain(project)])
  assert.equal(context.store.listManagedSessions().length, 0)
  assert.equal(context.store.list().length, 1)
}))

test('project membership persists independently of terminal cwd and editing a project affects only future chats', () => fixture(context => {
  const project = context.store.saveWorkspaceProject({ name: '设备管理', directory: context.directory })
  const record = session('chat-a', { projectId: project.id, localCwd: context.directory })
  context.store.upsertManagedSession(record)
  const other = join(context.directory, 'other')
  mkdirSync(other)
  context.store.upsertManagedSession({ ...record, localCwd: other })
  const edited = context.store.saveWorkspaceProject({ id: project.id, name: '设备管理新版', directory: '' })
  context.reopen()
  const restored = context.store.listManagedSessions()[0]
  assert.equal(restored.projectId, project.id)
  assert.equal(restored.localCwd, other)
  assert.equal(context.store.listWorkspaceProjects()[0].name, edited.name)
  assert.equal(workspaceSessionOptions('local', edited.id, context.store.listWorkspaceProjects()).localCwd, '')
}))

test('removing a project keeps its sessions, cwd and history, and detaches only that project', () => fixture(context => {
  const first = context.store.saveWorkspaceProject({ name: 'first', directory: context.directory })
  const second = context.store.saveWorkspaceProject({ name: 'second', directory: '' })
  context.store.upsertManagedSession(session('chat-a', { projectId: first.id, localCwd: context.directory }))
  context.store.upsertManagedSession(session('chat-b', { projectId: second.id }))
  context.store.upsert({ id: randomUUID(), title: 'history', url: 'https://chatgpt.com/c/history' })
  assert.equal(context.store.removeWorkspaceProject(first.id), true)
  context.reopen()
  const rows = context.store.listManagedSessions()
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.id === 'chat-a').projectId, null)
  assert.equal(rows.find(row => row.id === 'chat-a').localCwd, context.directory)
  assert.equal(rows.find(row => row.id === 'chat-b').projectId, second.id)
  assert.equal(context.store.list().length, 1)
}))

test('legacy databases gain explicit nullable membership without changing existing session or history data', () => fixture(context => {
  context.store.upsertManagedSession(session('legacy', { localCwd: context.directory, title: '旧会话' }))
  const db = new DatabaseSync(context.file)
  try {
    db.exec('ALTER TABLE managed_sessions DROP COLUMN workspace_project_id; DROP TABLE workspace_projects;')
  } finally { db.close() }
  context.reopen()
  const restored = context.store.listManagedSessions()[0]
  assert.equal(restored.title, '旧会话')
  assert.equal(restored.localCwd, context.directory)
  assert.equal(restored.projectId, null)
  assert.deepEqual(plain(context.store.listWorkspaceProjects()), [])
}))
