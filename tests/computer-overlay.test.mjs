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

test('terminal/file steps and their completions cannot open a computer overlay, including legacy steps', () => {
  for (const tool of ['command', 'read_files']) {
    for (const legacy of [false, true]) {
      const lifetime = new ComputerOverlayLifetime(), t = task()
      Object.assign(t.progress.currentStep, { action: tool, tool, status: 'delivered', delivery: 'sent', execution: 'executed' })
      if (legacy) delete t.progress.currentStep.tool
      t.progress.phase = 'waiting-model'
      lifetime.update(t, 1000)
      assert.equal(lifetime.visible(t, 1000), false, 'a generic step count does not establish computer use')
      t.status = 'completed'
      lifetime.update(t, 2000)
      assert.equal(lifetime.visible(t, 2001), false, 'a command-only task has no computer completion notice')
    }
  }
})

test('an actual computer step opens its own lifetime and keeps mixed tool steps continuous', () => {
  const lifetime = new ComputerOverlayLifetime(), t = task()
  t.progress.stepCount = 0
  t.progress.currentStep = null
  lifetime.update(t, 1000)
  assert.equal(lifetime.visible(t, 1000), false, 'an enabled capability or a new goal is not a desktop step')
  t.progress.stepCount = 1
  t.progress.currentStep = { ...task().progress.currentStep, tool: 'computer', action: 'observe' }
  assert.equal(lifetime.visible(t, 1100), false, 'reading a task cannot open the overlay')
  lifetime.update(t, 1100)
  assert.equal(lifetime.visible(t, 1100), true)
  t.progress.stepCount++
  t.progress.currentStep = { ...t.progress.currentStep, tool: 'command', action: 'command' }
  lifetime.update(t, 1200)
  assert.equal(lifetime.visible(t, 1200), true, 'the same computer task may also run a terminal command')
  const next = { ...t, id: 'mail-only', generation: 2 }
  lifetime.update(next, 1300)
  assert.equal(lifetime.visible(next, 1300), false, 'new mail/terminal tasks do not inherit computer visibility')
  assert.equal(lifetime.visible(t, 1300), false)
})

const runtimePath = '../src/main/session-runtime.ts'
const runtimeAst = ts.createSourceFile(runtimePath, readFileSync(new URL(runtimePath, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const runtimeClass = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionRuntime')
const readMethod = runtimeClass.members.find(node => node.name?.getText(runtimeAst) === 'getComputerOverlaySnapshot')
const readSnapshot = new Script(ts.transpileModule('class Runtime {' + readMethod.getText(runtimeAst) + '} Runtime.prototype.getComputerOverlaySnapshot', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ computerOverlaySnapshot: project,
  taskPresentationLease: load('../src/shared/task-presentation.ts').taskPresentationLease })

test('the native window snapshot stays null for mail/terminal work with computer use enabled on either platform', () => {
  for (const platformId of ['chatgpt', 'deepseek']) {
    const t = { ...task(), platformId, originalRequest: '重新发一下邮件。' }, lifetime = new ComputerOverlayLifetime()
    Object.assign(t.progress.currentStep, { action: 'command', tool: 'command', description: undefined,
      status: 'delivered', execution: 'executed', delivery: 'sent' })
    t.progress.phase = 'waiting-model'
    lifetime.update(t)
    let activityReads = 0
    const runtime = { id: t.sessionId, active: true, disposed: false, activePlatformId: platformId,
      getComputerUseCapability: () => ({ computerUseEnabled: true }), embed: { getState: () => ({ conversationId: t.conversationId }) },
      options: { store: { latestAutonomousTask: () => t } }, computerOverlayLifetime: lifetime,
      getTaskActivity() { activityReads++; return null }, runner: { getAutomation: () => ({ paused: false }) } }
    assert.equal(readSnapshot.call(runtime), null)
    assert.equal(activityReads, 0)
    Object.assign(t.progress.currentStep, { tool: 'computer', action: 'observe' })
    lifetime.update(t)
    assert.equal(readSnapshot.call(runtime).action, '观察界面')
    assert.equal(activityReads, 1)
  }
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
