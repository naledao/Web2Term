// User-run offline regression tests: the actual injected script runs in a VM with
// synthetic DOM nodes and timers. No Electron, browser session, network or shell.
// Run from the repository root: node --test tests/deepseek-reply-guards.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const interceptorSource = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
// Test-only access to confirmed-send reporting. The shipped script has no test hook.
const fixtureHook = 'window[STATE_KEY] = {'
assert.equal(interceptorSource.split(fixtureHook).length, 2)
const instrumentedInterceptor = interceptorSource.replace(fixtureHook,
  'window.__replyGuardFixture = { report, setReplyWaiting, state };\n' + fixtureHook)
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
// Keep coverage of the generic resume fallback for adapters without native edit recovery.
const LEGACY_CONTINUE_PAGE = { ...DEEPSEEK_PAGE, nativeEdit: null }

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
  const location = { pathname: '/a/chat/s/offline-fixture' }
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
  new Script(instrumentedInterceptor).runInNewContext({
    window, document, Date: FakeDate,
    location,
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
    navigate(path) { location.pathname = path },
    confirmSend() {
      window.__replyGuardFixture.state.taskActive = true
      window.__replyGuardFixture.state.replyActionDetected = false
      window.__replyGuardFixture.setReplyWaiting(++now, 'user-sent')
      window.__replyGuardFixture.report({ event: 'user-message', text: '启动这个项目' })
      return events.filter(event => event.event === 'user-message').at(-1).submissionId
    },
    confirmResult() {
      window.__replyGuardFixture.state.replyActionDetected = false
      window.__replyGuardFixture.setReplyWaiting(++now, 'result-sent')
    },
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

test('an adapter without native edit recovery resumes a cut-off reply with its measured button', () => {
  const button = continueButton()
  const app = fixture([userTurn('1'), cutOffTurn('2', button)], LEGACY_CONTINUE_PAGE)
  app.controller.checkNow()
  assert.equal(button.clicks, 1)
  assert.deepEqual(app.continues().map((event) => [event.reason, event.attempt]), [['continue-clicked', 1]])
  assert.notEqual(app.controller.status().awaitingReplySince, 0, 'the reply wait stays owned')
})

test('partial prose next to 继续生成 is not saved as the final answer', () => {
  const button = continueButton()
  const app = fixture([proseTurn('2', 'Now need to add CSS for the header.', button)], LEGACY_CONTINUE_PAGE)
  app.controller.checkNow()
  app.tick(250)
  assert.equal(button.clicks, 1)
  assert.equal(app.events.some((event) => event.event === 'assistant-message' || event.event === 'task-finished'), false)
  assert.notEqual(app.controller.status().awaitingReplySince, 0)
})

test('presses are spaced by the cooldown and capped, then the partial reply settles normally', () => {
  const button = continueButton()
  const app = fixture([proseTurn('2', '部分回答', button)], LEGACY_CONTINUE_PAGE)
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
  const app = fixture([proseTurn('2', '部分回答', button), overlay], LEGACY_CONTINUE_PAGE)
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
  const app = fixture([proseTurn('2', '部分回答', button)], LEGACY_CONTINUE_PAGE)
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
const commandCodeTurn = (key, text) => element('div', { 'data-virtual-list-item-key': key }, [
  element('div', { class: 'ds-assistant-message-main-content' }, [element('pre', {}, [element('code', {}, text)])])
])

test('a raw analysis recap is intercepted before quoted commands or placeholders can execute', async () => {
  for (const command of ['...', 'echo old-command']) {
    const app = fixture([userTurn('1')])
    app.confirmSend()
    app.replaceNodes([userTurn('1'), proseTurn('2', '<analysis> 让我按时间顺序梳理整个对话：\n' + commandJson(command))])
    app.scan()
    assert.equal(app.commands().length, 0)
    app.tick(250)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    assert.ok(app.events.some(event => event.reason === 'analysis-leak-detected'))
    assert.equal(app.commands().length, 0)
    assert.equal(app.events.some(event => event.event === 'parse-failed'), false)
  }
})

test('analysis tags in restored history, reasoning panels and explicit code examples do not resend', () => {
  const restored = fixture([userTurn('1'), proseTurn('2', '<analysis> 旧对话回顾')])
  restored.controller.armBaseline()
  restored.scan(); restored.tick(250)
  assert.equal(restored.events.some(event => event.reason === 'analysis-leak-detected'), false)

  const example = fixture([userTurn('1')])
  example.confirmSend()
  example.replaceNodes([userTurn('1'), commandCodeTurn('2', '<analysis>标签示例</analysis>')])
  example.scan(); example.tick(250)
  assert.equal(example.events.some(event => event.reason === 'analysis-leak-detected'), false)

  const thought = fixture([userTurn('1')])
  thought.confirmSend()
  thought.replaceNodes([userTurn('1'), element('div', { 'data-virtual-list-item-key': '2' }, [
    element('div', { class: 'ds-think-content' }, '<analysis> 正常思考内容'),
    element('div', { class: 'ds-assistant-message-main-content' }, '正常回答')
  ])])
  thought.scan(); thought.tick(250)
  assert.equal(thought.events.some(event => event.reason === 'analysis-leak-detected'), false)
})

test('analysis recovery waits for stable text and is cancelled by task or conversation changes', () => {
  for (const change of ['text', 'stop', 'route', 'generation']) {
    const app = fixture([userTurn('1')])
    app.confirmSend()
    app.replaceNodes([userTurn('1'), proseTurn('2', '<analysis> 尚未稳定的回复')])
    app.scan()
    if (change === 'text') app.replaceNodes([userTurn('1'), proseTurn('2', '已纠正的正常回答')])
    if (change === 'stop') app.controller.endTask()
    if (change === 'route') app.navigate('/a/chat/s/another-chat')
    if (change === 'generation') app.controller.configure({ taskPromptGeneration: 1 })
    app.tick(250)
    assert.equal(app.events.some(event => event.reason === 'analysis-leak-detected'), false, change)
  }
})

test('a streaming JSON fragment is rechecked before format feedback is sent', () => {
  const app = fixture([userTurn('1')])
  app.confirmSend()
  app.replaceNodes([userTurn('1'), commandCodeTurn('2', '{"command":"cat /etc/letsencrypt/')])
  app.scan()
  assert.equal(app.events.some(event => event.event === 'parse-failed'), false)
  assert.notEqual(app.controller.status().awaitingReplySince, 0)
  // Markdown finishes rendering before the delayed failure confirmation.
  app.replaceNodes([userTurn('1'), commandCodeTurn('2', commandJson('cat /etc/letsencrypt/renewal/example.conf'))])
  app.tick(1000)
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].live, true)
  assert.equal(app.events.some(event => event.event === 'parse-failed'), false)
  assert.equal(app.controller.status().commandRecoveryUsed, false)
})

test('a corrected reply that grows after a second format failure remains live and is reported once', async () => {
  const app = fixture([userTurn('1')])
  app.confirmSend()
  app.replaceNodes([userTurn('1'), commandCodeTurn('2', '{"command":"uname -a","background":"true"}')])
  app.scan()
  app.tick(1000)
  const original = app.controller.status().failedCommand
  const sent = stubSends(app)
  assert.equal(await app.controller.recoverCommand(original.token, original.generation, true), 'ok')
  app.confirmResult()
  app.replaceNodes([userTurn('1'), commandCodeTurn('3', '{"command":"cat /etc/letsencrypt/')])
  app.scan()
  app.tick(1000)
  const second = app.controller.status().failedCommand
  assert.equal(second.status, 'failed')
  assert.equal(app.controller.status().awaitingReplySince, 0)
  const json = commandJson('cat /etc/letsencrypt/renewal/example.conf')
  // A remounted row and a changed content hash still belong to this failed reply.
  app.replaceNodes([userTurn('1'), commandCodeTurn('3', json)])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].live, true)
  assert.equal(app.controller.status().failedCommand, null)
  assert.equal(app.controller.status().commandRecoveryUsed, false)
  assert.ok(app.events.some(event => event.reason === 'command-format-resolved'))
  app.replaceNodes([userTurn('1'), commandCodeTurn('3', json + '\n等待结果')])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(sent.length, 1, 'no additional correction is sent after the valid command')
})

test('failure ownership cannot promote history, another row, another route or a stopped task to live', () => {
  for (const change of ['history', 'row', 'route', 'stop', 'generation']) {
    const app = fixture([userTurn('1')])
    app.confirmSend()
    app.replaceNodes([userTurn('1'), commandCodeTurn('2', '{"command":"uname')])
    app.scan()
    app.tick(1000)
    assert.ok(app.controller.status().failedCommand)
    if (change === 'history') app.controller.armBaseline()
    if (change === 'route') app.navigate('/a/chat/s/another-chat')
    if (change === 'stop') app.controller.endTask()
    if (change === 'generation') app.controller.configure({ taskPromptGeneration: 1 })
    app.replaceNodes([userTurn('1'), commandCodeTurn(change === 'row' ? '3' : '2', commandJson('uname -a'))])
    app.scan()
    assert.equal(app.commands().some(event => event.live), false, change)
  }
})

test('a file request that finishes rendering after a format failure also resolves the live wait', () => {
  const app = fixture([userTurn('1')])
  app.confirmSend()
  app.replaceNodes([userTurn('1'), proseTurn('2', '{"type":"read_files","files":[')])
  app.scan()
  app.tick(1000)
  assert.equal(app.controller.status().failedCommand.parseErrorCode, 'invalid-read-files')
  app.replaceNodes([userTurn('1'), proseTurn('2', JSON.stringify({ type: 'read_files',
    files: [{ path: '/var/log/example.log' }], description: '读取日志' }))])
  app.scan()
  const reads = app.events.filter(event => event.event === 'read-files')
  assert.equal(reads.length, 1)
  assert.equal(reads[0].live, true)
  assert.equal(app.controller.status().failedCommand, null)
})

test('delayed format errors are discarded after a task is stopped or its conversation changes', () => {
  for (const change of ['stop', 'route', 'generation']) {
    const app = fixture([userTurn('1')])
    app.confirmSend()
    app.replaceNodes([userTurn('1'), commandCodeTurn('2', '{"command":"uname')])
    app.scan()
    if (change === 'stop') app.controller.endTask()
    if (change === 'route') app.navigate('/a/chat/s/another-chat')
    if (change === 'generation') app.controller.configure({ taskPromptGeneration: 1 })
    app.tick(1000)
    assert.equal(app.events.some(event => event.event === 'parse-failed'), false, change)
  }
})

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
    title: '每日数值', caption: '数据来自用户输入', kind: 'table', series: [{ name: '数值', unit: '' }],
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
  for (const items of [['周一: 很高', '周二: 18'], ['1: CPU 20%', '2: GPU 25%'], ['1: CPU 20%', '2: CPU 25ms']]) {
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

test('ChatGPT categorical bars retain their kind, DIL title, caption and exact values', () => {
  const values = [.9684, .965, .966, 1.7572]
  const labels = ['零差分', '全局均值', '细胞均值', '同药同条件跨板均值']
  const native = element('g', { class: 'recharts-bar' }, values.map((value, index) =>
    element('path', { class: 'recharts-rectangle', x: String(index * 100), y: String(200 - value * 100), height: String(value * 100) })))
  const chart = element('div', { 'data-testid': 'chatgpt-chart-content-reference' }, [
    element('span', { 'data-d-component': 'Text', 'data-d-default-strong': '' }, '跨实验板已知药物条件评价'),
    element('section', { 'aria-label': '图表 图表' }, [element('svg', {}, [native]),
      element('ul', { class: 'sr-only' }, labels.map((label, index) => element('li', {}, `${label}: ${values[index]}`))),
      element('p', { class: 'line-clamp-2' }, '原尺度 MSE，越低越好；并非 drug-blind 测试。')])
  ])
  const turn = element('div', { 'data-chatgpt-selection-message-id': 'bars' }, [
    element('div', { 'data-markdown-text-style': 'assistant-message' }, [chart])])
  const read = () => {
    const app = fixture([turn], CHATGPT_PAGE)
    app.controller.checkNow(); app.tick(250)
    return JSON.parse(/<!--focus-chart (\{[^\n]*\}) -->/.exec(app.events.find(event => event.event === 'assistant-message').text)[1])
  }
  const data = read()
  assert.equal(data.kind, 'bar')
  assert.equal(data.title, '跨实验板已知药物条件评价')
  assert.match(data.caption, /drug-blind/)
  assert.deepEqual(data.rows, labels.map((label, index) => ({ label, values: [values[index]] })))
  // Mixed charts and horizontal bars cannot be relabelled as vertical bars or lines.
  native.childNodes.push(element('g', { class: 'recharts-line' }))
  assert.equal(read().kind, 'table')
  native.childNodes.pop()
  for (const node of native.childNodes) node.attributes.x = '0'
  assert.equal(read().kind, 'table')
  native.attributes.class = 'recharts-line'
  assert.equal(read().kind, 'line')
})

// DeepSeek's native tool-call markup, as its page renders it: the bars come out as `| |`
// with spaces, the wrapper loses its `function_` prefix, and Windows paths are unescaped.
const dsmlTurn = (key, lines) => element('div', { 'data-virtual-list-item-key': key }, [
  element('div', { class: 'ds-assistant-message-main-content' }, lines.map((line) => element('p', {}, line)))
])

const stubSends = (app) => {
  const sent = []
  app.controller.sendRaw = async (text) => { sent.push(text); return 'ok' }
  return sent
}
const dsmlCall = (tool, parameters, marker = ' | | DSML | | ', tag = 'invoke', wrapper = 'calls') => [
  '<' + marker + wrapper + '>',
  '<' + marker + tag + ' name="' + tool + '">',
  ...parameters.map(([name, string, value]) => '<' + marker + 'parameter name="' + name + '" string="' + string + '">' + value + '</' + marker + 'parameter>'),
  '</' + marker + tag + '>',
  '</' + marker + wrapper + '>'
]
const dsmlPromptRead = (...args) => dsmlCall('read_tool_prompt', ...args)

test('a live DSML tool-prompt read reaches the existing definition reader once and stays out of focus prose', () => {
  for (const marker of [' | | DSML | | ', '｜DSML｜', '｜｜DSML｜｜']) {
    for (const tag of ['invoke', 'invocation']) {
      for (const wrapper of ['calls', 'function_calls']) {
        const app = fixture([userTurn('1')])
        const sourceSubmissionId = app.confirmSend()
        app.replaceNodes([userTurn('1'), dsmlTurn('2', [
          '服务已启动。验证一下首页响应。',
          ...dsmlPromptRead([['tools', 'false', '["background_task","read_files"]']], marker, tag, wrapper)
        ])])
        app.scan()
        app.tick(250)
        app.scan()
        const reads = app.events.filter(event => event.event === 'tool-prompt-read')
        assert.equal(reads.length, 1, `${marker} ${tag} ${wrapper}`)
        assert.deepEqual(JSON.parse(reads[0].rawJson), { type: 'read_tool_prompt', tools: ['background_task', 'read_files'] })
        assert.equal(reads[0].sourceSubmissionId, sourceSubmissionId)
        assert.equal(reads[0].pagePath, '/a/chat/s/offline-fixture')
        assert.equal(reads[0].live, true)
        assert.equal(app.controller.status().awaitingReplySince, 0)
        assert.equal(app.controller.focusSnapshot().reply.answer, '')
        assert.equal(app.events.some(event => ['command', 'read-files', 'question', 'assistant-message', 'task-finished', 'parse-failed'].includes(event.event)), false)
      }
    }
  }
})

test('malformed DSML tool-prompt parameters still reach the reader for its format correction', () => {
  for (const [parameters, expected] of [
    [[], { type: 'read_tool_prompt' }],
    [[['tools', 'false', '[]']], { type: 'read_tool_prompt', tools: [] }],
    [[['tools', 'false', '["unknown_tool"]']], { type: 'read_tool_prompt', tools: ['unknown_tool'] }],
    [[['tools', 'true', '["background_task"]']], { type: 'read_tool_prompt', tools: '["background_task"]' }]
  ]) {
    const app = fixture([userTurn('1')])
    app.confirmSend()
    app.replaceNodes([userTurn('1'), dsmlTurn('2', dsmlPromptRead(parameters))])
    app.scan()
    app.tick(250)
    const reads = app.events.filter(event => event.event === 'tool-prompt-read')
    assert.equal(reads.length, 1)
    assert.deepEqual(JSON.parse(reads[0].rawJson), expected)
    assert.equal(app.events.some(event => ['command', 'read-files', 'assistant-message', 'task-finished'].includes(event.event)), false)
  }
})

test('DSML tool-prompt reads in history or with automatic execution disabled do not request definitions', () => {
  const reply = () => dsmlTurn('2', dsmlPromptRead([['tools', 'false', '["background_task"]']]))
  const history = fixture([userTurn('1'), reply()])
  history.scan()
  history.tick(250)
  assert.equal(history.events.some(event => event.event === 'tool-prompt-read'), false)
  assert.equal(history.controller.focusSnapshot().reply.answer, '')

  const disabled = fixture([userTurn('1')])
  disabled.confirmSend()
  disabled.controller.configure({ enabled: false })
  disabled.replaceNodes([userTurn('1'), reply()])
  disabled.scan()
  disabled.tick(250)
  assert.equal(disabled.events.some(event => event.event === 'tool-prompt-read'), false)
})

test('a DSML read_files call from the DeepSeek page becomes a read_files request', () => {
  const app = fixture([userTurn('1'), dsmlTurn('2', [
    '< | | DSML | | calls>',
    '< | | DSML | | invoke name="read_files">',
    '< | | DSML | | parameter name="files" string="false">[{"path": "C:\Users\ksdy\qq_typed3.png"}]</ | | DSML | | parameter>',
    '< | | DSML | | parameter name="description" string="true">查看第三次粘贴后的QQ窗口截图</ | | DSML | | parameter>',
    '</ | | DSML | | invoke>',
    '</ | | DSML | | calls>'
  ])])
  app.controller.checkNow()
  const reads = app.events.filter((event) => event.event === 'read-files')
  assert.equal(reads.length, 1)
  assert.deepEqual(reads[0].files, [{ path: 'C:\Users\ksdy\qq_typed3.png' }])
  assert.equal(reads[0].description, '查看第三次粘贴后的QQ窗口截图')
  assert.equal(app.events.some((event) => event.event === 'parse-failed'), false)
})

const backgroundLogPaths = [
  String.raw`C:\Users\24196\AppData\Local\Temp\w2t-background-job\stdout.log`,
  String.raw`C:\Users\24196\AppData\Local\Temp\w2t-background-job\stderr.log`
]

test('DSML read_files accepts the native paths list and a missing description without changing Windows paths', () => {
  for (const marker of [' | | DSML | | ', '｜DSML｜']) {
    for (const field of ['paths', 'files']) {
      const app = fixture([userTurn('1')])
      app.confirmSend()
      // Match the screenshot's unescaped Windows path strings, including the JSON-looking array.
      const raw = field === 'paths' ? '[' + backgroundLogPaths.map(path => '"' + path + '"').join(',') + ']'
        : JSON.stringify(backgroundLogPaths.map(path => ({ path })))
      app.replaceNodes([userTurn('1'), dsmlTurn('2', dsmlCall('read_files', [[field, 'false', raw]], marker))])
      app.scan()
      app.scan()
      const reads = app.events.filter(event => event.event === 'read-files')
      assert.equal(reads.length, 1, marker + field)
      assert.deepEqual(reads[0].files, backgroundLogPaths.map(path => ({ path })))
      assert.equal(reads[0].description, '读取指定文件')
      assert.equal(reads[0].live, true)
      assert.equal(app.controller.focusSnapshot().reply.answer, '')
      assert.equal(app.events.some(event => ['command', 'parse-failed', 'assistant-message', 'task-finished'].includes(event.event)), false)
    }
  }
})

test('invalid or ambiguous DSML file lists retain file validation and produce one recoverable failure', () => {
  const invalid = [
    [['paths', 'false', '[]']],
    [['paths', 'false', JSON.stringify(['a.log', 'b.log', 'c.log', 'd.log'])]],
    [['paths', 'false', JSON.stringify([null])]],
    [['paths', 'false', JSON.stringify(['   '])]],
    [['paths', 'false', JSON.stringify(['a\u0000.log'])]],
    [['paths', 'false', JSON.stringify(['a'.repeat(4097)])]],
    [['paths', 'false', '["a.log"]'], ['files', 'false', '[{"path":"b.log"}]']],
    [['files', 'false', '[{"path":"a.log"}]'], ['description', 'true', '']]
  ]
  for (const parameters of invalid) {
    const app = fixture([userTurn('1')])
    app.confirmSend()
    app.replaceNodes([userTurn('1'), dsmlTurn('2', dsmlCall('read_files', parameters))])
    app.scan()
    app.scan()
    app.tick(1000)
    const failures = app.events.filter(event => event.event === 'parse-failed')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].reason, 'invalid-read-files')
    assert.equal(failures[0].parseErrorCode, 'invalid-read-files')
    assert.equal(failures[0].live, true)
    assert.equal(failures[0].parseFailureToken, app.controller.status().failedCommand.token)
    assert.equal(app.controller.status().awaitingReplySince, 0)
    assert.equal(app.events.some(event => ['read-files', 'command', 'assistant-message', 'task-finished'].includes(event.event)), false)
  }
})

test('invalid file requests get a file-specific correction and a corrected reply can continue normally', async () => {
  const app = fixture([userTurn('1')])
  app.confirmSend()
  app.replaceNodes([userTurn('1'), proseTurn('2', '{"type":"read_files","paths":["stdout.log"]}')])
  app.scan()
  app.tick(1000)
  const failure = app.controller.status().failedCommand
  const sent = stubSends(app)
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true), 'ok')
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^【文件读取请求格式错误：未执行】/)
  assert.match(sent[0], /"files":\[\{"path":/)
  assert.match(sent[0], /"description":/)
  assert.match(sent[0], /不要重新执行已完成的命令/)
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true), 'stale')
  app.confirmResult()
  app.replaceNodes([userTurn('1'), proseTurn('3', JSON.stringify({ type: 'read_files', files: [{ path: 'stdout.log' }], description: '检查后台任务输出' }))])
  app.scan()
  assert.equal(app.events.filter(event => event.event === 'read-files').length, 1)
  assert.equal(app.controller.status().failedCommand, null)
  assert.equal(app.controller.status().commandRecoveryUsed, false)
})

test('file format recovery respects the automatic retry budget and inactive history', async () => {
  const app = fixture([userTurn('1')])
  app.confirmSend()
  app.replaceNodes([userTurn('1'), dsmlTurn('2', dsmlCall('read_files', [['paths', 'false', '[]']]))])
  app.scan()
  app.tick(1000)
  const sent = stubSends(app)
  let failure = app.controller.status().failedCommand
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, false), 'busy')
  assert.deepEqual(sent, [])
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true), 'ok')
  app.confirmResult()
  app.replaceNodes([userTurn('1'), dsmlTurn('3', dsmlCall('read_files', [['files', 'false', '[]']]))])
  app.scan()
  app.tick(1000)
  failure = app.controller.status().failedCommand
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true), 'limit')
  assert.equal(sent.length, 1)

  const history = fixture([userTurn('1'), dsmlTurn('2', dsmlCall('read_files', [['paths', 'false', '[]']]))])
  history.scan()
  history.tick(1000)
  assert.equal(history.controller.status().failedCommand, null)
  assert.equal(history.events.find(event => event.event === 'parse-failed').live, false)
})

test('a canonical DSML command call runs as a command with its typed parameters', () => {
  const app = fixture([userTurn('1'), dsmlTurn('2', [
    '<｜DSML｜function_calls>',
    '<｜DSML｜invoke name="command">',
    '<｜DSML｜parameter name="command" string="true">Get-ChildItem "C:\Users\ksdy"</｜DSML｜parameter>',
    '<｜DSML｜parameter name="description" string="true">列出目录</｜DSML｜parameter>',
    '<｜DSML｜parameter name="timeout_seconds" string="false">30</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜function_calls>'
  ])])
  app.controller.checkNow()
  assert.deepEqual(app.commands().map((event) => [event.command, event.description, event.timeoutSeconds]),
    [['Get-ChildItem "C:\Users\ksdy"', '列出目录', 30]])
})

test('a DSML call to an unknown tool is not turned into a request', () => {
  const app = fixture([userTurn('1'), dsmlTurn('2', [
    '<｜DSML｜function_calls>',
    '<｜DSML｜invoke name="web_search">',
    '<｜DSML｜parameter name="query" string="true">天气</｜DSML｜parameter>',
    '</｜DSML｜invoke>',
    '</｜DSML｜function_calls>'
  ])])
  app.controller.checkNow()
  assert.equal(app.events.some((event) => ['command', 'read-files', 'question'].includes(event.event)), false)
})

// DeepSeek ended a reply by itself mid-thinking: the reasoning header reads 已停止, no answer, no 继续生成.
const stoppedTurn = (key) => element('div', { 'data-virtual-list-item-key': key }, [
  element('div', { class: 'ds-think-header' }, [element('span', {}, '已停止')]),
  element('div', { class: 'ds-think-content' }, 'Actually, let me just try press_key with Ctrl+F to see if it works.')
])
// The first scan only marks the turn; the settle timer rescans it.
const settleStopped = (app) => { app.advance(4000); app.tick(4000); app.tick(800) }

test('DeepSeek interruptions use edit recovery and never press Continue or send a continuation message', () => {
  for (const reasoningOnly of [false, true]) {
    const button = continueButton()
    const reply = reasoningOnly ? stoppedTurn('2') : proseTurn('2', '未完成的回顾：' + commandJson('echo should-not-run'), button)
    const app = fixture([userTurn('1'), reply])
    const sent = stubSends(app)
    app.controller.checkNow()
    assert.equal(app.events.some(event => event.reason === 'stopped-retry-detected'), false, 'wait until the stopped reply is stable')
    settleStopped(app)
    assert.ok(app.events.some(event => event.reason === 'stopped-retry-detected'))
    assert.ok(app.events.some(event => event.reason === 'stopped-retry-failed' && event.step === 'edit-button'), 'the user row is selected even before an assistant answer marker exists')
    assert.equal(button.clicks, 0)
    assert.deepEqual(sent, [])
    assert.equal(app.commands().length, 0)
    app.scan() // Missing edit control gives up; it never falls back to the old recovery method.
    assert.equal(app.controller.status().awaitingReplySince, 0)
    assert.equal(app.commands().length, 0)
    assert.deepEqual(sent, [])
    assert.equal(app.continues().some(event => event.reason === 'continue-clicked'), false)
  }
})

test('restored or explicitly ended DeepSeek tasks are not edited to recover a stopped reply', () => {
  for (const ended of [false, true]) {
    const button = continueButton()
    const app = fixture([userTurn('1'), proseTurn('2', '部分回复', button)])
    if (ended) { app.controller.checkNow(); app.controller.endTask() }
    else app.controller.armBaseline()
    settleStopped(app); app.scan()
    assert.equal(app.events.some(event => event.reason === 'stopped-retry-detected'), false)
    assert.equal(button.clicks, 0)
  }
})

test('a disabled DeepSeek Continue control still selects edit recovery', () => {
  const button = continueButton()
  button.attributes['aria-disabled'] = 'true'
  const app = fixture([userTurn('1'), proseTurn('2', '部分回复', button)])
  app.controller.checkNow(); settleStopped(app)
  assert.ok(app.events.some(event => event.reason === 'stopped-retry-detected'))
  assert.equal(button.clicks, 0)
  assert.equal(app.continues().some(event => event.reason === 'continue-clicked'), false)
})

test('changed interrupted content starts a fresh stability wait before edit recovery', () => {
  const app = fixture([userTurn('1'), proseTurn('2', '第一段', continueButton())])
  app.controller.checkNow()
  app.advance(3000)
  app.replaceNodes([userTurn('1'), proseTurn('2', '后续仍在变化的内容', continueButton())])
  app.scan()
  app.advance(1000); app.tick(800)
  assert.equal(app.events.some(event => event.reason === 'stopped-retry-detected'), false)
  settleStopped(app)
  assert.ok(app.events.some(event => event.reason === 'stopped-retry-detected'))
})

test('a reply the site stopped mid-thinking gets one automatic 继续 after it stays stopped', async () => {
  const app = fixture([userTurn('1'), stoppedTurn('2')], LEGACY_CONTINUE_PAGE)
  const sent = stubSends(app)
  app.controller.checkNow()
  assert.deepEqual(sent, [], 'never on the first sight of a stopped turn')
  settleStopped(app)
  assert.deepEqual(sent, ['继续'])
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(app.events.some((event) => event.event === 'continue-generation' && event.reason === 'stopped-continue-sent'))
  settleStopped(app)
  assert.deepEqual(sent, ['继续'], 'the same stopped turn is answered once')
})

test('automatic 继续 stops after three stopped replies in a row, and never fires outside a live wait or with an answer', () => {
  const app = fixture([userTurn('1'), stoppedTurn('2')], LEGACY_CONTINUE_PAGE)
  const sent = stubSends(app)
  app.controller.checkNow()
  for (const key of ['2', '4', '6', '8']) {
    app.replaceNodes([userTurn('1'), stoppedTurn(key)])
    app.scan(); settleStopped(app)
  }
  assert.equal(sent.length, 3)
  assert.ok(app.events.some((event) => event.reason === 'stopped-continue-limit'))

  const history = fixture([userTurn('1'), stoppedTurn('2')], LEGACY_CONTINUE_PAGE)
  const none = stubSends(history)
  history.controller.armBaseline()
  history.scan(); settleStopped(history)
  assert.deepEqual(none, [], 'a restored stopped turn is history')

  const answered = fixture([proseTurn('2', '这是最终回答。', element('span', {}, '已停止'))])
  const nothing = stubSends(answered)
  answered.controller.checkNow(); settleStopped(answered)
  assert.deepEqual(nothing, [], 'a turn with an answer is read normally')
})
