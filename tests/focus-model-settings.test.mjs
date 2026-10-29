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
  const code = method ? '({' + node.getText(file).replace(/^(?:private|public|protected)\s+/, '') + '}).' + name : '(' + node.initializer.getText(file) + ')'
  return new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInContext(context)
}
function automaticRead(context) {
  const path = '../src/renderer/src/components/FocusChatView.tsx'
  const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect' &&
      node.arguments[0]?.getText(file).includes('modelReadAttempted.current = true')) return node.arguments[0]
    return ts.forEachChild(node, find)
  }
  const callback = find(file)
  assert.ok(callback, 'automatic model-settings read effect')
  return new Script('(' + callback.getText(file) + ')').runInContext(context)
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
  trigger.getAttribute = key => ({ 'aria-label': '选择 ChatGPT 模型', 'aria-haspopup': 'menu',
    'aria-expanded': String(open), 'aria-controls': open ? 'native-menu' : null,
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
    setReplyWaiting: since => { context.state.awaitingReplySince = since },
    getComposer: () => composer, findStopButton: () => null,
    // Match the measured button's attributes, including the absence of legacy markers.
    queryAll: selectors => selectors.some(selector => selector.replace(/\[[^\]]+\]/g, '') === 'button' &&
      [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, name, value]) =>
        value === undefined ? trigger.getAttribute(name) !== null : trigger.getAttribute(name) === value)) ? [trigger] : [],
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
    resetHistory: actual('armBaseline', context),
    change: async (kind, value = null) => { step = 0; return await api.updateModelSettings(kind, value, context.location.pathname, 'test-operation') },
    originalOpen() { open = true }, isOpen: () => open,
    replaceTrigger() { const previous = trigger; trigger = { ...previous, isConnected: true }; previous.isConnected = false },
    showTrigger(value) { triggerVisible = value }, showEffortAttribute(value) { effortPresent = value },
    failFocus() { focused = false }, changeOwner() { owner = false }, duplicateModels() { duplicates = true },
    differentRange() { range = '3' }, afterInput(callback) { afterInput = callback } }
}

test('the measured trigger without the legacy marker reads settings and closes its own popup without selecting anything', async () => {
  const f = fixture()
  assert.equal(f.trigger.getAttribute('data-codex-intelligence-trigger'), null)
  assert.equal(f.context.queryAll(['button[data-codex-intelligence-trigger][aria-label="选择 ChatGPT 模型"]']).length, 0)
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

test('settings survive interim conversation ids and task completion without requiring another native click', async () => {
  for (const sending of ['waiting', 'programmatic', 'attachment']) {
    const f = fixture(), result = await f.change('read')
    const expected = JSON.stringify(result.settings), inputs = f.inputs.length
    if (sending === 'waiting') f.context.state.awaitingReplySince = 1
    if (sending === 'programmatic') f.context.state.programmatic = true
    if (sending === 'attachment') f.context.fileSend = { submitted: true }
    f.failFocus()
    f.showTrigger(false)
    for (const path of ['/c/interim-id', '/c/final-id']) {
      f.context.location.pathname = path
      assert.equal(JSON.stringify(f.read()), expected, sending + ' at ' + path)
    }
    f.context.state.awaitingReplySince = 0
    f.context.state.programmatic = false
    f.context.fileSend = null
    f.context.state.taskPromptGeneration++
    f.replaceTrigger()
    f.showTrigger(true)
    assert.equal(JSON.stringify(f.read()), expected, sending + ' after task completion')
    assert.equal(f.inputs.length, inputs)
    const refresh = await f.change('read')
    assert.equal(refresh.reason, 'native-input-failed')
    assert.equal(JSON.stringify(refresh.settings), expected, 'a failed explicit refresh retains confirmed settings')
  }
})

test('home-send inheritance ends at idle, a new task generation, or explicit history navigation', async () => {
  for (const boundary of ['idle', 'generation', 'history']) {
    const f = fixture()
    await f.change('read')
    f.context.state.awaitingReplySince = 1
    f.context.location.pathname = '/c/created'
    assert.equal(f.read().model, 'GPT-6')
    if (boundary === 'idle') {
      f.context.state.awaitingReplySince = 0
      assert.equal(f.read().model, 'GPT-6')
    }
    if (boundary === 'generation') f.context.state.taskPromptGeneration++
    if (boundary === 'history') f.resetHistory()
    f.context.state.awaitingReplySince = 1
    f.context.location.pathname = '/c/unrelated'
    const switched = f.read()
    assert.equal(switched.model, null, boundary)
    assert.equal(switched.effort, null, boundary)
    assert.equal(switched.models.length, 0, boundary)
    assert.equal(switched.efforts.length, 0, boundary)
  }
})

test('arming the same conversation history preserves its confirmed settings', async () => {
  const f = fixture(), result = await f.change('read')
  f.resetHistory()
  assert.equal(JSON.stringify(f.read()), JSON.stringify(result.settings))
})

test('a remounted focus view keeps confirmed settings when its task becomes idle', async () => {
  const f = fixture(), initial = await f.change('read'), reads = []
  f.context.state.awaitingReplySince = 1
  for (const path of ['/c/interim-id', '/c/final-id']) {
    f.context.location.pathname = path
    f.read()
  }
  const context = createContext({ owner: { platformId: 'chatgpt' }, visible: true, ready: true, working: true,
    editingId: null, sendLock: { current: false }, modelReadAttempted: { current: false },
    modelReadAttempts: { current: 0 }, settingPending: null,
    state: { modelSettings: f.read(), modelSettingsReady: true }, updateModelSettings: kind => { reads.push(kind) } })
  const effect = automaticRead(context)
  effect()
  assert.equal(context.modelReadAttempted.current, false, 'wait while the task is working')
  f.context.state.awaitingReplySince = 0
  f.context.state.taskPromptGeneration++
  context.state.modelSettings = f.read()
  context.working = false
  effect()
  assert.equal(context.modelReadAttempted.current, true)
  assert.deepEqual(reads, [], 'task completion must not reopen the native menu')
  assert.equal(JSON.stringify(context.state.modelSettings), JSON.stringify(initial.settings))
  context.modelReadAttempted = { current: false }
  context.state.modelSettings = { model: null, effort: null, models: [], efforts: [] }
  effect()
  effect()
  assert.deepEqual(reads, ['read'], 'a different conversation without settings still reads once')
})

test('initialization waits for a late model trigger instead of spending its only read on a ready composer', () => {
  const reads = []
  const context = createContext({ owner: { platformId: 'chatgpt' }, visible: true, ready: true, working: false,
    editingId: null, sendLock: { current: false }, modelReadAttempted: { current: false }, modelReadAttempts: { current: 0 },
    settingPending: null, state: { modelSettingsReady: false, modelSettings: { model: null, effort: null, models: [], efforts: [] } },
    updateModelSettings: kind => reads.push(kind) })
  const effect = automaticRead(context)
  for (let snapshot = 0; snapshot < 8; snapshot++) effect()
  assert.deepEqual(reads, [])
  assert.equal(context.modelReadAttempted.current, false)
  assert.equal(context.modelReadAttempts.current, 0)
  assert.equal(context.sendLock.current, false, 'waiting for hydration must leave the local draft usable')
  context.state.modelSettingsReady = true
  effect(); effect()
  assert.deepEqual(reads, ['read'])
  assert.equal(context.modelReadAttempts.current, 1)
})

test('new chat resets initialization even when reloading home keeps the same null conversation owner', () => {
  let navigations = 0
  const context = createContext({ modelReadAttempted: { current: true }, modelReadAttempts: { current: 3 }, setSettingError() {},
    props: { onNewChat() {
      assert.equal(context.modelReadAttempted.current, false)
      assert.equal(context.modelReadAttempts.current, 0)
      navigations++
    } } })
  const start = actual('startNewChat', context, false, '../src/renderer/src/components/FocusChatView.tsx')
  start()
  assert.equal(navigations, 1)
})

function rendererInitialization(results) {
  const owner = { sessionId: 'workspace', platformId: 'chatgpt', conversationId: null }
  const empty = { model: null, effort: null, models: [], efforts: [] }
  let pending, requests = 0
  const errors = [], context = createContext({ owner, ownerKey: 'workspace:home', visible: true, ready: true, working: false,
    editingId: null, sendLock: { current: false }, settingBusy: { current: false }, readEpoch: { current: 0 }, alive: { current: true },
    lastSnapshot: { current: '' }, modelReadAttempted: { current: false }, modelReadAttempts: { current: 0 }, settingPending: null,
    state: { ...owner, ready: true, modelSettingsReady: true, modelSettings: empty },
    useCallback: callback => callback, focusOwnerKey: () => 'workspace:home',
    setSettingPending(value) { context.settingPending = value }, setSettingError(value) { errors.push(value) }, setError() {},
    setState(value) { context.state = value }, window: { api: {
      async updateFocusModelSettings() { requests++; return results.shift() },
      async getFocusChat() { return context.state }
    } } })
  const update = actual('updateModelSettings', context, false, '../src/renderer/src/components/FocusChatView.tsx')
  context.updateModelSettings = (...args) => { pending = update(...args); return pending }
  return { context, errors, effect: automaticRead(context), wait: () => pending, requests: () => requests }
}

test('a pre-input trigger race recovers on readiness without showing a persistent error or replaying a click', async () => {
  const settings = { model: 'GPT-6', effort: 'high', models: [{ value: 'GPT-6', label: 'GPT-6' }], efforts: [{ value: 'high', label: 'High' }] }
  const f = rendererInitialization([{ outcome: 'unavailable', reason: 'control-missing', settings: null }, { outcome: 'ok', settings }])
  f.effect(); await f.wait()
  assert.equal(f.requests(), 1)
  assert.equal(f.context.modelReadAttempted.current, false)
  assert.deepEqual(f.errors.filter(Boolean), [])
  f.context.state.modelSettingsReady = false
  f.effect()
  assert.equal(f.requests(), 1)
  f.context.state.modelSettingsReady = true
  f.effect(); await f.wait()
  assert.equal(f.context.state.modelSettings.model, 'GPT-6')
  assert.equal(f.context.state.modelSettings.effort, 'high')
  f.effect()
  assert.equal(f.requests(), 2)
  assert.equal(f.context.sendLock.current, false)
  assert.equal(f.context.settingBusy.current, false)
})

test('automatic recovery is bounded and never retries an uncertain native input result', async () => {
  const missing = () => ({ outcome: 'unavailable', reason: 'control-missing', settings: null })
  const f = rendererInitialization([missing(), missing(), missing()])
  for (let attempt = 0; attempt < 5; attempt++) { f.effect(); await f.wait() }
  assert.equal(f.requests(), 3)
  assert.equal(f.context.modelReadAttempted.current, true)
  assert.equal(f.errors.filter(Boolean).length, 1)
  for (const result of [{ outcome: 'unknown', reason: 'native-input-failed' }, { outcome: 'unknown', reason: 'menu-unavailable' }]) {
    const g = rendererInitialization([{ ...result, settings: null }])
    g.effect(); await g.wait(); g.effect()
    assert.equal(g.requests(), 1)
    assert.equal(g.context.modelReadAttempted.current, true)
    assert.equal(g.errors.filter(Boolean).length, 1)
  }
})

test('new documents and client-side navigation keep the hidden view painting without showing or focusing it', () => {
  const path = '../src/main/embed.ts'
  const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const handlers = new Map()
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'contents.on' && ts.isStringLiteral(node.arguments[0]) &&
      ['dom-ready', 'did-finish-load', 'did-navigate-in-page'].includes(node.arguments[0].text)) handlers.set(node.arguments[0].text, node.arguments[1])
    ts.forEachChild(node, visit)
  }
  visit(file)
  const settings = [], context = createContext({})
  const keepRendering = actual('keepRenderingWhileHidden', context, true, path)
  const embed = { liveContents: () => ({ setBackgroundThrottling: value => settings.push(value) }),
    installInterceptor() {}, installTheme() {}, installSelectionQuestion() {}, publishState() {}, captureCurrentConversation() {},
    dismissSelectionQuestion() {} }
  embed.keepRenderingWhileHidden = () => keepRendering.call(embed)
  context.embed = embed
  for (const event of ['dom-ready', 'did-finish-load', 'did-navigate-in-page']) {
    assert.ok(handlers.has(event), event)
    new Script('(function () { (' + handlers.get(event).getText(file) + ')() }).call(embed)').runInContext(context)
  }
  assert.deepEqual(settings, [false, false, false])
})

test('the embed snapshot boundary accepts boolean model readiness and rejects malformed readiness', async () => {
  const context = createContext({ URL, Promise, setTimeout, clearTimeout,
    validFocusComposerModes: shared.validFocusComposerModes, validFocusModelSettings: shared.validFocusModelSettings,
    validFocusSendFailure: shared.validFocusSendFailure })
  const read = actual('readFocusSnapshot', context, true, '../src/main/embed.ts')
  for (const value of [undefined, false, true, 'true', 1, null]) {
    const raw = { path: '/', ready: true, nativeDraft: false, waiting: false, generating: 'idle', reply: null, modelSettingsReady: value }
    const embed = { focusPage: () => ({ getURL: () => 'https://chatgpt.com/', isDestroyed: () => false,
      executeJavaScript: async () => raw }) }
    const snapshot = await read.call(embed)
    if (value === undefined || typeof value === 'boolean') assert.equal(snapshot, raw)
    else assert.equal(snapshot, null)
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
  const waiting = renderToStaticMarkup(Controls({ settings: null, disabled: false, pending: null, waiting: true, onChange() {}, onRefresh() {} }))
  assert.match(waiting, /正在等待模型控件/)
  assert.match(waiting, /读取中…/)
  assert.doesNotMatch(waiting, /尚未读取/)
})
