// User-run only: node --test tests/scheduled-tasks.test.mjs
// Real scheduler, SQLite, calendar arithmetic and app methods with fake clocks/views.
// No Electron launch, user profile, desktop interaction, shell processes or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8')), { filename: path }).runInNewContext({
    exports, Intl, console, AbortController, structuredClone,
    require(name) { if (Object.hasOwn(dependencies, name)) return dependencies[name]; return nodeRequire(name) }
  })
  return exports
}
const shared = load('../src/shared/scheduled-tasks.ts')
const time = load('../src/main/scheduled-task-time.ts')
const targets = load('../src/main/scheduled-task-target.ts')
const storage = load('../src/main/scheduled-task-store.ts')
const { ScheduledTasks } = load('../src/main/scheduled-tasks.ts', {
  '../shared/scheduled-tasks': shared, './scheduled-task-time': time, './scheduled-task-store': storage
})
const { ScheduledTaskTools } = load('../src/main/scheduled-task-tools.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const settleTools = () => new Promise(resolve => setImmediate(resolve))
const owner = { sessionId: 'workspace-a', platformId: 'deepseek', conversationId: 'chat-a' }
const target = { machineId: 'machine-a', transport: 'local', key: 'machine-a', cwd: 'C:\\project', label: '本机' }
const request = { type: 'scheduled_task', schedule: { kind: 'interval', minutes: 30 }, prompt: '检查服务状态。' }
const begin = Date.parse('2026-10-27T00:00:00Z')
const minute = 60_000

function fixture(t) {
  const db = new DatabaseSync(':memory:'), store = new storage.ScheduledTaskStore(db)
  let now = begin, reason = null
  const timers = new Set(), sends = [], outcomes = [], changes = [], signals = []
  const scheduler = new ScheduledTasks(store, {
    now: () => now, ready: () => reason, changed: id => changes.push(id),
    schedule(callback, delay) { const handle = { callback, delay, unref() {} }; timers.add(handle); return handle },
    cancel(handle) { timers.delete(handle) },
    async send(task, run, signal) {
      sends.push({ task: plain(task), run: plain(run) }); signals.push(signal)
      const outcome = outcomes.shift()
      return typeof outcome === 'function' ? outcome(task, run, signal) : outcome ?? { outcome: 'ok' }
    }
  })
  t.after(() => { scheduler.dispose(); db.close() })
  return { db, store, scheduler, timers, sends, outcomes, changes, signals,
    create(source = 'source-a', input = request, receipt = false) { return scheduler.create(owner, target, input, source, receipt, 'user:first') },
    setTime(value) { now = value }, setReason(value) { reason = value },
    snapshot: () => plain(store.snapshot(owner.sessionId)), async tick(value = now) { now = value; await scheduler.tick() }
  }
}

test('the request accepts only two business fields and rejects unknown context, short periods and unstable schedules', () => {
  assert.deepEqual(plain(shared.parseScheduledTaskRequest(request)), request)
  for (const bad of [ { ...request, owner }, { ...request, prompt: ' ' }, { ...request, prompt: 'x'.repeat(16001) },
    { ...request, schedule: { kind: 'interval', minutes: 0 } }, { ...request, schedule: { kind: 'interval', minutes: 1.5 } },
    { ...request, schedule: { kind: 'cron', expression: '* * * * * *', timeZone: 'Asia/Shanghai' } },
    { ...request, schedule: { kind: 'cron', expression: 'H * * * *', timeZone: 'Asia/Shanghai' } },
    { ...request, schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'invalid/zone' } } ])
    assert.equal(shared.parseScheduledTaskRequest(bad), null)
})

test('the model tool keeps legacy creation and validates management actions and partial updates', () => {
  assert.deepEqual(plain(shared.parseScheduledTaskToolRequest(request)), request)
  assert.deepEqual(plain(shared.parseScheduledTaskToolRequest({ ...request, action: 'create' })), request)
  for (const input of [
    { type: 'scheduled_task', action: 'list' },
    { type: 'scheduled_task', action: 'list', offset: 10 },
    { type: 'scheduled_task', action: 'get', id: 'task-a' },
    { type: 'scheduled_task', action: 'update', id: 'task-a', revision: 1, prompt: '新的完整描述' },
    { type: 'scheduled_task', action: 'update', id: 'task-a', revision: 1, schedule: request.schedule },
    { type: 'scheduled_task', action: 'delete', id: 'task-a', revision: 1 }
  ]) assert.ok(shared.parseScheduledTaskToolRequest(input))
  for (const input of [
    { action: 'unknown' }, { action: {} }, { action: 'list', owner }, { action: 'list', offset: -1 }, { action: 'list', offset: null },
    { action: 'get', id: '' }, { action: 'get', id: '../task' }, { action: 'delete', id: 'task-a' },
    { action: 'delete', id: 'task-a', revision: 0 }, { action: 'delete', id: 'task-a', revision: 1, prompt: 'extra' },
    { action: 'update', id: 'task-a', revision: 1 }, { action: 'update', id: 'task-a', revision: 1, prompt: ' ' },
    { action: 'update', id: 'task-a', revision: 1, prompt: 'x'.repeat(16001) },
    { action: 'update', id: 'task-a', revision: 1, schedule: { kind: 'interval', minutes: 0 } },
    { action: 'update', id: 'task-a', revision: 1, prompt: 'new', target },
    { action: 'create', ...request, owner }
  ]) assert.equal(shared.parseScheduledTaskToolRequest({ type: 'scheduled_task', ...input }), null, JSON.stringify(input).slice(0, 150))
})

test('model management lists only the original conversation and returns complete details on demand', t => {
  const f = fixture(t)
  const longPrompt = 'A'.repeat(16000)
  const task = f.create('source-long', { ...request, prompt: longPrompt })
  for (let i = 0; i < 11; i++) f.create('source-' + i)
  f.scheduler.create({ ...owner, conversationId: 'other-chat' }, target, request, 'other-chat')
  f.scheduler.create({ ...owner, platformId: 'chatgpt' }, target, request, 'other-platform')
  f.scheduler.create({ ...owner, sessionId: 'workspace-b' }, target, request, 'other-workspace')
  const list = offset => JSON.parse(f.scheduler.manage(owner, { type: 'scheduled_task', action: 'list', offset }, 'list-' + offset).split('\n')[1])
  const first = list(0), second = list(10)
  assert.equal(first.total, 12); assert.equal(first.tasks.length, 10); assert.equal(first.nextOffset, 10)
  assert.equal(second.tasks.length, 2); assert.equal(second.nextOffset, null)
  const all = [...first.tasks, ...second.tasks]
  const summary = all.find(item => item.id === task.id)
  assert.equal(summary.prompt.length, 1000); assert.equal(summary.promptTruncated, true)
  const detail = JSON.parse(f.scheduler.manage(owner, { type: 'scheduled_task', action: 'get', id: task.id }, 'get-long').split('\n')[1])
  assert.equal(detail.prompt, longPrompt); assert.equal(detail.revision, 1)
})

test('model edits retain identity, binding and unspecified fields while cancelling old queued occurrences', async t => {
  const f = fixture(t), task = f.create()
  f.setReason('busy'); f.scheduler.start(); await f.tick(begin + 30 * minute)
  const updated = f.scheduler.manage(owner, { type: 'scheduled_task', action: 'update', id: task.id, revision: 1, prompt: '检查新增 Star 用户并发送邮件。' }, 'update-a')
  assert.match(updated, /定时任务已修改/)
  let stored = f.store.get(task.id)
  assert.equal(stored.id, task.id); assert.equal(stored.revision, 2)
  assert.deepEqual(plain(stored.schedule), request.schedule)
  assert.deepEqual(plain(stored.owner), owner); assert.deepEqual(plain(stored.target), target)
  assert.equal(f.snapshot().tasks.length, 1); assert.equal(f.snapshot().runs[0].status, 'cancelled')
  assert.equal(stored.nextRunAt, begin + 60 * minute)
  assert.equal(f.scheduler.manage(owner, { type: 'scheduled_task', action: 'update', id: task.id, revision: 1, prompt: 'duplicate' }, 'update-a'), null)
  assert.equal(f.store.get(task.id).revision, 2)
  f.scheduler.act(owner.sessionId, task.id, 'pause')
  const prompt = stored.prompt
  f.scheduler.manage(owner, { type: 'scheduled_task', action: 'update', id: task.id, revision: 2, schedule: { kind: 'interval', minutes: 6 } }, 'update-b')
  stored = f.store.get(task.id)
  assert.equal(stored.prompt, prompt); assert.equal(stored.enabled, false); assert.equal(stored.revision, 3)
  assert.equal(stored.nextRunAt, begin + 36 * minute)
})

test('model management rejects stale versions, deleted ids and other conversations without mutating plans', t => {
  const f = fixture(t), task = f.create()
  const operation = { type: 'scheduled_task', action: 'delete', id: task.id, revision: 1 }
  for (const foreign of [{ ...owner, sessionId: 'other' }, { ...owner, platformId: 'chatgpt' }, { ...owner, conversationId: 'other' }]) {
    assert.match(f.scheduler.manage(foreign, operation, JSON.stringify(foreign)), /操作未完成/)
    assert.equal(f.store.get(task.id).deleted, false)
  }
  f.scheduler.edit(owner.sessionId, { owner, id: task.id, revision: 1, requestId: 'ui-edit', ...request, prompt: 'UI 已修改' })
  assert.match(f.scheduler.manage(owner, operation, 'stale-delete'), /重新查询/)
  assert.equal(f.store.get(task.id).deleted, false)
  assert.equal(f.store.get(task.id).prompt, 'UI 已修改')
  const text = f.scheduler.manage(owner, { ...operation, revision: 2 }, 'delete-a')
  assert.match(text, /定时任务已删除/); assert.equal(f.snapshot().tasks.length, 0)
  assert.equal(f.store.get(task.id).deleted, true)
  assert.equal(f.scheduler.manage(owner, { ...operation, revision: 2 }, 'delete-a'), null)
  assert.match(f.scheduler.manage(owner, { type: 'scheduled_task', action: 'update', id: task.id, revision: 2, prompt: 'restore' }, 'resurrect'), /操作未完成/)
  const restored = new ScheduledTasks(new storage.ScheduledTaskStore(f.db), { ready: () => null, send: async () => ({ outcome: 'ok' }), changed() {} })
  assert.equal(restored.manage(owner, operation, 'delete-a'), null, 'replay markers survive scheduler reconstruction')
  assert.equal(f.store.bySource('source-a').deleted, true)
  f.store.removeSession(owner.sessionId)
  assert.equal(f.store.toolResult('delete-a'), undefined)
})

test('invalid schedules and receipt persistence failures cannot partially apply model edits', async t => {
  const f = fixture(t), task = f.create()
  f.setReason('busy'); f.scheduler.start(); await f.tick(begin + 30 * minute)
  const update = { type: 'scheduled_task', action: 'update', id: task.id, revision: 1, prompt: 'changed' }
  assert.match(f.scheduler.manage(owner, { ...update, schedule: { kind: 'cron', expression: '80 9 * * *', timeZone: 'Asia/Shanghai' } }, 'bad-cron'), /操作未完成/)
  assert.equal(f.store.get(task.id).revision, 1)
  f.db.exec("CREATE TRIGGER refuse_tool_result BEFORE INSERT ON scheduled_task_tool_results BEGIN SELECT RAISE(FAIL, 'synthetic result failure'); END")
  assert.throws(() => f.scheduler.manage(owner, update, 'failed-write'), /synthetic result failure/)
  assert.equal(f.store.get(task.id).prompt, request.prompt)
  assert.equal(f.store.get(task.id).revision, 1)
  assert.equal(f.snapshot().runs[0].status, 'pending')
})

test('deleting a plan cancels queued work and aborts an in-flight submission without recreating it', async t => {
  const f = fixture(t), task = f.create()
  let finish
  f.outcomes.push(() => new Promise(resolve => { finish = resolve }))
  f.scheduler.start()
  const running = f.tick(begin + 30 * minute)
  await Promise.resolve()
  assert.match(f.scheduler.manage(owner, { type: 'scheduled_task', action: 'delete', id: task.id, revision: 1 }, 'delete-running'), /已删除/)
  assert.equal(f.signals[0].aborted, true)
  finish({ outcome: 'unknown' }); await running
  await f.tick(begin + 90 * minute)
  assert.equal(f.sends.length, 1); assert.equal(f.store.get(task.id).deleted, true)
})

test('fixed intervals retain their planned anchor across late wakeups; calendar rules retain their timezone', () => {
  assert.deepEqual(plain(time.dueScheduledTime(request.schedule, begin + 30 * minute, begin + 97 * minute)),
    { plannedAt: begin + 90 * minute, nextRunAt: begin + 120 * minute })
  assert.equal(time.nextScheduledTime({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai' }, begin), begin + 60 * minute)
  assert.equal(time.nextScheduledTime({ kind: 'cron', expression: '0 9 * * *', timeZone: 'America/New_York' }, Date.parse('2026-03-07T14:00:00Z')),
    Date.parse('2026-03-08T13:00:00Z'))
  assert.throws(() => time.nextScheduledTime({ kind: 'cron', expression: '80 9 * * *', timeZone: 'Asia/Shanghai' }, begin))
})

test('one source request creates one durable plan and one receipt; identical human wording can be scheduled separately', t => {
  const f = fixture(t)
  const first = f.create('source-a', request, true)
  assert.equal(f.create('source-a', request, true).id, first.id)
  assert.notEqual(f.create('source-b').id, first.id)
  assert.equal(f.snapshot().tasks.length, 2); assert.equal(f.snapshot().runs.length, 1)
  assert.equal(f.snapshot().runs[0].kind, 'receipt')
  assert.equal(f.sends.length, 0)
  f.scheduler.act(owner.sessionId, first.id, 'delete')
  assert.equal(f.create('source-a').deleted, true, 'an old reply cannot resurrect a deleted plan')
  assert.equal(f.snapshot().tasks.length, 1)
})

test('a due occurrence is committed before submission and successful delivery does not imply task completion', async t => {
  const f = fixture(t), task = f.create()
  f.scheduler.start()
  await f.tick(begin + 29 * minute); assert.equal(f.sends.length, 0)
  f.outcomes.push((task, run) => {
    assert.equal(f.store.run(run.id).status, 'sending')
    assert.equal(f.store.get(task.id).nextRunAt, begin + 60 * minute)
    return { outcome: 'ok', autonomousTaskId: 'actual-ai-task' }
  })
  await f.tick(begin + 30 * minute)
  const run = f.snapshot().runs[0]
  assert.equal(run.status, 'sent'); assert.equal(run.autonomousTaskId, 'actual-ai-task')
  assert.match(run.message, /执行结果请查看原对话/)
  assert.equal(f.store.get(task.id).nextRunAt, begin + 60 * minute)
  await f.tick(begin + 30 * minute); assert.equal(f.sends.length, 1)
  await f.tick(begin + 60 * minute); assert.equal(f.sends.length, 2)
})

test('sleep/restart catchup collapses missed periods, and busy drafts retain only one pending occurrence', async t => {
  const f = fixture(t), task = f.create()
  f.setReason('保留用户草稿'); f.scheduler.start()
  await f.tick(begin + 97 * minute)
  assert.equal(f.sends.length, 0); assert.equal(f.snapshot().runs.length, 1)
  assert.equal(f.snapshot().runs[0].plannedAt, begin + 90 * minute)
  assert.equal(f.snapshot().runs[0].missedSince, begin + 30 * minute)
  await f.tick(begin + 181 * minute)
  assert.equal(f.snapshot().runs.length, 1)
  assert.equal(f.snapshot().runs[0].plannedAt, begin + 180 * minute)
  assert.equal(f.store.get(task.id).nextRunAt, begin + 210 * minute)
  f.setReason(null); await f.tick()
  assert.equal(f.sends.length, 1); assert.equal(f.snapshot().runs[0].status, 'sent')
})

test('uncertain web outcomes and interrupted sending are not automatically replayed', async t => {
  const f = fixture(t), task = f.create()
  f.outcomes.push({ outcome: 'unknown' }); f.scheduler.start()
  await f.tick(begin + 30 * minute)
  assert.equal(f.snapshot().runs[0].status, 'needs-attention')
  await f.tick(begin + 90 * minute); assert.equal(f.sends.length, 1); assert.equal(f.snapshot().runs.length, 1)
  const run = f.snapshot().runs[0]
  f.scheduler.act(owner.sessionId, task.id, 'confirm-sent', run.id)
  await f.tick(begin + 120 * minute); assert.equal(f.sends.length, 2)
  f.scheduler.dispose()
  const pending = f.store.insertRun(task, begin + 150 * minute, begin, 'crashed')
  f.store.saveRun({ ...pending, status: 'sending' })
  f.scheduler.start()
  assert.equal(f.store.run(pending.id).status, 'needs-attention')
  await f.tick(begin + 150 * minute); assert.equal(f.sends.length, 2)
})

test('a busy send stays queued and retries the same occurrence when the page becomes available', async t => {
  const f = fixture(t)
  f.create(); f.outcomes.push({ outcome: 'busy', message: 'AI 正在生成，等待当前回复结束。' }); f.scheduler.start()
  await f.tick(begin + 30 * minute)
  const queued = f.snapshot().runs[0]
  assert.equal(f.sends.length, 1); assert.equal(queued.status, 'pending')
  assert.match(queued.message, /AI 正在生成/)
  assert.equal([...f.timers][0].delay, 10_000)
  await f.tick(begin + 30 * minute + 10_000)
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].run.id, queued.id)
  assert.equal(f.snapshot().runs.length, 1); assert.equal(f.snapshot().runs[0].status, 'sent')
  await f.tick(); assert.equal(f.sends.length, 2, 'a confirmed send must not be replayed')
})

test('known pre-submit busy is retried; pausing cancels queued work and resume starts a fresh interval', async t => {
  const f = fixture(t), task = f.create()
  f.outcomes.push({ outcome: 'busy' }); f.scheduler.start()
  await f.tick(begin + 30 * minute); assert.equal(f.snapshot().runs[0].status, 'pending')
  f.scheduler.act(owner.sessionId, task.id, 'pause')
  assert.equal(f.snapshot().runs[0].status, 'cancelled')
  await f.tick(begin + 60 * minute); assert.equal(f.sends.length, 1)
  f.scheduler.act(owner.sessionId, task.id, 'resume')
  assert.equal(f.store.get(task.id).nextRunAt, begin + 90 * minute)
  await f.tick(begin + 89 * minute); assert.equal(f.sends.length, 1)
})

test('edits preserve the original execution binding, cancel old queued work, and reject stale revisions', async t => {
  const f = fixture(t), task = f.create()
  f.setReason('原会话未选中'); f.scheduler.start(); await f.tick(begin + 30 * minute)
  const edited = f.scheduler.edit(owner.sessionId, { owner: { ...owner, conversationId: 'other-chat' }, id: task.id,
    revision: task.revision, requestId: 'edit-a', schedule: { kind: 'interval', minutes: 60 }, prompt: '新任务' })
  assert.equal(edited.revision, 2); assert.deepEqual(plain(edited.owner), owner); assert.deepEqual(plain(edited.target), target)
  assert.equal(f.snapshot().runs[0].status, 'cancelled')
  assert.throws(() => f.scheduler.edit(owner.sessionId, { id: task.id, revision: 1, ...request }), /已被修改/)
  assert.throws(() => f.scheduler.act('wrong-session', task.id, 'delete'), /不属于/)
})

test('pausing during an outstanding submission aborts it and retains an uncertain result', async t => {
  const f = fixture(t), task = f.create()
  let finish
  f.outcomes.push((_task, _run, signal) => new Promise(resolve => { finish = resolve; assert.equal(signal.aborted, false) }))
  f.scheduler.start()
  const running = f.tick(begin + 30 * minute)
  await Promise.resolve()
  f.scheduler.act(owner.sessionId, task.id, 'pause')
  assert.equal(f.signals[0].aborted, true)
  finish({ outcome: 'unknown' }); await running
  assert.equal(f.snapshot().runs[0].status, 'needs-attention')
})

test('a failed occurrence transaction cannot leave a partial run or advance the schedule', async t => {
  const f = fixture(t), task = f.create()
  f.db.exec("CREATE TRIGGER refuse_advance BEFORE UPDATE ON scheduled_tasks BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END")
  f.scheduler.start(); await f.tick(begin + 30 * minute)
  assert.equal(f.snapshot().runs.length, 0)
  assert.equal(f.store.get(task.id).nextRunAt, task.nextRunAt)
  assert.equal(f.sends.length, 0)
})

test('an unresponsive renderer times out as uncertain without blocking scheduling or accepting a late positive result', async t => {
  const f = fixture(t)
  f.create()
  let finish
  f.outcomes.push(() => new Promise(resolve => { finish = resolve }))
  f.scheduler.start()
  const sending = f.tick(begin + 30 * minute)
  await Promise.resolve()
  const deadline = [...f.timers].find(timer => timer.delay === 20_000)
  assert.ok(deadline); deadline.callback()
  await sending
  assert.equal(f.signals[0].aborted, true)
  assert.equal(f.snapshot().runs[0].status, 'needs-attention')
  finish({ outcome: 'ok' }); await Promise.resolve()
  assert.equal(f.snapshot().runs[0].status, 'needs-attention')
  await f.tick(begin + 60 * minute); assert.equal(f.sends.length, 1)
})

test('wakeup uses the nearest occurrence and bounds long waits; the indexed schedule lookup survives clock rollback', async t => {
  const f = fixture(t), task = f.create()
  f.scheduler.start(); await f.tick(begin + 29 * minute + 59_000)
  assert.equal([...f.timers][0].delay, 1000)
  await f.tick(begin - 60 * minute)
  assert.equal([...f.timers][0].delay, 60_000)
  assert.equal(f.store.get(task.id).nextRunAt, task.nextRunAt)
  const plan = f.db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM scheduled_tasks WHERE enabled=1 AND deleted=0 AND next_run_at<=? ORDER BY next_run_at').all(begin)
  assert.ok(plan.some(row => row.detail.includes('idx_scheduled_due')))
})

test('manual runs retain cadence, block duplicate pending work and session removal cleans only the owner', t => {
  const f = fixture(t), task = f.create()
  f.scheduler.act(owner.sessionId, task.id, 'run')
  assert.equal(f.store.get(task.id).nextRunAt, task.nextRunAt)
  assert.throws(() => f.scheduler.act(owner.sessionId, task.id, 'run'), /已有/)
  f.scheduler.create({ ...owner, sessionId: 'workspace-b' }, target, request, 'source-b')
  f.store.removeSession(owner.sessionId)
  assert.equal(f.snapshot().tasks.length, 0); assert.equal(f.store.runs().length, 0)
  assert.equal(f.store.snapshot('workspace-b').tasks.length, 1)
})

test('execution target identity respects Windows aliases and case-sensitive POSIX paths', () => {
  assert.equal(targets.sameScheduledTarget(target, { ...target, cwd: 'c:/PROJECT/' }), true)
  assert.equal(targets.sameScheduledTarget(target, { ...target, key: 'different-machine' }), false)
  const remote = { ...target, transport: 'ssh', key: 'host-a', cwd: '/srv/Project' }
  assert.equal(targets.sameScheduledTarget(remote, { ...remote, cwd: '/srv/Project/' }), true)
  assert.equal(targets.sameScheduledTarget(remote, { ...remote, cwd: '/srv/project' }), false)
})

function methods(path, className, names, globals = {}) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  const body = names.map(name => declaration.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
  return new Script(compile(`class Actual { ${body} }; Actual`)).runInNewContext({ structuredClone, AbortController, console, ...globals })
}

test('scheduled transport restores confirmed conversation prompt history without recording prepared or failed injections', async () => {
  const recorded = new Set(), sends = []
  const Embed = methods('../src/main/embed.ts', 'ChatGptEmbed', ['handlePageReport', 'sendScheduledUser'], {
    URL, INTERCEPTOR_LOG_TAG: '[cmd-terminal] ', writeReplyDiagnostic() {}, writePromptDiagnostic() {},
    conversationIdOf: (platform, url) => platform.conversationIdFromPath(new URL(url).pathname)
  })
  const contents = { id: 1, isDestroyed: () => false, getURL: () => 'https://chat.deepseek.com/a/chat/s/chat-a',
    executeJavaScript: script => new Script(script).runInNewContext({ window: { __cmdTerminalInterceptor: {
      sendScheduledUser: (...args) => { sends.push(args); return 'ok' }
    } } }) }
  const embed = Object.assign(new Embed(), {
    taskPromptGeneration: 1, computerPageEpoch: 'page-a', taskPromptInjected: false,
    platform: { id: 'deepseek', homeUrl: 'https://chat.deepseek.com/', conversationIdFromPath: path => path.split('/').at(-1) },
    interceptor: { prefix: 'system and tools', injectedCount: 0, taskStartedAt: null, taskFinishedAt: null },
    liveContents: () => contents, getInterceptorStatus: () => ({}), handlers: {
      onInterceptor() {}, hasConversationPrompt: id => recorded.has(id), onPromptInjected: id => recorded.add(id)
    }
  })
  const report = event => embed.handlePageReport('[cmd-terminal] ' + JSON.stringify(event))
  report({ event: 'injected' }); report({ event: 'send-failed' })
  assert.equal(recorded.size, 0, 'writing a prefix or failing to send cannot establish prompt history')
  report({ event: 'sent', promptInjected: true, taskPromptGeneration: 0 })
  report({ event: 'sent', promptInjected: false, taskPromptGeneration: 1 })
  assert.equal(recorded.size, 0)
  await embed.sendScheduledUser('first task', 'chat-a', 'run-first', new AbortController().signal, () => true)
  assert.equal(sends[0][3], false)
  report({ event: 'sent', promptInjected: true, taskPromptGeneration: 1 })
  assert.equal(recorded.has('chat-a'), true)
  embed.taskPromptInjected = false; embed.taskPromptGeneration++
  await embed.sendScheduledUser('next task', 'chat-a', 'run-next', new AbortController().signal, () => true)
  assert.equal(sends[1][3], true, 'task completion must not discard conversation prompt history')
  recorded.clear()
  report({ event: 'sent', promptInjected: false, conversationPromptInjected: true, taskPromptGeneration: 2 })
  assert.equal(recorded.has('chat-a'), true, 'confirmed reuse upgrades older rendered history to a durable record')
})

test('runtime checks send availability and owner controls without waiting for AI task completion', () => {
  const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', ['scheduledTaskReady', 'canRunConversationInBackground'], {
    taskPausedByInput: task => task?.paused === true, computerUseSendBlock: () => null, sameScheduledTarget: targets.sameScheduledTarget
  })
  const task = { ...request, owner, target }, run = { kind: 'task' }
  const subject = Object.assign(new Runtime(), { id: owner.sessionId, active: true, activePlatformId: owner.platformId, taskEnded: true,
    embed: { getState: () => ({ conversationId: owner.conversationId }), getInterceptorStatus: () => ({ enabled: true, installed: true, promptInjectionEnabled: true, taskStartedAt: begin, taskFinishedAt: null }) },
    runner: { getAutomation: () => ({ paused: false }), hasInFlightWork: () => false }, backgroundTaskResults: { isSending: false },
    taskCoordinator: { latest: () => null, waitingForUser: () => false }, options: {}, toolPreferences: () => ({ scheduledTasksEnabled: true }),
    scheduledTarget: () => target, getComputerUseCapability: () => ({}), taskRunning: () => false })
  assert.equal(subject.scheduledTaskReady(task, run), null)
  subject.active = false; assert.equal(subject.scheduledTaskReady(task, run), null, 'terminal schedules run without selecting their workspace')
  subject.getComputerUseCapability = () => ({ scopeSupported: true, computerUseEnabled: true })
  assert.match(subject.scheduledTaskReady(task, run), /工作区/, 'desktop-tool tasks still require the selected workspace')
  subject.getComputerUseCapability = () => ({}); subject.active = true
  subject.options.automationBlocked = () => true; assert.match(subject.scheduledTaskReady(task, run), /急停/); delete subject.options.automationBlocked
  subject.options.desktopCoordinator = { getState: () => ({ humanControl: true }) }; assert.match(subject.scheduledTaskReady(task, run), /接管/); delete subject.options.desktopCoordinator
  subject.scheduledTarget = () => ({ ...target, cwd: 'C:\\other' }); assert.match(subject.scheduledTaskReady(task, run), /工作目录/)
  subject.scheduledTarget = () => target; subject.taskEnded = false; subject.taskRunning = () => true
  assert.equal(subject.scheduledTaskReady(task, run), null, 'an unfinished AI task must not block an available send channel')
  subject.runner.hasInFlightWork = () => true; assert.match(subject.scheduledTaskReady(task, run), /发送或工具执行/)
  subject.runner.hasInFlightWork = () => false; subject.focusSending = true; assert.match(subject.scheduledTaskReady(task, run), /发送或工具执行/)
  subject.focusSending = false; assert.equal(subject.scheduledTaskReady(task, run), null)
})

test('a confirmed scheduled goal starts a fresh task without releasing human control; unowned acknowledgements are ignored', () => {
  let released = 0, submissions = 0
  const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', ['embedHandlers'], {
    process: { platform: 'win32', arch: 'x64' }, supportsFocusView: () => false, taskPausedByInput: () => false
  })
  const marker = { task: { ...request, owner, target }, runId: 'run-a', text: 'scheduled goal', autonomousTaskId: null }
  const subject = Object.assign(new Runtime(), { active: true, disposed: false, taskEnded: true, activePlatformId: owner.platformId,
    scheduledSubmission: marker, scheduledOwnerCurrent: () => true, lastSubmissions: new Map(),
    embeds: new Map([[owner.platformId, { conversationId: owner.conversationId }]]), focusChat: { begin: () => 'turn-a' }, environment: {},
    taskCoordinator: { context: () => ({ task: null }), waitingForUser: () => false,
      submit(input) { submissions++; assert.equal(input.resume, undefined); return { id: 'new-task-a', status: 'recorded' } }, fail() { throw new Error('unexpected failure') } },
    getComputerUseCapability: () => ({}), runner: { getTerminalState: () => ({ cwd: target.cwd }) },
    options: { localMachineId: target.machineId, desktopCoordinator: { canReleaseHumanControl: () => true, releaseHumanControl() { released++ } } }
  })
  const intake = subject.embedHandlers({ id: owner.platformId }).onUserStarted
  assert.equal(intake(marker.text, [], undefined, { id: 'user:scheduled:run-a', kind: 'goal' }, 'run-a'), 'turn-a')
  assert.equal(submissions, 1); assert.equal(released, 0); assert.equal(subject.taskEnded, false)
  assert.equal(marker.autonomousTaskId, 'new-task-a')
  subject.scheduledSubmission = null
  assert.equal(intake(marker.text, [], undefined, { id: 'user:scheduled:unowned', kind: 'goal' }, 'unowned'), undefined)
  assert.equal(submissions, 1)
})

test('model-created plans take their owner from the live app and reject stale epochs, sources and injected owner fields', () => {
  const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', ['receiveScheduledTask'], {
    parseScheduledTaskToolRequest: shared.parseScheduledTaskToolRequest, sameConversationToolsOwner: (a, b) => JSON.stringify(a) === JSON.stringify(b)
  })
  const calls = [], errors = [], notes = []
  let scheduledTasksEnabled = true
  const subject = Object.assign(new Runtime(), { active: true, disposed: false, taskEnded: false, activePlatformId: owner.platformId,
    observeFocusTool: () => undefined,
    options: { scheduledTasks: { create(...args) { calls.push(args) } } }, lastSubmissions: new Map([[owner.platformId, 'user:first']]),
    embed: { getComputerUsePageEpoch: () => 'epoch-a', getState: () => ({ conversationId: owner.conversationId }),
      async sendTaskResult(text) { errors.push(text); return 'ok' } },
    runner: { getAutomation: () => ({ paused: false }), refreshTerminal: note => notes.push(note) },
    toolPreferences: () => ({ scheduledTasksEnabled }), scheduledTarget: () => target, toolsOwner: () => owner
  })
  const call = { messageId: 'reply-a', rawJson: JSON.stringify(request), conversationId: owner.conversationId, pageEpoch: 'epoch-a', sourceSubmissionId: 'user:first' }
  subject.receiveScheduledTask(call)
  assert.equal(calls.length, 1); assert.deepEqual(plain(calls[0][0]), owner); assert.deepEqual(plain(calls[0][1]), target)
  assert.equal(notes.length, 0)
  subject.receiveScheduledTask({ ...call, pageEpoch: 'old' })
  subject.receiveScheduledTask({ ...call, sourceSubmissionId: 'user:old' })
  assert.equal(errors.length, 0, 'stale requests are never answered to the AI')
  assert.deepEqual(notes, ['定时任务请求未处理：原对话已切换。', '定时任务请求未处理：该请求不属于最新一次发送。'])
  subject.receiveScheduledTask({ ...call, rawJson: JSON.stringify({ ...request, owner: { sessionId: 'wrong' } }) })
  assert.equal(calls.length, 1); assert.equal(errors.length, 1)
  assert.match(errors[0], /^【定时任务操作未完成】\n定时任务参数无效/)
  scheduledTasksEnabled = false
  subject.receiveScheduledTask(call)
  assert.equal(calls.length, 1); assert.equal(errors.length, 2)
  assert.match(errors[1], /已关闭定时任务工具/)
  assert.match(notes.at(-1), /^定时任务操作未完成：当前对话已关闭定时任务工具/)
})

test('live model requests query, update and delete the saved plan and deliver deletion receipts independently', async t => {
  const f = fixture(t), task = f.create(), replies = [], notes = []
  const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', ['receiveScheduledTask', 'toolPromptReadCurrent'], {
    parseScheduledTaskToolRequest: shared.parseScheduledTaskToolRequest,
    sameConversationToolsOwner: (a, b) => JSON.stringify(a) === JSON.stringify(b), taskPausedByInput: () => false
  })
  let humanControl = false, enabled = true
  const subject = Object.assign(new Runtime(), { id: owner.sessionId, active: true, disposed: false, taskEnded: false, activePlatformId: owner.platformId,
    observeFocusTool: () => undefined,
    options: { scheduledTasks: f.scheduler, desktopCoordinator: { getState: () => ({ humanControl }) } },
    lastSubmissions: new Map([[owner.platformId, 'user:first']]),
    embed: { getComputerUsePageEpoch: () => 'epoch-a', getState: () => ({ conversationId: owner.conversationId }),
      getInterceptorStatus: () => ({ enabled: true }), async sendTaskResult(text) { replies.push(text); return 'ok' } },
    runner: { getAutomation: () => ({ paused: false }), refreshTerminal: note => notes.push(note) },
    taskCoordinator: { latest: () => null, waitingForUser: () => false },
    toolPreferences: () => ({ scheduledTasksEnabled: enabled }), toolsOwner: () => owner,
    scheduledTarget() { throw new Error('management must not capture a new execution target') }
  })
  subject.scheduledTaskTools = new ScheduledTaskTools({
    current: call => enabled && subject.toolPromptReadCurrent(call),
    send: async (text, call, signal, current) => current() && !signal.aborted ? subject.embed.sendTaskResult(text) : 'cancelled',
    note: text => notes.push(text)
  })
  t.after(() => subject.scheduledTaskTools.cancel())
  let messageNumber = 0
  const call = action => ({ messageId: 'reply-' + ++messageNumber, rawJson: JSON.stringify({ type: 'scheduled_task', ...action }),
    conversationId: owner.conversationId, pageEpoch: 'epoch-a', sourceSubmissionId: 'user:first' })
  for (const action of [{ action: 'list' }, { action: 'get', id: task.id },
    { action: 'update', id: task.id, revision: 1, prompt: '在原任务追加新增用户和北京时间。' },
    { action: 'delete', id: task.id, revision: 2 }]) {
    subject.receiveScheduledTask(call(action))
    await settleTools()
  }
  assert.equal(replies.length, 4)
  assert.match(replies[0], /定时任务列表/); assert.match(replies[1], /定时任务详情/)
  assert.match(replies[2], /定时任务已修改/); assert.match(replies[3], /定时任务已删除/)
  assert.equal(f.store.get(task.id).deleted, true); assert.equal(f.snapshot().tasks.length, 0)
  const other = f.create('other-source')
  humanControl = true
  subject.receiveScheduledTask(call({ action: 'update', id: other.id, revision: 1, prompt: 'blocked' }))
  assert.equal(f.store.get(other.id).revision, 1)
  humanControl = false
  subject.receiveScheduledTask({ ...call({ action: 'delete', id: other.id, revision: 1 }), sourceSubmissionId: 'old-source' })
  subject.receiveScheduledTask({ ...call({ action: 'delete', id: other.id, revision: 1 }), pageEpoch: 'old-epoch' })
  assert.equal(f.store.get(other.id).deleted, false)
  assert.equal(replies.length, 4)
})

test('management result delivery retries busy pages without repeating changes and never retries uncertain sends', async t => {
  const f = fixture(t), task = f.create(), sends = [], timers = [], outcomes = ['busy', 'ok'], notes = []
  let current = true, executions = 0
  const tools = new ScheduledTaskTools({ current: () => current,
    async send(text, _call, signal, guard) { sends.push({ text, signal, guard }); return outcomes.shift() ?? 'ok' },
    note: text => notes.push(text), schedule(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer },
    cancel(timer) { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1) }
  })
  t.after(() => tools.cancel())
  const call = { messageId: 'delete-a', rawJson: '', conversationId: owner.conversationId, pageEpoch: 'a', sourceSubmissionId: 'first' }
  const execute = () => { executions++; return f.scheduler.manage(owner, { type: 'scheduled_task', action: 'delete', id: task.id, revision: 1 }, 'delete-a') }
  tools.receive(call, execute)
  await settleTools()
  assert.equal(f.store.get(task.id).deleted, true); assert.equal(tools.busy, true)
  tools.receive(call, execute); assert.equal(executions, 1)
  timers.shift().callback(); await settleTools()
  assert.equal(sends.length, 2); assert.equal(executions, 1); assert.equal(tools.busy, false)
  assert.match(sends[1].text, /已删除/)
  tools.receive(call, execute); assert.equal(sends.length, 2, 'durable duplicates do not resend receipts')
  outcomes.push('unknown')
  tools.receive({ ...call, messageId: 'list-a' }, () => 'query result')
  await settleTools()
  assert.equal(tools.busy, false); assert.equal(timers.length, 0)
  assert.match(notes.at(-1), /不会自动重复变更/)
  outcomes.push('busy')
  tools.receive({ ...call, messageId: 'list-b' }, () => 'query result')
  await settleTools()
  const pending = sends.at(-1)
  current = false; tools.reconcile()
  assert.equal(pending.signal.aborted, true); assert.equal(pending.guard(), false); assert.equal(timers.length, 0)
  assert.equal(tools.busy, false)
  tools.receive(call, () => { throw new Error('stale calls must not execute') })
})

test('the focus view describes scheduled management actions without exposing transport JSON', () => {
  const focus = load('../src/shared/focus-chat.ts')
  for (const [action, label] of [['create', '创建'], ['list', '查询'], ['get', '查询'], ['update', '修改'], ['delete', '删除']]) {
    assert.equal(focus.cleanFocusAnswer('```json\n' + JSON.stringify({ type: 'scheduled_task', action }) + '\n```'), `正在${label}定时任务`)
  }
  assert.equal(focus.cleanFocusAnswer(JSON.stringify(request)), '正在创建定时任务')
  assert.equal(focus.cleanFocusAnswer('{"type":"scheduled_task","action":"upd'), '')
})

test('a plan requested after the user answers a question carries that answer as its source, like other tools', () => {
  // The answer is a clarification submission; main records it as the latest send and admits only that source.
  const page = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
  const branch = page.slice(page.indexOf('if (looksLikeScheduledReply(text)) {'), page.indexOf("report({ event: 'scheduled-task'"))
  assert.match(branch, /const sourceSubmissionId = mailSourceSubmissionId\b/)
  assert.match(page, /if \(event\.event === 'user-message'\) \{\s*mailSourceSubmissionId = event\.submissionId/)
})

test('the page preserves user drafts and scheduled identities; automatic task sources remain compatible with tool provenance', async () => {
  const ast = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  function find(node, predicate) { if (predicate(node)) return node; return ts.forEachChild(node, child => find(child, predicate)) }
  const context = createContext({ computerResultToken: null, state: { enabled: true, prefix: 'system', promptInjectionEnabled: true, taskPromptGeneration: 1, taskPromptInjected: false, awaitingReplySince: 0 },
    getComposer: () => ({}), location: { pathname: '/a/chat/s/chat-a' }, fileSend: null, lastUserSendBlock: null,
    findStopButton: () => null, collapse: value => value.trim(), readComposer: () => 'user draft', report() {} })
  const sendNode = find(ast, node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'sendUser')
  const send = new Script('({' + sendNode.getText(ast) + '})').runInContext(context).sendUser
  assert.equal(await send.call({}, 'scheduled goal', '/a/chat/s/chat-a', { scheduledRunId: 'run-a', computerResultToken: 'scheduled:run-a' }), 'busy')
  assert.equal(context.lastUserSendBlock, 'text-draft')
  const Embed = methods('../src/main/embed.ts', 'ChatGptEmbed', ['taskActionSource'], { URL })
  const embed = Object.assign(new Embed(), { platform: { page: { computerUseRequests: true }, allowedOriginPattern: /^https:\/\/chat.deepseek.com\//,
    conversationIdFromPath: () => 'chat-a' }, computerUseRecognitionEnabled: true, taskPromptGeneration: 1,
    liveContents: () => ({ getURL: () => 'https://chat.deepseek.com/a/chat/s/chat-a' }) })
  assert.equal(embed.taskActionSource({ live: true, taskPromptGeneration: 1, sourceSubmissionId: 'user:scheduled:run-a', pagePath: '/a/chat/s/chat-a' }).sourceSubmissionId,
    'user:scheduled:run-a')
})
