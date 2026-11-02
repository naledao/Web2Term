// User-run only: node --test tests/tool-prompt-views.test.mjs
// Actual settings component rendered with synthetic state. No Electron, DOM or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import { createElement } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

function load(path, dependencies) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText).runInNewContext({ exports, require(name) {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../src/shared/conversation-tools.ts', { './computer-progress': { normalizeComputerResultDelay: value => value ?? 0 } })
const skills = load('../src/shared/focus-skills.ts', {})
const state = { owner: { sessionId: 'workspace', platformId: 'chatgpt', conversationId: 'chat' },
  preferences: { ...shared.DEFAULT_CONVERSATION_TOOLS }, tools: [
    ['files', '文件读取'], ['background', '后台任务'], ['scheduled', '定时任务'], ['mail', '邮件通知'], ['computer', '电脑操作（computer use）']
  ].map(([id, name]) => ({ id, name, enabled: id !== 'computer', available: true, summary: name + '摘要', prompt: name + '完整说明', message: '' })) }
let hook = 0
const hooks = { useEffect() {}, useRef: value => ({ current: value }),
  useState: initial => [hook++ === 0 ? state : typeof initial === 'function' ? initial() : initial, () => {}] }
const wrapper = tag => ({ children, className }) => createElement(tag, { className }, children)
const Dialog = { Root: wrapper('div'), Portal: wrapper('div'), Popup: wrapper('section'), Title: wrapper('h2'),
  Description: wrapper('p'), Close: props => createElement('button', { 'aria-label': props['aria-label'] }, props.children) }
const { default: Settings } = load('../src/renderer/src/components/ToolPromptsDialog.tsx', {
  react: hooks, 'react/jsx-runtime': jsxRuntime, '@base-ui/react/dialog': { Dialog },
  '@uiw/react-md-editor': { default: { Markdown: ({ source }) => createElement('pre', null, source) } },
  '@shared/conversation-tools': shared, '@shared/focus-skills': skills,
  './ComputerUseSettings': { default: () => createElement('div', null, '结果回传间隔设置') }, './ToolPromptsDialog.css': {}
})
function render(skillId) {
  hook = 0
  return renderToStaticMarkup(createElement(Settings, { owner: state.owner, theme: 'light', container: {},
    trigger: { current: null }, onClose() {}, ...(skillId ? { skillId } : {}) }))
}

test('normal tool prompt window exposes only file/background controls, even when all skills exist in state', () => {
  const html = render()
  assert.match(html, /工具提示词|文件读取|后台任务/)
  for (const hidden of ['定时任务', '邮件通知', '电脑操作', 'computer use', '结果回传间隔设置']) assert.ok(!html.includes(hidden), hidden)
  assert.equal((html.match(/role="switch"/g) ?? []).length, 2)
  assert.ok(!html.includes('conversation-tool-computer'))
})

test('each skill has its own settings view without exposing the other skills or automatic tools', () => {
  for (const [id, label] of [['scheduled_task', '定时任务'], ['send_email', '邮件通知'], ['computer', '电脑操作']]) {
    const html = render(id)
    assert.ok(html.includes(label + '设置'))
    assert.ok(html.includes('说明仅随选中的任务按需加载'))
    assert.equal((html.match(/role="switch"/g) ?? []).length, 1)
    for (const other of ['文件读取', '后台任务', '定时任务', '邮件通知', '电脑操作'].filter(name => name !== label)) assert.ok(!html.includes(other), other)
    assert.equal(html.includes('结果回传间隔设置'), id === 'computer')
  }
})
