// User-run only: node --test tests/focus-citation-hover.test.mjs
// Actual citation component with hook state and synthetic popover parts.
// No Electron, DOM input, real browser, application profile or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { test } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'

const compile = (source, fileName = 'module.ts') => ts.transpileModule(source, {
  fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText
const shared = {}
new Script(compile(readFileSync(new URL('../src/shared/focus-citations.ts', import.meta.url), 'utf8')))
  .runInNewContext({ exports: shared, URL })
const component = compile(readFileSync(new URL('../src/renderer/src/components/FocusCitationLink.tsx', import.meta.url), 'utf8') +
  '\nexport { CitationControl };', 'FocusCitationLink.tsx')
const Popover = Object.fromEntries(['Root', 'Trigger', 'Portal', 'Positioner', 'Popup', 'Close'].map(name => [name, 'popover-' + name.toLowerCase()]))
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements)
  return React.isValidElement(node) ? [node, ...elements(node.props.children)] : []
}
const source = title => ({ title, url: 'https://support.google.com/' + encodeURIComponent(title), site: 'support.google.com' })
const sources = [source('Free up storage on your Android device'), source('Clear your junk files')]
const ok = links => ({ outcome: 'ok', sources: links })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function fixture() {
  let cursor = 0, mounted = true, lateWrites = 0, pendingEffects = []
  const slots = [], calls = [], responses = [], exports = {}
  const hooks = {
    createContext: React.createContext, useContext: () => null,
    useRef(initial) { const at = cursor++; return (slots[at] ??= { value: { current: initial } }).value },
    useState(initial) {
      const at = cursor++, slot = slots[at] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slot.value, value => {
        if (!mounted) lateWrites++
        slot.value = typeof value === 'function' ? value(slot.value) : value
      }]
    },
    useEffect(callback, dependencies) {
      const at = cursor++, previous = slots[at]
      if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
        pendingEffects.push(() => { previous?.cleanup?.(); slots[at] = { dependencies, cleanup: callback() } })
      }
    }
  }
  const context = { owner: { sessionId: 'session-1', platformId: 'chatgpt', conversationId: 'chat-1' },
    ownerKey: 'session-1:chatgpt:chat-1', visible: true, containerRef: { current: { id: 'focus-container' } }, onOriginal() {} }
  new Script(component).runInNewContext({ exports, window: { api: {
    readFocusCitation(request) { calls.push(request); return new Promise(resolve => responses.push(resolve)) }
  } }, require(name) {
    if (name === 'react') return hooks
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === '@base-ui/react/popover') return { Popover }
    if (name === '@shared/focus-citations') return shared
    if (name.endsWith('.css')) return {}
    throw new Error('Unexpected citation dependency: ' + name)
  } })
  const data = { sourceMessageId: 'reply-1', index: 0, signature: '12345678', label: 'Google Play +1' }
  let tree
  const render = () => {
    cursor = 0; pendingEffects = []
    tree = exports.CitationControl({ data, context })
    for (const run of pendingEffects) run()
    return tree
  }
  const part = name => elements(tree).find(node => node.type === Popover[name])
  render()
  return { context, calls, responses, render, part,
    open(reason = 'trigger-hover') { part('Root').props.onOpenChange(true, { reason }); render() },
    close(reason = 'trigger-hover') { part('Root').props.onOpenChange(false, { reason }); render() },
    links: () => elements(tree).filter(node => node.type === 'a'),
    loading: () => elements(tree).some(node => node.props.role === 'status'),
    lateWrites: () => lateWrites,
    unmount() { for (const slot of slots) slot?.cleanup?.(); mounted = false }
  }
}

test('the source trigger uses the library hover interaction and the same root as its popup', () => {
  const f = fixture(), trigger = f.part('Trigger').props
  assert.equal(trigger.openOnHover, true)
  assert.equal(trigger.delay, 200)
  assert.equal(trigger.closeDelay, 300)
  assert.equal(f.calls.length, 0, 'rendering and passing an unopened trigger never read the native page')
  assert.equal(f.part('Root').props.modal, false)
  assert.equal(f.part('Portal').props.container, f.context.containerRef)
  assert.equal(f.part('Positioner').props.collisionBoundary, f.context.containerRef.current)
  assert.equal(f.part('Positioner').props.side, 'bottom')
  assert.equal(f.part('Positioner').props.collisionAvoidance.side, 'flip')
  assert.ok(f.part('Close'), 'the popup keeps the native close/keyboard interaction')
})

test('hover and click share one in-flight read, including leaving and re-entering before completion', async () => {
  const f = fixture()
  f.open(); f.open('trigger-press')
  assert.equal(f.calls.length, 1)
  assert.equal(f.loading(), true)
  assert.equal(f.calls[0].conversationId, 'chat-1')
  assert.equal(f.calls[0].sourceMessageId, 'reply-1')
  f.close(); f.open()
  assert.equal(f.calls.length, 1)
  assert.equal(f.loading(), true)
  f.responses[0](ok(sources)); await flush(); f.render()
  assert.equal(f.loading(), false)
  assert.deepEqual(f.links().map(node => node.props.href), sources.map(item => item.url))
  assert.ok(f.links().every(node => node.props.target === '_blank' && node.props.rel === 'noopener noreferrer'))
})

test('closing during a read caches its result for the next hover without reopening the popup', async () => {
  const f = fixture()
  f.open(); f.close('escape-key')
  f.responses[0](ok(sources)); await flush(); f.render()
  assert.equal(f.part('Root').props.open, false)
  f.open()
  assert.equal(f.part('Root').props.open, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.links().length, 2)
  f.close('outside-press')
  assert.equal(f.part('Root').props.open, false)
})

test('hiding the view revokes old results, and an old completion cannot clear a newer loading state', async () => {
  const f = fixture()
  f.open()
  f.context.visible = false; f.render()
  assert.equal(f.part('Root').props.open, false)
  assert.equal(f.part('Popup').props.finalFocus(), false)
  f.context.visible = true; f.render(); f.open()
  assert.equal(f.calls.length, 2)
  f.responses[0](ok([source('旧来源')])); await flush(); f.render()
  assert.equal(f.loading(), true)
  assert.equal(f.links().length, 0)
  f.responses[1](ok(sources)); await flush(); f.render()
  assert.equal(f.loading(), false)
  assert.deepEqual(f.links().map(node => node.props.href), sources.map(item => item.url))
})

test('failed reads can retry on the next deliberate open, and unmount prevents late state writes', async () => {
  const f = fixture()
  f.open('trigger-press')
  f.responses[0]({ outcome: 'unavailable', sources: [] }); await flush(); f.render()
  assert.equal(f.loading(), false)
  f.close(); f.open()
  assert.equal(f.calls.length, 2)
  f.unmount()
  f.responses[1](ok(sources)); await flush()
  assert.equal(f.lateWrites(), 0)
})
