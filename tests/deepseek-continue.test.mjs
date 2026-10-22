// User-run offline regression tests: the actual injected script runs in a VM with
// synthetic DOM nodes and timers. No Electron, browser session, network or shell.
// Run from the repository root: node --test tests/deepseek-continue.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const interceptorSource = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const platformSource = readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8')
const platformExports = {}
new Script(ts.transpileModule(platformSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({
  exports: platformExports,
  require(name) {
    assert.equal(name, './types')
    return { isConversationId() { throw new Error('Unexpected conversation validation') } }
  }
})
const { CHATGPT_PAGE, DEEPSEEK_PAGE } = platformExports

class ElementFixture {
  nodeType = 1
  isConnected = true
  parentElement = null
  position = 0
  rendered = true
  clicks = 0

  constructor(tag, attributes = {}, content = []) {
    this.tagName = tag.toUpperCase()
    this.attributes = attributes
    this.childNodes = (Array.isArray(content) ? content : [content]).map((child) =>
      typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child
    )
    for (const child of this.childNodes) child.parentElement = this
  }

  get className() { return this.attributes.class || '' }
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join('') }
  get innerText() { return this.textContent }
  getAttribute(name) { return this.attributes[name] ?? null }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) if (!node.rendered) return []
    return [{}]
  }
  compareDocumentPosition(other) { return this.position < other.position ? 4 : this.position > other.position ? 2 : 0 }
  dispatchEvent() { return true }
  click() { this.clicks += 1 }

  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()))
    if (/^[a-z]+$/i.test(selector)) return this.tagName.toLowerCase() === selector.toLowerCase()
    if (/^\.[\w-]+$/.test(selector)) return this.className.split(/\s+/).includes(selector.slice(1))
    const match = /^(\w+)?\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]$/.exec(selector)
    if (!match || (match[1] && this.tagName.toLowerCase() !== match[1])) return false
    const value = this.getAttribute(match[2])
    if (value === null) return false
    if (!match[3]) return true
    if (match[3] === '*=') return value.includes(match[4])
    if (match[3] === '^=') return value.startsWith(match[4])
    if (match[3] === '$=') return value.endsWith(match[4])
    return value === match[4]
  }

  descendants() {
    return this.childNodes.filter((child) => child.nodeType === 1).flatMap((child) => [child, ...child.descendants()])
  }

  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node
    return null
  }
  contains(other) { return this === other || this.descendants().includes(other) }
}

const element = (tag, attributes, content) => new ElementFixture(tag, attributes, content)
const continueButton = () => element('div', { role: 'button', class: 'ds-button' }, [element('span', {}, '继续生成')])
// A turn cut off while still thinking: reasoning only, no answer marker yet.
const cutOffTurn = (key, button) => element('div', { 'data-virtual-list-item-key': key }, [
  element('div', { class: 'ds-think-content' }, 'Now need to add CSS for the header.'),
  ...(button ? [button] : [])
])
const proseTurn = (key, text, button) => element('div', { 'data-virtual-list-item-key': key }, [
  element('div', { class: 'ds-assistant-message-main-content' }, text),
  ...(button ? [button] : [])
])
const userTurn = (key) => element('div', { 'data-virtual-list-item-key': key }, '【上一条命令执行结果】')

function fixture(nodes, page = DEEPSEEK_PAGE) {
  const events = []
  const timers = new Map()
  let timerSerial = 0
  let notifyMutation
  let now = 1_000_000
  const body = element('body', {}, nodes)
  const window = {}
  const refreshPositions = () => {
    ;[body, ...body.descendants()].forEach((node, index) => { node.position = index })
  }
  const document = {
    body,
    activeElement: null,
    addEventListener() {},
    querySelectorAll(selector) { refreshPositions(); return body.querySelectorAll(selector) },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  }
  class FakeDate extends Date {
    static now() { return now }
  }
  new Script(interceptorSource).runInNewContext({
    window, document, Date: FakeDate,
    location: { pathname: '/a/chat/s/offline-fixture' },
    Element: ElementFixture,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    MouseEvent: class { constructor(type) { this.type = type } },
    MutationObserver: class {
      constructor(callback) { notifyMutation = callback }
      observe() {}
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout(callback, delay) { const id = ++timerSerial; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    console: { log(line) { events.push(JSON.parse(line.slice('[cmd-terminal] '.length))) } }
  })
  const controller = window.__cmdTerminalInterceptor
  controller.configure({ enabled: true, page })
  return {
    controller, events,
    continues: () => events.filter((event) => event.event === 'continue-generation'),
    replaceNodes(next) {
      body.childNodes = next
      for (const node of next) node.parentElement = body
    },
    advance(ms) { now += ms },
    // Fire the timers of this delay that are pending now; ones they schedule wait for the next tick.
    tick(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue
        timers.delete(id)
        timer.callback()
      }
    },
    scan() {
      notifyMutation()
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 800) continue
        timers.delete(id)
        timer.callback()
      }
    }
  }
}

test('a DeepSeek reply cut off while thinking is resumed with 继续生成 during a live wait', () => {
  const button = continueButton()
  const app = fixture([userTurn('1'), cutOffTurn('2', button)])
  app.controller.checkNow()
  assert.equal(button.clicks, 1)
  assert.deepEqual(app.continues().map((event) => [event.reason, event.attempt]), [['continue-clicked', 1]])
  assert.notEqual(app.controller.status().awaitingReplySince, 0, 'the reply wait stays owned')
})

test('partial prose next to 继续生成 is not saved as the final answer', () => {
  const button = continueButton()
  const app = fixture([proseTurn('2', 'Now need to add CSS for the header.', button)])
  app.controller.checkNow()
  app.tick(250)
  assert.equal(button.clicks, 1)
  assert.equal(app.events.some((event) => event.event === 'assistant-message' || event.event === 'task-finished'), false)
  assert.notEqual(app.controller.status().awaitingReplySince, 0)
})

test('presses are spaced by the cooldown and capped, then the partial reply settles normally', () => {
  const button = continueButton()
  const app = fixture([proseTurn('2', '部分回答', button)])
  app.controller.checkNow()
  app.scan()
  assert.equal(button.clicks, 1, 'a scan inside the cooldown must not press again')
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    app.advance(5000)
    app.tick(5000)
    app.tick(800)
    assert.equal(button.clicks, attempt)
  }
  app.advance(5000)
  app.tick(5000)
  app.tick(800)
  assert.equal(button.clicks, 5)
  const last = app.continues().at(-1)
  assert.equal(last.reason, 'continue-limit')
  assert.equal(last.attempt, 5)
  app.tick(250)
  assert.equal(app.events.filter((event) => event.event === 'task-finished').length, 1)
})

test('history and older turns are never resumed', () => {
  const restored = continueButton()
  const app = fixture([cutOffTurn('2', restored)])
  app.controller.armBaseline()
  app.scan()
  assert.equal(restored.clicks, 0, 'not waiting for a reply of our own')

  const older = continueButton()
  const next = fixture([cutOffTurn('2', older), userTurn('3')])
  next.controller.checkNow()
  assert.equal(older.clicks, 0, 'the button belongs to a turn before the newest one')
  assert.equal(next.continues().length, 0)
})

test('a new reply wait gets a fresh press budget', () => {
  const button = continueButton()
  const app = fixture([proseTurn('2', '部分回答', button)])
  app.controller.checkNow()
  app.advance(1)
  app.controller.checkNow()
  assert.equal(button.clicks, 2)
  assert.deepEqual(app.continues().map((event) => event.attempt), [1, 1])
})

test('platforms without measured labels ignore look-alike buttons', () => {
  const button = continueButton()
  const reply = element('div', { 'data-chatgpt-selection-message-id': 'a1' }, [
    element('div', { 'data-markdown-text-style': 'assistant-message' }, '部分回答'), button
  ])
  const app = fixture([reply], CHATGPT_PAGE)
  app.controller.configure({ page: DEEPSEEK_PAGE })
  app.controller.configure({ page: CHATGPT_PAGE })
  app.controller.checkNow()
  assert.equal(button.clicks, 0)
})
