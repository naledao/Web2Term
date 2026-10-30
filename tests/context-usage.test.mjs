// User-run only: node --test tests/context-usage.test.mjs tests/focus-token-usage.test.mjs
// Real SQLite, recorder and extracted app/page methods. No Electron, UI, network or user database.
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Script, createContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({ exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/context-usage.ts')
const tokens = load('../src/shared/focus-token-usage.ts', {
  './context-usage': shared, './focus-chat': load('../src/shared/focus-chat.ts'), './prompt-injection': load('../src/shared/prompt-injection.ts')
})
const { FocusChat } = load('../src/main/focus-chat.ts', { 'node:crypto': crypto, '../shared/focus-chat': load('../src/shared/focus-chat.ts') })
const { ContextUsageStore } = load('../src/main/context-usage-store.ts', { '../shared/context-usage': shared })
const { ContextUsageRecorder } = load('../src/main/context-usage-recorder.ts', {
  'node:crypto': crypto, '../shared/focus-token-usage': tokens
})
const plain = value => JSON.parse(JSON.stringify(value))
const entry = (id, patch = {}) => ({ id, conversationId: 'chat-a', turnId: 'turn-a', sourceMessageId: null,
  category: 'tool-result', state: 'sent', estimatedTokens: 3, characters: 12, images: 0, files: 0, createdAt: 1000, ...patch })
const schema = `CREATE TABLE conversations (id TEXT PRIMARY KEY);
  CREATE TABLE focus_turns (id TEXT PRIMARY KEY, payload TEXT);
  INSERT INTO conversations VALUES ('chat-a'), ('chat-b');
  INSERT INTO focus_turns VALUES ('turn-a', '{}'), ('old-turn', '{"supersededBy":"turn-a"}');`

test('statistics resolve only the matching cached turn without loading history or resuming task authority', () => {
  const chat = new FocusChat('session-a', {
    listFocusTurns() { assert.fail('statistics must not load or replace focus state') },
    saveFocusTurn() { assert.fail('statistics must not mutate focus state') }
  })
  const entry = { conversationId: 'chat-a', current: null, turns: [{ id: 'old', supersededBy: 'turn-a' }, { id: 'turn-a' }] }
  chat.entries.set('chatgpt', entry)
  assert.equal(chat.contextUsageTurnId('chatgpt', 'chat-a'), 'turn-a')
  assert.equal(chat.contextUsageTurnId('chatgpt', 'chat-b'), undefined)
  assert.equal(chat.currentTurnId('chatgpt'), undefined, 'a stopped/restored task stays stopped')
  entry.conversationId = null; entry.current = 'turn-a'
  assert.equal(chat.contextUsageTurnId('chatgpt', 'just-created-native-id'), 'turn-a')
})

test('observations persist across reopen, are scoped and idempotent, and only an unknown receipt can be upgraded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'web2term-context-test-'))
  const path = join(directory, 'context.db')
  let db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA foreign_keys = ON'); db.exec(schema)
    let store = new ContextUsageStore(db)
    store.save('chatgpt', entry('one', { state: 'unknown' }))
    assert.equal(store.summary('chatgpt', 'chat-a').uncertainCount, 1)
    store.save('chatgpt', entry('one'))
    store.save('chatgpt', entry('one', { state: 'unknown', estimatedTokens: 99999 }))
    store.save('chatgpt', entry('two', { category: 'injection' }))
    store.save('chatgpt', entry('three', { category: 'tool-definition' }))
    store.save('chatgpt', entry('request', { category: 'tool-request', sourceMessageId: 'native-message-a' }))
    store.save('chatgpt', entry('unknown', { state: 'unknown', images: 1 }))
    store.save('chatgpt', entry('media', { category: 'attachment', estimatedTokens: 0, characters: 0, images: 2, files: 1 }))
    store.save('chatgpt', entry('archived', { turnId: 'old-turn', estimatedTokens: 99999 }))
    store.save('deepseek', entry('one', { estimatedTokens: 50 }))
    store.save('chatgpt', entry('one', { conversationId: 'chat-b', estimatedTokens: 60 }))
    const result = store.summary('chatgpt', 'chat-a')
    for (const key of ['toolResults', 'injections', 'toolDefinitions', 'toolRequests']) assert.equal(result[key].estimatedTokens, 3, key)
    assert.equal(result.uncertainCount, 1); assert.equal(result.uncertain.estimatedTokens, 3)
    assert.equal(result.images, 2); assert.equal(result.files, 1)
    assert.deepEqual(plain(result.requestSourceIds), ['native-message-a'])
    assert.equal(store.summary('deepseek', 'chat-a').toolResults.estimatedTokens, 50)
    assert.equal(store.summary('chatgpt', 'chat-b').toolResults.estimatedTokens, 60)
    assert.equal(db.prepare('SELECT method FROM context_usage LIMIT 1').get().method, 'char-mix-v1')
    assert.ok(!JSON.stringify(db.prepare('PRAGMA table_info(context_usage)').all()).includes('raw_text'), 'no duplicate prompt/output content stored')
    db.close(); db = new DatabaseSync(path); store = new ContextUsageStore(db)
    assert.deepEqual(plain(store.summary('chatgpt', 'chat-a')), plain(result))
    db.exec('PRAGMA foreign_keys = ON'); db.exec("DELETE FROM conversations WHERE id = 'chat-a'")
    assert.equal(store.summary('chatgpt', 'chat-a').toolResults.estimatedTokens, 0)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('recorder captures the original owner, exact normalized payload, tool definitions and stable native request identities', () => {
  let owner = { conversationId: 'chat-a', turnId: 'turn-a' }
  const records = []
  const recorder = new ContextUsageRecorder(() => owner, row => records.push(row))
  const ticket = recorder.begin('【工具说明】\r\n协议的发送版本', 'tool-result')
  assert.equal(records.length, 0, 'preparing a payload is not a submission')
  owner = { conversationId: 'chat-b', turnId: 'turn-b' }
  recorder.finish(ticket, 'ok')
  assert.equal(records[0].conversationId, 'chat-a'); assert.equal(records[0].turnId, 'turn-a')
  assert.equal(records[0].category, 'tool-definition')
  assert.equal(recorder.begin('【工具说明读取失败】\n无可用说明', 'tool-result').category, 'tool-result', 'a failure receipt is not a full tool definition')
  assert.equal(records[0].characters, '【工具说明】\n协议的发送版本'.length)
  const request = '{\n  "command": "git status", "description": "检查"\n}'
  recorder.confirmed(request, 'tool-request', 'message-a', 'message-a')
  const restarted = new ContextUsageRecorder(() => owner, row => records.push(row))
  restarted.confirmed(request, 'tool-request', 'message-a', 'message-a')
  assert.equal(records[1].id, records[2].id, 'reload of a native reply cannot create a second request')
  assert.equal(records[1].characters, request.length, 'JSON syntax and formatting count')
  for (const outcome of ['busy', 'no-composer', 'insert-failed', 'cancelled', 'not-submitted']) recorder.finish(ticket, outcome)
  assert.equal(records.length, 3)
  recorder.finish(ticket, 'stuck'); assert.equal(records.at(-1).state, 'unknown')
  const faulty = new ContextUsageRecorder(() => { throw Error('missing owner') }, () => { throw Error('store error') })
  assert.equal(faulty.begin('payload', 'tool-result'), undefined)
  assert.doesNotThrow(() => faulty.finish(ticket, 'ok'))
})

const embedSource = ts.createSourceFile('embed.ts', readFileSync(new URL('../src/main/embed.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const embedClass = embedSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ChatGptEmbed')
function embedMethods(names, globals = {}) {
  const body = names.map(name => embedClass.members.find(node => node.name?.getText(embedSource) === name).getText(embedSource)).join('\n')
  return new Script(compile(`class Embed { ${body} }; Embed`)).runInNewContext({ URL, console: { info() {}, warn() {} }, ...globals })
}
const reportGlobals = { INTERCEPTOR_LOG_TAG: '[cmd-terminal] ', REPLY_PROTOCOL_VERSION: 1, REPLY_PROTOCOL_REMINDER: 'short',
  conversationIdOf: (_platform, url) => new URL(url).pathname.split('/').at(-1), writeReplyDiagnostic() {}, writePromptDiagnostic() {} }
function embedFixture(fileSend = async () => 'ok') {
  const records = [], scripts = []
  let outcome = 'ok', url = 'https://chatgpt.com/c/chat-a'
  const contents = { getURL: () => url, isDestroyed: () => false, executeJavaScript: async script => {
    scripts.push(script)
    if (outcome instanceof Error) throw outcome
    return outcome
  } }
  const Embed = embedMethods(['sendRaw', 'sendTaskResult', 'sendFileResult', 'sendTaskObservation', 'handlePageReport'], {
    ...reportGlobals, fileReadingPlatform: id => ({ id }), sendPageFiles: fileSend
  })
  const embed = Object.assign(new Embed(), { liveContents: () => contents, taskPromptGeneration: 1, computerPageEpoch: 'page-a',
    platform: { id: 'chatgpt', page: { computerUseRequests: true }, homeUrl: 'https://chatgpt.com/', conversationIdFromPath: path => path.split('/').at(-1) },
    interceptor: { injectedCount: 0, pendingQuestion: null, taskStartedAt: null, taskFinishedAt: null },
    handlers: { onInterceptor() {}, onInjectionSent() {}, onPromptInjected() {} }, getInterceptorStatus: () => ({}), noteAttachmentTraffic() {} })
  embed.contextUsage = new ContextUsageRecorder(() => ({ conversationId: new URL(url).pathname.split('/').at(-1), turnId: 'turn-a' }), row => records.push(row))
  return { embed, records, scripts, setOutcome: value => { outcome = value }, navigate: value => { url = value },
    report: payload => embed.handlePageReport('[cmd-terminal] ' + JSON.stringify(payload)) }
}

test('real send methods exclude blocked sends and preserve unknown outcomes without changing delivery behavior', async () => {
  const f = embedFixture(), signal = new AbortController().signal
  for (const outcome of ['busy', 'insert-failed', 'no-composer']) {
    f.setOutcome(outcome)
    assert.equal(await f.embed.sendTaskResult('结果', 'chat-a', signal), outcome)
    await f.embed.sendRaw('结果')
  }
  assert.equal(f.records.length, 0)
  f.setOutcome('stuck'); assert.equal(await f.embed.sendTaskResult('可能发送', 'chat-a', signal), 'stuck')
  f.setOutcome(undefined); assert.equal(await f.embed.sendTaskResult('IPC 无返回值', 'chat-a', signal), 'unknown')
  f.setOutcome(Error('navigation')); assert.equal(await f.embed.sendTaskResult('IPC 中断', 'chat-a', signal), 'unknown')
  assert.equal(f.records.length, 3); assert.ok(f.records.every(record => record.state === 'unknown'))
  f.setOutcome('ok'); assert.equal(await f.embed.sendTaskResult('确定发送', 'chat-a', signal), 'ok')
  assert.equal(f.records.at(-1).state, 'sent')
  const count = f.records.length
  f.navigate('https://chatgpt.com/c/chat-b')
  assert.equal(await f.embed.sendTaskResult('旧目标', 'chat-a', signal), 'stale')
  assert.equal(f.records.length, count)
})

test('tool results measure the actual truncated formatted message instead of the full local output', async () => {
  const source = ts.createSourceFile('commands.ts', readFileSync(new URL('../src/main/commands.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const names = ['truncateOutput', 'formatExitCode', 'describeOutcome', 'buildResultMessage']
  const body = names.map(name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source)).join('\n')
  const build = new Script(compile(`const OUTPUT_HEAD=4000, OUTPUT_TAIL=2000; ${body}; buildResultMessage`)).runInNewContext({})
  const output = '\x1b[32m' + 'long log\r\n'.repeat(10000) + '\x1b[0m'
  const sent = build({ output, exitCode: 0, cwd: 'C:\\project' }) + '\n{"task_id":"actual-task","step":2}'
  assert.match(sent, /中间省略/); assert.ok(sent.length < output.length / 5)
  const f = embedFixture()
  await f.embed.sendTaskResult(sent, 'chat-a', new AbortController().signal)
  assert.equal(f.records[0].characters, sent.length)
  assert.equal(f.records[0].estimatedTokens, tokens.estimateContextText(sent).estimatedTokens)
  assert.ok(f.scripts[0].includes(JSON.stringify(sent)))
})

test('image/file results count only submitted captions and attachment metadata, including unknown uploads', async () => {
  let outcome = 'ok'
  const f = embedFixture(async () => { if (outcome instanceof Error) throw outcome; return outcome })
  const attachments = [{ mimeType: 'image/png' }, { mimeType: 'text/plain' }]
  const signal = new AbortController().signal
  await f.embed.sendFileResult({ text: 'this caption is not passed to the upload API', attachments }, 'files-a', () => true, signal)
  assert.equal(f.records[0].characters, 0); assert.equal(f.records[0].images, 1); assert.equal(f.records[0].files, 1)
  await f.embed.sendTaskObservation('actual observation caption', 'chat-a', signal, attachments.slice(0, 1), 'image-a', () => true)
  assert.equal(f.records[1].characters, 'actual observation caption'.length); assert.equal(f.records[1].images, 1)
  outcome = 'upload-failed'
  await f.embed.sendFileResult({ attachments }, 'files-b', () => true, signal)
  assert.equal(f.records.length, 2)
  outcome = Error('upload IPC interrupted')
  await assert.rejects(f.embed.sendFileResult({ attachments }, 'files-c', () => true, signal))
  assert.equal(f.records.at(-1).state, 'unknown')
})

test('confirmed sends use the prefix snapshot carried by that submission, without counting prepared or stale injections', () => {
  const f = embedFixture()
  const page = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(page) === 'userPromptInjection') return node
    return ts.forEachChild(node, find)
  }
  const prefix = '【实际发送的旧版完整提示词】', separator = '\u2063\u2063'
  const state = { enabled: true, promptInjectionEnabled: true, prefix, taskPromptInjected: false,
    prefixIncludesReplyProtocol: true, replyProtocolVersion: 1, replyProtocolFullLength: 4,
    replyProtocolPrefix: 'short', contextPrefixUsage: tokens.estimateContextText(prefix + separator),
    contextReminderUsage: tokens.estimateContextText('short' + separator) }
  const injectionOf = new Script('(' + find(page).initializer.getText(page) + ')').runInContext(createContext({ state }))
  const injection = injectionOf()
  f.report({ event: 'injected', taskPromptGeneration: 1, prefixLength: prefix.length })
  assert.equal(f.records.length, 0)
  state.prefix = 'later different prompt'; state.contextPrefixUsage = tokens.estimateContextText(state.prefix + separator)
  f.report({ event: 'sent', taskPromptGeneration: 0, contextUsage: injection.metadata.contextUsage })
  assert.equal(f.records.length, 0)
  f.report({ event: 'sent', taskPromptGeneration: 1, contextUsage: injection.metadata.contextUsage })
  assert.equal(f.records[0].characters, prefix.length + separator.length)
  f.report({ event: 'sent', taskPromptGeneration: 1, contextUsage: injection.metadata.contextUsage })
  assert.equal(f.records[0].id, f.records[1].id, 'duplicate acknowledgements have one durable identity')
  state.taskPromptInjected = true
  const reminder = injectionOf()
  f.report({ event: 'sent', taskPromptGeneration: 1, contextUsage: reminder.metadata.contextUsage })
  assert.equal(f.records.at(-1).characters, 'short'.length + separator.length)
  const count = f.records.length
  f.report({ event: 'sent', taskPromptGeneration: 1, contextUsage: { id: 'bad', estimatedTokens: Infinity, characters: 1 } })
  assert.equal(f.records.length, count)
})
