// User-run only: node --test tests/conversation-continuity.test.mjs
// Real lineage, context accounting and runtime adoption with an in-memory store. No Electron/network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), modules = new Map()
function load(path) {
  path = resolve(root, path)
  if (modules.has(path)) return modules.get(path)
  const exports = {}
  modules.set(path, exports)
  new Script(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, { filename: path }).runInNewContext({ exports, URL, require(name) {
    assert.ok(name.startsWith('.'), 'No service or Electron dependency: ' + name)
    return load(resolve(dirname(path), name + '.ts'))
  } })
  return exports
}
const { ConversationContinuity, compactionViewKey } = load('src/main/conversation-continuity.ts')
const shared = load('src/shared/conversation-compaction.ts')
const { estimateFocusConversation, estimateContextText } = load('src/shared/focus-token-usage.ts')
const { emptyContextUsage } = load('src/shared/context-usage.ts')
const { selectionQuestionConversation } = load('src/shared/deepseek-question.ts')
const physicalA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', physicalC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const physicalE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const jobOne = '11111111-1111-4111-8111-111111111111', jobTwo = '22222222-2222-4222-8222-222222222222'
const owner = (conversationId = physicalA, platformId = 'chatgpt') => ({ sessionId: 'workspace', platformId, conversationId })
const message = (id, conversationId, role = 'user', content = id, sourceMessageId = null) => ({ id, conversationId, role, content, sourceMessageId, attachments: [], createdAt: 100 })
const turn = (id, userMessageId, userText = id) => ({ id, userMessageId, userText, createdAt: 100, updatedAt: 101, status: 'answered',
  segments: [{ cycle: 0, sourceMessageId: id + ':answer', answer: '回答', parts: [], settled: true }], executionIds: [], deliveries: {} })
const job = (source = physicalA, target = physicalC, id = jobOne, platformId = 'chatgpt') => ({ version: 1,
  state: { id, owner: owner(source, platformId), hasSummary: true, createdAt: 200, targetSessionId: 'workspace' },
  handoffUrl: platformId === 'chatgpt' ? 'https://chatgpt.com/c/' + target : 'https://chat.deepseek.com/a/chat/s/' + target,
  handoffAnswer: '已接收，等待下一条消息。', handoffReplyId: 'native:' + id,
  seed: { session: { title: '原来的标题' }, preferences: { fileReadingEnabled: true } } })
function fixture() {
  const settings = new Map(), messages = new Map(), turns = new Map(), executions = new Map(), usage = new Map()
  let serial = 0
  const store = { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => settings.set(key, value),
    listManagedSessions: () => [{ id: 'workspace' }], listConversationMessages: id => messages.get(id) ?? [],
    listFocusTurns: (_session, _platform, id) => turns.get(id) ?? [], listExecutions: id => executions.get(id) ?? [],
    appendConversationMessage(id, role, content, source, at = 201) {
      const rows = messages.get(id) ?? []
      if (rows.some(row => row.sourceMessageId === source)) return null
      const row = { ...message('saved:' + (++serial), id, role, content, source), createdAt: at }
      rows.push(row); messages.set(id, rows); return row.id
    }, contextUsage: { save: (platform, entry) => usage.set(platform + ':' + entry.id, entry) } }
  messages.set(physicalA, [message('old-user', physicalA), message('old-answer', physicalA, 'assistant', '旧回答', 'old-turn:answer')])
  turns.set(physicalA, [turn('old-turn', 'old-user')])
  executions.set(physicalA, [{ messageId: 'build', conversationId: physicalA, status: 'done', command: 'npm run build', output: '完整输出', exitCode: 0 }])
  const continuity = new ConversationContinuity('workspace', store)
  return { settings, messages, turns, executions, usage, store, continuity }
}
const plain = value => JSON.parse(JSON.stringify(value))

test('both supported platforms retain the original local view identity', () => {
  for (const platform of ['chatgpt', 'deepseek']) {
    const f = fixture()
    f.continuity.install(job(physicalA, physicalC, jobOne, platform), '# 摘要')
    assert.equal(f.continuity.root(platform, physicalC), physicalA)
    assert.deepEqual(Array.from(f.continuity.displayMessages(platform, physicalC), row => row.id), ['old-user', 'old-answer'])
    assert.equal(f.continuity.decorate({ conversationId: physicalC }, platform).viewConversationId, physicalA)
  }
})

test('compression annotations are persistent local boundaries, once per successful handoff, never model messages', () => {
  const f = fixture(), first = job()
  first.state.updatedAt = 300
  first.budget = shared.compactionBudget(5100)
  f.continuity.install(first, '# 摘要一')
  const boundary = f.continuity.history('chatgpt', physicalC).compactions[0]
  assert.equal(boundary.id, 'compaction:' + jobOne)
  assert.equal(boundary.createdAt, 300)
  assert.equal(boundary.beforeTokens, 5100)
  assert.ok(boundary.afterTokens > 0)
  f.messages.get(physicalC).push({ ...message('middle', physicalC), createdAt: 400 })
  const second = job(physicalC, physicalE, jobTwo)
  second.state.updatedAt = 500
  f.continuity.install(second, '# 摘要二')
  const restored = new ConversationContinuity('workspace', f.store)
  const annotations = restored.history('chatgpt', physicalE).compactions
  assert.deepEqual(Array.from(annotations, item => item.id), ['compaction:' + jobOne, 'compaction:' + jobTwo])
  assert.ok(annotations[0].createdAt < 400 && annotations[1].createdAt > 400)
  assert.ok(!restored.displayMessages('chatgpt', physicalE).some(row => row.content === '会话已压缩'))
  assert.equal(f.messages.get(physicalE).length, 2, 'only actual imported context is stored as model history')
})

test('adoption preserves the original transcript, hides only trusted transport and survives reload', () => {
  const f = fixture(), task = job()
  f.turns.get(physicalA)[0].userSkills = ['scheduled_task', 'computer']
  f.continuity.install(task, '# 交接摘要\n完成的事和待办')
  const rows = f.messages.get(physicalC)
  assert.equal(rows.length, 2, 'hidden context is retained for later compression')
  rows.push(message('native-prompt', physicalC, 'user', shared.compactionHandoffPrompt(jobOne)),
    message('old-native-prompt', physicalC, 'user', shared.compactionHandoffPrompt(jobOne).replace('本轮只回复“已读取交接摘要，等待下一条消息。”，随后给出结束标记。不要复述目标、待办或摘要，', '本轮只用简短文字确认已接收的目标和待办，等待我下一条消息。')),
    message('native-ack', physicalC, 'assistant', task.handoffAnswer + '\n' + shared.compactionHandoffMarker(jobOne), task.handoffReplyId),
    message('actual-user', physicalC, 'user', '从上一会话导入的交接摘要（summary.md）：这是我自己输入的内容'),
    message('actual-answer', physicalC, 'assistant', '新的回答'))
  const visible = f.continuity.displayMessages('chatgpt', physicalC)
  assert.deepEqual(Array.from(visible, row => row.id), ['old-user', 'old-answer', 'actual-user', 'actual-answer'])
  assert.ok(visible.slice(0, 2).every(row => row.archived === true))
  assert.ok(visible.slice(2).every(row => !row.archived))
  assert.equal(f.continuity.root('chatgpt', physicalC), physicalA)
  assert.equal(f.continuity.owns('chatgpt', physicalC, jobOne), true)
  const restored = new ConversationContinuity('workspace', f.store)
  assert.deepEqual(plain(restored.displayMessages('chatgpt', physicalC)), plain(visible))
  const archived = restored.history('chatgpt', physicalC).turns.find(turn => turn.id === 'old-turn')
  assert.equal(archived.archived, true)
  assert.deepEqual(plain(archived.userSkills), ['scheduled_task', 'computer'], 'compression retains message references')
  const count = rows.length
  restored.install(task, '# 不应覆盖第一次导入')
  assert.equal(rows.length, count, 'recovery does not insert duplicate import messages')
})

test('the frozen view follows the effective branch, not later changes to source A', () => {
  const f = fixture(), original = f.messages.get(physicalA)
  original.push(message('superseded', physicalA), message('superseded-answer', physicalA, 'assistant'))
  f.turns.get(physicalA).push({ ...turn('superseded-turn', 'superseded'), supersededBy: 'old-turn', executionIds: ['old-command'] })
  const view = f.continuity.capture(owner(), original, f.turns.get(physicalA), f.executions.get(physicalA), ['superseded', 'superseded-answer'])
  f.settings.set(compactionViewKey(jobOne), JSON.stringify(view))
  original.push(message('later-edit', physicalA))
  f.continuity.install(job(), '# 摘要')
  const history = f.continuity.history('chatgpt', physicalC)
  assert.deepEqual(Array.from(history.messages, row => row.id), ['old-user', 'old-answer'])
  assert.deepEqual(Array.from(history.turns, row => row.id), ['old-turn'])
  assert.equal(history.executions[0].output, '')
  assert.equal(history.executions[0].outputDeferred, true)
  assert.equal(history.executions[0].archived, true)
  assert.equal(f.executions.get(physicalA)[0].output, '完整输出')
})

test('repeated compression retains one display lineage while exporting only the live physical context', () => {
  const f = fixture()
  f.continuity.install(job(), '# 摘要一\n原来的任务')
  f.messages.get(physicalC).push(message('middle-user', physicalC), message('middle-answer', physicalC, 'assistant', '中间回复'))
  const input = { owner: owner(physicalC), title: '原来的标题', capturedAt: 300, environment: '', messages: f.messages.get(physicalC),
    turns: [], executions: [], hiddenMessageIds: [] }
  const source = shared.compactionSourceMarkdown(input).markdown
  assert.ok(source.includes('# 摘要一') && source.includes('middle-user'))
  assert.ok(!source.includes('old-user'), 'display-only source history cannot inflate the new context')
  const view = f.continuity.capture(owner(physicalC), input.messages, [], [], [])
  f.settings.set(compactionViewKey(jobTwo), JSON.stringify(view))
  f.continuity.install(job(physicalC, physicalE, jobTwo), '# 摘要二')
  f.messages.get(physicalE).push(message('latest-user', physicalE))
  assert.deepEqual(Array.from(f.continuity.displayMessages('chatgpt', physicalE), row => row.id),
    ['old-user', 'old-answer', 'middle-user', 'middle-answer', 'latest-user'])
  assert.equal(f.continuity.root('chatgpt', physicalE), physicalA)
  assert.ok(!f.continuity.history('chatgpt', physicalE).messages.some(row => row.content.includes('# 摘要')))
})

test('hidden imported context is counted once; archived history and attachments do not count again', () => {
  const f = fixture(), task = job(), summary = '# 交接摘要\n不要执行未经授权的操作'
  f.continuity.install(task, summary)
  const recorded = emptyContextUsage(), entry = [...f.usage.values()][0]
  assert.equal(entry.category, 'injection')
  assert.ok(entry.estimatedTokens >= estimateContextText(summary).estimatedTokens)
  recorded.injections = { estimatedTokens: entry.estimatedTokens, characters: entry.characters }; recorded.files = entry.files
  recorded.observedSince = entry.createdAt
  const messages = f.continuity.displayMessages('chatgpt', physicalC), history = f.continuity.history('chatgpt', physicalC)
  messages[0].attachments = [{ mimeType: 'image/png' }]
  const actual = estimateFocusConversation({ messages, turns: history.turns, executions: history.executions, contextUsage: recorded })
  assert.equal(actual.estimatedTokens, entry.estimatedTokens)
  assert.equal(actual.details.conversation.estimatedTokens, 0)
  assert.equal(actual.details.images, 0)
  assert.equal(actual.details.files, 1)
})

test('legacy target sessions recover trusted lineage; unrelated chats and platform owners stay separate', () => {
  const f = fixture(), task = job()
  task.state.targetSessionId = 'legacy-target'
  f.settings.set('conversationCompaction:workspace', JSON.stringify(task))
  f.messages.set(physicalC, [message('seed', physicalC, 'user', '从上一会话导入的交接摘要（summary.md）：\n# 原摘要', 'compaction:' + jobOne + ':user')])
  const legacy = new ConversationContinuity('legacy-target', f.store)
  assert.deepEqual(Array.from(legacy.displayMessages('chatgpt', physicalC), row => row.id), ['old-user', 'old-answer'])
  assert.equal(legacy.root('chatgpt', physicalC), physicalA)
  assert.equal(legacy.root('deepseek', physicalC), physicalC)
  assert.equal(legacy.root('chatgpt', physicalE), physicalE)
  assert.throws(() => legacy.install(job(physicalE, physicalC, jobTwo), '# 冲突来源'), /已有其他来源/)
})

// Exercise actual SessionRuntime adoption/output methods without constructing Electron.
const runtimePath = resolve(root, 'src/main/session-runtime.ts'), runtimeText = readFileSync(runtimePath, 'utf8')
const ast = ts.createSourceFile(runtimePath, runtimeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const runtimeClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
function runtimeFixture() {
  const f = fixture(), calls = [], entry = { conversationId: physicalA, url: 'https://chatgpt.com/c/' + physicalA }
  const exports = {}, names = ['adoptCompaction', 'readFocusExecutionOutput', 'getEmbedState']
  const methods = runtimeClass.members.filter(node => names.includes(node.name?.getText(ast)))
  new Script(ts.transpileModule('class Runtime {' + methods.map(node => node.getText(ast)).join('\n') + '} exports.Runtime = Runtime', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText).runInNewContext({ exports, selectionQuestionConversation, IpcChannels: { embedState: 'state' } })
  let actual = physicalA
  const runtime = new exports.Runtime()
  Object.assign(runtime, { id: 'workspace', disposed: false, activePlatformId: 'chatgpt', customTitle: '原来的标题',
    continuity: f.continuity, activeEmbed: () => entry, runner: { hasInFlightWork: () => false },
    options: { store: { ...f.store, upsert: row => calls.push(['upsert', row.id]),
      getExecution: id => [...f.executions.values()].flat().find(row => row.messageId === id) }, onSummaryChanged: () => calls.push(['persist', entry.conversationId]) },
    conversationTools: { update: (...args) => calls.push(['preferences', ...args]) },
    interruptTaskControl: id => calls.push(['interrupt', id]),
    focusChat: { flush: () => {}, context: (_platform, id) => calls.push(['focus', id]), supersededExecutionIds: () => new Set() },
    embed: { resetTaskPrompt: () => calls.push(['reset']), navigate: url => calls.push(['navigate', url]),
      getState: () => ({ url: entry.url, conversationId: actual, title: '旧页面标题', isLoading: false }) },
    ownsFocus: request => request.sessionId === 'workspace' && request.conversationId === physicalC,
    send: (_channel, state) => calls.push(['state', state]) })
  return { ...f, runtime, calls, entry, loaded: () => { actual = physicalC } }
}

test('runtime reuses the same workspace and persists target before navigation; pending display keeps its root', () => {
  const f = runtimeFixture()
  assert.equal(f.runtime.adoptCompaction(job(), '# 摘要'), 'workspace')
  assert.equal(f.runtime.customTitle, '原来的标题')
  assert.equal(f.entry.conversationId, physicalC)
  assert.ok(f.calls.findIndex(call => call[0] === 'persist') < f.calls.findIndex(call => call[0] === 'navigate'))
  const state = f.runtime.getEmbedState()
  assert.equal(state.conversationId, physicalC)
  assert.equal(state.viewConversationId, physicalA)
  assert.equal(state.isLoading, true)
  assert.equal(f.runtime.adoptCompaction(job(), '# 摘要'), 'workspace')
  assert.equal(f.calls.filter(call => call[0] === 'navigate').length, 1)
})

test('only trusted inherited execution outputs can be read through the new conversation', () => {
  const f = runtimeFixture()
  f.runtime.adoptCompaction(job(), '# 摘要')
  f.executions.set('unrelated', [{ messageId: 'private', conversationId: 'unrelated', output: '其他会话的输出' }])
  assert.equal(f.runtime.readFocusExecutionOutput(owner(physicalC), 'build'), '完整输出')
  assert.equal(f.runtime.readFocusExecutionOutput(owner(physicalC), 'private'), null)
  assert.equal(f.runtime.readFocusExecutionOutput(owner(physicalA), 'build'), null)
})

test('a changed source, another platform or ongoing execution prevents adoption', () => {
  for (const setup of [f => { f.entry.conversationId = physicalE }, f => { f.runtime.activePlatformId = 'deepseek' },
    f => { f.runtime.focusSending = true }, f => { f.runtime.runner.hasInFlightWork = () => true }]) {
    const f = runtimeFixture(); setup(f)
    assert.throws(() => f.runtime.adoptCompaction(job(), '# 摘要'), /来源会话已变化|当前操作结束/)
    assert.equal(f.calls.length, 0)
  }
})
