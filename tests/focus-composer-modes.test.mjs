// User-run only: node --test tests/focus-composer-modes.test.mjs
// Actual page helpers, runtime method and React output; synthetic DOM/clock only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import * as React from 'react'
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
const { DEEPSEEK_PAGE, GEMINI_PAGE } = moduleAt('../src/shared/platforms.ts')
const { default: Modes } = moduleAt('../src/renderer/src/components/FocusComposerModes.tsx', {
  react: React, 'react/jsx-runtime': jsxRuntime, '@shared/focus-chat': shared
})
function actual(path, name, context, method = false) {
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
const pagePath = '../src/main/injected/send-interceptor.js'

test('existing Gemini tasks use the conversation header and preserve mode without home switches', () => {
  const path = '/app/0123456789abcdef'
  const status = (textContent, box, inReply = false) => ({
    textContent, getAttribute: () => null, closest: selector => inReply && selector.includes('model-response'),
    getBoundingClientRect: () => box
  })
  const header = { top: 20, bottom: 52, left: 1160, right: 1210 }
  const rows = [status('完成', header, true), status('已完成', { ...header, top: 560, bottom: 592 }),
    status('Done', { ...header, left: 240, right: 290 })]
  const context = createContext({ PAGE: GEMINI_PAGE, location: { pathname: path },
    CONTROL_SELECTOR: 'button, [role="button"]', focusModelCache: null,
    document: { documentElement: { clientWidth: 1248 }, querySelectorAll: () => rows },
    collapse: value => String(value || '').trim(), isVisibleElement: () => true })
  context.focusGeminiConversationTask = actual(pagePath, 'focusGeminiConversationTask', context)
  const read = actual(pagePath, 'focusGeminiComposerMode', context)
  assert.equal(read([]), undefined)
  assert.equal(read([], 'chat'), 'chat')
  rows.push(status('完成', header))
  assert.equal(read([], 'chat'), 'task', 'the live header can correct the stored mode')
  rows.pop()
  context.focusModelCache = { path, composerMode: 'task' }
  assert.equal(read([]), 'task', 'a transiently missing header keeps the confirmed mode')
  context.location.pathname = '/app/abcdef0123456789'
  assert.equal(read([]), undefined, 'the previous conversation does not supply the mode')
  context.location.pathname = '/app/'
  assert.equal(read([{ id: 'chat', active: true }, { id: 'task', active: false }], 'task'), 'chat')
})

function fixture() {
  const control = (text, active) => ({ textContent: text, attrs: { 'aria-pressed': String(active) }, disabled: false,
    getAttribute(key) { return this.attrs[key] ?? null }, matches() { return false } })
  const thinking = control('深度思考', false), search = control('智能搜索', true), calls = []
  let controls = [thinking, search], now = 100, toggleWorks = true, afterClick = null
  const composer = { draft: '保留原网页草稿' }
  const context = createContext({ PAGE: DEEPSEEK_PAGE, Date: { now: () => now }, location: { pathname: '/' },
    focusModeChanging: null, focusEditing: null, fileSend: null, state: { programmatic: false, awaitingReplySince: 0, taskPromptGeneration: 1 },
    focusComposerModeControls: () => controls, controlDisabled: node => node.disabled,
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(), getComposer: () => composer, findStopButton: () => null,
    setTimeout(callback, delay) { now += delay; queueMicrotask(callback) },
    pressButton(node) { calls.push(node); if (toggleWorks) node.attrs['aria-pressed'] = String(node.attrs['aria-pressed'] !== 'true'); afterClick?.() }
  })
  context.focusComposerModeMatches = actual(pagePath, 'focusComposerModeMatches', context)
  context.focusComposerModesOf = actual(pagePath, 'focusComposerModesOf', context)
  return { context, thinking, search, calls, composer, read: context.focusComposerModesOf,
    change: actual(pagePath, 'setComposerMode', context, true),
    setControls(value) { controls = value }, failClick() { toggleWorks = false }, afterClick(callback) { afterClick = callback } }
}

test('mode discovery walks past the attachment/send footer until both named switches are in scope', () => {
  const button = textContent => ({ textContent, visible: true })
  const attachment = button(''), send = button(''), thinking = button('深度思考'), search = button('智能搜索')
  const body = {}, outer = { parentElement: body, querySelectorAll: () => [attachment, send, thinking, search] }
  const inner = { parentElement: outer, querySelectorAll: () => [attachment, send] }
  const context = createContext({ PAGE: DEEPSEEK_PAGE, CONTROL_SELECTOR: 'button, [role="button"]',
    document: { body }, getComposer: () => ({ parentElement: inner }), isVisibleElement: node => node.visible,
    collapse: value => String(value || '').trim() })
  context.focusComposerModeMatches = actual(pagePath, 'focusComposerModeMatches', context)
  const read = actual(pagePath, 'focusComposerModeControls', context)
  assert.deepEqual(Array.from(read()), [attachment, send, thinking, search])
  search.visible = false
  assert.deepEqual(Array.from(read()), [attachment, send, thinking], 'an absent switch stays unknown')
  thinking.visible = false
  assert.equal(read().length, 0, 'never use anonymous send/attachment controls as switches')
})

test('measured roleless ds-toggle-button controls are discovered and verified for all four mode combinations', async () => {
  // deepseek-composer-modes-2026-10-24T16-11-14-390Z-12768.log:
  // lines 2/6/10/14/18: DIV, no role; aria-pressed is the actual state.
  const f = fixture()
  const native = (control, className) => {
    control.tagName = 'DIV'
    control.attrs = { ...control.attrs, class: className, tabindex: '0' }
    control.matches = selector => selector.split(',').some(part => {
      part = part.trim()
      if (part.startsWith('.')) return control.attrs.class.split(/\s+/).includes(part.slice(1))
      if (part === '[role="button"]') return control.attrs.role === 'button'
      return part === 'button' && control.tagName === 'BUTTON'
    })
    return control
  }
  native(f.thinking, 'hash-one ds-toggle-button ds-toggle-button--m')
  native(f.search, 'hash-two ds-toggle-button ds-toggle-button--m ds-toggle-button--selected')
  const attachment = native({ textContent: '', attrs: { role: 'button' } }, 'ds-button')
  const send = native({ textContent: '', attrs: { role: 'button' } }, 'ds-button ds-button--primary')
  const body = {}, all = [attachment, send, f.thinking, f.search]
  const outer = { parentElement: body, querySelectorAll: selector => all.filter(control => control.matches(selector)) }
  const inner = { parentElement: outer, querySelectorAll: selector => [attachment, send].filter(control => control.matches(selector)) }
  f.composer.parentElement = inner
  f.context.document = { body }
  f.context.CONTROL_SELECTOR = 'button, [role="button"]'
  f.context.isVisibleElement = () => true
  f.context.focusComposerModeControls = actual(pagePath, 'focusComposerModeControls', f.context)
  assert.equal(f.thinking.attrs.role, undefined)
  assert.equal(f.thinking.matches(DEEPSEEK_PAGE.focus.composerModeControlSelector), true, 'must include the measured roleless class')
  for (const [thinking, search] of [[false, false], [true, false], [true, true], [false, true]]) {
    f.thinking.attrs['aria-pressed'] = String(thinking)
    f.search.attrs['aria-pressed'] = String(search)
    assert.deepEqual(Array.from(f.read(), mode => mode.data.active), [thinking, search])
    assert.ok(f.read().every(mode => mode.data.disabled === false))
  }
  // The class intentionally disagrees here: aria-pressed remains authoritative.
  f.search.attrs['aria-pressed'] = 'false'
  assert.equal(f.read()[1].data.active, false)
  f.thinking.attrs['aria-pressed'] = 'false'
  assert.equal(await f.change('thinking', true, '/'), 'ok')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0], f.thinking)
  assert.equal(f.composer.draft, '保留原网页草稿')
  delete f.thinking.attrs['aria-pressed']
  assert.equal(f.read()[0].data.active, null, 'a missing semantic state cannot be guessed from colors or classes')
})

test('reads only uniquely named composer controls and keeps unknown distinct from off', () => {
  const f = fixture(), modes = f.read()
  assert.equal(modes[0].data.active, false)
  assert.equal(modes[1].data.active, true)
  delete f.thinking.attrs['aria-pressed']
  assert.equal(f.read()[0].data.active, null)
  assert.equal(f.read()[0].data.disabled, true)
  f.setControls([f.thinking, { ...f.thinking }, f.search])
  assert.equal(f.read()[0].control, null)
  f.setControls([f.search])
  assert.equal(f.read()[0].data.active, null)
})

test('one idempotent, confirmed mode change preserves the draft and never submits', async () => {
  const f = fixture()
  assert.equal(await f.change('thinking', true, '/'), 'ok')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0], f.thinking)
  assert.equal(f.composer.draft, '保留原网页草稿')
  assert.equal(f.search.attrs['aria-pressed'], 'true')
  assert.equal(await f.change('thinking', true, '/'), 'ok')
  assert.equal(f.calls.length, 1, 'already selected does not toggle back')
  assert.equal(f.context.focusModeChanging, null)
})

test('unconfirmed clicks are not retried, and navigation cancels verification', async () => {
  const f = fixture(); f.failClick()
  assert.equal(await f.change('thinking', true, '/'), 'unknown')
  assert.equal(f.calls.length, 1)
  const g = fixture(); g.afterClick(() => { g.context.location.pathname = '/a/chat/s/other' })
  assert.equal(await g.change('thinking', true, '/'), 'cancelled')
  assert.equal(g.calls.length, 1)
  assert.equal(g.context.focusModeChanging, null)
})

test('busy, missing, disabled and unsupported switches never click', async () => {
  for (const kind of ['waiting', 'generating', 'upload', 'editing', 'unknown', 'disabled', 'path', 'invalid']) {
    const f = fixture()
    if (kind === 'waiting') f.context.state.awaitingReplySince = 1
    if (kind === 'generating') f.context.findStopButton = () => ({})
    if (kind === 'upload') f.context.fileSend = {}
    if (kind === 'editing') f.context.focusEditing = {}
    if (kind === 'unknown') delete f.thinking.attrs['aria-pressed']
    if (kind === 'disabled') f.thinking.disabled = true
    const result = await f.change(kind === 'invalid' ? 'other' : 'thinking', true, kind === 'path' ? '/other' : '/')
    assert.notEqual(result, 'ok', kind)
    assert.equal(f.calls.length, 0, kind)
  }
})

test('snapshot boundary rejects duplicate IDs, malformed states and extra switches', () => {
  assert.equal(shared.validFocusComposerModes([{ id: 'thinking', active: null, disabled: true }]), true)
  assert.equal(shared.validFocusComposerModes([{ id: 'chat', active: true, disabled: false }, { id: 'task', active: false, disabled: false }]), true)
  for (const modes of [[{ id: 'other', active: false, disabled: false }], [{ id: 'thinking', active: 'on', disabled: false }],
    [{ id: 'search', active: true }], Array(2).fill({ id: 'thinking', active: false, disabled: false }), Array(3).fill({})]) {
    assert.equal(shared.validFocusComposerModes(modes), false)
  }
})

test('runtime serializes switches with sends and rejects a stale home/chat owner', async () => {
  const owner = { sessionId: 'one', platformId: 'deepseek', conversationId: null }, diagnostics = []
  const context = createContext({ writeFocusDiagnostic: (_owner, value) => diagnostics.push(value) })
  const change = actual('../src/main/session-runtime.ts', 'setFocusComposerMode', context, true)
  let release, current = true
  const runtime = { active: true, activePlatform: { page: DEEPSEEK_PAGE }, ownsFocus: () => current, focusSending: false, focusRevision: null,
    runner: { hasInFlightWork: () => false }, embed: { getInterceptorStatus: () => ({}),
      setFocusComposerMode: () => new Promise(resolve => { release = resolve }) } }
  const pending = change.call(runtime, { ...owner, id: 'thinking', active: true })
  assert.equal(runtime.focusSending, true)
  assert.equal(await change.call(runtime, { ...owner, id: 'search', active: false }), 'busy')
  current = false; release('ok')
  assert.equal(await pending, 'cancelled')
  assert.equal(runtime.focusSending, false)
  assert.equal(await change.call(runtime, { ...owner, id: 'thinking', active: true }), 'unavailable')
  assert.equal(diagnostics.at(-1).outcome, 'cancelled')
})

test('focus controls show native checked/unknown/pending state without optimistic selection', () => {
  const html = renderToStaticMarkup(React.createElement(Modes, { platformId: 'deepseek', modes: [
    { id: 'thinking', active: true, disabled: false }, { id: 'search', active: false, disabled: false }
  ], disabled: false, pending: null, onChange() {} }))
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /aria-pressed="false"/)
  assert.equal((html.match(/type="button"/g) ?? []).length, 2)
  assert.match(html, /深度思考/); assert.match(html, /智能搜索/)
  const unknown = renderToStaticMarkup(React.createElement(Modes, { platformId: 'deepseek', modes: [], disabled: false, pending: null, onChange() {} }))
  assert.equal((unknown.match(/data-state="unknown"/g) ?? []).length, 2)
  assert.equal((unknown.match(/disabled=""/g) ?? []).length, 2)
  assert.equal(unknown.includes('aria-pressed='), false)
  const pending = renderToStaticMarkup(React.createElement(Modes, { platformId: 'deepseek', modes: [
    { id: 'thinking', active: false, disabled: false }
  ], disabled: false, pending: 'thinking', onChange() {} }))
  assert.match(pending, /aria-busy="true"/)
  assert.match(pending, /aria-pressed="false"/)
})

test('Gemini selects one home mode, checks the rendered composer, and preserves native drafts', async () => {
  const f = fixture()
  let placeholder = 'Ask Gemini', attachmentDraft = false
  const control = textContent => ({ textContent, visible: true, disabled: false, attrs: {},
    closest() { return this.inNavigation ? {} : null }, getAttribute(key) { return this.attrs[key] ?? null } })
  const chat = control('对话'), task = control('任务'), sidebarTask = { ...control('任务'), inNavigation: true }
  const send = control('发送'), body = {}
  const controls = [send, chat, task, sidebarTask]
  const outer = { parentElement: body, querySelectorAll: () => controls }
  f.composer.parentElement = { parentElement: outer, querySelectorAll: () => [send] }
  f.composer.getAttribute = key => key === 'data-placeholder' ? placeholder : null
  f.composer.closest = () => null
  f.composer.draft = ''
  Object.assign(f.context, { PAGE: GEMINI_PAGE, document: { body }, location: { pathname: '/app' },
    isVisibleElement: node => node.visible, readComposer: node => node.draft, draftAttachmentEvidence: () => attachmentDraft,
    pressButton(node) { f.calls.push(node); placeholder = node === task ? '描述任务' : 'Ask Gemini' } })
  f.context.focusComposerModeControls = actual(pagePath, 'focusComposerModeControls', f.context)
  const selected = () => f.read().find(mode => mode.data.active === true)?.data.id
  assert.equal(selected(), 'chat')
  assert.equal(await f.change('task', false, '/app'), 'invalid')
  assert.equal(await f.change('task', true, '/app'), 'ok')
  assert.equal(selected(), 'task')
  assert.equal(await f.change('task', true, '/app'), 'ok')
  f.composer.draft = '原网页草稿'
  assert.equal(await f.change('chat', true, '/app'), 'busy')
  assert.equal(f.composer.draft, '原网页草稿')
  f.composer.draft = ''
  attachmentDraft = true
  assert.equal(await f.change('chat', true, '/app'), 'busy')
  attachmentDraft = false
  assert.equal(await f.change('chat', true, '/app'), 'ok')
  assert.equal(selected(), 'chat')
  assert.deepEqual(f.calls, [task, chat])

  placeholder = 'Unrecognized placeholder'
  assert.equal(selected(), undefined)
  task.attrs['aria-selected'] = 'true'
  assert.equal(selected(), 'task')
  chat.attrs['aria-selected'] = 'true'
  assert.equal(selected(), undefined, 'conflicting states do not show a selected mode')
  controls.push(control('任务'))
  assert.equal(f.read().length, 0, 'ambiguous mode controls cannot be clicked')
  controls.pop()
  task.visible = false
  assert.equal(f.read().length, 0)
  task.visible = true
  f.context.location.pathname = '/app/0123456789abcdef'
  assert.equal(await f.change('chat', true, f.context.location.pathname), 'unavailable')
  assert.deepEqual(f.calls, [task, chat])
})

test('Gemini runtime rejects mode changes with an active task, queued message or existing conversation', async () => {
  const context = createContext({ writeFocusDiagnostic() {} })
  const change = actual('../src/main/session-runtime.ts', 'setFocusComposerMode', context, true)
  const owner = { sessionId: 'one', platformId: 'gemini', conversationId: null }
  const calls = []
  let taskRunning = false, pending = 0
  const runtime = { active: true, activePlatform: { page: GEMINI_PAGE }, ownsFocus: () => true, taskRunning: () => taskRunning,
    aiOutboundQueue: { stateFor: () => ({ pending }) }, runner: { hasInFlightWork: () => false },
    embed: { getInterceptorStatus: () => ({}), async setFocusComposerMode(id, active) { calls.push([id, active]); return 'ok' } } }
  const request = { ...owner, id: 'task', active: true }
  assert.equal(await change.call(runtime, { ...request, conversationId: '0123456789abcdef' }), 'unavailable')
  assert.equal(await change.call(runtime, { ...request, id: 'thinking' }), 'invalid')
  taskRunning = true
  assert.equal(await change.call(runtime, request), 'busy')
  taskRunning = false; pending = 1
  assert.equal(await change.call(runtime, request), 'busy')
  pending = 0
  assert.equal(await change.call(runtime, request), 'ok')
  assert.deepEqual(calls, [['task', true]])
})

test('Gemini renders the two modes with the native selection while pending', () => {
  const html = renderToStaticMarkup(React.createElement(Modes, { platformId: 'gemini', modes: [
    { id: 'chat', active: false, disabled: false }, { id: 'task', active: true, disabled: false }
  ], disabled: false, pending: 'chat', onChange() {} }))
  assert.match(html, /aria-busy="true"[^>]*>对话/)
  assert.match(html, /aria-pressed="true"[^>]*>任务/)
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2)
})
