// User-run only: node --test tests/focus-answer-layout.test.mjs
// The real turn renderer with synthetic state; no Electron, browser session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/components/FocusChatView.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('FocusChatView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function findRenderer(node = file) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'renderTurn') return node.initializer
  return ts.forEachChild(node, findRenderer)
}
const renderer = findRenderer()
assert.ok(renderer, 'Missing actual focus turn renderer')
const compiled = ts.transpileModule('export const renderTurn = ' + renderer.getText(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: 'render-turn.tsx'
}).outputText
const Markdown = ({ text }) => React.createElement('p', null, text)
const ProcessScroll = ({ children }) => React.createElement('div', null, children)

function fixture({ records = [], richAnswers = new Map() } = {}) {
  const exports = {}, copies = []
  new Script(compiled).runInNewContext({
    exports, require: createRequire(import.meta.url), Markdown, ProcessScroll,
    ProcessHint: () => null, richAnswers, recordsById: new Map(records.map(record => [record.messageId, record])),
    messagesById: new Map(), focusDelivery: (_record, delivery) => delivery,
    remembered: (_key, open = false) => ({ open }),
    userContent: (_id, text) => React.createElement('p', null, text),
    renderExecution: record => React.createElement('div', { 'data-execution': record.messageId }),
    modelIcon: null, modelLabel: 'DeepSeek', theme: 'light', state: null,
    editingId: null, copiedId: null, actionId: null,
    props: { onOpenTerminal() {} }, copy: (...args) => copies.push(args)
  })
  return { render: exports.renderTurn, copies }
}
const segment = (cycle, answer, parts = []) => ({ cycle, sourceMessageId: 'reply-' + cycle, answer, parts, settled: true })
const turn = segments => ({ id: 'turn-1', userMessageId: null, userText: '看看这个后台任务情况',
  status: 'working', segments, executionIds: [], executionCycles: {}, deliveries: {} })

function elements(node, ancestors = []) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, ancestors))
  if (!React.isValidElement(node)) return []
  return [{ node, ancestors }, ...elements(node.props.children, [...ancestors, node])]
}
const inProcess = entry => entry.ancestors.some(node => node.props.className === 'focus-process')
const answersOf = tree => elements(tree).filter(({ node }) => node.props.className === 'focus-answer')
const answerTexts = tree => answersOf(tree).map(({ node }) => node.props.children.props.text)

test('a prose reply stays outside the process panel after a command and an empty result cycle', () => {
  const text = '站点启动失败的根本原因是数据库尚未初始化。'
  const current = turn([
    segment(0, text, [{ kind: 'reasoning', text: '检查任务状态' }]),
    segment(1, ''), segment(2, '')
  ])
  current.executionIds = ['command-1']
  current.executionCycles['command-1'] = 1
  current.deliveries['command-1'] = 'pending'
  const f = fixture({ records: [{ messageId: 'command-1', status: 'done' }] })
  const tree = f.render(current), all = elements(tree)

  assert.deepEqual(answerTexts(tree), [text])
  assert.equal(answersOf(tree)[0].node.props['data-question-answer'], 'reply-0')
  assert.ok(answersOf(tree).every(entry => !inProcess(entry)))
  assert.deepEqual(all.filter(entry => entry.node.type === Markdown && inProcess(entry)).map(entry => entry.node.props.text), ['检查任务状态'])
  assert.ok(inProcess(all.find(entry => entry.node.props['data-execution'] === 'command-1')))
  assert.match(renderToStaticMarkup(tree), /正在回传执行结果/)
})

test('earlier prose remains in the main conversation as the next reply streams or the turn stops', () => {
  const f = fixture(), current = turn([segment(0, '已有诊断结果')])
  assert.deepEqual(answerTexts(f.render(current)), ['已有诊断结果'])
  current.segments.push({ ...segment(1, ''), settled: false })
  assert.deepEqual(answerTexts(f.render(current)), ['已有诊断结果'])
  current.segments[1].answer = '下一步操作正在生成'
  for (const status of ['working', 'stopped', 'blocked', 'answered']) {
    current.status = status
    const tree = f.render(current)
    assert.deepEqual(answerTexts(tree), ['已有诊断结果', '下一步操作正在生成'], status)
    assert.ok(answersOf(tree).every(entry => !inProcess(entry)), status)
  }
})

test('a final DeepSeek answer is visible and old pending deliveries cannot override its completed state', () => {
  const final = '已创建 HTML 页面并交给 Spring Boot 托管，访问验证通过。'
  const current = { ...turn([segment(0, ''), segment(1, '等待后台构建。'), segment(2, final)]), status: 'answered',
    executionIds: ['startup'], executionCycles: { startup: 0 }, deliveries: { startup: 'pending' } }
  const f = fixture({ records: [{ messageId: 'startup', status: 'done' }] })
  const tree = f.render(current), html = renderToStaticMarkup(tree)
  assert.deepEqual(answerTexts(tree), ['等待后台构建。', final])
  assert.match(html, /已回复/)
  assert.doesNotMatch(html, /正在回传执行结果/)
  current.status = 'stopped'
  assert.match(renderToStaticMarkup(f.render(current)), /已停止/)
  assert.doesNotMatch(renderToStaticMarkup(f.render(current)), /正在回传执行结果/)
})

test('background handoff does not look like shell delivery while a real foreground result still does', () => {
  const current = { ...turn([segment(0, '')]), executionIds: ['startup'], executionCycles: { startup: 0 },
    deliveries: { startup: 'background' } }
  const f = fixture({ records: [{ messageId: 'startup', status: 'done' }] })
  const background = renderToStaticMarkup(f.render(current))
  assert.match(background, /正在处理/)
  assert.doesNotMatch(background, /正在回传执行结果/)
  current.deliveries.startup = 'pending'
  assert.match(renderToStaticMarkup(f.render(current)), /正在回传执行结果/)
})

test('each visible answer retains its source, rich content and place in the copied reply', () => {
  const rich = '完整图表与诊断结果'
  const f = fixture({ richAnswers: new Map([['reply-0', rich]]) })
  const current = { ...turn([segment(0, '旧图表'), segment(1, ''), segment(2, '最终操作说明')]), status: 'answered' }
  const tree = f.render(current)
  assert.deepEqual(answerTexts(tree), [rich, '最终操作说明'])
  assert.deepEqual(answersOf(tree).map(({ node }) => node.props['data-question-answer']), ['reply-0', 'reply-2'])
  const copy = elements(tree).find(({ node }) => node.type === 'button' && node.props.children === '复制回答')
  copy.node.props.onClick()
  assert.deepEqual(f.copies, [['turn-1', rich + '\n\n最终操作说明']])
  assert.match(renderToStaticMarkup(tree), /最终操作说明/)
})

test('rich refreshes never restore command JSON to empty execution segments or copied answers', () => {
  const command = 'JSON\n\n```json\n{"command":"unzip -n -q website-source-2.zip","description":"解压项目","timeout_seconds":30}\n```'
  const final = '已成功解压至 `/root/website-source-2/`。'
  const current = { ...turn([segment(0, ''), segment(1, ''), segment(2, final)]), status: 'answered' }
  current.executionIds = ['reply-0', 'reply-1']
  current.executionCycles = { 'reply-0': 0, 'reply-1': 1 }
  const f = fixture({ records: current.executionIds.map(messageId => ({ messageId, status: 'done' })),
    richAnswers: new Map([['reply-0', command], ['reply-1', command], ['reply-2', final]]) })
  const tree = f.render(current), all = elements(tree)
  assert.deepEqual(answerTexts(tree), [final])
  assert.doesNotMatch(renderToStaticMarkup(tree), /unzip|timeout_seconds|```json/)
  for (const id of current.executionIds) assert.ok(inProcess(all.find(entry => entry.node.props['data-execution'] === id)))
  all.find(entry => entry.node.type === 'button' && entry.node.props.children === '复制回答').node.props.onClick()
  assert.deepEqual(f.copies, [['turn-1', final]])
})

test('known legacy command answers stay hidden while independent prose in the same cycle remains visible', () => {
  const command = '{"command":"pwd","description":"检查目录","timeout_seconds":30}'
  const current = turn([segment(0, command), { ...segment(1, '目录已确认。'), sourceMessageId: 'final-reply' }])
  current.executionIds = ['reply-0', 'execution-1']
  current.executionCycles = { 'execution-1': 1 }
  const f = fixture()
  assert.deepEqual(answerTexts(f.render(current)), ['目录已确认。'])
})

test('an authoritative empty answer stays empty while prose with ordinary code examples remains visible', () => {
  const example = '配置示例：\n\n```json\n{"name":"example","scripts":{"dev":"vite"}}\n```\n\n运行 `npm run dev`。'
  const current = turn([segment(0, ''), segment(1, example)])
  const f = fixture({ richAnswers: new Map([['reply-0', '意外的富内容回填']]) })
  assert.deepEqual(answerTexts(f.render(current)), [example])
})
