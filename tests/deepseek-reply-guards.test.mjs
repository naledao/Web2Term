// User-run offline regression tests: the actual injected script runs in a VM with
// synthetic DOM nodes and timers. No Electron, browser session, network or shell.
// Run from the repository root: node --test tests/deepseek-reply-guards.test.mjs
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
  // One 10px row per document position, so a reported point names exactly one element.
  getBoundingClientRect() { return { left: 0, top: this.position * 10, width: 10, height: 10 } }
  scrollIntoView() {}

  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()))
    // Child combinator and tag.class: enough for the shipped chart selectors.
    const child = selector.lastIndexOf(' > ')
    if (child !== -1) return this.matches(selector.slice(child + 3)) && !!this.parentElement?.matches(selector.slice(0, child))
    const tagClass = /^(\w+)\.([\w-]+)$/.exec(selector)
    if (tagClass) return this.tagName.toLowerCase() === tagClass[1] && this.className.split(/\s+/).includes(tagClass[2])
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
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null },
    elementFromPoint(_x, y) {
      refreshPositions()
      return cover || [body, ...body.descendants()].find((node) => node.position * 10 + 5 === y) || null
    }
  }
  let cover = null
  class FakeDate extends Date {
    static now() { return now }
  }
  new Script(interceptorSource).runInNewContext({
    window, document, Date: FakeDate,
    location: { pathname: '/a/chat/s/offline-fixture' },
    Element: ElementFixture,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    MutationObserver: class {
      constructor(callback) { notifyMutation = callback }
      observe() {}
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout(callback, delay) { const id = ++timerSerial; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    console: {
      log(line) {
        const event = JSON.parse(line.slice('[cmd-terminal] '.length))
        events.push(event)
        // Stand in for the main process: its trusted click lands on whatever is at the point.
        if (event.reason === 'continue-clicked') document.elementFromPoint(event.x, event.y).clicks += 1
      }
    }
  })
  const controller = window.__cmdTerminalInterceptor
  controller.configure({ enabled: true, page })
  return {
    controller, events,
    continues: () => events.filter((event) => event.event === 'continue-generation'),
    commands: () => events.filter((event) => event.event === 'command'),
    cover(element) { cover = element },
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

test('a covered button is not clicked through whatever covers it, but the reply stays unfinished', () => {
  const button = continueButton()
  const overlay = element('div', { class: 'overlay' })
  const app = fixture([proseTurn('2', '部分回答', button), overlay])
  app.cover(overlay)
  app.controller.checkNow()
  const reported = app.continues()
  assert.deepEqual(reported.map((event) => [event.reason, event.x]), [['continue-unreachable', undefined]])
  assert.equal(overlay.clicks, 0)
  assert.equal(button.clicks, 0)
  app.tick(250)
  assert.equal(app.events.some((event) => event.event === 'task-finished'), false)
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

const commandJson = (command) => JSON.stringify({ command, description: '替换头部图标', timeout_seconds: 30 })
const commandTurn = (key, text) => element('div', { 'data-virtual-list-item-key': key }, [
  element('div', { class: 'ds-assistant-message-main-content' }, text)
])

test('a reply that grows after its command was reported does not report the same command again', () => {
  const turn = commandTurn('2', commandJson('Get-Content a.txt'))
  const app = fixture([userTurn('1'), turn])
  app.controller.checkNow()
  assert.equal(app.commands().length, 1)
  // Same turn element, more text after the JSON: a new content hash, the same command.
  turn.childNodes[0].childNodes.push({ nodeType: 3, nodeValue: '\n命令已给出，等待结果。' })
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.ok(app.events.some((event) => event.reason === 'duplicate-command'))
})

test('a remounted row at the same position is still the same turn', () => {
  const app = fixture([userTurn('1'), commandTurn('2', commandJson('Get-Content a.txt'))])
  app.controller.checkNow()
  app.replaceNodes([userTurn('1'), commandTurn('2', commandJson('Get-Content a.txt') + '\n补充说明')])
  app.scan()
  assert.equal(app.commands().length, 1)
})

test('a different command in the grown reply, or the same command after a new send, still runs', () => {
  const turn = commandTurn('2', commandJson('Get-Content a.txt'))
  const app = fixture([userTurn('1'), turn])
  app.controller.checkNow()
  app.replaceNodes([userTurn('1'), commandTurn('2', commandJson('Get-Content b.txt'))])
  app.scan()
  assert.deepEqual(app.commands().map((event) => event.command), ['Get-Content a.txt', 'Get-Content b.txt'])

  app.advance(1)
  // A new wait (what a confirmed send does) starts a new reply, even on a recycled row.
  app.controller.checkNow()
  assert.equal(app.commands().length, 3)
})

test('a ChatGPT chart is saved as its title, data points and caption, not as its SVG text', () => {
  const chart = element('div', { 'data-testid': 'chatgpt-chart-content-reference' }, [
    element('section', { 'aria-label': '每日数值' }, [
      element('div', { role: 'img' }, [element('svg', {}, ['周一周二周三', '0510152025'])]),
      element('ul', { class: 'sr-only' }, [element('li', {}, '周一: 12'), element('li', {}, '周二: 18'), element('li', {}, '周三: 9')]),
      element('p', { class: 'line-clamp-2 text-xs' }, '数据来自用户输入')
    ]),
    element('button', { 'aria-label': '分享' }, '分享')
  ])
  const answer = element('div', { 'data-markdown-text-style': 'assistant-message' }, [
    element('p', {}, '下面是折线图：'), chart, element('p', {}, '周四最高。')
  ])
  const turn = element('div', { 'data-chatgpt-selection-message-id': 'msg-chart' }, [answer])
  const app = fixture([turn], CHATGPT_PAGE)
  app.controller.checkNow()
  app.tick(250)
  const saved = app.events.find((event) => event.event === 'assistant-message')
  assert.ok(saved, 'the finished reply is saved')
  assert.match(saved.text, /> 📊 \*\*每日数值\*\*/)
  assert.match(saved.text, /> - 周一: 12\n> - 周二: 18\n> - 周三: 9/)
  assert.match(saved.text, /> 数据来自用户输入/)
  assert.match(saved.text, /下面是折线图：[\s\S]*周四最高。/)
  assert.equal(/0510152025|周一周二周三|分享/.test(saved.text), false, 'axis ticks and buttons are not spelled out')
  // The focus view draws from the machine-readable marker that precedes the quote.
  const marker = /<!--focus-chart (\{[\s\S]*?\}) -->\n> 📊/.exec(saved.text)
  assert.ok(marker, 'marker sits directly before its quoted fallback')
  assert.deepEqual(JSON.parse(marker[1]), {
    title: '每日数值', caption: '数据来自用户输入', series: [{ name: '数值', unit: '' }],
    rows: [{ label: '周一', values: [12] }, { label: '周二', values: [18] }, { label: '周三', values: [9] }]
  })
})

test('chart data parses multi-series points, and any unparsable point leaves only the quoted list', () => {
  const chartTurn = (items) => element('div', { 'data-chatgpt-selection-message-id': 'msg-' + items.length }, [
    element('div', { 'data-markdown-text-style': 'assistant-message' }, [
      element('div', { 'data-testid': 'chatgpt-chart-content-reference' }, [
        element('h2', {}, 'CPU 与内存使用率'),
        element('section', { 'aria-label': '图表' }, [element('ul', { class: 'sr-only' }, items.map((item) => element('li', {}, item)))])
      ])
    ])
  ])
  const savedFor = (items) => {
    const app = fixture([chartTurn(items)], CHATGPT_PAGE)
    app.controller.checkNow()
    app.tick(250)
    return app.events.find((event) => event.event === 'assistant-message').text
  }
  const good = savedFor(['1: CPU 20%, 内存 50.9%', '2: CPU 25%, 内存 51.1%'])
  const data = JSON.parse(/<!--focus-chart (\{[\s\S]*?\}) -->/.exec(good)[1])
  assert.equal(data.title, 'CPU 与内存使用率', 'the card heading wins over the aria-label')
  assert.deepEqual(data.series, [{ name: 'CPU', unit: '%' }, { name: '内存', unit: '%' }])
  assert.deepEqual(data.rows[1], { label: '2', values: [25, 51.1] })
  for (const items of [['周一: 很高', '周二: 18'], ['1: CPU 20%', '2: GPU 25%'], ['只有一个: 1']]) {
    const text = savedFor(items)
    assert.equal(text.includes('focus-chart'), false, items.join(' | '))
    assert.match(text, /> 📊/)
  }
})

test('a chart whose only label is a type word ("图表 图表") gets no title of its own', () => {
  const turn = element('div', { 'data-chatgpt-selection-message-id': 'msg-generic' }, [
    element('div', { 'data-markdown-text-style': 'assistant-message' }, [
      element('h2', {}, '周一至周五数据折线图'),
      element('div', { 'data-testid': 'chatgpt-chart-content-reference' }, [
        element('section', { 'aria-label': '图表 图表' }, [element('ul', { class: 'sr-only' }, [element('li', {}, '周一: 12'), element('li', {}, '周二: 18')])])
      ])
    ])
  ])
  const app = fixture([turn], CHATGPT_PAGE)
  app.controller.checkNow()
  app.tick(250)
  const text = app.events.find((event) => event.event === 'assistant-message').text
  assert.equal(JSON.parse(/<!--focus-chart (\{[\s\S]*?\}) -->/.exec(text)[1]).title, '')
  assert.match(text, /## 周一至周五数据折线图/)
  assert.match(text, /> 📊 图表（可在原始视图中交互查看）/)
  assert.equal(text.includes('图表 图表'), false)
})
