// User-run only: node --test tests/focus-token-usage.test.mjs
// Actual estimator, injection planner and React header, with no Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText).runInNewContext({ exports, require: name => {
    assert.ok(name in dependencies, 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const focus = load('../src/shared/focus-chat.ts')
const planner = load('../src/shared/prompt-injection.ts')
const context = load('../src/shared/context-usage.ts')
const tokens = load('../src/shared/focus-token-usage.ts', { './focus-chat': focus, './prompt-injection': planner, './context-usage': context })
const { estimateFocusText, estimateFocusConversation, focusPromptInjectionState, remainingFocusInjectionTokens } = tokens
const { default: Header } = load('../src/renderer/src/components/FocusTokenUsage.tsx', {
  'react/jsx-runtime': jsxRuntime, '@shared/focus-token-usage': tokens
})
const prefix = '【角色】\n你是终端助手。\n\n【工作协议】\n使用工具处理用户任务。'
const status = { installed: true, enabled: true, promptInjectionEnabled: true, prefix }
const committed = () => planner.commitInjection(null, planner.planInjection(null, prefix, 'chatgpt'), 100)
const sum = texts => texts.reduce((total, text) => {
  const next = estimateFocusText(text)
  return { estimatedTokens: total.estimatedTokens + next.estimatedTokens, characters: total.characters + next.characters }
}, { estimatedTokens: 0, characters: 0 })
const plain = value => JSON.parse(JSON.stringify(value))
const totals = value => plain({ estimatedTokens: value.estimatedTokens, characters: value.characters })

test('mixed-language estimates distinguish ASCII/code from Chinese without counting binary images or presentation trees', () => {
  assert.equal(estimateFocusText('abcd').estimatedTokens, 1)
  assert.equal(estimateFocusText('你好世界').estimatedTokens, 4)
  assert.equal(estimateFocusText(' \n\t ').estimatedTokens, 0)
  const code = 'const value = 42;\nconsole.log(value);'
  assert.ok(estimateFocusText(code).estimatedTokens > 0)
  const image = 'data:image/png;base64,' + 'AAAA'.repeat(40000)
  const marker = '<!--focus-layout ' + JSON.stringify({ root: { tag: 'img', attrs: { src: image } } }) + ' -->\n> 架构图片'
  assert.deepEqual(plain(estimateFocusText(marker)), plain(estimateFocusText('> 架构图片')))
  assert.deepEqual(plain(estimateFocusText('![示例](' + image + ')')), plain(estimateFocusText('![示例]()')))
  assert.ok(estimateFocusText('```html\n<!-- keep this code comment -->\n```').characters > 30, 'ordinary code comments remain text')
})

test('saved rows and live turns are counted once, streaming rich answers replace their saved version, and edits hide replaced branches', () => {
  const turn = { id: 'turn-a', userMessageId: 'user-a', userText: '请检查代码', segments: [
    { sourceMessageId: 'reply-a', answer: '旧回复', parts: [{ kind: 'reasoning', text: '正在检查' }] }
  ] }
  const input = { turns: [turn, { ...turn, id: 'old', supersededBy: 'turn-a', userText: '被替换的内容' }],
    messages: [{ id: 'user-a', role: 'user', sourceMessageId: null, content: turn.userText },
      { id: 'assistant-a', role: 'assistant', sourceMessageId: 'reply-a', content: '旧回复' },
      { id: 'old-user', role: 'user', sourceMessageId: null, content: '不要统计' }],
    hiddenMessageIds: ['old-user'], executions: [], smartReplies: [{ sourceMessageId: 'reply-a', answer: '新的完整回复' }] }
  assert.deepEqual(totals(estimateFocusConversation(input)), sum([turn.userText, '新的完整回复']))
  assert.deepEqual(plain(estimateFocusConversation(input).details.visibleReasoning), sum(['正在检查']))
  input.turns[0].segments[0].answer = '旧回复的另一个快照'
  assert.deepEqual(totals(estimateFocusConversation(input)), sum([turn.userText, '新的完整回复']))
})

test('only observed requests and submitted results count; full local execution logs and duplicate assistant rows do not', () => {
  const record = { messageId: 'command-a', command: 'git status', description: '检查仓库状态', output: 'working tree clean' }
  const input = { messages: [{ id: 'assistant-a', role: 'assistant', sourceMessageId: record.messageId, content: '重复的指令记录' },
    { id: 'file-copy', role: 'assistant', sourceMessageId: 'read-files:request', content: '重复的文件回传' }],
    turns: [{ userMessageId: null, userText: '检查项目', segments: [{ sourceMessageId: record.messageId, answer: '重复的指令记录', parts: [] }] }],
    executions: [record, record] }
  assert.deepEqual(totals(estimateFocusConversation(input)), sum(['检查项目']))
  const observed = context.emptyContextUsage()
  observed.toolRequests = tokens.estimateContextText(JSON.stringify({ command: record.command, description: record.description }))
  observed.toolResults = tokens.estimateContextText('【上一条命令执行结果】\n输出已截断。')
  observed.injections = tokens.estimateContextText('当时发送的提示词版本')
  observed.toolDefinitions = tokens.estimateContextText('【工具说明】\n完整工具协议')
  observed.requestSourceIds.push(record.messageId)
  observed.uncertain = tokens.estimateContextText('这次回传是否成功不确定，不能计入')
  observed.uncertainCount = 1
  input.contextUsage = observed
  const expected = sum(['检查项目'])
  for (const bucket of [observed.toolRequests, observed.toolResults, observed.injections, observed.toolDefinitions]) {
    expected.estimatedTokens += bucket.estimatedTokens; expected.characters += bucket.characters
  }
  assert.deepEqual(totals(estimateFocusConversation(input)), expected)
  record.output = '完整输出'.repeat(100000)
  assert.deepEqual(totals(estimateFocusConversation(input)), expected, 'changing a local log does not alter submitted context')
})

test('attachments are not assigned invented tokens, old gaps are disclosed, and full injection never resets context totals', () => {
  const observed = context.emptyContextUsage()
  observed.observedSince = 10000; observed.images = 1; observed.files = 2
  observed.injections = tokens.estimateContextText(prefix)
  const input = { messages: [{ id: 'u', role: 'user', sourceMessageId: null, content: '检查附件', createdAt: 1,
    attachments: [{ mimeType: 'image/png' }] }], turns: [{ userMessageId: 'u', userText: '检查附件', createdAt: 1,
    userAttachments: [{ mimeType: 'image/png' }, { mimeType: 'text/plain' }], segments: [] }], executions: [], contextUsage: observed }
  const before = estimateFocusConversation(input)
  assert.equal(before.details.images, 2, 'live and saved copies of the user image count once')
  assert.equal(before.details.files, 3)
  assert.equal(before.details.incompleteHistory, true)
  const refreshed = planner.commitInjection(committed(), planner.planInjection(null, prefix, 'chatgpt'), 200)
  assert.equal(focusPromptInjectionState('chatgpt', refreshed, status).charactersSinceFull, 0)
  assert.deepEqual(totals(estimateFocusConversation(input)), totals(before))
  input.messages[0].createdAt = 10000; input.turns[0].createdAt = 10000
  assert.equal(estimateFocusConversation(input).details.incompleteHistory, false)
  delete input.contextUsage
  assert.equal(estimateFocusConversation(input).details.incompleteHistory, true)
})

test('remaining tokens follow the real character threshold and reset only on confirmed full injection', () => {
  const ledger = committed(), usage = estimateFocusText('你好世界')
  assert.equal(focusPromptInjectionState('chatgpt', null, status).phase, 'full-next')
  assert.equal(remainingFocusInjectionTokens(focusPromptInjectionState('chatgpt', null, status), usage), 0)
  const before = JSON.stringify(ledger)
  const first = focusPromptInjectionState('chatgpt', ledger, status)
  assert.equal(first.phase, 'countdown')
  assert.equal(remainingFocusInjectionTokens(first, usage), 60000)
  assert.equal(JSON.stringify(ledger), before, 'reading the counter never advances or resets the ledger')
  const traffic = planner.addInjectionTraffic(ledger, 59999)
  const last = focusPromptInjectionState('chatgpt', traffic, status)
  assert.equal(last.phase, 'countdown'); assert.equal(remainingFocusInjectionTokens(last, usage), 1)
  const dueLedger = planner.addInjectionTraffic(traffic, 1)
  const due = focusPromptInjectionState('chatgpt', dueLedger, status)
  assert.equal(due.phase, 'full-next'); assert.equal(due.reason, 'budget')
  assert.equal(remainingFocusInjectionTokens(due, usage), 0)
  const after = planner.commitInjection(dueLedger, planner.planInjection(dueLedger, prefix, 'chatgpt'), 200)
  assert.equal(remainingFocusInjectionTokens(focusPromptInjectionState('chatgpt', after, status), usage), 60000)
  assert.equal(remainingFocusInjectionTokens(first, estimateFocusText('abcd')), 15000, 'ASCII uses its observed density')
})

test('disabled/loading and early full-refresh reasons match the existing injection planner', () => {
  const ledger = committed()
  for (const patch of [{ enabled: false }, { promptInjectionEnabled: false }]) {
    assert.equal(focusPromptInjectionState('chatgpt', ledger, { ...status, ...patch }).phase, 'disabled')
  }
  assert.equal(focusPromptInjectionState('chatgpt', ledger, { ...status, installed: false }).phase, 'loading')
  assert.equal(focusPromptInjectionState('chatgpt', ledger, { ...status, prefix: '' }).phase, 'loading')
  const once = planner.noteInjectionViolation(ledger)
  assert.equal(focusPromptInjectionState('chatgpt', once, status).phase, 'countdown', 'one violation sends a reminder')
  const twice = focusPromptInjectionState('chatgpt', planner.noteInjectionViolation(once), status)
  assert.equal(twice.phase, 'full-next'); assert.equal(twice.reason, 'violations')
  const changed = focusPromptInjectionState('chatgpt', ledger, { ...status, prefix: '【角色】\n' + '新的完整约定'.repeat(100) })
  assert.equal(changed.phase, 'full-next'); assert.equal(changed.reason, 'mostly-changed')
})

test('header renders estimated conversation and remaining tokens with clear pending/disabled states', () => {
  const usage = estimateFocusText('abcd'), ledger = committed()
  const render = (injection, loading = false) => renderToStaticMarkup(createElement(Header, { usage, injection, loading }))
  const html = render(focusPromptInjectionState('chatgpt', ledger, status))
  assert.match(html, /上下文/); assert.match(html, /≈1 tokens/)
  assert.match(html, /完整提示词注入剩余/); assert.match(html, /≈15.0K tokens/)
  assert.match(html, /字符/); assert.match(html, /查看上下文估算明细/)
  assert.match(render(focusPromptInjectionState('chatgpt', null, status)), /0 tokens · 下次任务注入/)
  assert.match(render(focusPromptInjectionState('chatgpt', ledger, { ...status, enabled: false })), /已关闭/)
  assert.match(render(undefined, true), /读取中…/)
})

test('header keeps the breakdown compact with category totals and no explanatory paragraphs', () => {
  const observed = context.emptyContextUsage()
  observed.uncertainCount = 1; observed.uncertain = tokens.estimateContextText('不确定提交')
  observed.images = 1
  const usage = estimateFocusConversation({ turns: [], executions: [], contextUsage: observed,
    messages: [{ id: 'u', role: 'user', sourceMessageId: null, content: '旧消息', createdAt: 1, attachments: [] }] })
  const html = renderToStaticMarkup(createElement(Header, { usage, loading: false }))
  for (const label of ['部分记录', '上下文估算明细', '对话消息', '提示词注入', '工具完整说明', '工具请求', '已回传的工具与自动消息']) assert.ok(html.includes(label), label)
  assert.doesNotMatch(html, /<p[ >]/)
})
