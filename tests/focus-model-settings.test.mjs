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
const { CHATGPT_PAGE, CLAUDE_PAGE, GEMINI_PAGE } = moduleAt('../src/shared/platforms.ts')
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
  context.compaction ??= { blocked: false }
  context.modelSettingsKind ??= context.owner.platformId
  context.geminiReadModel ??= { current: null }
  Object.defineProperty(context, 'modelSettingsBlocked', { get: () => !context.ready || context.working || context.editingId || context.compaction.blocked })
  context.setTimeout ??= callback => { callback(); return 1 }
  context.clearTimeout ??= () => {}
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

function geminiFixture() {
  const rules = GEMINI_PAGE.focus.modelSettings
  let open = false, effortOpen = false, active = '56fdd199312815e2', activeEffort = 'high', now = 0, nextHit, reject = false, requireClick = false
  const clicks = [], draft = { value: '保持草稿', closest: selector => selector === rules.composerScopeSelector ? scope : null }
  const element = (attributes, label, left, localName = 'button') => ({
    isConnected: true, localName, label, getAttribute: name => attributes[name] ?? null,
    contains(node) { return node === this }, closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left, right: left + 20, top: 10, bottom: 30, width: 20, height: 20 })
  })
  const option = (value, label, model, shortName, left, disabled = false) => {
    const row = element({ role: 'menuitemradio', 'data-test-id': `bard-mode-option-${value}`, 'aria-disabled': String(disabled) }, label, left, 'gem-menu-item')
    const getAttribute = row.getAttribute
    row.getAttribute = name => name === 'aria-checked' ? String(active === value) : getAttribute(name)
    row.querySelector = selector => selector === 'gem-menu-item-content .sublabel' ? { textContent: model } : null
    return { ...row, value, shortName }
  }
  const flash = option('8c46e95b1a07cecc', '快速解答', '3.5 Flash-Lite', 'Flash Lite', 40)
  const hydrogen = option('56fdd199312815e2', '日常帮助', '4 Hydrogen', 'Hydrogen', 70)
  const pro = option('e6fa609c3fa255c0', '深度研究', '3.1 Pro', 'Pro', 100)
  const argon = option('argon', '代码与分析', '4 Argon', 'Argon', 130)
  const locked = option('upsell_MODE_CATEGORY_ULTRA', '高难任务', '4 Carbon', 'Carbon', 160)
  locked.querySelectorAll = selector => selector === 'mat-icon' ? [element({ fonticon: 'lock' }, '', 0)] : []
  const disabled = option('unavailable', '不可用', '3.0 Pro', 'Pro', 190, true)
  const options = [flash, hydrogen, pro, argon, locked, disabled]
  const trigger = element({}, '', 10)
  const otherTrigger = element({}, '其他入口', 260)
  trigger.getAttribute = name => ({ 'aria-expanded': String(open), 'aria-controls': open ? 'angular-menu' : null })[name] ?? null
  trigger.querySelector = selector => {
    if (selector === '[data-test-id="logo-pill-label-container"] .picker-primary-text') return { textContent: options.find(option => option.value === active).shortName }
    if (selector === '[data-test-id="logo-pill-label-container"] .picker-secondary-text') return { textContent: levels.find(option => option.value === activeEffort).label }
    return null
  }
  const scope = { contains: node => node === trigger }
  const menu = element({ role: 'menu', 'data-test-id': 'gem-mode-menu' }, '', 230, 'gem-menu')
  const thinking = element({}, '思考等级', 280, 'gem-menu-item')
  thinking.getAttribute = name => ({ role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': String(effortOpen), 'aria-controls': 'effort-menu' })[name] ?? null
  thinking.querySelector = selector => selector === 'gem-menu-item-content .label' ? { textContent: thinking.label } : null
  const effortMenu = element({ role: 'menu' }, '', 310, 'gem-menu')
  const levels = [['low', '低'], ['medium', '中'], ['high', '高']].map(([value, label], index) => {
    const row = element({ role: 'menuitemradio' }, label, 350 + index * 30, 'gem-menu-item')
    row.getAttribute = name => ({ role: 'menuitemradio', 'aria-checked': String(activeEffort === value) })[name] ?? null
    row.querySelector = selector => selector === 'gem-menu-item-content .label' ? { textContent: label } : null
    return { ...row, value }
  })
  const findRows = (rows, selector) => rows.filter(row => selector.split(',').some(rule => {
    const part = rule.trim()
    return part.split('[')[0] === row.localName && [...part.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]+)")?\]/g)].every(([, name, operator, value]) => {
      const attr = row.getAttribute(name)
      return operator === '=' ? attr === value : operator === '^=' ? attr?.startsWith(value) : attr !== null
    })
  }))
  menu.querySelectorAll = selector => findRows([...options, thinking, ...levels], selector)
  effortMenu.querySelectorAll = selector => findRows(levels, selector)
  menu.querySelector = selector => menu.querySelectorAll(selector)[0] ?? null
  menu.contains = node => node === menu || node === thinking || options.includes(node) || effortMenu.contains(node)
  effortMenu.contains = node => node === effortMenu || levels.includes(node)
  const visible = node => !!node && (node === trigger || node === otherTrigger || open && (!effortMenu.contains(node) || effortOpen))
  const document = {
    activeElement: trigger, getElementById: id => open ? ({ 'angular-menu': menu, 'effort-menu': effortMenu })[id] ?? null : null,
    elementFromPoint(x) {
      nextHit = [trigger, ...options, thinking, ...levels].find(node => visible(node) && x >= node.getBoundingClientRect().left && x <= node.getBoundingClientRect().right)
      return nextHit
    },
    createTreeWalker(node) {
      const texts = [{ nodeValue: 'check', parentElement: { closest: () => ({}) } }, { nodeValue: node.label }, { nodeValue: '模型说明' }]
      return { nextNode: () => texts.shift() }
    }
  }
  const context = createContext({ PAGE: GEMINI_PAGE, document, NodeFilter: { SHOW_TEXT: 4 }, location: { pathname: '/app' },
    Date: { now: () => now }, setTimeout(callback, delay) { now += delay; queueMicrotask(callback) },
    focusModelCache: null, focusModeChanging: null, focusEditing: null, fileSend: null,
    state: { taskPromptGeneration: 1, programmatic: false, awaitingReplySince: 0, pendingQuestion: false },
    getComposer: () => draft, findStopButton: () => null,
    queryAll: selectors => selectors.includes(rules.triggerSelector) ? [otherTrigger, trigger] : [],
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(), controlDisabled: node => node.getAttribute('aria-disabled') === 'true',
    isVisibleElement: visible,
    innerWidth: 1000, innerHeight: 800, report(payload) {
      queueMicrotask(() => { void dispatchFocusModelClick(contents, payload.focusModelToken, payload.count, () => true, () => true) })
    } })
  for (const name of ['focusModelPickerParts', 'focusGeminiModelLabel', 'focusGeminiModelName', 'focusGeminiModelOptions',
    'focusGeminiEffortParts', 'focusGeminiEffortValue', 'focusGeminiEffortOptions', 'focusModelSettingsOf']) context[name] = actual(name, context)
  const api = {}
  context.focusModelClickPoint = actual('focusModelClickPoint', context)
  for (const name of ['prepareFocusModelClick', 'finishFocusModelClick', 'updateModelSettings']) api[name] = actual(name, context, true)
  context.window = { __cmdTerminalInterceptor: api }
  const contents = { getZoomFactor: () => 1, executeJavaScript: source => Promise.resolve(new Script(source).runInContext(context)),
    sendInputEvent(event) {
      if (event.type === 'keyDown' && event.keyCode === 'Escape') {
        if (effortOpen) {
          clicks.push('dismiss-effort')
          effortOpen = false
          document.activeElement = thinking
        } else {
          clicks.push('dismiss')
          open = false
          document.activeElement = trigger
        }
      }
      if (event.type === 'mouseMove' && nextHit === thinking && !requireClick) {
        clicks.push('hover-effort')
        effortOpen = true
        document.activeElement = thinking
      }
      if (event.type !== 'mouseUp') return
      if (nextHit === trigger) {
        assert.equal(open, false, 'the backdrop covers the trigger while the menu is open')
        clicks.push('open')
        open = true
        document.activeElement = flash
      } else if (nextHit === thinking) {
        clicks.push('open-effort')
        effortOpen = true
        document.activeElement = levels[0]
      } else if (options.includes(nextHit) || levels.includes(nextHit)) {
        const value = nextHit.value
        clicks.push(value)
        if (!reject && options.includes(nextHit)) active = value
        if (!reject && levels.includes(nextHit)) activeEffort = value
        open = false
        effortOpen = false
        document.activeElement = trigger
      }
    } }
  return { context, clicks, draft, read: context.focusModelSettingsOf, declineChange() { reject = true }, clickOnly() { requireClick = true },
    change: (kind, value = null) => api.updateModelSettings(kind, value, context.location.pathname, 'gemini-operation') }
}

test('Gemini reads model names from custom radio rows and confirms a choice from the abbreviated button label', async () => {
  const f = geminiFixture()
  const read = await f.change('read')
  assert.equal(read.outcome, 'ok')
  assert.equal(read.settings.model, '56fdd199312815e2')
  assert.deepEqual(Array.from(read.settings.models, item => [item.value, item.label]), [
    ['8c46e95b1a07cecc', '3.5 Flash-Lite'], ['56fdd199312815e2', '4 Hydrogen'], ['e6fa609c3fa255c0', '3.1 Pro'], ['argon', '4 Argon']
  ])
  assert.equal(read.settings.effort, 'high')
  assert.deepEqual(Array.from(read.settings.efforts, item => [item.value, item.label]), [['low', '低'], ['medium', '中'], ['high', '高']])
  assert.deepEqual(f.clicks, ['open', 'dismiss'])
  assert.equal(shared.validFocusModelSettings(read.settings), true)

  const switched = await f.change('model', 'argon')
  assert.equal(switched.outcome, 'ok')
  assert.equal(f.read().model, 'argon')
  assert.equal(f.read().efforts.length, 0, 'another model must refresh its own available levels')
  assert.equal(f.draft.value, '保持草稿')
  assert.deepEqual(f.clicks, ['open', 'dismiss', 'open', 'argon'])

  assert.equal((await f.change('model', '8c46e95b1a07cecc')).outcome, 'ok')
  assert.equal(f.read().model, '8c46e95b1a07cecc', 'a hyphenated model name still matches the short button label')
})

test('Gemini rejects locked options and active tasks, and an unapplied native click remains unconfirmed', async () => {
  const f = geminiFixture()
  f.context.state.awaitingReplySince = 1
  assert.equal((await f.change('model', 'argon')).outcome, 'busy')
  assert.deepEqual(f.clicks, [])
  f.context.state.awaitingReplySince = 0
  assert.equal((await f.change('model', 'upsell_MODE_CATEGORY_ULTRA')).reason, 'option-unavailable')
  assert.deepEqual(f.clicks, ['open', 'dismiss'])
  f.declineChange()
  const unchanged = await f.change('model', 'argon')
  assert.equal(unchanged.reason, 'selection-unconfirmed')
  assert.equal(unchanged.settings.model, '56fdd199312815e2')
})

test('Gemini selects strength from the linked menu and confirms it after the submenu closes', async () => {
  for (const requireClick of [false, true]) {
    const f = geminiFixture()
    if (requireClick) f.clickOnly()
    const changed = await f.change('effort', 'medium')
    assert.equal(changed.outcome, 'ok')
    assert.equal(changed.settings.effort, 'medium')
    assert.equal(changed.settings.model, '56fdd199312815e2')
    assert.equal(f.draft.value, '保持草稿')
    assert.deepEqual(f.clicks, ['open', requireClick ? 'open-effort' : 'hover-effort', 'medium'])
    assert.equal(f.read().effort, 'medium')
  }
})

test('Gemini rejects an unavailable level and does not retry a selection the page did not apply', async () => {
  const f = geminiFixture()
  f.context.state.awaitingReplySince = 1
  assert.equal((await f.change('effort', 'medium')).outcome, 'busy')
  assert.deepEqual(f.clicks, [])
  f.context.state.awaitingReplySince = 0
  assert.equal((await f.change('effort', 'extreme')).reason, 'option-unavailable')
  assert.deepEqual(f.clicks, ['open', 'dismiss'])
  f.declineChange()
  const unchanged = await f.change('effort', 'medium')
  assert.equal(unchanged.reason, 'selection-unconfirmed')
  assert.equal(unchanged.settings.effort, 'high')
  assert.deepEqual(f.clicks, ['open', 'dismiss', 'open', 'hover-effort', 'medium'])
})
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
  context.focusModelClickPoint = actual('focusModelClickPoint', context)
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
  return { context, contents, inputs, reports, composer, get trigger() { return trigger }, models, read: context.focusModelSettingsOf,
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
    assert.equal(refresh.reason, 'native-click-window-unfocused')
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
  const context = createContext({ modelReadAttempted: { current: true }, modelReadAttempts: { current: 3 }, geminiReadModel: { current: 'argon' }, setSettingError() {},
    props: { onNewChat() {
      assert.equal(context.modelReadAttempted.current, false)
      assert.equal(context.modelReadAttempts.current, 0)
      assert.equal(context.geminiReadModel.current, null)
      navigations++
    } } })
  const start = actual('startNewChat', context, false, '../src/renderer/src/components/FocusChatView.tsx')
  start()
  assert.equal(navigations, 1)
})

test('Gemini reads each changed model once when its levels need refreshing', () => {
  const reads = []
  const context = createContext({ owner: { platformId: 'gemini' }, visible: true, ready: true, working: false,
    editingId: null, sendLock: { current: false }, modelReadAttempted: { current: false }, modelReadAttempts: { current: 0 },
    settingPending: null, state: { modelSettingsReady: true, modelSettings: { model: 'argon', efforts: [{ value: 'high', label: '高' }] } },
    updateModelSettings: kind => reads.push(kind) })
  const effect = automaticRead(context)
  effect()
  assert.deepEqual(reads, [])
  context.state.modelSettings = { model: 'hydrogen', efforts: [] }
  effect(); effect()
  assert.deepEqual(reads, ['read'])
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
    applySnapshot(value) { context.state = value }, setState(value) { context.state = value }, window: { api: {
      async updateFocusModelSettings() { requests++; return results.shift() },
      async getFocusChat() { return context.state }
    } } })
  const effect = automaticRead(context)
  const update = actual('updateModelSettings', context, false, '../src/renderer/src/components/FocusChatView.tsx')
  context.updateModelSettings = (...args) => { pending = update(...args); return pending }
  return { context, errors, effect, wait: () => pending, requests: () => requests }
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

test('post-compaction initialization waits for the page to settle and does not run while compaction is blocked', async () => {
  const settings = { model: 'GPT-6', effort: 'high', models: [{ value: 'GPT-6', label: 'GPT-6' }], efforts: [{ value: 'high', label: 'High' }] }
  const f = rendererInitialization([{ outcome: 'ok', settings }]), timers = []
  f.context.setTimeout = (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer }
  f.context.clearTimeout = timer => { timer.cancelled = true }
  f.context.compaction.blocked = true
  f.effect()
  assert.equal(timers.length, 0)
  f.context.compaction.blocked = false
  const cancel = f.effect()
  assert.equal(f.requests(), 0, 'DOM readiness alone must not immediately dispatch native input')
  assert.equal(f.context.modelReadAttempts.current, 0)
  cancel()
  assert.equal(timers[0].cancelled, true, 'navigation or readiness changes cancel the pending initialization')
  f.effect()
  timers.at(-1).callback()
  await f.wait()
  assert.equal(f.requests(), 1)
  assert.equal(f.context.state.modelSettings.model, 'GPT-6')
})

test('an explicitly rejected first click can recover without switching views or reporting an uncertain selection', async () => {
  const settings = { model: 'GPT-6', effort: 'high', models: [{ value: 'GPT-6', label: 'GPT-6' }], efforts: [{ value: 'high', label: 'High' }] }
  for (const reason of ['native-click-not-dispatched', 'native-click-window-unfocused', 'native-click-unreachable', 'native-click-dispatch-failed']) {
    const f = rendererInitialization([{ outcome: 'unavailable', reason, settings: null }, { outcome: 'ok', settings }])
    f.effect(); await f.wait()
    assert.equal(f.context.modelReadAttempted.current, false, reason)
    assert.deepEqual(f.errors.filter(Boolean), [], reason)
    f.effect(); await f.wait()
    assert.equal(f.requests(), 2, reason)
    assert.equal(f.context.state.modelSettings.model, 'GPT-6', reason)
  }
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
test('an unfocused first read reports that no native click was dispatched', async () => {
  const f = fixture()
  f.failFocus()
  const result = await f.change('read')
  assert.equal(result.outcome, 'unavailable')
  assert.equal(result.reason, 'native-click-window-unfocused')
  assert.equal(f.inputs.length, 0)
  assert.equal(f.isOpen(), false)
})
test('an unreachable first trigger is retryable before any native input', async () => {
  const f = fixture()
  f.context.document.elementFromPoint = () => null
  const result = await f.change('read')
  assert.equal(result.outcome, 'unavailable')
  assert.equal(result.reason, 'native-click-unreachable')
  assert.equal(f.inputs.length, 0)
  assert.equal(f.isOpen(), false)
})
test('a partial native input failure remains uncertain and does not dispatch cleanup or another click', async () => {
  const f = fixture(), send = f.contents.sendInputEvent
  f.contents.sendInputEvent = event => {
    send(event)
    if (event.type === 'mouseDown') throw new Error('synthetic partial native input failure')
  }
  const result = await f.change('read')
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.reason, 'native-input-failed')
  assert.equal(f.inputs.filter(event => event.type === 'mouseDown').length, 1)
  assert.equal(f.inputs.filter(event => event.type === 'mouseUp').length, 0)
  assert.equal(f.context.focusModeChanging, null)
})
test('the embed defers a background-window read without opening the native menu', async () => {
  let calls = 0
  const context = createContext({ BrowserWindow: { getFocusedWindow: () => null } })
  const read = actual('updateFocusModelSettings', context, true, '../src/main/embed.ts')
  const embed = { platform: { id: 'chatgpt', page: CHATGPT_PAGE }, view: {}, focusEditToken: null, focusModelNativeClick: null,
    focusPage: () => ({ executeJavaScript: async () => { calls++ } }) }
  const result = await read.call(embed, { kind: 'read' }, 'test-operation', () => true)
  assert.equal(result.outcome, 'unavailable')
  assert.equal(result.reason, 'native-click-window-unfocused')
  assert.equal(calls, 0)
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
  let resolve, owns = true, running = true
  const pending = new Promise(done => { resolve = done })
  const context = createContext({ validFocusModelSettingsRequest: shared.validFocusModelSettingsRequest,
    randomUUID: () => 'runtime-token', writeFocusDiagnostic() {} })
  const change = actual('updateFocusModelSettings', context, true, '../src/main/session-runtime.ts')
  const runtime = { active: true, activePlatform: { page: GEMINI_PAGE }, focusSending: false, focusRevision: null,
    taskRunning() { return this.focusSending || running }, ownsFocus: () => owns, runner: { hasInFlightWork: () => false },
    embed: { getInterceptorStatus: () => ({ pendingQuestion: null }), updateFocusModelSettings: () => pending } }
  const request = { sessionId: 's', platformId: 'gemini', conversationId: null, kind: 'read' }
  assert.equal((await change.call(runtime, request)).outcome, 'busy')
  assert.equal(runtime.focusSending, false)
  running = false
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

test('Gemini renders both settings with native labels and disables them during a task', () => {
  const html = renderToStaticMarkup(Controls({ platformLabel: 'Gemini', settings: {
    model: 'argon', effort: 'medium', models: [{ value: 'argon', label: '4 Argon' }], efforts: [{ value: 'medium', label: '中' }]
  }, disabled: true, pending: null, onChange() {}, onRefresh() {} }))
  assert.equal((html.match(/<select[^>]*disabled/g) || []).length, 2)
  assert.match(html, /value="argon" selected="">4 Argon/)
  assert.match(html, /value="medium" selected="">中/)
  assert.match(html, /Gemini 模型设置/)
  assert.match(html, /aria-label="刷新模型和思考强度"/)
})

function claudeFixture() {
  const rules = CLAUDE_PAGE.focus.modelSettings
  let open = false, subMenu = null, activeModel = 'claude-sonnet-5-5', activeEffort = 'medium'
  let now = 0, nextHit = null, requireClick = false, decline = false
  const clicks = [], draft = { value: '保留 Claude 草稿' }
  const textNode = value => ({ nodeType: 3, nodeValue: value })
  const span = (children, attributes = {}) => ({
    nodeType: 1, tagName: 'SPAN', isConnected: true,
    getAttribute: name => attributes[name] ?? null,
    childNodes: Array.isArray(children) ? children : [textNode(children)],
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 })
  })
  const makeRadio = (attrs, children, left) => ({
    nodeType: 1, tagName: 'DIV', isConnected: true,
    getAttribute: name => attrs[name] ?? null,
    childNodes: children,
    contains(node) { return node === this },
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left, right: left + 20, top: 10, bottom: 30, width: 20, height: 20 })
  })
  const lockedOpus = makeRadio({ role: 'menuitem', 'data-model-id': 'claude-opus-5-5' },
    [span('Opus 5.5'), span('Pro'), span('Upgrade')], 40)
  const sonnet55 = makeRadio({ role: 'menuitemradio', 'data-model-id': 'claude-sonnet-5-5' },
    [span('Sonnet 5.5'), span('Everyday tasks')], 70)
  const haiku55 = makeRadio({ role: 'menuitemradio', 'data-model-id': 'claude-haiku-5-5' },
    [span('Haiku 5.5'), span('Fastest for quick answers')], 100)
  const sonnet5 = makeRadio({ role: 'menuitemradio', 'data-model-id': 'claude-sonnet-5' },
    [span('Sonnet 5')], 130)
  const sonnet46 = makeRadio({ role: 'menuitemradio', 'data-model-id': 'claude-sonnet-4-6' },
    [span('Sonnet 4.6')], 160)
  const mainModels = [lockedOpus, sonnet55, haiku55]
  const moreModels = [sonnet5, sonnet46]
  const allModels = [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }
  ]
  for (const [node, id] of [[sonnet55, 'claude-sonnet-5-5'], [haiku55, 'claude-haiku-5-5'],
    [sonnet5, 'claude-sonnet-5'], [sonnet46, 'claude-sonnet-4-6']]) {
    const base = node.getAttribute
    node.getAttribute = name => name === 'aria-checked' ? String(activeModel === id) : base(name)
  }
  const effortLevels = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['extra', 'Extra'], ['max', 'Max']].map(([id, label], index) => {
    const node = makeRadio({ role: 'menuitemradio', 'data-effort-id': id },
      id === 'medium' ? [span(label), span('Recommended')] : [span(label)], 260 + index * 30)
    const base = node.getAttribute
    node.getAttribute = name => name === 'aria-checked' ? String(activeEffort === id) : base(name)
    return { id, label, node }
  })
  const effortToggle = {
    nodeType: 1, tagName: 'DIV', isConnected: true,
    getAttribute: name => ({
      role: 'menuitem', 'aria-haspopup': 'menu',
      'aria-expanded': String(subMenu === 'effort'),
      'aria-controls': subMenu === 'effort' ? 'claude-effort-menu' : null
    })[name] ?? null,
    get childNodes() {
      const current = effortLevels.find(item => item.id === activeEffort)?.label ?? ''
      return [span('Effort'), span(current)]
    },
    contains(node) { return node === this },
    getBoundingClientRect: () => ({ left: 190, right: 210, top: 10, bottom: 30, width: 20, height: 20 })
  }
  const moreToggle = {
    nodeType: 1, tagName: 'DIV', isConnected: true,
    getAttribute: name => ({
      role: 'menuitem', 'aria-haspopup': 'menu',
      'aria-expanded': String(subMenu === 'more'),
      'aria-controls': subMenu === 'more' ? 'claude-more-menu' : null
    })[name] ?? null,
    childNodes: [span('More models')],
    contains(node) { return node === this },
    getBoundingClientRect: () => ({ left: 220, right: 240, top: 10, bottom: 30, width: 20, height: 20 })
  }
  const trigger = {
    nodeType: 1, tagName: 'BUTTON', id: 'claude-trigger', isConnected: true,
    getAttribute: name => ({
      type: 'button', 'data-testid': 'model-selector-dropdown',
      'aria-haspopup': 'menu', 'aria-expanded': String(open),
      'aria-controls': open ? 'claude-main-menu' : null
    })[name] ?? null,
    get childNodes() {
      const modelLabel = allModels.find(item => item.id === activeModel)?.label ?? ''
      const effortLabel = activeModel === 'claude-sonnet-4-6' ? '' : (effortLevels.find(item => item.id === activeEffort)?.label ?? '')
      return [
        span('', { 'aria-hidden': 'true' }),
        span([
          span([span(modelLabel), ...(effortLabel ? [span(effortLabel)] : [])]),
          ...(activeEffort === 'max' && effortLabel ? [span('!', { role: 'img', 'aria-label': 'Max warning' })] : [])
        ])
      ]
    },
    contains(node) { return node === this },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 10, right: 30, top: 10, bottom: 30, width: 20, height: 20 })
  }
  const matchRows = (rows, selector) => rows.filter(row => selector.split(',').some(part => {
    const attrs = [...part.trim().matchAll(/\[([\w-]+)(?:="([^"]+)")?\]/g)]
    return attrs.length > 0 && attrs.every(([, name, value]) => {
      const actualValue = row.getAttribute(name)
      return value === undefined ? actualValue !== null : actualValue === value
    })
  }))
  const moreMenu = {
    nodeType: 1, tagName: 'DIV', id: 'claude-more-menu', isConnected: true,
    getAttribute: name => ({ role: 'menu' })[name] ?? null,
    querySelectorAll: selector => matchRows(moreModels, selector),
    querySelector: selector => matchRows(moreModels, selector)[0] ?? null,
    contains: node => node === moreMenu || moreModels.includes(node),
    getBoundingClientRect: () => ({ left: 120, right: 185, top: 40, bottom: 80, width: 65, height: 40 })
  }
  const effortMenu = {
    nodeType: 1, tagName: 'DIV', id: 'claude-effort-menu', isConnected: true,
    getAttribute: name => ({ role: 'menu' })[name] ?? null,
    querySelectorAll: selector => matchRows(effortLevels.map(item => item.node), selector),
    querySelector: selector => matchRows(effortLevels.map(item => item.node), selector)[0] ?? null,
    contains: node => node === effortMenu || effortLevels.some(item => item.node === node),
    getBoundingClientRect: () => ({ left: 250, right: 410, top: 40, bottom: 80, width: 160, height: 40 })
  }
  const mainMenu = {
    nodeType: 1, tagName: 'DIV', id: 'claude-main-menu', isConnected: true,
    getAttribute: name => ({ role: 'menu', 'aria-labelledby': 'claude-trigger' })[name] ?? null,
    querySelectorAll: selector => {
      const toggles = activeModel === 'claude-sonnet-4-6' ? [moreToggle] : [effortToggle, moreToggle]
      return matchRows([...mainModels, ...toggles], selector)
    },
    querySelector: selector => mainMenu.querySelectorAll(selector)[0] ?? null,
    contains: node => node === mainMenu || mainModels.includes(node) || node === effortToggle || node === moreToggle,
    getBoundingClientRect: () => ({ left: 35, right: 245, top: 40, bottom: 120, width: 210, height: 80 })
  }
  const visible = node => {
    if (!node) return false
    if (node === trigger || trigger.childNodes.includes(node)) return true
    if (open && (mainMenu.contains(node) || (node.nodeType === 1 && node.getAttribute?.('aria-hidden') !== 'true'))) {
      if (subMenu === 'more' && moreMenu.contains(node)) return true
      if (subMenu === 'effort' && effortMenu.contains(node)) return true
      if (mainMenu.contains(node)) return true
    }
    return false
  }
  // Ensure inner text spans inside trigger and menu rows count as visible when their parent is visible.
  const allNodesVisible = node => {
    if (!node) return false
    if (node.getAttribute?.('aria-hidden') === 'true' || node.getAttribute?.('role') === 'img') return false
    if (node === trigger || mainMenu.contains(node) || (subMenu === 'more' && moreMenu.contains(node)) || (subMenu === 'effort' && effortMenu.contains(node))) return visible(node)
    return true
  }
  const document = {
    activeElement: trigger,
    getElementById: id => open ? ({
      'claude-main-menu': mainMenu,
      'claude-more-menu': subMenu === 'more' ? moreMenu : null,
      'claude-effort-menu': subMenu === 'effort' ? effortMenu : null
    })[id] ?? null : null,
    elementFromPoint(x) {
      const hitPool = [trigger, ...mainModels, ...(activeModel === 'claude-sonnet-4-6' ? [moreToggle] : [effortToggle, moreToggle]),
        ...(subMenu === 'more' ? moreModels : []), ...(subMenu === 'effort' ? effortLevels.map(item => item.node) : [])]
      nextHit = hitPool.find(node => visible(node) && x >= node.getBoundingClientRect().left && x <= node.getBoundingClientRect().right) ?? null
      return nextHit
    }
  }
  const context = createContext({
    PAGE: CLAUDE_PAGE, document, location: { pathname: '/new' },
    Date: { now: () => now }, setTimeout(callback, delay) { now += delay; queueMicrotask(callback) },
    focusModelCache: null, focusModeChanging: null, focusEditing: null, fileSend: null,
    state: { taskPromptGeneration: 1, programmatic: false, awaitingReplySince: 0, pendingQuestion: false },
    getComposer: () => draft, findStopButton: () => null,
    queryAll: selectors => selectors.includes(rules.triggerSelector) ? [trigger] : [],
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(),
    controlDisabled: node => node?.getAttribute('aria-disabled') === 'true',
    isVisibleElement: allNodesVisible,
    innerWidth: 1000, innerHeight: 800,
    report(payload) {
      queueMicrotask(() => { void dispatchFocusModelClick(contents, payload.focusModelToken, payload.count, () => true, () => true) })
    }
  })
  for (const name of ['focusModelPickerParts', 'focusVisibleTextNodes', 'focusClaudeMenuPanel', 'focusClaudeSubmenuToggle',
    'focusClaudeRadioOptions', 'focusGeminiModelLabel', 'focusGeminiModelName', 'focusGeminiModelOptions',
    'focusGeminiEffortParts', 'focusGeminiEffortValue', 'focusGeminiEffortOptions', 'focusModelSettingsOf']) {
    context[name] = actual(name, context)
  }
  const api = {}
  context.focusModelClickPoint = actual('focusModelClickPoint', context)
  for (const name of ['prepareFocusModelClick', 'finishFocusModelClick', 'updateModelSettings']) api[name] = actual(name, context, true)
  context.window = { __cmdTerminalInterceptor: api }
  const contents = {
    getZoomFactor: () => 1,
    executeJavaScript: source => Promise.resolve(new Script(source).runInContext(context)),
    sendInputEvent(event) {
      if (event.type === 'keyDown' && event.keyCode === 'Escape') {
        if (subMenu) {
          clicks.push('dismiss-' + subMenu)
          subMenu = null
          document.activeElement = mainMenu
        } else if (open) {
          clicks.push('dismiss-main')
          open = false
          document.activeElement = trigger
        }
      }
      if (event.type === 'mouseMove' && !requireClick) {
        if (nextHit === moreToggle && subMenu !== 'more') { clicks.push('hover-more'); subMenu = 'more' }
        if (nextHit === effortToggle && subMenu !== 'effort') { clicks.push('hover-effort'); subMenu = 'effort' }
      }
      if (event.type !== 'mouseUp') return
      if (nextHit === trigger) {
        clicks.push('open')
        open = !open
        if (!open) subMenu = null
      } else if (nextHit === moreToggle) {
        clicks.push('click-more')
        subMenu = 'more'
      } else if (nextHit === effortToggle) {
        clicks.push('click-effort')
        subMenu = 'effort'
      } else if ([...mainModels, ...moreModels].includes(nextHit) && nextHit.getAttribute('role') === 'menuitemradio') {
        const id = nextHit.getAttribute('data-model-id')
        clicks.push(id)
        if (!decline) activeModel = id
        open = false
        subMenu = null
        document.activeElement = trigger
      } else if (effortLevels.some(item => item.node === nextHit)) {
        const id = nextHit.getAttribute('data-effort-id')
        clicks.push(id)
        if (!decline) activeEffort = id
        open = false
        subMenu = null
        document.activeElement = trigger
      }
    }
  }
  return {
    context, clicks, draft, read: context.focusModelSettingsOf,
    clickOnly() { requireClick = true },
    declineChange() { decline = true },
    change: (kind, value = null) => api.updateModelSettings(kind, value, context.location.pathname, 'claude-op')
  }
}

test('Claude reads models across main/More-models menus, ignores locked Upgrade items, and reads all 5 Effort levels', async () => {
  const f = claudeFixture()
  const read = await f.change('read')
  assert.equal(read.outcome, 'ok')
  assert.equal(read.settings.model, 'claude-sonnet-5-5')
  assert.deepEqual(Array.from(read.settings.models, item => [item.value, item.label]), [
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-sonnet-5', 'Sonnet 5'],
    ['claude-sonnet-4-6', 'Sonnet 4.6']
  ])
  assert.equal(read.settings.effort, 'medium')
  assert.deepEqual(Array.from(read.settings.efforts, item => [item.value, item.label]), [
    ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['extra', 'Extra'], ['max', 'Max']
  ])
  assert.deepEqual(f.clicks, ['open', 'hover-more', 'hover-effort', 'dismiss-effort', 'dismiss-main'])
  assert.equal(shared.validFocusModelSettings(read.settings), true)
})

test('Claude switches main-menu and More-models models, preserves selection across /new -> /chat, and switches Effort', async () => {
  for (const requireClick of [false, true]) {
    const f = claudeFixture()
    if (requireClick) f.clickOnly()
    assert.equal((await f.change('read')).outcome, 'ok')
    f.clicks.length = 0

    // Switch to Max effort (trigger displays warning icon role="img" which must not break label reading).
    const maxRes = await f.change('effort', 'max')
    assert.equal(maxRes.outcome, 'ok')
    assert.equal(maxRes.settings.effort, 'max')
    assert.equal(f.read().model, 'claude-sonnet-5-5')
    assert.equal(f.read().effort, 'max')
    assert.deepEqual(f.clicks, ['open', requireClick ? 'click-effort' : 'hover-effort', 'max'])

    // Switch to Haiku 5.5 on the main menu.
    f.clicks.length = 0
    const haiku = await f.change('model', 'claude-haiku-5-5')
    assert.equal(haiku.outcome, 'ok')
    assert.equal(haiku.settings.model, 'claude-haiku-5-5')
    assert.deepEqual(f.clicks, ['open', 'claude-haiku-5-5'])

    // Switch to Sonnet 4.6 inside More models (which has no Effort submenu).
    f.clicks.length = 0
    const legacy = await f.change('model', 'claude-sonnet-4-6')
    assert.equal(legacy.outcome, 'ok')
    assert.equal(legacy.settings.model, 'claude-sonnet-4-6')
    assert.equal(legacy.settings.efforts.length, 0)
    assert.equal(legacy.settings.effort, null)
    assert.deepEqual(f.clicks, ['open', requireClick ? 'click-more' : 'hover-more', 'claude-sonnet-4-6'])

    // First send from /new to /chat/<uuid> retains cached models.
    f.context.state.awaitingReplySince = 1
    f.context.location.pathname = '/chat/11111111-1111-4111-8111-111111111111'
    assert.equal(f.read().model, 'claude-sonnet-4-6')
    assert.equal(f.read().models.length, 4)
    assert.equal(f.draft.value, '保留 Claude 草稿')
  }
})

test('Claude rejects locked options and refreshes Effort availability after switching models in FocusChatView', async () => {
  const f = claudeFixture()
  await f.change('read')
  assert.equal((await f.change('model', 'claude-opus-5-5')).reason, 'option-unavailable')
  f.declineChange()
  assert.equal((await f.change('effort', 'extra')).reason, 'selection-unconfirmed')

  const reads = []
  const view = {
    owner: { platformId: 'claude' }, modelSettingsKind: 'claude', visible: true, ready: true, working: false, editingId: null, sending: false,
    sendLock: { current: false }, modelReadAttempted: { current: true }, modelReadAttempts: { current: 1 },
    geminiReadModel: { current: 'claude-sonnet-5-5' }, settingPending: null,
    state: { modelSettingsReady: true, modelSettings: { model: 'claude-haiku-5-5', effort: null, models: [{ value: 'claude-haiku-5-5', label: 'Haiku 5.5' }], efforts: [] } },
    updateModelSettings(kind, value, automatic) { reads.push({ kind, value, automatic }) }
  }
  automaticRead(view).call(view)
  assert.deepEqual(reads, [{ kind: 'read', value: undefined, automatic: true }])
})

test('claude focus view waits for Base UI submenu toggle hit-test readiness before hovering', async () => {
  const f = claudeFixture()
  const rules = f.context.PAGE.focus.modelSettings
  const originalHit = f.context.document.elementFromPoint
  let blockedHits = 2
  f.context.document.elementFromPoint = (x, y) => {
    const menu = f.context.focusModelPickerParts()?.menu
    const more = menu ? f.context.focusClaudeSubmenuToggle(menu, rules.moreModelsLabels) : null
    if (more && blockedHits > 0) {
      const b = more.getBoundingClientRect()
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
        blockedHits -= 1
        return null
      }
    }
    return originalHit(x, y)
  }
  const res = await f.change('read')
  assert.equal(blockedHits, 0)
  assert.equal(res.outcome, 'ok')
  assert.ok(res.settings.models.length >= 4)
  assert.ok(res.settings.efforts.length > 0)
  assert.ok(res.settings.effort !== null)
  assert.deepEqual(f.clicks, ['open', 'hover-more', 'hover-effort', 'dismiss-effort', 'dismiss-main'])
})

test('claude focus view dismisses an overlapping sibling submenu so effort remains readable', async () => {
  const f = claudeFixture()
  const rules = f.context.PAGE.focus.modelSettings
  const originalHit = f.context.document.elementFromPoint
  f.context.document.elementFromPoint = (x, y) => {
    const menu = f.context.focusModelPickerParts()?.menu
    const more = menu ? f.context.focusClaudeSubmenuToggle(menu, rules.moreModelsLabels) : null
    const effort = menu ? f.context.focusClaudeSubmenuToggle(menu, rules.effortMenu.toggleLabels) : null
    const morePanel = more ? f.context.focusClaudeMenuPanel(more) : null
    if (morePanel && effort) {
      const b = effort.getBoundingClientRect()
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) return morePanel
    }
    return originalHit(x, y)
  }
  const res = await f.change('read')
  assert.equal(res.outcome, 'ok')
  assert.ok(res.settings.models.length >= 4)
  assert.ok(res.settings.efforts.length > 0)
  assert.ok(f.clicks.includes('hover-more'))
  assert.ok(f.clicks.includes('hover-effort'))
})

test('claude focus view scrolls offscreen submenu toggles into view before dispatching hover', async () => {
  const f = claudeFixture()
  const rules = f.context.PAGE.focus.modelSettings
  const originalSend = f.contents.sendInputEvent
  let scrolled = null, wrapped = false
  f.contents.sendInputEvent = event => {
    originalSend(event)
    if (wrapped || event.type !== 'mouseUp') return
    const menu = f.context.focusModelPickerParts()?.menu
    const effort = menu ? f.context.focusClaudeSubmenuToggle(menu, rules.effortMenu.toggleLabels) : null
    if (!effort) return
    wrapped = true
    const originalRect = effort.getBoundingClientRect.bind(effort)
    let offscreen = true
    effort.getBoundingClientRect = () => offscreen ? { left: 10, top: 960, width: 220, height: 30, right: 230, bottom: 990 } : originalRect()
    effort.scrollIntoView = options => { scrolled = options; offscreen = false }
  }
  const res = await f.change('read')
  assert.deepEqual(scrolled, { block: 'nearest' })
  assert.equal(res.outcome, 'ok')
  assert.ok(res.settings.efforts.length > 0)
})

test('claude submenu failure returns allowlisted sub-step diagnostics across interceptor and embed', async () => {
  const f = claudeFixture()
  const rules = f.context.PAGE.focus.modelSettings
  const originalHit = f.context.document.elementFromPoint
  f.context.document.elementFromPoint = (x, y) => {
    const menu = f.context.focusModelPickerParts()?.menu
    const effort = menu ? f.context.focusClaudeSubmenuToggle(menu, rules.effortMenu.toggleLabels) : null
    if (effort) {
      const b = effort.getBoundingClientRect()
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) return null
    }
    return originalHit(x, y)
  }
  const failed = await f.change('read')
  assert.equal(failed.outcome, 'unknown')
  assert.equal(failed.reason, 'menu-unavailable')
  assert.equal(failed.diagnostic?.stage, 'open')
  assert.equal(failed.diagnostic?.target, 'effort-menu')
  assert.equal(failed.diagnostic?.detail, 'hit-test-missed')
  assert.ok(failed.diagnostic?.settleMs >= 500)
  assert.ok(failed.diagnostic?.stepCount >= 2)

  const view = {}
  const embedContext = createContext({
    URL, Promise, setTimeout, clearTimeout,
    BrowserWindow: { getFocusedWindow: () => ({ contentView: { children: [view] } }) },
    validFocusModelSettings: shared.validFocusModelSettings,
    validFocusModelSettingDiagnostic: shared.validFocusModelSettingDiagnostic,
    dispatchFocusModelClick: () => {}
  })
  const updateEmbed = actual('updateFocusModelSettings', embedContext, true, '../src/main/embed.ts')
  const sanitized = await updateEmbed.call({
    platform: { id: 'claude', page: { focus: { modelSettings: rules } } },
    view, focusEditToken: null, focusModelNativeClick: null,
    focusPage: () => ({
      isDestroyed: () => false,
      getURL: () => 'https://claude.ai/chat/123',
      executeJavaScript: async () => ({
        outcome: 'unknown', reason: 'menu-unavailable',
        settings: { model: 'claude-sonnet-4-6', effort: null, models: [{ value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }], efforts: [] },
        diagnostic: { stage: 'open', target: 'effort-menu', detail: 'hit-test-missed', stepCount: 3, settleMs: 520, extra: 'drop-me' }
      })
    })
  }, { kind: 'read' }, 'embed-diag-op', () => true)
  assert.deepEqual(sanitized.diagnostic, { stage: 'open', target: 'effort-menu', detail: 'hit-test-missed', stepCount: 3, settleMs: 520 })
})
