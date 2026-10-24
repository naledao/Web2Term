// User-run only: node --test tests/deepseek-mode-probe.test.mjs
// Compile the actual browser reader against synthetic DOM; never load Electron.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const path = new URL('../tools/diag/deepseek-composer-modes-probe.cjs', import.meta.url)
const file = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const fn = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'inspectModes')
assert.ok(fn)
class Element {
  constructor(tag, text = '', attrs = {}, children = []) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.text = text; this.attrs = attrs; this.children = children
    this.className = attrs.class ?? ''; this.visible = true
    this.style = { visibility: 'visible', color: 'rgb(13, 13, 13)', backgroundColor: 'transparent' }
    for (const child of children) child.parentElement = this
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join('') }
  getAttribute(name) { return this.attrs[name] ?? null }
  getClientRects() { return this.visible ? [{}] : [] }
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim()
      if (part.startsWith('.')) return this.className.split(/\s+/).includes(part.slice(1))
      if (part === '[role="button"]') return this.attrs.role === 'button'
      if (part.startsWith('[')) return this.attrs[part.slice(1, -1)] !== undefined
      if (part === 'textarea[placeholder]') return this.tagName === 'TEXTAREA' && this.attrs.placeholder !== undefined
      return this.tagName.toLowerCase() === part
    })
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
}
function fixture(semantic = true) {
  const input = new Element('textarea', '', { placeholder: '输入消息' }); input.value = 'PRIVATE-DRAFT'
  const attachment = new Element('div', '', { role: 'button', class: 'ds-button' })
  const send = new Element('div', '', { role: 'button', class: 'ds-button ds-button--primary' })
  const inner = new Element('div', '', { class: 'inner-composer' }, [input, attachment, send])
  const mode = label => semantic ? new Element('div', label, { role: 'button', class: 'ds-button native-mode' }) :
    new Element('div', '', { class: 'new-mode-wrapper' }, [new Element('span', label)])
  const thinking = mode('深度思考'), search = mode('智能搜索')
  const modes = new Element('div', '', { class: 'mode-region' }, [thinking, search])
  const outer = new Element('div', '', { class: 'outer-composer' }, [inner, modes])
  const body = new Element('body', '', {}, [new Element('p', 'PRIVATE-MESSAGE'), outer])
  const listeners = [], output = [], window = {}
  const document = { body, querySelectorAll: selector => body.querySelectorAll(selector),
    addEventListener: (type, listener) => { if (type === 'click') listeners.push(listener) } }
  const context = createContext({ document, window, getComputedStyle: node => node.style, console: { log: text => output.push(text) } })
  const read = new Script('(' + fn.getText(file) + ')').runInContext(context)
  const config = { key: '__probeTest', tag: 'test-mode:' }
  return { read: () => read(config), listeners, output, thinking, modes, outer, body }
}

test('probe includes mode siblings beyond the inner attachment/send toolbar and omits message/draft text', () => {
  const f = fixture(), snapshot = f.read()
  assert.equal(snapshot.ready, true)
  assert.equal(snapshot.toolbar, true)
  assert.equal(snapshot.scopes[0].controlCount, 2, 'the known failed-log inner scope is reproduced')
  assert.equal(snapshot.scopes[0].modeIds.length, 0)
  assert.deepEqual(Array.from(snapshot.namedControls, node => node.id), ['thinking', 'search'])
  assert.ok(snapshot.namedControls.every(node => node.inComposerScope))
  const serialized = JSON.stringify(snapshot)
  assert.equal(serialized.includes('PRIVATE-DRAFT'), false)
  assert.equal(serialized.includes('PRIVATE-MESSAGE'), false)
})

test('probe discovers label leaves and ancestors when switches have no semantic button role', () => {
  const snapshot = fixture(false).read()
  assert.deepEqual(Array.from(snapshot.namedControls, node => node.id), ['thinking', 'search'])
  assert.ok(snapshot.namedControls.every(node => node.discovery === 'label-leaf'))
  assert.ok(snapshot.namedControls[0].ancestors.some(node => node.classes === 'new-mode-wrapper'))
})

test('one read-only click listener records trusted mode clicks without menu marks', () => {
  const f = fixture(); f.read(); f.read()
  assert.equal(f.listeners.length, 1, 'polling must not duplicate event listeners')
  const event = { isTrusted: true, composedPath: () => [f.thinking, f.modes, f.outer, f.body] }
  f.listeners[0]({ ...event, isTrusted: false })
  assert.equal(f.output.length, 0)
  f.listeners[0](event)
  assert.equal(f.output.length, 1)
  const data = JSON.parse(f.output[0].slice('test-mode:'.length))
  assert.equal(data.id, 'thinking'); assert.equal(data.trusted, true)
  assert.equal(data.target.label, '深度思考')
})
