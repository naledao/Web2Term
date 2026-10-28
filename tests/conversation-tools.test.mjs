// User-run only: node --test tests/conversation-tools.test.mjs
// Actual settings/runtime/prompt methods with an in-memory SQLite database and synthetic views.
// No Electron, desktop helper, real page, shell, user profile or network is started.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Script } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, structuredClone, require(name) {
      const value = dependencies[name] ?? progressVmModules[name]
      assert.ok(value, 'Unexpected test dependency: ' + name)
      return value
    }
  })
  return exports
}
function methods(path, name, names, globals = {}) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name)
  const body = names.map(name => declaration.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
  return new Script(compile(`class Subject { ${body} }; Subject`)).runInNewContext({ structuredClone, ...globals })
}
const shared = load('../src/shared/conversation-tools.ts')
const scheduled = load('../src/shared/scheduled-tasks.ts')
const mail = load('../src/shared/mail-notification.ts')
const settings = load('../src/main/computer-use-settings.ts')
const { ConversationTools } = load('../src/main/conversation-tools.ts', {
  '../shared/conversation-tools': shared, './computer-use-settings': settings
})
const Store = methods('../src/main/db.ts', 'ConversationStore', ['getSetting', 'setSetting', 'setSettings'])
const protocol = load('../src/shared/computer-use-protocol.ts')
const computer = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const files = load('../src/shared/file-requests.ts')
const background = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': background })
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const store = Object.assign(new Store(), { db })
  t.after(() => db.close())
  return { db, store, choices: new ConversationTools('workspace-a', store), rows: () => plain(db.prepare('SELECT * FROM settings ORDER BY key').all()) }
}

test('new conversations enable files and background while computer use stays off, including with old global settings', t => {
  const f = fixture(t)
  for (const key of ['computerUseEnabled', 'desktopControlEnabled', 'autonomousExecutionEnabled']) f.store.setSetting(key, '1')
  const preferences = f.choices.read('deepseek', 'chat-a')
  assert.equal(preferences.fileReadingEnabled, true); assert.equal(preferences.backgroundTasksEnabled, true)
  assert.equal(preferences.scheduledTasksEnabled, true)
  assert.equal(preferences.mailNotificationsEnabled, true)
  assert.equal(preferences.computerUseEnabled, false); assert.equal(preferences.desktopControlEnabled, false)
  assert.equal(preferences.desktopPointClickEnabled, false)
})

test('choices persist by platform and conversation across workspace instances without leaking to another conversation', t => {
  const f = fixture(t)
  f.choices.update('deepseek', 'chat-a', { fileReadingEnabled: false, backgroundTasksEnabled: false, computerUseEnabled: true, computerResultDelaySeconds: 4 })
  const reopened = new ConversationTools('another-workspace', Object.assign(new Store(), { db: f.db }))
  const saved = reopened.read('deepseek', 'chat-a')
  assert.equal(saved.fileReadingEnabled, false); assert.equal(saved.backgroundTasksEnabled, false)
  assert.equal(saved.computerUseEnabled, true); assert.equal(saved.desktopControlEnabled, true)
  assert.equal(saved.desktopPointClickEnabled, true); assert.equal(saved.computerResultDelaySeconds, 4)
  assert.deepEqual(plain(reopened.read('deepseek', 'chat-b')), plain(shared.DEFAULT_CONVERSATION_TOOLS))
  assert.deepEqual(plain(reopened.read('chatgpt', 'chat-a')), plain(shared.DEFAULT_CONVERSATION_TOOLS))
})

test('confirmed prompt history persists across workspaces and stays isolated by platform and conversation', t => {
  const f = fixture(t)
  assert.equal(f.choices.hasInjectedPrompt('chatgpt', 'chat-a'), false)
  f.choices.markPromptInjected('chatgpt', 'chat-a')
  f.choices.update('chatgpt', 'chat-a', { backgroundTasksEnabled: false })
  const reopened = new ConversationTools('another-workspace', Object.assign(new Store(), { db: f.db }))
  assert.equal(reopened.hasInjectedPrompt('chatgpt', 'chat-a'), true)
  assert.equal(reopened.hasInjectedPrompt('chatgpt', 'chat-b'), false)
  assert.equal(reopened.hasInjectedPrompt('deepseek', 'chat-a'), false)
  assert.equal(reopened.read('chatgpt', 'chat-a').backgroundTasksEnabled, false)
})

test('a first injected send transfers prompt history even with default tools and never leaks to the next new chat', t => {
  const f = fixture(t)
  f.choices.markPromptInjected('chatgpt', null)
  f.choices.bind('chatgpt', null, 'new-chat')
  assert.equal(f.choices.hasInjectedPrompt('chatgpt', 'new-chat'), true)
  assert.equal(f.choices.hasInjectedPrompt('chatgpt', null), false)
  f.choices.bind('chatgpt', 'new-chat', null)
  f.choices.bind('chatgpt', null, 'another-chat')
  assert.equal(f.choices.hasInjectedPrompt('chatgpt', 'another-chat'), false)
  assert.equal(new ConversationTools('another-workspace', f.store).hasInjectedPrompt('chatgpt', null), false)
})

test('a confirmed first send transfers its draft choices once and the following new chat starts with defaults', t => {
  const f = fixture(t)
  f.choices.update('deepseek', null, { fileReadingEnabled: false, computerUseEnabled: true })
  f.choices.submitted('deepseek'); f.choices.bind('deepseek', null, 'new-chat')
  assert.equal(f.choices.read('deepseek', 'new-chat').computerUseEnabled, true)
  assert.equal(f.choices.read('deepseek', 'new-chat').fileReadingEnabled, false)
  assert.deepEqual(plain(f.choices.read('deepseek', null)), plain(shared.DEFAULT_CONVERSATION_TOOLS))
  f.choices.bind('deepseek', 'new-chat', null)
  f.choices.bind('deepseek', null, 'another-new-chat')
  assert.equal(f.choices.read('deepseek', 'another-new-chat').computerUseEnabled, false)
})

test('opening history without sending cannot inherit a draft or overwrite the history conversation', t => {
  const f = fixture(t)
  f.choices.update('deepseek', null, { computerUseEnabled: true })
  f.choices.bind('deepseek', null, 'history-without-settings')
  assert.equal(f.choices.read('deepseek', 'history-without-settings').computerUseEnabled, false)
  f.choices.update('deepseek', 'saved-history', { backgroundTasksEnabled: false })
  f.choices.update('deepseek', null, { computerUseEnabled: true })
  f.choices.submitted('deepseek'); f.choices.bind('deepseek', null, 'saved-history')
  assert.equal(f.choices.read('deepseek', 'saved-history').computerUseEnabled, false)
  assert.equal(f.choices.read('deepseek', 'saved-history').backgroundTasksEnabled, false)
})

test('drafts stay isolated by workspace and platform and survive reopening their own workspace', t => {
  const f = fixture(t)
  f.choices.update('deepseek', null, { computerUseEnabled: true })
  assert.equal(new ConversationTools('workspace-a', f.store).read('deepseek', null).computerUseEnabled, true)
  assert.equal(new ConversationTools('workspace-b', f.store).read('deepseek', null).computerUseEnabled, false)
  assert.equal(f.choices.read('chatgpt', null).computerUseEnabled, false)
})

test('invalid patches do not partially save and corrupt historical JSON falls back to the defaults', t => {
  const f = fixture(t), before = f.rows()
  for (const patch of [null, [], { fileReadingEnabled: 'false' }, { backgroundTasksEnabled: 0 }, { scheduledTasksEnabled: 'false' }, { mailNotificationsEnabled: 'true' },
    { computerUseEnabled: true, computerResultDelaySeconds: -1 }, { computerUseEnabled: 'true' }]) {
    assert.throws(() => f.choices.update('deepseek', 'chat-a', patch))
    assert.deepEqual(f.rows(), before)
  }
  f.choices.update('deepseek', 'chat-a', { computerUseEnabled: true })
  f.store.setSetting(f.rows()[0].key, 'broken-json')
  assert.deepEqual(plain(f.choices.read('deepseek', 'chat-a')), plain(shared.DEFAULT_CONVERSATION_TOOLS))
})

test('draft transfer rolls back its new conversation row if clearing the draft fails', t => {
  const f = fixture(t)
  f.choices.update('deepseek', null, { computerUseEnabled: true })
  f.choices.submitted('deepseek')
  f.db.exec(`CREATE TRIGGER reject_draft_clear BEFORE UPDATE ON settings
    WHEN NEW.value = '' BEGIN SELECT RAISE(FAIL, 'synthetic settings failure'); END`)
  assert.throws(() => f.choices.bind('deepseek', null, 'new-chat'), /synthetic settings failure/)
  assert.equal(f.choices.read('deepseek', null).computerUseEnabled, true)
  assert.equal(f.choices.read('deepseek', 'new-chat').computerUseEnabled, false)
})

test('prompt composition independently includes only enabled file, background and computer declarations', () => {
  for (const platform of ['deepseek', 'chatgpt', 'claude', 'gemini']) {
    assert.equal(types.toolPromptForPlatform(platform, false, '', false), '')
    const onlyFiles = types.toolPromptForPlatform(platform, true, '', false)
    assert.match(onlyFiles, /【工具：read_files】/); assert.doesNotMatch(onlyFiles, /【工具：background_task】/)
    const onlyBackground = types.toolPromptForPlatform(platform, false)
    assert.match(onlyBackground, /【工具：background_task】/); assert.doesNotMatch(onlyBackground, /【工具：read_files】/)
    assert.equal(types.toolPromptForPlatform(platform, false, 'computer declaration', false), 'computer declaration')
    assert.match(types.toolPromptForPlatform(platform, false, '', false, scheduled.scheduledTaskToolPrompt), /【工具：scheduled_task】/)
    assert.equal(types.toolPromptForPlatform(platform, false, '', false, '', mail.mailNotificationToolPrompt), mail.mailNotificationToolPrompt)
  }
})

const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', [
  'toolPreferences', 'toolsOwner', 'getConversationTools', 'updateConversationTools', 'getComputerUseCapability', 'toolPrompt'
], { ...computer, ...shared, ...types, ...scheduled, ...mail, process: { platform: 'win32', arch: 'x64' }, taskPausedByInput: () => false })

test('runtime rejects stale conversation/workspace writes and derives computer capability from this conversation', t => {
  const f = fixture(t), entry = { conversationId: 'chat-a' }, refreshes = []
  const runtime = Object.assign(new Runtime(), { id: 'workspace-a', activePlatformId: 'deepseek', disposed: false,
    activeEmbed: () => entry, embeds: new Map([['deepseek', entry]]), conversationTools: f.choices,
    options: { settings: () => ({ computerUseEnabled: true, desktopControlEnabled: true }) },
    computerUseTool: { definitions: () => [] }, refreshComputerUseCapabilities: owner => refreshes.push(owner) })
  const owner = { sessionId: 'workspace-a', platformId: 'deepseek', conversationId: 'chat-a' }
  assert.equal(runtime.getComputerUseCapability().computerUseEnabled, false, 'old global intent cannot enable a new conversation')
  const first = runtime.getConversationTools(owner)
  assert.deepEqual(plain(first.tools.map(tool => tool.name)), ['文件读取', '后台任务', '定时任务', '邮件通知', '电脑操作（computer use）'])
  assert.ok(first.tools.every(tool => tool.prompt.length > 0), 'closed tools still have a readable preview')
  const saved = runtime.updateConversationTools({ ...owner, patch: { computerUseEnabled: true, fileReadingEnabled: false } })
  assert.equal(saved.computerUseCapability.computerUseEnabled, true)
  assert.equal(refreshes.length, 1)
  assert.doesNotMatch(runtime.toolPrompt('deepseek'), /【工具：read_files】/)
  assert.match(runtime.toolPrompt('deepseek'), /当前对话已关闭文件读取工具/)
  runtime.updateConversationTools({ ...owner, patch: { scheduledTasksEnabled: false } })
  assert.doesNotMatch(runtime.toolPrompt('deepseek'), /【工具：scheduled_task】/)
  assert.match(runtime.toolPrompt('deepseek'), /当前对话已关闭定时任务工具/)
  runtime.updateConversationTools({ ...owner, patch: { mailNotificationsEnabled: false } })
  assert.doesNotMatch(runtime.toolPrompt('deepseek'), /【工具：send_email】/)
  assert.match(runtime.toolPrompt('deepseek'), /当前对话已关闭邮件通知工具/)
  assert.equal(f.choices.read('deepseek', 'chat-a').mailNotificationsEnabled, false)
  assert.equal(f.choices.read('deepseek', 'chat-b').mailNotificationsEnabled, true)
  const before = f.rows()
  entry.conversationId = 'chat-b'
  assert.throws(() => runtime.updateConversationTools({ ...owner, patch: { computerUseEnabled: true } }), /对话已变化/)
  assert.throws(() => runtime.getConversationTools(owner), /对话已变化/)
  assert.deepEqual(f.rows(), before)
  assert.equal(runtime.getComputerUseCapability().computerUseEnabled, false)
  assert.throws(() => runtime.updateConversationTools({ ...owner, sessionId: 'old-workspace', conversationId: 'chat-b', patch: { computerUseEnabled: true } }))
})

test('refreshing tool choices requests reinjection without clearing a live question or changing task generation', () => {
  const Embed = methods('../src/main/embed.ts', 'ChatGptEmbed', ['setPromptParts'])
  const question = { messageId: 'live-question' }, parts = { basePrompt: 'base', toolPrompt: 'files', prefix: 'base files' }
  const embed = Object.assign(new Embed(), { interceptor: { ...parts, pendingQuestion: question }, taskPromptInjected: true,
    toolPromptRevision: 0, taskPromptGeneration: 7, handlers: { onInterceptor() {} },
    getInterceptorStatus: () => ({}), liveContents: () => null })
  embed.setPromptParts({ ...parts, toolPrompt: 'background', prefix: 'base background' }, true)
  assert.equal(embed.taskPromptInjected, false); assert.equal(embed.toolPromptRevision, 1)
  assert.equal(embed.taskPromptGeneration, 7); assert.equal(embed.interceptor.pendingQuestion, question)
  embed.setPromptParts({ ...parts, toolPrompt: 'background', prefix: 'base background' })
  assert.equal(embed.toolPromptRevision, 1)
})
