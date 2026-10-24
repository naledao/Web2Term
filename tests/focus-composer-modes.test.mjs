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
const { DEEPSEEK_PAGE } = moduleAt('../src/shared/platforms.ts')
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
  const runtime = { ownsFocus: () => current, focusSending: false, focusRevision: null,
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
  const html = renderToStaticMarkup(React.createElement(Modes, { modes: [
    { id: 'thinking', active: true, disabled: false }, { id: 'search', active: false, disabled: false }
  ], disabled: false, pending: null, onChange() {} }))
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /aria-pressed="false"/)
  assert.equal((html.match(/type="button"/g) ?? []).length, 2)
  assert.match(html, /深度思考/); assert.match(html, /智能搜索/)
  const unknown = renderToStaticMarkup(React.createElement(Modes, { modes: [], disabled: false, pending: null, onChange() {} }))
  assert.equal((unknown.match(/data-state="unknown"/g) ?? []).length, 2)
  assert.equal((unknown.match(/disabled=""/g) ?? []).length, 2)
  assert.equal(unknown.includes('aria-pressed='), false)
  const pending = renderToStaticMarkup(React.createElement(Modes, { modes: [
    { id: 'thinking', active: false, disabled: false }
  ], disabled: false, pending: 'thinking', onChange() {} }))
  assert.match(pending, /aria-busy="true"/)
  assert.match(pending, /aria-pressed="false"/)
})
