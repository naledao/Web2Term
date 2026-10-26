// User-run only: node --test tests/focus-model-settings.test.mjs
// Actual page methods + native dispatcher. Synthetic DOM/input only; never Electron/network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

function moduleAt(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText).runInNewContext({ exports, require: name => dependencies[name] ?? {} })
  return exports
}
const shared = moduleAt('../src/shared/focus-chat.ts')
const { CHATGPT_PAGE } = moduleAt('../src/shared/platforms.ts')
const { dispatchFocusModelClick } = moduleAt('../src/main/focus-model-click.ts')
const { default: Controls } = moduleAt('../src/renderer/src/components/FocusModelSettings.tsx', { 'react/jsx-runtime': jsxRuntime })
const pagePath = '../src/main/injected/send-interceptor.js'
function actual(name, context, method = false, path = pagePath) {
  const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  function find(node) {
    if ((method ? ts.isMethodDeclaration(node) : ts.isVariableDeclaration(node)) && node.name?.getText(file) === name) return node
    return ts.forEachChild(node, find)
  }
  const node = find(file)
  assert.ok(node, name)
  const code = method ? '({' + node.getText(file) + '}).' + name : '(' + node.initializer.getText(file) + ')'
  return new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context)
}
function fixture() {
  let open = false, view = 'effort', model = 'GPT-6', effort = 'high', now = 0, step = 0
  let focused = true, owner = true, blocked = false, duplicates = false, range = '2', afterInput = null, hit = null
  let triggerVisible = true, effortPresent = true
  const composer = { draft: 'keep this draft exactly' }, inputs = [], reports = []
  const rules = CHATGPT_PAGE.focus.modelSettings
  const node = (text, attributes, box, visible = () => true) => ({
    textContent: text, id: attributes.id || '', isConnected: true, visible,
    getAttribute(key) { return attributes[key] ?? null },
    contains(other) { return this === other },
    closest(selector) { return selector.includes('aria-hidden') && !this.visible() ? {} : null },
    getBoundingClientRect() { return { left: box[0], top: box[1], width: box[2], height: box[3], right: box[0] + box[2], bottom: box[1] + box[3] } }
  })
  let trigger = node('High', { id: 'native-trigger' }, [10, 10, 160, 32], () => triggerVisible)
  trigger.getAttribute = key => ({ 'aria-expanded': String(open), 'aria-controls': open ? 'native-menu' : null,
    [rules.effortAttribute]: effortPresent ? effort : null })[key] ?? null
  const models = ['GPT-6', 'GPT-5.6 Sol'].map((text, i) => {
    const item = node(text, {}, [10, 80 + i * 35, 240, 30], () => open && view === 'model')
    item.getAttribute = key => key === 'aria-checked' ? String(model === text) : null
    return item
  })
  const toggle = node('High', {}, [10, 75, 240, 30], () => open && view === 'effort')
  const slider = node('', {}, [10, 135, 220, 32], () => open && view === 'effort')
  const root = node('', {}, [20, 140, 200, 20], () => open && view === 'effort')
  const rangeInput = node('', {}, [0, 0, 0, 0])
  rangeInput.getAttribute = key => ({ 'aria-valuemin': '0', 'aria-valuemax': range })[key] ?? null
  slider.querySelector = selector => selector === '[role="slider"]' ? rangeInput : selector === rules.sliderRootSelector ? root : null
  const menu = node('', { role: 'menu', 'aria-labelledby': trigger.id }, [10, 60, 250, 140], () => open)
  menu.querySelectorAll = selector => selector === rules.modelSelector ? duplicates ? [...models, models[0]] : models :
    selector === rules.viewToggleSelector ? [toggle] : []
  menu.querySelector = selector => selector === rules.sliderSelector ? slider : null
  const context = createContext({ PAGE: CHATGPT_PAGE, location: { pathname: '/' }, Date: { now: () => now },
    focusModeChanging: null, focusModelCache: null, focusEditing: null, fileSend: null,
    state: { taskPromptGeneration: 1, programmatic: false, awaitingReplySince: 0, pendingQuestion: false },
    getComposer: () => composer, findStopButton: () => null,
    queryAll: selectors => selectors[0] === rules.triggerSelector ? [trigger] : [],
    isVisibleElement: element => element?.isConnected && element.visible(), controlDisabled: () => blocked,
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(),
    innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ direction: 'ltr' }),
    document: { getElementById: id => id === 'native-menu' && open ? menu : null,
      elementFromPoint(x, y) { hit = [trigger, ...models, toggle, root].find(item => {
        const b = item.getBoundingClientRect()
        return item.visible() && x >= b.left && x < b.right && y >= b.top && y < b.bottom
      }); return hit } },
    setTimeout(callback, delay) { now += delay; queueMicrotask(callback) },
    report(payload) {
      reports.push(payload)
      if (payload.count !== step + 1) return
      step = payload.count
      queueMicrotask(() => { void dispatchFocusModelClick(contents, payload.focusModelToken, payload.count, () => owner, () => focused) })
    }
  })
  context.focusModelPickerParts = actual('focusModelPickerParts', context)
  context.focusModelSettingsOf = actual('focusModelSettingsOf', context)
  const api = {}
  for (const name of ['prepareFocusModelClick', 'finishFocusModelClick', 'updateModelSettings']) api[name] = actual(name, context, true)
  context.window = { __cmdTerminalInterceptor: api }
  const contents = { getZoomFactor: () => 1.5, executeJavaScript: source => Promise.resolve(new Script(source).runInContext(context)),
    sendInputEvent(event) {
      inputs.push(event)
      if (event.type !== 'mouseUp') return
      if (hit === trigger) { open = !open; if (open) view = 'effort' }
      else if (hit === toggle) view = 'model'
      else if (models.includes(hit)) { model = hit.textContent; view = 'effort'; effort = 'medium' }
      else if (hit === root) effort = ['none', 'medium', 'high'][Math.round((event.x / 1.5 - 20) / 100)]
      afterInput?.(hit)
    } }
  return { context, inputs, reports, composer, get trigger() { return trigger }, models, read: context.focusModelSettingsOf,
    change: async (kind, value = null) => { step = 0; return await api.updateModelSettings(kind, value, context.location.pathname, 'test-operation') },
    originalOpen() { open = true }, isOpen: () => open,
    replaceTrigger() { const previous = trigger; trigger = { ...previous, isConnected: true }; previous.isConnected = false },
    showTrigger(value) { triggerVisible = value }, showEffortAttribute(value) { effortPresent = value },
    failFocus() { focused = false }, changeOwner() { owner = false }, duplicateModels() { duplicates = true },
    differentRange() { range = '3' }, afterInput(callback) { afterInput = callback } }
}

test('initial read discovers hidden model radios without selecting anything and closes its own popup', async () => {
  const f = fixture()
  assert.equal(f.read().model, null)
  const result = await f.change('read')
  assert.equal(result.outcome, 'ok')
  assert.equal(result.settings.model, 'GPT-6')
  assert.equal(result.settings.effort, 'high')
  assert.deepEqual(Array.from(result.settings.models, item => item.value), ['GPT-6', 'GPT-5.6 Sol'])
  assert.deepEqual(Array.from(result.settings.efforts, item => item.value), ['none', 'medium', 'high'])
  assert.equal(f.inputs.filter(event => event.type === 'mouseUp').length, 2)
  assert.equal(f.isOpen(), false)
  assert.equal(f.composer.draft, 'keep this draft exactly')
  assert.equal(shared.validFocusModelSettings(result.settings), true)
})

test('confirmed settings survive trigger replacement and temporary removal without opening the menu', async () => {
  const f = fixture(), result = await f.change('read')
  const expected = JSON.stringify(result.settings), inputs = f.inputs.length
  f.replaceTrigger()
  assert.equal(JSON.stringify(f.read()), expected)
  f.showTrigger(false)
  assert.equal(JSON.stringify(f.read()), expected)
  f.showTrigger(true)
  f.showEffortAttribute(false)
  assert.equal(JSON.stringify(f.read()), expected)
  f.showEffortAttribute(true)
  assert.equal(JSON.stringify(f.read()), expected)
  assert.equal(f.inputs.length, inputs)
  assert.equal(f.isOpen(), false)
  assert.equal(f.composer.draft, 'keep this draft exactly')
})

test('the first text or attachment send retains settings when home becomes its new conversation', async () => {
  for (const sending of ['waiting', 'programmatic', 'attachment']) {
    const f = fixture(), result = await f.change('read')
    const expected = JSON.stringify(result.settings), inputs = f.inputs.length
    if (sending === 'waiting') f.context.state.awaitingReplySince = 1
    if (sending === 'programmatic') f.context.state.programmatic = true
    if (sending === 'attachment') f.context.fileSend = { submitted: true }
    f.context.location.pathname = '/c/6ade12d0-6344-83e8-a38d-4666cda5b371'
    f.replaceTrigger()
    f.showTrigger(false)
    assert.equal(JSON.stringify(f.read()), expected, sending)
    f.context.state.awaitingReplySince = 0
    f.context.state.programmatic = false
    f.context.fileSend = null
    f.showTrigger(true)
    assert.equal(JSON.stringify(f.read()), expected, sending + ' after generation')
    assert.equal(f.inputs.length, inputs)
    assert.equal(f.isOpen(), false)
  }
})

test('manual navigation and switching between conversations discard settings even if a reply is active', async () => {
  const f = fixture()
  await f.change('read')
  f.context.location.pathname = '/c/first'
  assert.equal(f.read().model, null, 'idle navigation from home must not inherit a selection')
  assert.equal(f.read().models.length, 0)
  await f.change('read')
  assert.equal(f.read().model, 'GPT-6')
  f.context.state.awaitingReplySince = 1
  f.context.location.pathname = '/c/second'
  f.showTrigger(false)
  const switched = f.read()
  assert.equal(switched.model, null)
  assert.equal(switched.effort, null)
  assert.equal(switched.models.length, 0)
  assert.equal(switched.efforts.length, 0)
  f.context.location.pathname = '/'
  assert.equal(f.read().model, null, 'returning to home must not resurrect the previous selection')
})

test('live menu evidence still updates settings and invalid menus invalidate confirmed selections', async () => {
  const f = fixture()
  await f.change('read')
  f.replaceTrigger()
  const changed = await f.change('model', 'GPT-5.6 Sol')
  assert.equal(changed.outcome, 'ok')
  assert.equal(changed.settings.model, 'GPT-5.6 Sol')
  assert.equal(changed.settings.effort, 'medium')
  f.originalOpen()
  f.duplicateModels()
  assert.equal(f.read().model, null)
  assert.equal(f.read().models.length, 0)
  f.differentRange()
  assert.equal(f.read().effort, null)
  assert.equal(f.read().efforts.length, 0)
})
test('model switch opens native list, selects once, and reads the model-specific effort afterward', async () => {
  const f = fixture(), result = await f.change('model', 'GPT-5.6 Sol')
  assert.equal(result.outcome, 'ok')
  assert.equal(result.settings.model, 'GPT-5.6 Sol')
  assert.equal(result.settings.effort, 'medium')
  assert.equal(f.inputs.filter(event => event.type === 'mouseUp').length, 4)
  assert.equal(f.isOpen(), false)
  assert.equal(f.composer.draft, 'keep this draft exactly')
})
test('all three measured effort values use native input at the matching slider position', async () => {
  for (const value of ['none', 'medium', 'high']) {
    const f = fixture()
    const result = await f.change('effort', value)
    assert.equal(result.outcome, 'ok')
    assert.equal(result.settings.effort, value)
    assert.equal(f.inputs.filter(event => event.type === 'mouseUp').length, value === 'high' ? 2 : 3)
    assert.equal(f.composer.draft, 'keep this draft exactly')
  }
})
test('refresh preserves a menu that was already open and never chooses a different model', async () => {
  const f = fixture(); f.originalOpen()
  const result = await f.change('read')
  assert.equal(result.outcome, 'ok')
  assert.equal(f.isOpen(), true)
  assert.equal(f.inputs.length, 0)
})
test('unfocused window, ambiguous models and an unmeasured slider range fail closed', async () => {
  const focus = fixture(); focus.failFocus()
  assert.notEqual((await focus.change('model', 'GPT-5.6 Sol')).outcome, 'ok')
  assert.equal(focus.inputs.length, 0)
  const duplicate = fixture(); duplicate.duplicateModels()
  assert.notEqual((await duplicate.change('model', 'GPT-5.6 Sol')).outcome, 'ok')
  assert.equal(duplicate.read().model, null)
  const range = fixture(); range.differentRange()
  assert.notEqual((await range.change('effort', 'medium')).outcome, 'ok')
  assert.deepEqual(Array.from(range.read().efforts), [])
})
test('path changes stop later native steps, release the page lock, and preserve the draft', async () => {
  const f = fixture()
  f.afterInput(() => { f.context.location.pathname = '/c/other' })
  assert.equal((await f.change('model', 'GPT-5.6 Sol')).outcome, 'cancelled')
  assert.equal(f.inputs.filter(event => event.type === 'mouseUp').length, 1)
  assert.equal(f.context.focusModeChanging, null)
  assert.equal(f.composer.draft, 'keep this draft exactly')
})
test('native dispatcher rechecks owner after its awaited coordinate read', async () => {
  let owns = true, sent = 0
  const contents = { getZoomFactor: () => 1, sendInputEvent() { sent++ },
    async executeJavaScript() { owns = false; return { x: 40, y: 40 } } }
  await dispatchFocusModelClick(contents, 'test-operation', 1, () => owns, () => true)
  assert.equal(sent, 0)
})
test('runtime shares the send lock and rejects a result whose workspace owner changed', async () => {
  let resolve, owns = true
  const pending = new Promise(done => { resolve = done })
  const context = createContext({ validFocusModelSettingsRequest: shared.validFocusModelSettingsRequest,
    randomUUID: () => 'runtime-token', writeFocusDiagnostic() {} })
  const change = actual('updateFocusModelSettings', context, true, '../src/main/session-runtime.ts')
  const runtime = { focusSending: false, focusRevision: null, ownsFocus: () => owns, runner: { hasInFlightWork: () => false },
    embed: { getInterceptorStatus: () => ({ pendingQuestion: null }), updateFocusModelSettings: () => pending } }
  const request = { sessionId: 's', platformId: 'chatgpt', conversationId: null, kind: 'read' }
  const first = change.call(runtime, request)
  assert.equal(runtime.focusSending, true)
  assert.equal((await change.call(runtime, request)).outcome, 'busy')
  owns = false
  resolve({ outcome: 'ok', settings: { model: null, effort: null, models: [], efforts: [] } })
  assert.equal((await first).outcome, 'cancelled')
  assert.equal(runtime.focusSending, false)
})
test('request and settings validation reject stale/malformed selections and oversized lists', () => {
  assert.equal(shared.validFocusModelSettingsRequest({ kind: 'read' }), true)
  assert.equal(shared.validFocusModelSettingsRequest({ kind: 'read', value: 'GPT-6' }), false)
  assert.equal(shared.validFocusModelSettingsRequest({ kind: 'model', value: 'GPT-6' }), true)
  assert.equal(shared.validFocusModelSettingsRequest({ kind: 'effort', value: '<script>' }), false)
  assert.equal(shared.validFocusModelSettings({ model: 'missing', effort: null, models: [], efforts: [] }), false)
  assert.equal(shared.validFocusModelSettings({ model: null, effort: null, models: Array(21).fill({ value: 'GPT-6', label: 'GPT-6' }), efforts: [] }), false)
})
test('header renders two labelled native selects, actual options, and a recoverable unknown state', () => {
  const html = renderToStaticMarkup(Controls({ settings: { model: 'GPT-6', effort: 'high',
    models: [{ value: 'GPT-6', label: 'GPT-6' }], efforts: [{ value: 'high', label: 'High' }] },
    disabled: false, pending: null, onChange() {}, onRefresh() {} }))
  assert.equal((html.match(/<select/g) || []).length, 2)
  assert.match(html, /当前模型/); assert.match(html, /思考强度/)
  assert.match(html, /value="GPT-6" selected=""/)
  assert.match(html, /value="high" selected=""/)
  const unknown = renderToStaticMarkup(Controls({ settings: null, disabled: false, pending: null, onChange() {}, onRefresh() {} }))
  assert.equal((unknown.match(/<select[^>]*disabled/g) || []).length, 2)
  assert.match(unknown, /刷新模型和思考强度/)
  assert.doesNotMatch(unknown, /GPT-6/)
})
