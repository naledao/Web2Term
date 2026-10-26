// User-run only. Actual presentation/cache/runtime code with synthetic journal rows and file verification.
// Does not launch Electron, helper, browser, desktop, shell, or access real artifacts/network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { progressVmModules } from './fixtures/progress-vm-modules.mjs'

const wire = progressVmModules['../shared/task-presentation']
const { TaskObservationPreviewCache } = progressVmModules['./task-observation-preview']
const plain = value => JSON.parse(JSON.stringify(value))
const lease = { sessionId: 'session-a', platformId: 'deepseek', conversationId: 'chat-a', taskId: 'task-a', generation: 3 }
const oid = n => 'obs_' + String(n).repeat(32)
const eid = 'ev_' + 'a'.repeat(32)
const summary = (n = 1) => ({ observationId: oid(n), stepId: 'step-a', observedAt: new Date(1000).toISOString(), target: 'window',
  windowTitle: 'Report.txt', application: 'Editor', width: 100, height: 80, controls: { count: 4, complete: false, focus: 'inside_target' }, previewAvailable: true })
function task(patch = {}) {
  return { id: lease.taskId, ...lease, status: 'recorded', machine: { id: 'machine-a', label: 'Local', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\work' },
    originalRequest: '生成报告并检查', inputs: [], updatedAt: 1200, progress: { phase: 'waiting-model', stepCount: 1, currentStep: null }, ...patch }
}
function record(patch = {}) {
  return { ...lease, machineId: 'machine-a', executionId: 'exec-a', action: 'launch_app', kind: 'action', executionState: 'dispatching', execution: 'unknown',
    deliveryState: 'pending', deliveryAttempts: 0, createdAt: 1000, updatedAt: 1100, resultJson: '{"secret":"never display"}', deliveryText: 'private model/tool text', ...patch }
}
const file = { id: eid, kind: 'file', target: 'C:\\work\\report.txt', sha256: 'b'.repeat(64), sizeBytes: 12 }
const artifactTask = () => task({ completion: { evidence: [file], report: { artifacts: [{ evidenceId: eid, path: file.target, sha256: file.sha256, sizeBytes: 12, label: '报告' }] } } })
const compile = (source, react = false) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: react ? ts.JsxEmit.ReactJSX : undefined } }).outputText
function runtime(globals = {}) {
  const url = new URL('../src/main/session-runtime.ts', import.meta.url), source = ts.createSourceFile('runtime.ts', readFileSync(url, 'utf8'), ts.ScriptTarget.ES2022, true)
  const cls = source.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'SessionRuntime')
  const names = ['presentationTask', 'getTaskActivity', 'getTaskObservationImage', 'revealTaskArtifact']
  const body = names.map(name => cls.members.find(n => n.name?.getText(source) === name).getText(source)).join('\n')
  const Subject = new Script(compile(`class Subject { ${body} }; Subject`)).runInNewContext({ ...wire, ...globals })
  const instance = new Subject(), calls = [], mutable = { task: artifactTask(), conversationId: lease.conversationId }
  Object.assign(instance, { id: lease.sessionId, active: true, disposed: false, activePlatformId: lease.platformId,
    embed: { getState: () => ({ conversationId: mutable.conversationId }) }, options: { store: { latestAutonomousTask: () => mutable.task,
      listComputerActions: () => { calls.push('journal'); return [record()] } }, computerUseObservations: {
      displaySummary: () => { calls.push('summary'); return summary() }, displayImage: () => { calls.push('image'); return 'data:image/png;base64,AA==' }
    } } })
  return { instance, calls, mutable }
}

test('read requests require the exact complete lease and only opaque observation/evidence identifiers', () => {
  assert.equal(wire.validTaskPresentationRequest(lease), true)
  for (const value of [{ ...lease, generation: 0 }, { ...lease, conversationId: '' }, { ...lease, path: file.target }, { ...lease, token: 'cu_forged' }, { ...lease, sessionId: 'a\n' }])
    assert.equal(wire.validTaskPresentationRequest(value), false)
  assert.equal(wire.validTaskPresentationRequest({ ...lease, observationId: oid(1) }, 'observationId'), true)
  assert.equal(wire.validTaskPresentationRequest({ ...lease, observationId: file.target }, 'observationId'), false)
  assert.equal(wire.validTaskPresentationRequest({ ...lease, evidenceId: eid }, 'evidenceId'), true)
})

test('activity scopes every journal row by task, generation, session, platform, conversation and machine', () => {
  const foreign = Object.entries({ sessionId: 'foreign', platformId: 'other', conversationId: 'foreign', taskId: 'foreign', generation: 4, machineId: 'other' })
    .map(([k, v]) => record({ [k]: v }))
  const original = task(), before = JSON.stringify(original)
  const activity = wire.taskActivity(original, [record(), ...foreign], summary(), 1300)
  assert.equal(activity.actions.length, 1); assert.equal(activity.readAt, 1300)
  assert.equal(JSON.stringify(original), before)
  assert.doesNotMatch(JSON.stringify(activity), /private model|never display|resultJson|deliveryText|grantToken|step_token/)
  assert.equal(activity.actions[0].state, 'dispatching'); assert.equal(activity.actions[0].execution, 'unknown')
  assert.equal(activity.actions[0].delivery, 'pending')
})

test('late executor receipts and uncertain delivery remain independent facts in the feed', () => {
  const activity = wire.taskActivity(task({ status: 'stopped' }), [record({ executionState: 'completed', execution: 'executed', deliveryState: 'unknown', deliveryAttempts: 2 })], null)
  assert.equal(activity.actions[0].state, 'completed'); assert.equal(activity.actions[0].delivery, 'unknown')
  assert.equal(activity.actions[0].deliveryAttempts, 2)
  assert.equal(Object.hasOwn(activity, 'completed'), false)
})

test('activity is bounded and ordered without claiming that dispatch selected an application', () => {
  const rows = Array.from({ length: 60 }, (_, i) => record({ executionId: 'row-' + i, createdAt: 1000 + i }))
  const t = task({ continuity: { windows: [{ key: 'window-a', title: 'Example', executablePath: 'C:\\Example.exe' }], transitions: [
    { toWindowKey: 'window-a', evidence: 'dispatched', seenAt: 1000 }
  ] } })
  let activity = wire.taskActivity(t, rows, null)
  assert.equal(activity.actions.length, 50); assert.equal(activity.actions[0].id, 'row-59'); assert.equal(activity.hasMoreActions, true)
  assert.equal(activity.application, null)
  t.continuity.transitions.push({ toWindowKey: 'window-a', evidence: 'focus-confirmed', seenAt: 2000 })
  activity = wire.taskActivity(t, rows, null)
  assert.equal(activity.application.title, 'Example'); assert.equal(activity.application.confirmedAt, 2000)
})

test('preview reads are independent copies, scoped by complete lease, and do not extend expiry', () => {
  let now = 0
  const cache = new TaskObservationPreviewCache(() => now), owner = {}, bytes = Uint8Array.from([1, 2, 3])
  cache.record(owner, lease, summary(), bytes); bytes[0] = 9
  const image = cache.image(lease, oid(1)); assert.deepEqual(Array.from(image), [1, 2, 3]); image[1] = 9
  assert.deepEqual(Array.from(cache.image(lease, oid(1))), [1, 2, 3])
  for (const patch of [{ taskId: 'other' }, { generation: 4 }, { conversationId: 'other' }, { sessionId: 'other' }, { platformId: 'other' }])
    assert.equal(cache.image({ ...lease, ...patch }, oid(1)), null)
  assert.equal(cache.image(lease, oid(2)), null)
  now = 899999; assert.ok(cache.summary(lease)); now = 900000
  assert.equal(cache.summary(lease), null); assert.equal(cache.image(lease, oid(1)), null)
})

test('latest controls-only observation replaces the previous screenshot and owner cleanup is isolated', () => {
  const cache = new TaskObservationPreviewCache(() => 0), owner = {}, second = {}
  cache.record(owner, lease, summary(), Uint8Array.of(1))
  cache.record(second, { ...lease, taskId: 'other' }, summary(2), Uint8Array.of(2))
  cache.record(owner, lease, { ...summary(3), target: 'controls', previewAvailable: false }, null)
  assert.equal(cache.summary(lease).target, 'controls'); assert.equal(cache.summary(lease).previewAvailable, false)
  assert.equal(cache.image(lease, oid(1)), null)
  cache.removeOwner(owner); assert.equal(cache.summary(lease), null)
  assert.ok(cache.summary({ ...lease, taskId: 'other' })); cache.clear()
  assert.equal(cache.summary({ ...lease, taskId: 'other' }), null)
})

test('preview cache evicts by entry count and total byte budget', () => {
  const owner = {}, cache = new TaskObservationPreviewCache(() => 0)
  for (let n = 0; n < 17; n++) cache.record(owner, { ...lease, taskId: String(n) }, summary(), null)
  assert.equal(cache.summary({ ...lease, taskId: '0' }), null); assert.ok(cache.summary({ ...lease, taskId: '16' }))
  cache.clear()
  const bytes = new Uint8Array(8 * 1024 * 1024)
  for (let n = 0; n < 5; n++) cache.record(owner, { ...lease, taskId: String(n) }, summary(), bytes)
  assert.equal(cache.summary({ ...lease, taskId: '0' }), null); assert.ok(cache.summary({ ...lease, taskId: '4' }))
  cache.record(owner, lease, summary(), new Uint8Array(8 * 1024 * 1024 + 1))
  assert.equal(cache.summary(lease).previewAvailable, false)
})

test('runtime getters reject stale visible scopes before reading a journal or preview', () => {
  const f = runtime()
  for (const patch of [{ sessionId: 'other' }, { platformId: 'other' }, { conversationId: 'other' }, { taskId: 'other' }, { generation: 4 }]) {
    assert.equal(f.instance.getTaskActivity({ ...lease, ...patch }), null)
    assert.equal(f.instance.getTaskObservationImage({ ...lease, ...patch, observationId: oid(1) }), null)
  }
  assert.deepEqual(f.calls, [])
  assert.ok(f.instance.getTaskActivity(lease)); assert.equal(f.instance.getTaskObservationImage({ ...lease, observationId: oid(1) }), 'data:image/png;base64,AA==')
  f.instance.disposed = true; assert.equal(f.instance.getTaskActivity(lease), null)
})

test('stopped and completed tasks remain inspectable without restoring an executable coordinator', () => {
  const f = runtime()
  for (const status of ['stopped', 'interrupted', 'completed']) { f.mutable.task.status = status; assert.ok(f.instance.getTaskActivity(lease)) }
  assert.deepEqual(f.calls, ['journal', 'summary', 'journal', 'summary', 'journal', 'summary'])
})

test('artifact resolution requires both a saved report entry and its matching source snapshot', async () => {
  const t = artifactTask(); assert.equal(wire.reportedArtifactEvidence(t, eid).target, file.target)
  for (const patch of [{ target: 'C:\\forged.exe' }, { sha256: 'c'.repeat(64) }, { sizeBytes: 13 }, { kind: 'observation' }]) {
    t.completion.evidence = [{ ...file, ...patch }]; assert.equal(wire.reportedArtifactEvidence(t, eid), null)
  }
  const seen = [], f = runtime({ recheckCompletionFile: async e => { seen.push(e.target); return true }, shell: { showItemInFolder: p => seen.push(p) } })
  assert.equal(await f.instance.revealTaskArtifact({ ...lease, evidenceId: eid }), '')
  assert.deepEqual(seen, [file.target, file.target])
  assert.notEqual(await f.instance.revealTaskArtifact({ ...lease, evidenceId: eid, path: 'C:\\forged.exe' }), '')
  assert.equal(seen.length, 2)
})

test('changed files or a task switch during async file verification never open a stale artifact', async () => {
  let revealCount = 0, release
  let f = runtime({ recheckCompletionFile: async () => false, shell: { showItemInFolder: () => revealCount++ } })
  assert.notEqual(await f.instance.revealTaskArtifact({ ...lease, evidenceId: eid }), '')
  f = runtime({ recheckCompletionFile: () => new Promise(resolve => { release = resolve }), shell: { showItemInFolder: () => revealCount++ } })
  const pending = f.instance.revealTaskArtifact({ ...lease, evidenceId: eid })
  f.mutable.conversationId = 'other'; release(true)
  assert.notEqual(await pending, ''); assert.equal(revealCount, 0)
})

function renderActivity(activity, visible = true) {
  const exports = {}, states = [activity, '', 0, false, null, '']
  let index = 0
  const source = readFileSync(new URL('../src/renderer/src/components/TaskActivityPanel.tsx', import.meta.url), 'utf8')
  new Script(compile(source, true)).runInNewContext({ exports, require(name) {
    if (name === 'react') return { useState: () => [states[index++], () => {}], useEffect() {} }
    if (name === 'react/jsx-runtime') return jsx
    if (name === '@shared/task-presentation') return wire
    if (name.endsWith('.css')) return {}
    throw new Error(name)
  } })
  return renderToStaticMarkup(React.createElement(exports.default, { task: task(), visible }))
}

test('UI renders dispatch and unknown delivery as facts, escapes titles, and hides raw tool/model text', () => {
  const activity = wire.taskActivity(task(), [record(), record({ executionId: 'exec-b', executionState: 'completed', execution: 'executed', deliveryState: 'unknown' })], summary(), 1200)
  activity.observation.windowTitle = '<script>title</script>'
  const html = renderActivity(activity)
  assert.match(html, /已派发，等待回执/); assert.match(html, /回传未确认/); assert.match(html, /不代表用户目标完成/)
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|private model|never display/)
  assert.equal(renderActivity(activity, false), '')
})

function pendingView({ activity, showImage = false, api }) {
  const exports = {}, effects = [], writes = [], states = [activity, '', 0, showImage, null, '']
  let index = 0
  new Script(compile(readFileSync(new URL('../src/renderer/src/components/TaskActivityPanel.tsx', import.meta.url), 'utf8'), true)).runInNewContext({
    exports, window: { api }, document: { visibilityState: 'visible' }, setTimeout: () => 1, clearTimeout() {}, require(name) {
      if (name === 'react') return { useState: () => { const n = index++; return [states[n], value => writes.push({ n, value })] }, useEffect: effect => effects.push(effect) }
      if (name === 'react/jsx-runtime') return jsx
      if (name === '@shared/task-presentation') return wire
      if (name.endsWith('.css')) return {}
      throw new Error(name)
    }
  })
  exports.default({ task: task(), visible: true })
  return { effects, writes }
}

test('late activity responses after closing/switching the inspector are discarded', async () => {
  let resolve
  const view = pendingView({ activity: null, api: { getTaskActivity: () => new Promise(done => { resolve = done }) } })
  const cleanup = view.effects[0](); cleanup()
  resolve(wire.taskActivity(task(), [record()], summary()))
  await Promise.resolve(); await Promise.resolve()
  assert.equal(view.writes.length, 0)
})

test('late screenshot responses never replace the preview after its observation scope is closed', async () => {
  let resolve
  const view = pendingView({ activity: wire.taskActivity(task(), [], summary()), showImage: true,
    api: { getTaskObservationImage: () => new Promise(done => { resolve = done }) } })
  const cleanup = view.effects[1](); assert.equal(view.writes.length, 2)
  cleanup(); resolve('data:image/png;base64,AA==')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(view.writes.length, 2)
})
