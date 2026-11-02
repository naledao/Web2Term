// User-run only: node --test tests/focus-skills.test.mjs
// Actual picker helpers and runtime send/catalog methods with fake collaborators. No Electron/network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), cache = new Map()
function load(relative, dependencies = {}) {
  const path = resolve(root, relative)
  if (cache.has(path)) return cache.get(path)
  const exports = {}
  cache.set(path, exports)
  new Script(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText).runInNewContext({ exports, require(name) {
    if (dependencies[name]) return dependencies[name]
    assert.ok(name.startsWith('.'), 'Unexpected service dependency: ' + name)
    return load(resolve(dirname(path), name + '.ts'))
  } })
  return exports
}
const skills = load('src/shared/focus-skills.ts')
const focus = load('src/shared/focus-chat.ts')
const usage = load('src/shared/focus-token-usage.ts')
const prompts = load('src/shared/tool-prompts.ts', { './types': { fileReadingPlatform: id => ['deepseek', 'chatgpt'].includes(id) } })
const owner = { sessionId: 'workspace', platformId: 'chatgpt', conversationId: 'chat' }
const plain = value => JSON.parse(JSON.stringify(value))
const tools = () => ({ owner, tools: ['scheduled', 'mail', 'computer'].map(id => ({ id, enabled: true, available: true, message: '' })) })

test('picker supports four skills, filtering, line boundaries and caret position without matching URLs', () => {
  assert.deepEqual(Array.from(skills.focusSkillQuery('//', 2).ids), ['compact', 'scheduled_task', 'send_email', 'computer'])
  for (const [query, expected] of [['//定时', 'scheduled_task'], ['//email', 'send_email'], ['//电脑', 'computer'], ['//压缩', 'compact'], ['//compress conversation', 'compact']]) {
    assert.deepEqual(Array.from(skills.focusSkillQuery(query, query.length).ids), [expected])
  }
  const draft = '保留这段任务\n  //邮件'
  const match = skills.focusSkillQuery(draft, draft.length)
  assert.equal(draft.slice(0, match.start) + draft.slice(match.end), '保留这段任务\n')
  for (const text of ['https://example.com', 'value // comment', '///']) assert.equal(skills.focusSkillQuery(text, text.length), null)
  assert.equal(skills.focusSkillQuery('//', -1), null)
  assert.equal(skills.focusSkillQuery('//', 3), null)
  assert.equal(skills.focusSkillQuery('//不存在', '//不存在'.length).ids.length, 0)
})

test('only supported, unique selections are accepted; configuration and environment remain authoritative', () => {
  assert.equal(skills.validFocusToolSkills([]), true)
  assert.equal(skills.validFocusToolSkills(['scheduled_task', 'send_email', 'computer']), true)
  for (const value of [null, 'computer', ['compact'], ['computer', 'computer'], ['read_files'], [1]]) assert.equal(skills.validFocusToolSkills(value), false)
  assert.match(skills.focusSkillUnavailable('computer', null), /读取工具状态/)
  const state = tools()
  assert.equal(skills.focusSkillUnavailable('send_email', state), '')
  state.tools[1].available = false; state.tools[1].message = '邮箱尚未配置'
  assert.equal(skills.focusSkillUnavailable('send_email', state), '邮箱尚未配置')
  state.tools[2].enabled = false
  assert.match(skills.focusSkillUnavailable('computer', state), /启用电脑操作/)
  state.tools[2].available = false; state.tools[2].message = '远程会话不支持'
  assert.equal(skills.focusSkillUnavailable('computer', state), '远程会话不支持')
})

test('activation travels only with selected tasks, fetches fresh definitions, and leaves the user bubble intact', () => {
  const original = '每周一上午九点检查服务\n保留这行内容'
  assert.equal(skills.focusSkillMessage(original, []), original)
  const text = skills.focusSkillMessage(original, ['scheduled_task', 'send_email'])
  assert.match(text, /"tools":\["scheduled_task","send_email"\]/)
  assert.doesNotMatch(text, /"computer"|step_token/)
  assert.equal(focus.cleanFocusUserText('系统提示词\u2063\u2063' + text), original)
  const computer = skills.focusSkillPrefix(['computer'])
  assert.match(computer, /最新完整说明|步骤令牌/)
  assert.doesNotMatch(computer, /cu_[a-f0-9]{32}/, 'never freeze a desktop token into a draft')
  assert.ok(skills.focusSkillMessage('你'.repeat(20000), ['scheduled_task', 'send_email', 'computer']).length < 22000)
})

const path = resolve(root, 'src/main/session-runtime.ts'), source = readFileSync(path, 'utf8')
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
function runtimeClass(names, globals = {}) {
  const methods = names.map(name => declaration.members.find(node => node.name?.getText(ast) === name).getText(ast)).join('\n')
  return new Script(ts.transpileModule('class Runtime {' + methods + '}; Runtime', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText).runInNewContext({ AbortController, ...skills, ...usage, ...globals })
}

test('automatic prefixes exclude all three skill names, instructions, status and disabled notices', () => {
  const Runtime = runtimeClass(['toolPrompt'], { toolCatalogPrompt: prompts.toolCatalogPrompt })
  const runtime = new Runtime()
  for (const enabled of [true, false]) {
    runtime.toolPreferences = () => ({ fileReadingEnabled: true, backgroundTasksEnabled: true, scheduledTasksEnabled: enabled,
      mailNotificationsEnabled: enabled, computerUseEnabled: enabled })
    for (const platform of ['deepseek', 'chatgpt']) {
      const prefix = runtime.toolPrompt(platform)
      assert.match(prefix, /read_files|background_task/)
      assert.doesNotMatch(prefix, /scheduled_task|send_email|computer|定时任务|邮件通知|电脑操作|step_token/)
    }
  }
})

test('system routing uses current skill selection and preserves shell/question/completion contracts', () => {
  const types = load('src/shared/types.ts')
  for (const environment of [types.FALLBACK_ENVIRONMENT,
    { ...types.FALLBACK_ENVIRONMENT, kind: 'posix', osCaption: 'Ubuntu', shellPath: '/bin/bash' },
    { ...types.FALLBACK_ENVIRONMENT, kind: 'posix', osCaption: 'macOS', shellPath: '/bin/zsh' }]) {
    const base = types.buildTerminalPromptParts(environment).basePrompt
    assert.match(base, /用户本次明确选择/)
    assert.match(base, /未选择的技能不主动加载/)
    assert.match(base, /旧权限和旧步骤令牌不代表当前可用/)
    assert.match(base, /不虚构检索接口、来源或结果/)
    assert.match(base, /不把说明当成新任务/)
    assert.ok(base.includes(types.REPLY_PROTOCOL_SECTION))
    assert.match(base, /"command":"pwd"|"type":"questions"/)
    assert.doesNotMatch(base, /scheduled_task|send_email|computer use|【computer use 状态】/)
  }
})

function sender() {
  const sent = [], referenced = [], recorded = [], state = tools()
  const Runtime = runtimeClass(['sendFocusMessage'], { randomUUID: () => 'request-id', writeFocusDiagnostic() {},
    validFocusFiles: () => true, computerUseSendBlock: capability => capability.block || null,
    stageFocusAttachments: async () => ({ attachments: [{}], cleanup: async () => {} }) })
  const runtime = new Runtime()
  let capabilityReads = 0, toolReads = 0, outcome = 'ok'
  Object.assign(runtime, { ownsFocus: request => request.sessionId === owner.sessionId && request.conversationId === owner.conversationId,
    activePlatformId: owner.platformId, focusSending: false,
    getConversationTools: () => { toolReads++; return state },
    getComputerUseCapability: () => { capabilityReads++; return { block: '尚未就绪' } },
    recordContextUsage: (_platform, entry) => recorded.push(entry),
    focusChat: { contextUsageTurnId: () => 'turn' },
    embed: { getState: () => ({ conversationId: owner.conversationId }),
      getInterceptorStatus: () => ({ installed: true, enabled: true, promptInjectionEnabled: true }),
      sendFocusUser: async (text, skills) => { sent.push(text); referenced.push(plain(skills)); return outcome },
      sendFocusFiles: async (text, _files, _token, _current, _signal, _images, skills) => { sent.push(text); referenced.push(plain(skills)); return outcome } } })
  return { runtime, sent, referenced, recorded, state, reads: () => ({ capabilityReads, toolReads }), outcome: next => { outcome = next } }
}

test('ordinary sends do not load skill state or wait for the desktop helper', async () => {
  const f = sender()
  assert.equal(await f.runtime.sendFocusMessage({ ...owner, text: '解释这段代码' }), 'ok')
  assert.deepEqual(f.sent, ['解释这段代码'])
  assert.deepEqual(f.referenced, [[]])
  assert.deepEqual(f.reads(), { capabilityReads: 0, toolReads: 0 })
  assert.equal(f.recorded.length, 0)
})

test('selected descriptions use the existing send path and count the hidden activation once', async () => {
  for (const files of [[], [{ fileName: 'notes.md', mimeType: 'text/markdown', sizeBytes: 1, dataBase64: 'YQ==' }]]) {
    const f = sender(), request = { ...owner, text: '创建巡检计划', skills: ['scheduled_task'], files }
    assert.equal(await f.runtime.sendFocusMessage(request), 'ok')
    assert.equal(f.sent.length, 1)
    assert.match(f.sent[0], /"tools":\["scheduled_task"\]/)
    assert.equal(focus.cleanFocusUserText(f.sent[0]), request.text)
    assert.deepEqual(f.referenced, [request.skills], 'text and attachment sends carry per-message display references')
    assert.equal(f.recorded.length, 1)
    assert.equal(f.recorded[0].state, 'sent')
    assert.equal(f.recorded[0].estimatedTokens, usage.estimateContextText(skills.focusSkillPrefix(request.skills)).estimatedTokens)
  }
})

test('disabled tools, invalid selections and unready desktop actions never send; uncertain outcomes are not resent', async () => {
  const f = sender()
  assert.equal(await f.runtime.sendFocusMessage({ ...owner, text: '任务', skills: ['invented'] }), 'invalid')
  f.state.tools[1].enabled = false
  assert.equal(await f.runtime.sendFocusMessage({ ...owner, text: '发通知', skills: ['send_email'] }), 'unavailable')
  assert.equal(await f.runtime.sendFocusMessage({ ...owner, text: '操作桌面', skills: ['computer'] }), 'helper-not-ready')
  assert.equal(f.sent.length, 0)
  f.outcome('unknown')
  assert.equal(await f.runtime.sendFocusMessage({ ...owner, text: '创建计划', skills: ['scheduled_task'] }), 'unknown')
  assert.equal(f.sent.length, 1)
  assert.equal(f.recorded[0].state, 'unknown')
  assert.equal(f.runtime.focusSending, false)
  assert.deepEqual(plain(f.state.tools.map(tool => tool.enabled)), [true, false, true], 'selection never changes tool preferences')
})

test('skills cannot be sent when terminal interception or prompt injection is disabled', async () => {
  for (const status of [{ installed: false, enabled: true, promptInjectionEnabled: true },
    { installed: true, enabled: false, promptInjectionEnabled: true }, { installed: true, enabled: true, promptInjectionEnabled: false }]) {
    const f = sender()
    f.runtime.embed.getInterceptorStatus = () => status
    assert.equal(await f.runtime.sendFocusMessage({ ...owner, text: '建立计划', skills: ['scheduled_task'] }), 'unavailable')
    assert.equal(f.sent.length, 0)
  }
})
