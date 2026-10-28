import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run offline regressions: node --test tests/project-terminal-notes.test.mjs
// Real SQLite and runtime methods with fake terminals/views; no Electron launch,
// shell process, app profile, UI automation or network.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const nodeRequire = createRequire(import.meta.url)
const compile = code => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8')), { filename: path })
    .runInNewContext({ exports, Buffer, URL, console, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name];
      if (name.startsWith('node:')) return nodeRequire(name)
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    } })
  return exports
}
const files = load('../src/shared/file-requests.ts')
const tasks = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': tasks })
const platforms = load('../src/shared/platforms.ts', { './types': types })
const protocol = load('../src/shared/computer-use-protocol.ts')
const computerUse = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const autonomousTasks = load('../src/shared/autonomous-task.ts')
const notes = load('../src/main/terminal-notes.ts')
const { ConversationStore } = load('../src/main/db.ts', {
  './scheduled-task-store': load('../src/main/scheduled-task-store.ts'),
  './computer-action-storage': load('../src/main/computer-action-storage.ts'),
  './computer-recovery': load('../src/main/computer-recovery.ts', { '../shared/autonomous-task': load('../src/shared/autonomous-task.ts') }),
  '../shared/computer-actions': load('../src/shared/computer-actions.ts'),
  '../shared/autonomous-task': autonomousTasks,
  electron: { nativeImage: {} }, '../shared/types': types,
  '../shared/file-requests': files, './terminal-notes': notes,
  './execution-recovery': { recoverInterruptedExecutions: () => 0, interruptRunningCommands: () => 0 }
})
const { SessionRuntime } = load('../src/main/session-runtime.ts', {
  './scheduled-task-target': load('../src/main/scheduled-task-target.ts'),
  '../shared/scheduled-tasks': load('../src/shared/scheduled-tasks.ts'),
  './computer-recovery': {},
  './task-coordinator': {},
  './computer-use-tool': {},
  './task-progression': {},
    './task-background-wait': {},
    './task-continuity': {},
  '../shared/computer-use-protocol': protocol,
  electron: {}, 'mysql2/promise': {}, './mysql-field-value': {}, './command-log': {},
  '../shared/types': types, '../shared/platforms': platforms, '../shared/computer-use': computerUse, '../shared/deepseek-question': {},
  './file-access': {}, './commands': {}, './extra-terminals': {}, './background-tasks': {}, './background-task-results': {}, '../shared/background-tasks': {}, './db': {},
  './focus-chat': {}, './focus-attachments': {}, './focus-chat-log': {}, '../shared/focus-chat': {},
  './nacos-view': {}, './mysql-table-rows': {}, './mysql-ddl-export': {}, './redis-reader': {},
  './embed': {}, './environment': {}, './shell': {}, './ssh': {}, './web2term-shell': {}, './terminal-notes': notes
})
const web2term = load('../src/main/web2term-shell.ts', {
  './remote-shell': {}, './environment': { REMOTE_DETECT_COMMAND: '' }
})
const main = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
const migration = main.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'inheritWorkspaceProjectNotes')
assert.ok(migration)
const inherit = new Script(compile(`${migration.getText(main)}\ninheritWorkspaceProjectNotes`))
  .runInNewContext({ localMachineId: 'desktop', ...web2term })

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'gpt-project-notes-test-'))
  const path = join(directory, 'test.db')
  let store = new ConversationStore(path)
  const context = { path, get store() { return store }, reopen() { store.close(); store = new ConversationStore(path) } }
  try { run(context) }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
}
function runtime(store, projectId = null, transport = 'local', cwd = 'C:\\work\\project') {
  const instance = Object.create(SessionRuntime.prototype)
  const events = [], prompts = []
  const terminal = { cwd }
  Object.assign(instance, {
    computerUseTool: { definitions: () => [] },
    projectId, disposed: false, lastDirectoryNotes: null, lastPersistedLocalCwd: cwd,
    options: { store, localMachineId: 'desktop', onSummaryChanged() {}, onTerminalNotesSaved() {} },
    web2term: transport === 'web2term' ? { alive: Boolean(cwd), cwd, hostId: 'device', binding: { deviceName: '设备', agentId: 'device' } } : null,
    remoteShell: transport === 'ssh' ? { alive: Boolean(cwd), cwd } : null,
    ssh: { getState: () => ({ attached: transport === 'ssh', modelCwd: cwd, hostId: 'ssh-host', name: 'SSH' }) },
    runner: { getTerminalState: () => terminal }, environment: { ...types.FALLBACK_ENVIRONMENT },
    embeds: new Map(platforms.CHAT_PLATFORMS.map(platform => [platform.id, {
      platform, embed: { setPromptParts(parts) { prompts.push(parts) }, setComputerUseRecognitionEnabled() {} }
    }])),
    toolPrompt: () => '', send: (channel, value) => events.push({ channel, value })
  })
  return { instance, events, prompts, terminal }
}
const session = (id, projectId, patch = {}) => ({
  id, projectId, title: '', url: '', conversationId: null, platformId: 'deepseek', paused: false,
  promptInjectionEnabled: true, localCwd: '', sshHostId: '', sshAttached: false, sshReconnect: false,
  sshCwd: '', sendDelaySeconds: 0, createdAt: 1, ...patch
})

test('new project chats inherit saved notes across directories, terminal modes and offline terminals', () => fixture(({ store }) => {
  const project = store.saveWorkspaceProject({ name: '项目', directory: '' })
  const source = runtime(store, project.id).instance
  source.applyTerminalNotes('统一使用中文回复', source.currentNotes())
  for (const transport of ['local', 'ssh', 'web2term']) {
    for (const cwd of ['', transport === 'local' ? 'D:\\other' : '/srv/other']) {
      const { instance, prompts } = runtime(store, project.id, transport, cwd)
      assert.equal(instance.currentNotes().text, '统一使用中文回复')
      assert.equal(types.canEditTerminalNotes(instance.currentNotes()), true)
      instance.refreshTerminalNotesForOwner(source.currentNotes())
      assert.equal(prompts.length, platforms.CHAT_PLATFORMS.length)
      for (const prompt of prompts) assert.ok(prompt.basePrompt.includes('统一使用中文回复'))
      assert.equal(instance.environment.workingDirectory, cwd)
    }
  }
}))

test('saving in a project refreshes other project chats but leaves unrelated projects and directory notes alone', () => fixture(({ store }) => {
  const first = store.saveWorkspaceProject({ name: 'A', directory: '' })
  const second = store.saveWorkspaceProject({ name: 'B', directory: '' })
  const a = runtime(store, first.id), b = runtime(store, first.id, 'ssh', '/other')
  const other = runtime(store, second.id), global = runtime(store)
  store.setDirectoryNote('local', 'desktop', 'C:\\work\\project', '目录说明')
  store.setWorkspaceProjectNote(second.id, '其他项目')
  a.instance.options.onTerminalNotesSaved = owner => {
    for (const target of [b, other, global]) target.instance.refreshTerminalNotesForOwner(owner)
  }
  a.instance.applyTerminalNotes('新项目说明', a.instance.currentNotes())
  assert.equal(b.events.find(event => event.channel === types.IpcChannels.terminalNotesChanged).value.text, '新项目说明')
  assert.equal(other.events.length, 0)
  assert.equal(global.events.length, 0)
  assert.equal(other.instance.currentNotes().text, '其他项目')
  assert.equal(global.instance.currentNotes().text, '目录说明')
}))

test('project notes survive cwd changes; moving a chat switches prompts and rejects stale saves', () => fixture(({ store }) => {
  const first = store.saveWorkspaceProject({ name: 'A', directory: '' })
  const second = store.saveWorkspaceProject({ name: 'B', directory: '' })
  store.setWorkspaceProjectNote(first.id, '说明 A')
  store.setWorkspaceProjectNote(second.id, '说明 B')
  const { instance, terminal } = runtime(store, first.id)
  const owner = instance.currentNotes()
  terminal.cwd = 'D:\\other'
  assert.equal(types.terminalNotesOwnerKey(owner), types.terminalNotesOwnerKey(instance.currentNotes()))
  instance.applyTerminalNotes('说明 A2', owner)
  instance.setProjectId(second.id)
  assert.equal(instance.environment.extraNotes, '说明 B')
  assert.throws(() => instance.applyTerminalNotes('过期保存', owner), /所属项目或工作目录已变化/)
  assert.equal(store.getWorkspaceProjectNote(first.id), '说明 A2')
  store.setDirectoryNote('local', 'desktop', terminal.cwd, '目录说明')
  instance.setProjectId(null)
  assert.equal(instance.environment.extraNotes, '目录说明')
  assert.throws(() => instance.applyTerminalNotes('过期保存', owner), /所属项目或工作目录已变化/)
}))

test('directory notes discovered after reconnect update project chats that were already open', () => fixture(({ store }) => {
  const project = store.saveWorkspaceProject({ name: '项目', directory: '' })
  const offline = runtime(store, project.id, 'web2term', '')
  const ssh = runtime(store, project.id, 'ssh', '/srv/resumed')
  offline.instance.refreshDirectoryNotes()
  assert.equal(offline.instance.environment.extraNotes, '')
  store.setDirectoryNote('ssh', 'ssh-host', '/srv/resumed', '恢复目录的说明')
  ssh.instance.options.onTerminalNotesSaved = owner => offline.instance.refreshTerminalNotesForOwner(owner)
  ssh.instance.refreshDirectoryNotes()
  assert.equal(offline.instance.environment.extraNotes, '恢复目录的说明')
  assert.equal(ssh.instance.environment.extraNotes, '恢复目录的说明')
  assert.equal(store.getWorkspaceProjectNote(project.id), '恢复目录的说明')
}))

test('startup inherits old project notes before shells reconnect, using only that project’s saved targets', () => fixture(context => {
  const { store } = context
  const root = store.saveWorkspaceProject({ name: '根目录', directory: 'C:\\root' })
  const local = store.saveWorkspaceProject({ name: '本机', directory: '' })
  const ssh = store.saveWorkspaceProject({ name: 'SSH', directory: '' })
  const remote = store.saveWorkspaceProject({ name: '远程', directory: '' })
  const empty = store.saveWorkspaceProject({ name: '无说明', directory: '' })
  const binding = { agentId: '00000000-1234-5678-9abc-0123456789ab', backendUrl: 'https://example.invalid', userId: 'owner', deviceName: '设备', cwd: '/srv/device' }
  store.setDirectoryNote('local', 'desktop', root.directory, '根目录说明')
  store.setDirectoryNote('local', 'desktop', 'D:\\old', '旧对话说明')
  store.setDirectoryNote('ssh', 'ssh-host', '/srv/ssh', 'SSH 说明')
  store.setDirectoryNote('ssh', web2term.web2termHostId(binding), binding.cwd, '远程说明')
  store.upsertManagedSession(session('old-local', local.id, { localCwd: 'D:\\old' }))
  store.upsertManagedSession(session('old-ssh', ssh.id, { sshAttached: true, sshHostId: 'ssh-host', sshCwd: '/srv/ssh' }))
  store.upsertManagedSession(session('old-device', remote.id))
  store.setSetting('web2termSession:old-device', JSON.stringify(binding))
  inherit(store)
  for (const [project, expected] of [[root, '根目录说明'], [local, '旧对话说明'], [ssh, 'SSH 说明'], [remote, '远程说明']]) {
    assert.equal(store.getWorkspaceProjectNote(project.id), expected)
  }
  assert.equal(store.getWorkspaceProjectNote(empty.id), null)
  assert.equal(store.getDirectoryNote('local', 'desktop', 'D:\\old'), '旧对话说明')
  context.reopen()
  assert.equal(runtime(context.store, remote.id, 'web2term', '').instance.currentNotes().text, '远程说明')
}))

test('latest directory notes win migration; explicit clearing persists through restart, rename and directory edits', () => fixture(context => {
  const { store } = context
  const project = store.saveWorkspaceProject({ name: '项目', directory: 'C:\\root' })
  store.setDirectoryNote('local', 'desktop', project.directory, '旧说明')
  store.setDirectoryNote('ssh', 'ssh-host', '/newer', '最新说明')
  const db = new DatabaseSync(context.path)
  try { db.prepare("UPDATE terminal_directory_notes SET updated_at = 200 WHERE machine_scope = 'ssh'").run()
    db.prepare("UPDATE terminal_directory_notes SET updated_at = 100 WHERE machine_scope = 'local'").run() }
  finally { db.close() }
  store.inheritWorkspaceProjectNote(project.id, [
    { scope: 'local', hostId: 'desktop', directory: project.directory },
    { scope: 'ssh', hostId: 'ssh-host', directory: '/newer' }
  ])
  assert.equal(store.getWorkspaceProjectNote(project.id), '最新说明')
  const instance = runtime(store, project.id).instance
  instance.applyTerminalNotes('', instance.currentNotes())
  store.saveWorkspaceProject({ id: project.id, name: '改名', directory: 'D:\\new' })
  context.reopen()
  inherit(context.store)
  assert.equal(context.store.getWorkspaceProjectNote(project.id), '')
  assert.equal(runtime(context.store, project.id, 'ssh', '/newer').instance.currentNotes().text, '')
  assert.equal(context.store.getDirectoryNote('ssh', 'ssh-host', '/newer'), '最新说明')
  context.store.removeWorkspaceProject(project.id)
  assert.equal(context.store.getWorkspaceProjectNote(project.id), null)
  assert.throws(() => context.store.setWorkspaceProjectNote(project.id, '说明'), /项目不存在/)
}))

test('old database schemas gain nullable project notes without losing saved projects', () => fixture(context => {
  const project = context.store.saveWorkspaceProject({ name: '旧项目', directory: '' })
  const db = new DatabaseSync(context.path)
  try { db.exec('ALTER TABLE workspace_projects DROP COLUMN terminal_notes') }
  finally { db.close() }
  context.reopen()
  assert.equal(context.store.listWorkspaceProjects()[0].id, project.id)
  assert.equal(context.store.getWorkspaceProjectNote(project.id), null)
  context.store.setWorkspaceProjectNote(project.id, '升级后说明')
  context.reopen()
  assert.equal(context.store.getWorkspaceProjectNote(project.id), '升级后说明')
}))

test('unassigned chats retain directory isolation and stale-directory save protection', () => fixture(({ store }) => {
  const first = runtime(store), same = runtime(store, null, 'local', 'c:/work/project/'), other = runtime(store, null, 'local', 'D:\\other')
  const owner = first.instance.currentNotes()
  first.instance.applyTerminalNotes('目录说明', owner)
  assert.equal(same.instance.currentNotes().text, '目录说明')
  assert.equal(other.instance.currentNotes().text, '')
  first.terminal.cwd = 'D:\\other'
  assert.throws(() => first.instance.applyTerminalNotes('过期保存', owner), /工作目录已变化/)
  assert.equal(types.canEditTerminalNotes(runtime(store, null, 'web2term', '').instance.currentNotes()), false)
}))
