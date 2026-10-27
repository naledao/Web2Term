// User-run only: node --test tests/computer-overlay.test.mjs
// Synthetic task data only; no Electron, desktop, helper or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

function load(path) {
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  new Script(code).runInNewContext({ exports, require(name) {
    if (name === 'react/jsx-runtime') return jsx
    if (name.endsWith('.css')) return {}
    throw new Error(name)
  } })
  return exports
}
const { computerOverlaySnapshot: project, computerOverlayEmergencySnapshot, ComputerOverlayLifetime, COMPUTER_OVERLAY_COMPLETION_MS } = load('../src/shared/computer-overlay.ts')
const { default: Overlay } = load('../src/renderer/src/components/ComputerUseOverlay.tsx')
const task = () => ({ sessionId: 's', platformId: 'deepseek', conversationId: 'c', id: 'task', generation: 1,
  status: 'recorded', originalRequest: '查找联系人', updatedAt: 1000,
  progress: { phase: 'executing-tool', stepCount: 3, currentStep: { id: 'step', action: 'click',
    description: '点击联系人入口，查找收件人', status: 'executing', execution: 'unknown', delivery: 'pending',
    resultText: '{"private":"raw-result-sentinel"}', updatedAt: 1000 } } })

test('model intent is displayed without inventing success, verified windows or raw tool output', () => {
  const t = task(), snapshot = project(t, null)
  assert.equal(snapshot.action, t.progress.currentStep.description)
  assert.equal(snapshot.actionStatus, '执行中')
  assert.equal(snapshot.targetAt, null)
  assert.equal(snapshot.result, '暂无执行结果')
  assert.doesNotMatch(JSON.stringify(snapshot), /raw-result-sentinel/)
  assert.equal(project(t, null, true).actionStatus, '自动执行已暂停')
  t.status = 'stopped'
  assert.equal(project(t, null).status, '任务已停止')
})

test('failure stays failure even with an executed receipt, delivery and optimistic model text', () => {
  const t = task()
  Object.assign(t.progress.currentStep, { description: '消息已经发送成功', status: 'delivered', execution: 'executed', delivery: 'sent', message: '执行失败，需要重新观察' })
  t.progress.phase = 'waiting-model'
  const snapshot = project(t, { actions: [{ id: 'step', state: 'failed' }] })
  assert.equal(snapshot.actionStatus, '执行失败')
  assert.equal(snapshot.resultTone, 'error')
  assert.notEqual(snapshot.status, '任务已完成')
})

test('legacy steps remain displayable and task ownership changes replace the snapshot key', () => {
  const t = task()
  delete t.progress.currentStep.description
  assert.equal(project(t, null).action, '点击目标')
  const first = project(t, null).taskKey
  t.generation++
  assert.notEqual(project(t, null).taskKey, first)
  t.conversationId = 'other'
  assert.notEqual(project(t, null).taskKey, first)
})

test('React displays descriptions as text and has an honest idle state', () => {
  const snapshot = project(task(), null)
  snapshot.action = '<img src=x onerror=alert(1)>点击联系人'
  const html = renderToStaticMarkup(jsx.jsx(Overlay, { snapshot }))
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /已复核|后台运行/)
  const idle = renderToStaticMarkup(jsx.jsx(Overlay, { snapshot: null }))
  assert.match(idle, /等待任务/)
  assert.doesNotMatch(idle, /QQ|第 19 步/)
})

test('long Chinese action descriptions reach the display in full', () => {
  const t = task()
  const description = '观察当前窗口并定位需要操作的目标，确认窗口内容后再继续下一步。'.repeat(30) + '完整说明结束'
  t.progress.currentStep.description = description
  const snapshot = project(t, null)
  assert.equal(snapshot.action, description)
  const html = renderToStaticMarkup(jsx.jsx(Overlay, { snapshot }))
  assert.ok(html.includes(description))
})

test('model completion displays a success notice instead of the running heading and step intent', () => {
  const t = task()
  t.status = 'completed'
  t.modelCompletion = { messageId: 'final-answer', receivedAt: 2000 }
  t.updatedAt = 2000
  const snapshot = project(t, null)
  assert.equal(snapshot.completed, true)
  assert.equal(snapshot.tone, 'success')
  assert.equal(snapshot.updatedAt, 2000)
  const html = renderToStaticMarkup(jsx.jsx(Overlay, { snapshot }))
  assert.match(html, /Computer Use 任务已完成/)
  assert.match(html, /提示将自动收起/)
  assert.match(html, /模型已输出/)
  assert.doesNotMatch(html, /正在操控|点击联系人入口|连续来回晃动鼠标/)
})

test('the live overlay explains the mouse-shake gesture and an emergency is never displayed as completion', () => {
  const snapshot = project(task(), null)
  const live = renderToStaticMarkup(jsx.jsx(Overlay, { snapshot }))
  assert.match(live, /连续来回晃动鼠标，立即急停/)
  assert.doesNotMatch(live, /ESC|F12/)
  const state = { active: true, source: 'mouse-gesture', triggeredAt: 2000, canReset: false }
  const stopped = computerOverlayEmergencySnapshot(snapshot, state, 2000)
  assert.equal(stopped.completed, false)
  assert.equal(stopped.emergencyStopped, true)
  assert.equal(stopped.status, '正在停止自动操作')
  const html = renderToStaticMarkup(jsx.jsx(Overlay, { snapshot: stopped }))
  assert.match(html, /全局急停已触发/)
  assert.match(html, /连续晃动鼠标/)
  assert.match(html, /所有会话/)
  assert.match(html, /解除急停后/)
  assert.doesNotMatch(html, /任务已完成|正在操控|点击联系人入口/)
  assert.equal(computerOverlayEmergencySnapshot(snapshot, { ...state, canReset: true }, 2100).status, '自动操作已停止')
  assert.equal(snapshot.emergencyStopped, undefined, 'stop projection never mutates the live task')
})

test('the emergency overlay expires from the original trigger time without polling extending it', () => {
  const snapshot = project(task(), null), state = { active: true, source: 'mouse-gesture', triggeredAt: 2000, canReset: false }
  assert.ok(computerOverlayEmergencySnapshot(snapshot, state, 2000 + COMPUTER_OVERLAY_COMPLETION_MS - 1))
  assert.equal(computerOverlayEmergencySnapshot(snapshot, state, 2000 + COMPUTER_OVERLAY_COMPLETION_MS), null)
  assert.equal(computerOverlayEmergencySnapshot(snapshot, { ...state, active: false }, 2100), null)
  assert.equal(computerOverlayEmergencySnapshot(null, state, 2100), null)
})

test('live completion expires once; polling and repeated completed events never renew it', () => {
  const lifetime = new ComputerOverlayLifetime(), t = task()
  lifetime.update(t, 1000)
  t.status = 'completed'
  lifetime.update(t, 2000)
  assert.equal(lifetime.visible(t, 2000), true)
  lifetime.update(t, 7000)
  assert.equal(lifetime.visible(t, 2000 + COMPUTER_OVERLAY_COMPLETION_MS - 1), true)
  assert.equal(lifetime.visible(t, 2000 + COMPUTER_OVERLAY_COMPLETION_MS), false)
  lifetime.update(t, 9000)
  assert.equal(lifetime.visible(t, 9000), false)
})

test('history stays hidden and an old completion cannot hide or replace a new task', () => {
  const lifetime = new ComputerOverlayLifetime(), history = task()
  history.status = 'completed'
  lifetime.update(history, 1000)
  assert.equal(lifetime.visible(history, 1000), false)
  const first = task()
  lifetime.update(first, 2000)
  first.status = 'completed'
  lifetime.update(first, 3000)
  const next = { ...task(), id: 'next-task', generation: 2 }
  lifetime.update(next, 3500)
  lifetime.update(first, 4000)
  assert.equal(lifetime.visible(first, 4000), false)
  assert.equal(lifetime.visible(next, 100000), true)
  const other = { ...task(), platformId: 'other-platform' }
  lifetime.update(other, 5000)
  assert.equal(lifetime.visible(next, 100000), true)
  next.status = 'stopped'
  lifetime.update(next, 6000)
  assert.equal(lifetime.visible(next, 6000), false)
})
