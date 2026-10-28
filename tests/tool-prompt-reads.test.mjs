// User-run only: node --test tests/tool-prompt-reads.test.mjs
// Actual tool catalog, page recognition, bridge and delivery code with a synthetic page and timers.
// No Electron, real page, shell, desktop helper or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
import { taskContextModule } from './fixtures/task-context-module.mjs'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}, globals = {}) {
  const exports = {}
  new Function('exports', 'require', ...Object.keys(globals), compile(readFileSync(new URL(path, import.meta.url), 'utf8')))(
    exports, name => {
      const value = dependencies[name] ?? progressVmModules[name]
      assert.ok(value, 'Unexpected test dependency: ' + name)
      return value
    }, ...Object.values(globals))
  return exports
}
function methods(path, name, names, globals = {}) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === name)
  const body = names.map(name => declaration.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
  return new Function(...Object.keys(globals), compile(`class Subject { ${body} }`) + '\nreturn Subject')(...Object.values(globals))
}
const pageAst = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function pageFunction(name, globals = {}) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(pageAst) === name) return node.initializer
    return ts.forEachChild(node, find)
  }
  return new Function(...Object.keys(globals), 'return ' + find(pageAst).getText(pageAst))(...Object.values(globals))
}

const files = load('../src/shared/file-requests.ts')
const background = load('../src/shared/background-tasks.ts', { './autonomous-task': taskContextModule })
const types = load('../src/shared/types.ts', { './file-requests': files, './background-tasks': background })
const prompts = load('../src/shared/tool-prompts.ts', { './types': types })
const focus = load('../src/shared/focus-chat.ts')
const { ToolPromptReads } = load('../src/main/tool-prompt-reads.ts', { '../shared/tool-prompts': prompts })
const request = { type: 'read_tool_prompt', tools: ['send_email', 'scheduled_task'] }
const call = { messageId: 'reply-a', rawJson: JSON.stringify(request), conversationId: 'chat-a', pageEpoch: 'epoch-a', sourceSubmissionId: 'user:first' }
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
const lookup = name => name === 'send_email' ? { unavailable: '当前对话已关闭邮件通知工具。' } : { prompt: `【工具：${name}】\n完整说明` }

test('requests accept only listed tool names, de-duplicate them and reject extra fields', () => {
  assert.deepEqual(prompts.parseReadToolPromptRequest({ type: 'read_tool_prompt', tools: ['computer', 'computer', 'read_files'] }),
    { type: 'read_tool_prompt', tools: ['computer', 'read_files'] })
  for (const value of [null, [], { type: 'read_tool_prompt' }, { type: 'read_tool_prompt', tools: [] },
    { type: 'read_tool_prompt', tools: ['shell'] }, { type: 'read_tool_prompt', tools: [1] },
    { type: 'read_tool_prompt', tools: ['read_files'], extra: true }, { type: 'read_files', tools: ['read_files'] },
    { type: 'read_tool_prompt', tools: ['read_files', 'background_task', 'scheduled_task', 'send_email', 'computer', 'read_files'] }]) {
    assert.equal(prompts.parseReadToolPromptRequest(value), null, JSON.stringify(value))
  }
})

test('the catalog carries summaries and inline notes, never full definitions, and only on supported platforms', () => {
  const catalog = prompts.toolCatalogPrompt('deepseek', [{ name: 'read_files' }, { name: 'send_email', note: '当前邮箱尚未配置完成。' }], '当前对话已关闭定时任务工具。')
  assert.match(catalog, /^【工具目录】/)
  assert.match(catalog, new RegExp('- read_files：' + prompts.TOOL_PROMPT_SUMMARIES.read_files))
  assert.match(catalog, /- send_email：.*当前邮箱尚未配置完成。/)
  assert.match(catalog, /\{"type":"read_tool_prompt","tools":\["read_files"\]\}/)
  assert.match(catalog, /当前对话已关闭定时任务工具。$/)
  assert.doesNotMatch(catalog, /【工具：/)
  assert.equal(prompts.toolCatalogPrompt('deepseek', [], 'only notes'), 'only notes')
  assert.equal(prompts.toolCatalogPrompt('unknown', [{ name: 'read_files' }], 'notes'), '')
  for (const name of prompts.TOOL_PROMPT_NAMES) assert.ok(prompts.TOOL_PROMPT_SUMMARIES[name])
})

test('the receipt holds each requested definition, explains unavailable tools and corrects malformed requests', () => {
  const reply = prompts.toolPromptReadReply(prompts.parseReadToolPromptRequest(request), lookup)
  assert.match(reply, /^【工具说明】/)
  assert.match(reply, /【工具：send_email】\n当前不可用：当前对话已关闭邮件通知工具。不要调用该工具。/)
  assert.match(reply, /【工具：scheduled_task】\n完整说明/)
  assert.ok(reply.indexOf('send_email') < reply.indexOf('scheduled_task'), 'keeps the requested order')
  assert.match(prompts.toolPromptReadReply(null, lookup), /^【工具说明读取失败】[\s\S]*"type":"read_tool_prompt"/)
})

function page(report, overrides = {}) {
  const state = { enabled: true, awaitingReplySince: 1, taskPromptGeneration: 3, ...overrides }
  const check = pageFunction('checkToolPromptRead', {
    state, mailSourceSubmissionId: 'user:first', computerPageEpoch: 'epoch-a',
    location: { pathname: '/chat-a' }, report,
    looksLikeToolPromptReadReply: pageFunction('looksLikeToolPromptReadReply'), balancedObjects: pageFunction('balancedObjects'),
    setReplyWaiting: value => { state.awaitingReplySince = value }
  })
  return { state, check }
}

test('page recognition accepts a request inside a short explanation and ignores history or disabled terminal mode', () => {
  const events = [], f = page(event => events.push(event))
  assert.equal(f.check('reply-a', '我先读取工具说明：\n```json\n' + JSON.stringify(request) + '\n```'), true)
  assert.deepEqual(JSON.parse(events[0].rawJson), request)
  assert.equal(events[0].event, 'tool-prompt-read')
  assert.equal(events[0].sourceSubmissionId, 'user:first')
  assert.equal(f.state.awaitingReplySince, 0)
  assert.equal(f.state.replyActionDetected, true)
  assert.equal(f.check('other', '普通回答'), false)
  for (const overrides of [{ enabled: false }, { awaitingReplySince: 0 }]) {
    const f = page(() => assert.fail('history must not read'), overrides)
    assert.equal(f.check('old-reply', JSON.stringify(request)), true)
  }
  const twice = page(event => events.push(event))
  twice.check('twice', JSON.stringify(request) + '\n' + JSON.stringify(request))
  assert.equal(prompts.parseReadToolPromptRequest(JSON.parse(events[1].rawJson)), null)
})

const Embed = methods('../src/main/embed.ts', 'ChatGptEmbed', ['handlePageReport'], {
  INTERCEPTOR_LOG_TAG: 'test:', writeReplyDiagnostic: () => null, writePromptDiagnostic() {},
  conversationIdOf: (_platform, url) => new URL(url).pathname.slice(1)
})
function embed(handler) {
  return Object.assign(new Embed(), {
    platform: { id: 'claude', homeUrl: 'https://example.test/', page: { computerUseRequests: false },
      conversationIdFromPath: path => path === '/chat-a' ? 'chat-a' : null },
    computerUseRecognitionEnabled: false, computerPageEpoch: 'epoch-a', taskPromptGeneration: 3,
    userSubmissions: new Set(['user:first']), interceptor: { pendingQuestion: null },
    liveContents: () => ({ id: 1, getURL: () => 'https://example.test/chat-a' }), getInterceptorStatus: () => ({}),
    handlers: { onToolPromptRead: handler, onInterceptor() {} }
  })
}

test('the bridge rejects stale epoch, generation, source and path', () => {
  const received = [], subject = embed(value => received.push(value))
  const payload = { event: 'tool-prompt-read', ...call, live: true, computerPageEpoch: call.pageEpoch, pagePath: '/chat-a', taskPromptGeneration: 3 }
  subject.handlePageReport('test:' + JSON.stringify(payload))
  assert.deepEqual(received, [call])
  for (const patch of [{ computerPageEpoch: 'old' }, { taskPromptGeneration: 2 }, { sourceSubmissionId: 'unknown' },
    { pagePath: '/other' }, { live: false }, { rawJson: 'x'.repeat(4001) }]) subject.handlePageReport('test:' + JSON.stringify({ ...payload, ...patch }))
  assert.equal(received.length, 1)
})

const Runtime = methods('../src/main/session-runtime.ts', 'SessionRuntime', ['toolPromptReadCurrent'], {
  taskPausedByInput: task => !!task?.paused
})
function runtime() {
  return Object.assign(new Runtime(), { active: true, disposed: false, taskEnded: false, stoppingTask: null,
    activePlatformId: 'claude', options: {}, lastSubmissions: new Map([['claude', 'user:first']]),
    runner: { getAutomation: () => ({ paused: false }) },
    taskCoordinator: { waitingForUser: () => false, latest: () => null },
    embed: { getComputerUsePageEpoch: () => 'epoch-a', getState: () => ({ conversationId: 'chat-a' }),
      getInterceptorStatus: () => ({ enabled: true, pendingQuestion: null }) }
  })
}

test('runtime admission rejects stopped, paused and stale conversation calls', () => {
  const subject = runtime()
  assert.equal(subject.toolPromptReadCurrent(call), true)
  for (const [key, value] of [['disposed', true], ['active', false], ['taskEnded', true], ['stoppingTask', {}]]) {
    const original = subject[key]; subject[key] = value
    assert.equal(subject.toolPromptReadCurrent(call), false); subject[key] = original
  }
  assert.equal(subject.toolPromptReadCurrent({ ...call, pageEpoch: 'old' }), false)
  assert.equal(subject.toolPromptReadCurrent({ ...call, sourceSubmissionId: 'old' }), false)
  assert.equal(subject.toolPromptReadCurrent({ ...call, conversationId: 'other' }), false)
  subject.runner.getAutomation = () => ({ paused: true })
  assert.equal(subject.toolPromptReadCurrent(call), false)
})

test('a page request sends the definitions once to the same AI conversation', async t => {
  const receipts = [], notes = []
  const reads = new ToolPromptReads({ current: () => true, lookup,
    send: async (text, value) => { receipts.push({ text, call: value }); return 'ok' }, note: text => notes.push(text) })
  t.after(() => reads.cancel())
  const bridge = embed(value => { reads.receive(value); reads.receive(value) })
  page(event => bridge.handlePageReport('test:' + JSON.stringify(event))).check('reply-a', JSON.stringify(request))
  await settle()
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].call.conversationId, 'chat-a')
  assert.match(receipts[0].text, /【工具：scheduled_task】/)
  assert.match(notes[0], /send_email、scheduled_task/)
  assert.equal(reads.busy, false)
})

test('only a busy page is retried; an uncertain send and a scope change are not', async t => {
  const timers = new Set(), { ToolPromptReads: Subject } = load('../src/main/tool-prompt-reads.ts', { '../shared/tool-prompts': prompts }, {
    setTimeout(callback) { const timer = { callback, unref() {} }; timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer) }
  })
  let deliveries = 0, outcome = 'busy', active = true
  const subject = new Subject({ current: () => active, lookup, send: async () => { deliveries++; return outcome }, note() {} })
  t.after(() => subject.cancel())
  subject.receive(call); await settle()
  assert.equal(deliveries, 1); assert.equal(timers.size, 1)
  outcome = 'unknown'
  const timer = [...timers][0]; timers.delete(timer); timer.callback(); await settle()
  assert.equal(deliveries, 2); assert.equal(timers.size, 0); assert.equal(subject.busy, false)
  outcome = 'busy'
  subject.receive(call); await settle()
  active = false; subject.reconcile()
  assert.equal(subject.busy, false); assert.equal(timers.size, 0)
  assert.equal(deliveries, 3)
})

test('the focus view shows a short line instead of the raw request', () => {
  assert.equal(focus.cleanFocusAnswer('```json\n' + JSON.stringify(request) + '\n```'), '正在读取工具说明：send_email、scheduled_task')
  assert.equal(focus.cleanFocusAnswer('{"type":"read_tool_prompt","tools":["send'), '')
  assert.equal(focus.cleanFocusAnswer('{"type":"read_tool_prompt","tools":[]}'), '')
})
