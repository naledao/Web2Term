import { progressVmModules } from './progress-vm-modules.mjs'
// User-run only: node --test tests/computer-action-dedup.test.mjs
// Actual SQLite schema/store, coordinator and progression with synthetic actions/results.
// No Electron, user DB, helper, desktop, real shell, network or process is started.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, structuredClone, AbortController,
    require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name]; if (name === '../shared/computer-diagnostics') return load('../../src/shared/computer-diagnostics.ts'); assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] } })
  return exports
}
const shared = load('../../src/shared/autonomous-task.ts'), actions = load('../../src/shared/computer-actions.ts')
const { TaskCoordinator } = load('../../src/main/task-coordinator.ts', { 'node:crypto': crypto, '../shared/computer-actions': actions })
const { TaskProgression } = load('../../src/main/task-progression.ts', { 'node:crypto': crypto })
const source = readFileSync(new URL('../../src/main/db.ts', import.meta.url), 'utf8')
const schema = ['autonomous_tasks', 'computer_action_claims', 'computer_actions', 'computer_observations'].map(table => source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\);`))[0]).join('\n')
const ast = ts.createSourceFile('db.ts', source, ts.ScriptTarget.ES2022, true)
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ConversationStore')
const body = ['autonomousTaskGeneration', 'latestAutonomousTask', 'autonomousTaskBySubmission', 'saveAutonomousTasks', 'hasComputerAction', 'listComputerActions']
  .map(name => declaration.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
const storage = load('../../src/main/computer-action-storage.ts')
const recovery = load('../../src/main/computer-recovery.ts', { '../shared/autonomous-task': shared })
const diagnostics = load('../../src/shared/computer-diagnostics.ts')
const Store = new Script(compile(`class Store { constructor(db) { this.db = db } ${body} }\nStore`)).runInNewContext({ ...shared, ...actions, ...storage, createHash: crypto.createHash })
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

export function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); db.exec(schema); db.exec(schema)
  const store = new Store(db), executions = [], sends = [], errors = [], timers = [], released = [], deliveries = []
  let loop, serial = 0, answer = 0, paused = false
  const coordinator = new TaskCoordinator('session-a', store, () => loop?.reconcile(), options.clock)
  const submit = (patch = {}) => coordinator.submit({ platformId: 'deepseek', conversationId: 'chat-a', submission: { id: `user:goal:${++serial}`, kind: 'goal' },
    text: '发现并检查桌面应用。', attachments: [], machine: { id: 'machine-a', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\work' },
    capability: { scopeSupported: true, computerUseEnabled: true, computerUseLimits: options.limits, context: { sessionId: 'session-a', platformId: 'deepseek' } }, ...patch })
  const first = submit()
  const lease = () => { const task = coordinator.current('deepseek'); return { sessionId: task.sessionId, platformId: task.platformId,
    conversationId: task.conversationId, taskId: task.id, generation: task.generation } }
  const request = (patch = {}) => {
    const stepToken = coordinator.computerStepToken('deepseek'), sourceMessageId = `computer:synthetic:${++answer}`
    const action = options.action ?? 'observe', parameters = options.parameters ?? { target: 'desktop' }
    return { ...lease(), sourceMessageId, stepToken,
      call: { action, parameters },
      receipt: { messageId: sourceMessageId, sourceSubmissionId: coordinator.current('deepseek').sourceSubmissionId,
        pagePath: '/a/chat/s/chat-a', pageEpoch: 'document-a', taskPromptGeneration: 1, outcome: 'candidate', issue: null,
        rawJson: JSON.stringify({ type: 'computer', version: 1, action, ...parameters, step_token: stepToken }) }, ...patch }
  }
  loop = new TaskProgression({ coordinator, isCurrent: () => true, canRun: () => !paused,
    acquire: options.acquire, scheduleDeadline: options.scheduleDeadline ?? options.clock?.schedule,
    continuity: options.continuity, diagnosticContext: options.diagnosticContext,
    invoke: async (call, owner, signal, step) => {
      const saved = db.prepare('SELECT * FROM computer_action_claims WHERE execution_id = ?').get(step.id)
      assert.ok(saved, 'the actual immutable request is committed before any executor is called')
      assert.equal(coordinator.current('deepseek').progress.currentStep.status, 'executing')
      assert.equal(saved.request_hash, crypto.createHash('sha256').update(saved.request_json).digest('hex'))
      assert.deepEqual(JSON.parse(saved.request_json).call, plain(call))
      executions.push({ call, owner, signal, step })
      return options.execute ? options.execute(call, signal) : { type: 'computer_result', version: 1, action: call.action, ok: true, code: 'ok', execution: 'executed', message: 'Synthetic observation' }
    },
    async send(text, owner, signal, attachments) {
      sends.push(JSON.parse(text)); deliveries.push({ text, owner, signal, attachments })
      return options.send ? options.send(text, owner, signal, attachments) : 'ok'
    },
    release(attachments, owner) { released.push({ attachments, owner }) },
    schedule(callback) { const timer = { callback, active: true }; timers.push(timer); return () => { timer.active = false } },
    onError(owner) { errors.push(owner); coordinator.fail(owner.platformId, owner.conversationId) }
  })
  t.after(() => { loop.dispose(); coordinator.dispose(); db.close() })
  return { db, store, coordinator, loop, executions, sends, errors, request, first, submit, lease, released, deliveries,
    state: () => db.prepare('SELECT * FROM computer_actions ORDER BY rowid DESC LIMIT 1').get(),
    observations: () => db.prepare('SELECT * FROM computer_observations ORDER BY rowid').all(),
    claims: () => db.prepare('SELECT * FROM computer_action_claims ORDER BY rowid').all(),
    payload: () => db.prepare('SELECT payload FROM autonomous_tasks WHERE id = ?').get(first.id).payload,
    pause(value) { paused = value },
    async run(value = request()) { const outcome = loop.enqueue(value); await loop.wake(); return outcome },
    async retry() { const timer = timers.find(item => item.active); assert.ok(timer); timer.active = false; timer.callback(); await loop.wake() }
  }
}


export { actions, plain, deferred, recovery, shared, TaskCoordinator, diagnostics }
