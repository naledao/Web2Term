import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/autonomous-task-entry.test.mjs
// Actual coordinator and SQLite persistence with synthetic submissions. No Electron, desktop, shell or network.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, structuredClone, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name];
      if (name === '../shared/computer-actions') return load('../src/shared/computer-actions.ts')
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return exports
}
const shared = load('../src/shared/autonomous-task.ts')
const protocol = load('../src/shared/computer-use-protocol.ts')
const { resolveComputerUseCapability } = load('../src/shared/computer-use.ts', { './computer-use-protocol': protocol })
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', { 'node:crypto': { createHash, randomUUID } })
const dbSource = readFileSync(new URL('../src/main/db.ts', import.meta.url), 'utf8')
const schema = dbSource.match(/CREATE TABLE IF NOT EXISTS autonomous_tasks \([\s\S]*?ON autonomous_tasks\([^;]+;/)?.[0]
assert.ok(schema, 'autonomous task schema exists')
const ast = ts.createSourceFile('db.ts', dbSource, ts.ScriptTarget.ES2022, true)
const storeClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ConversationStore')
const methods = ['autonomousTaskGeneration', 'latestAutonomousTask', 'autonomousTaskBySubmission', 'saveAutonomousTasks']
  .map(name => {
    const method = storeClass.members.find(node => node.name?.getText(ast) === name)
    assert.ok(method, `Missing actual store method ${name}`)
    return method.getText(ast)
  })
const sqlContext = { module: { exports: null }, ...shared }
new Script(compile(`class Store { constructor(db) { this.db = db } ${methods.join('\n')} }; module.exports = Store`)).runInNewContext(sqlContext)
const Store = sqlContext.module.exports

const baseContext = { sessionId: 'session-A', platformId: 'deepseek', hostPlatform: 'win32', hostArch: 'x64', connection: 'local' }
const capability = (context = {}, preferences = { computerUseEnabled: true, desktopControlEnabled: false }) =>
  resolveComputerUseCapability(preferences, { ...baseContext, ...context })
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(run) {
  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  db.exec(schema) // Safe on an upgraded database too; no destructive table replacement.
  const store = new Store(db)
  const events = []
  const coordinator = new TaskCoordinator('session-A', store, state => events.push(state))
  let serial = 0
  const submit = (overrides = {}) => coordinator.submit({
    platformId: 'deepseek', conversationId: 'conversation-A', submission: { id: `send-${++serial}`, kind: 'goal' },
    turnId: 'turn-A', text: '下载报表，整理为 Excel，保留原始数据，保存到指定目录并检查。', attachments: [],
    machine: { id: 'machine-A', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\reports' },
    capability: capability(), ...overrides
  })
  try { run({ db, store, coordinator, submit, events }) } finally { db.close() }
}

test('confirmed goals preserve the complete request and machine without requiring a plan or extracted intent', () => fixture(({ submit, store }) => {
  const text = '必要条件：不能修改原始文件。\n预期产物：C:\\报表\\十月.xlsx\n' + '中文与完整明细🗂️\n'.repeat(100)
  const task = submit({ text, attachments: [{ fileName: 'data.csv', mimeType: 'text/csv', sizeBytes: 512 }] })
  assert.equal(task.originalRequest, text)
  assert.equal(task.inputs[0].text, text)
  assert.equal(Object.hasOwn(task, 'intent'), false)
  assert.equal(task.machine.id, 'machine-A')
  assert.equal(task.machine.workingDirectory, 'C:\\reports')
  assert.equal(task.sourceTurnId, 'turn-A')
  assert.equal(task.status, 'recorded')
  assert.deepEqual(plain(store.latestAutonomousTask('session-A', 'deepseek', 'conversation-A')), plain(task))
}))

test('computer use enables its context intake independently of desktop permission; other contexts stay excluded', () => fixture(({ submit, db }) => {
  for (const cap of [capability({}, {}), capability({ connection: 'ssh' }), capability({ connection: 'web2term' }),
    capability({ platformId: 'chatgpt' }), capability({ hostPlatform: 'darwin' }), capability({ hostArch: 'arm64' }),
    capability({ sessionId: 'another-session' })]) assert.equal(submit({ capability: cap }), null)
  assert.equal(submit({ text: ' \n ' }), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM autonomous_tasks').get().n, 0)
  assert.equal(submit().generation, 1)
}))

test('duplicate acknowledgements are idempotent while identical new goals get a fresh generation', () => fixture(({ submit, store }) => {
  const first = submit({ submission: { id: 'first', kind: 'goal' } })
  assert.equal(submit({ submission: { id: 'first', kind: 'goal' } }).id, first.id)
  const second = submit({ submission: { id: 'second', kind: 'goal' } })
  assert.notEqual(first.id, second.id)
  assert.equal(second.generation, 2)
  assert.equal(store.autonomousTaskBySubmission('session-A', 'deepseek', 'first').status, 'superseded')
  submit({ submission: { id: 'first', kind: 'goal' } })
  assert.equal(store.latestAutonomousTask('session-A', 'deepseek', 'conversation-A').id, second.id)
  assert.equal(store.autonomousTaskGeneration('session-A'), 2)
}))

test('a new SPA conversation binds once, and changing conversations interrupts the old goal', () => fixture(({ coordinator, submit, store }) => {
  const task = submit({ conversationId: null })
  assert.equal(task.conversationId, null)
  const bound = coordinator.context('deepseek', 'created-conversation').task
  assert.equal(bound.id, task.id)
  assert.equal(bound.generation, task.generation)
  coordinator.context('deepseek', 'other-conversation')
  assert.equal(store.latestAutonomousTask('session-A', 'deepseek', 'created-conversation').status, 'interrupted')
  assert.equal(store.latestAutonomousTask('session-A', 'deepseek', 'other-conversation'), null)
}))

test('clarification answers stay on the original task and are recorded once', () => fixture(({ coordinator, submit, store }) => {
  assert.equal(submit({ submission: { id: 'orphan-answer', kind: 'clarification' } }), null)
  const original = submit()
  const answer = { submission: { id: 'answer', kind: 'clarification' }, text: '保存到 D:\\结果，输出 xlsx。' }
  const updated = submit(answer)
  assert.equal(updated.id, original.id)
  assert.equal(updated.originalRequest, original.originalRequest)
  assert.equal(updated.inputs.length, 2)
  submit(answer)
  assert.equal(coordinator.context('deepseek', 'conversation-A').task.inputs.length, 2)
  assert.equal(store.autonomousTaskGeneration('session-A'), 1)
}))

test('restoring history is interrupted, isolated and cannot auto-start a goal', () => fixture(({ submit, store }) => {
  const original = submit()
  const restored = new TaskCoordinator('session-A', store, () => {})
  assert.equal(restored.context('deepseek', 'conversation-A').task.status, 'interrupted')
  assert.equal(restored.context('deepseek', 'conversation-A').task.id, original.id)
  assert.equal(restored.context('chatgpt', 'conversation-A').task, null)
  const other = new TaskCoordinator('session-B', store, () => {})
  assert.equal(other.context('deepseek', 'conversation-A').task, null)
  assert.equal(store.autonomousTaskGeneration('session-A'), 1)
}))

test('stopping before the conversation id exists preserves its final record; dispose interrupts intake', () => fixture(({ submit, coordinator, store }) => {
  const task = submit({ conversationId: null })
  coordinator.stop('deepseek')
  assert.equal(coordinator.context('deepseek', 'created').task.status, 'stopped')
  assert.equal(store.latestAutonomousTask('session-A', 'deepseek', 'created').id, task.id)
  submit({ conversationId: 'created' })
  coordinator.dispose()
  assert.equal(store.latestAutonomousTask('session-A', 'deepseek', 'created').status, 'interrupted')
}))

test('owner changes are rejected and a failed replacement rolls back all writes', () => fixture(({ submit, store }) => {
  const original = submit()
  assert.throws(() => store.saveAutonomousTasks([{ ...original, sessionId: 'other-session' }]), /owner-mismatch/)
  assert.throws(() => store.saveAutonomousTasks([
    { ...original, status: 'superseded' },
    { ...original, id: 'conflict', sourceSubmissionId: 'another-send' }
  ]), /UNIQUE/)
  assert.equal(store.latestAutonomousTask('session-A', 'deepseek', 'conversation-A').status, 'recorded')
  assert.equal(store.autonomousTaskGeneration('session-A'), 1)
  assert.equal(shared.parseAutonomousTask('{bad'), null)
  assert.equal(shared.parseAutonomousTask(JSON.stringify({ ...original, inputs: [] })), null)
}))

test('published snapshots cannot mutate the coordinator or persisted task', () => fixture(({ submit, events, coordinator }) => {
  const returned = submit()
  returned.originalRequest = 'tampered'
  events.at(-1).task.machine.id = 'tampered'
  const state = coordinator.context('deepseek', 'conversation-A')
  assert.notEqual(state.task.originalRequest, 'tampered')
  assert.equal(state.task.machine.id, 'machine-A')
}))

test('legacy tasks with a pending intent restore without losing requirements, inputs or ownership', () => fixture(({ submit, store, db }) => {
  const original = submit({ attachments: [{ fileName: 'data.csv', mimeType: 'text/csv', sizeBytes: 512 }] })
  submit({ submission: { id: 'legacy-answer', kind: 'clarification' }, text: '请保留原始数据，输出 xlsx。' })
  const current = store.latestAutonomousTask('session-A', 'deepseek', 'conversation-A')
  const legacy = { ...current, intent: { status: 'pending', necessaryConditions: null, expectedOutputs: null } }
  db.prepare('UPDATE autonomous_tasks SET payload = ? WHERE id = ?').run(JSON.stringify(legacy), original.id)
  const restored = store.latestAutonomousTask('session-A', 'deepseek', 'conversation-A')
  assert.deepEqual(plain(restored), plain(current))
  assert.equal(Object.hasOwn(restored, 'intent'), false)
  const coordinator = new TaskCoordinator('session-A', store, () => {})
  const history = coordinator.context('deepseek', 'conversation-A').task
  assert.equal(history.status, 'interrupted')
  assert.equal(history.id, original.id)
  assert.equal(history.generation, original.generation)
  assert.equal(history.originalRequest, original.originalRequest)
  assert.deepEqual(plain(history.inputs), plain(current.inputs))
  assert.deepEqual(plain(history.machine), plain(current.machine))
  const saved = JSON.parse(db.prepare('SELECT payload FROM autonomous_tasks WHERE id = ?').get(original.id).payload)
  assert.equal(Object.hasOwn(saved, 'intent'), false)
  assert.equal(store.autonomousTaskGeneration('session-A'), 1)
}))

test('saving a legacy task normalizes only the obsolete extraction placeholder', () => fixture(({ submit, store, db }) => {
  const original = submit()
  store.saveAutonomousTasks([{ ...original, intent: { status: 'pending', necessaryConditions: null, expectedOutputs: null } }])
  const saved = JSON.parse(db.prepare('SELECT payload FROM autonomous_tasks WHERE id = ?').get(original.id).payload)
  assert.deepEqual(saved, plain(original))
}))

function actualClass(path, className, methodNames, globals) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  assert.ok(declaration, className)
  const body = methodNames.map(name => {
    const method = declaration.members.find(node => node.name?.getText(source) === name)
    assert.ok(method, name)
    return method.getText(source)
  }).join('\n')
  return new Script(compile(`class Actual { ${body} }; Actual`)).runInNewContext({ structuredClone, ...globals })
}

test('actual page-report and session handlers create goals only for current confirmed human sends', () => fixture(({ coordinator, store }) => {
  const silent = { info() {}, warn() {} }
  const Runtime = actualClass('../src/main/session-runtime.ts', 'SessionRuntime', ['embedHandlers'], {
    process: { platform: 'win32', arch: 'x64' }, console: silent,
    supportsFocusView: id => id === 'deepseek', writeFocusDiagnostic() {}
  })
  const runtime = new Runtime()
  let rawSends = 0, humanTurns = 0
  Object.assign(runtime, {
    id: 'session-A', active: true, disposed: false, taskCoordinator: coordinator, activePlatformId: 'deepseek',
    lastSubmissions: new Map(),
    embeds: new Map([['deepseek', { conversationId: 'conversation-A' }]]),
    focusChat: { begin() { return `turn-${++humanTurns}` }, rawSent() { rawSends++ } },
    options: { localMachineId: 'machine-A' }, environment: { workingDirectory: 'C:\\old' },
    runner: { getTerminalState: () => ({ cwd: 'C:\\current' }) }, getComputerUseCapability: () => capability()
  })
  const handlers = runtime.embedHandlers({ id: 'deepseek' })
  // Reporting status is independent from task intake in this bridge fixture.
  handlers.onInterceptor = () => {}
  const Embed = actualClass('../src/main/embed.ts', 'ChatGptEmbed', ['handlePageReport'], {
    INTERCEPTOR_LOG_TAG: '[cmd-terminal] ', console: silent, writeReplyDiagnostic() {}, writePromptDiagnostic() {}
  })
  const embed = Object.assign(new Embed(), {
    handlers, platform: { id: 'deepseek' }, taskPromptGeneration: 5, userSubmissions: new Set(),
    focusSendImages: new Map(), interceptor: { pendingQuestion: null },
    liveContents: () => null, getInterceptorStatus: () => ({}), deliverUserMessage: async () => {}
  })
  const report = payload => embed.handlePageReport('[cmd-terminal] ' + JSON.stringify(payload))
  report({ event: 'send-failed' })
  report({ event: 'sent-raw', text: 'terminal result' })
  assert.equal(store.autonomousTaskGeneration('session-A'), 0)
  assert.equal(rawSends, 1)
  const goal = { event: 'user-message', submissionId: 'user:fixture:1', submissionKind: 'goal', taskPromptGeneration: 5,
    text: '整理报表并生成 Excel。' }
  report(goal)
  report(goal)
  assert.equal(humanTurns, 1)
  const first = store.latestAutonomousTask('session-A', 'deepseek', 'conversation-A')
  assert.equal(first.generation, 1)
  assert.equal(first.machine.workingDirectory, 'C:\\current')
  report({ ...goal, submissionId: 'stale', taskPromptGeneration: 4 })
  report({ ...goal, submissionId: 'file-stale', focusSendToken: 'not-an-outstanding-upload' })
  assert.equal(humanTurns, 1)
  report({ ...goal, submissionId: 'answer', submissionKind: 'clarification', text: '保存到 D:\\结果。' })
  const updated = store.latestAutonomousTask('session-A', 'deepseek', 'conversation-A')
  assert.equal(updated.id, first.id)
  assert.equal(updated.inputs.length, 2)
  assert.equal(store.autonomousTaskGeneration('session-A'), 1)
}))

test('the actual native-composer interceptor preserves multiline requirements when injecting its prefix', () => {
  const source = ts.createSourceFile('send-interceptor.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'),
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  let interceptNode, sentinelNode
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'intercept') interceptNode = node.initializer
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'USER_TEXT_SENTINEL') sentinelNode = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(interceptNode)
  assert.ok(sentinelNode)
  const sentinel = new Script('(' + sentinelNode.getText(source) + ')').runInNewContext({})
  const original = '目标：整理报表\n必要条件：\n  保留  两列原始数据\n预期产物：D:\\结果.xlsx\n'
  let draft = original, submitted
  const element = {}
  const context = {
    state: { enabled: true, promptInjectionEnabled: true, prefix: 'SYSTEM\n', taskPromptGeneration: 1,
      taskPromptInjected: false, programmatic: false, injectedCount: 0 },
    draftRejected: false, USER_TEXT_SENTINEL: sentinel, SEND_ATTEMPT_BUDGET_MS: 1000, SEND_BUTTON_GRACE_MS: 100,
    getComposer: () => element, noteUserSend() {}, hasPrefix: () => false,
    readComposer: () => draft, collapse: value => String(value).replace(/\s+/g, ' ').trim(), userTextOf: value => value,
    hasDraftImageAttachment: () => false, beginUserImageCapture: () => 'attachment-token',
    insertText: (_, text) => { draft = text; return true }, report() {}, setTimeout: fn => { fn(); return 1 },
    submitWithRetry: text => { submitted = text }
  }
  const intercept = new Script('(' + interceptNode.getText(source) + ')').runInNewContext(context)
  assert.equal(intercept({ target: element, preventDefault() {}, stopImmediatePropagation() {} }), true)
  assert.equal(submitted, 'SYSTEM\n' + sentinel + original)
  assert.doesNotMatch(submitted, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
})
