// User-run offline regression tests: the actual injected script runs in a VM with
// synthetic DOM nodes and timers. No Electron, browser session, network or shell.
// Run from the repository root: node --test tests/claude-command.test.mjs
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
    // Conversation URL validation is outside these page-adapter tests.
    return { isConversationId() { throw new Error('Unexpected conversation validation') } }
  }
})
const { CHATGPT_PAGE, CLAUDE_PAGE, DEEPSEEK_PAGE } = platformExports

class ElementFixture {
  nodeType = 1
  isConnected = true
  parentElement = null
  position = 0
  rendered = true

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
const commandJson = (command = 'uname -a') => JSON.stringify({ command, description: '查看系统信息', timeout_seconds: 30 })
const codeReply = (command = 'uname -a') => element('div', { 'data-testid': 'assistant-message', class: 'group/message-row' }, [
  element('span', { class: 'sr-only' }, 'Claude responded: '),
  element('pre', {}, [element('code', {}, commandJson(command))])
])
const chatgptAnswer = (command) => element('div', { 'data-markdown-text-style': 'assistant-message' }, [
  element('pre', {}, [element('code', {}, commandJson(command))])
])
const chatgptReply = (id, command) => element('div', { 'data-chatgpt-selection-message-id': id }, [chatgptAnswer(command)])

function fixture(nodes, page = CLAUDE_PAGE) {
  const events = []
  const timers = new Map()
  let timerSerial = 0
  let notifyMutation
  let observationOptions
  const body = element('body', {}, nodes)
  const window = {}
  const location = { pathname: '/chat/offline-fixture' }
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
  new Script(interceptorSource).runInNewContext({
    window, document,
    location,
    Element: ElementFixture,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    MutationObserver: class {
      constructor(callback) { notifyMutation = callback }
      observe(_target, options) { observationOptions = options }
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
    navigate(path) { location.pathname = path },
    observation: () => observationOptions,
    commands: () => events.filter((event) => event.event === 'command'),
    replaceNodes(next) {
      body.childNodes = next
      for (const node of next) node.parentElement = body
    },
    mutate() { notifyMutation() },
    tick(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue
        timers.delete(id)
        timer.callback()
      }
    },
    scan() {
      notifyMutation()
      // Run just the reply-settle timers; never use wall-clock waits or send handlers.
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 800) continue
        timers.delete(id)
        timer.callback()
      }
    }
  }
}

test('Claude code-only JSON is detected without its usual answer font class', () => {
  const command = "printf '%s\\n' 'hello'; uname -a"
  const app = fixture([codeReply(command)])
  app.controller.checkNow()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].command, command)
  assert.equal(app.commands()[0].description, '查看系统信息')
  assert.equal(app.commands()[0].timeoutSeconds, 30)
  assert.equal(app.commands()[0].live, true)
  app.scan()
  assert.equal(app.commands().length, 1, 'repeated DOM scans must not report the command again')
})

test('background commands retain their execution mode through the actual page parser', () => {
  const payload = JSON.stringify({ command: 'gh auth login --hostname github.com --web', description: '登录', background: true, timeout_seconds: 30 })
  const reply = element('div', { 'data-testid': 'assistant-message', class: 'group/message-row' }, [element('pre', {}, [element('code', {}, payload)])])
  const app = fixture([reply])
  app.controller.checkNow()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].background, true)
})

test('invalid background flags never fall through to a foreground command', () => {
  for (const background of ['true', 1, null]) {
    const payload = JSON.stringify({ command: 'gh auth login --web', description: '登录', background })
    const reply = element('div', { 'data-testid': 'assistant-message' }, [element('pre', {}, [element('code', {}, payload)])])
    const app = fixture([reply])
    app.controller.checkNow()
    assert.equal(app.commands().length, 0)
  }
})

const slash = String.fromCharCode(92)
const rawPathReply = (command, background = true) => JSON.stringify({ command, description: '登录', background, timeout_seconds: 30 })
  .split(slash + slash).join(slash)
const protocolReply = payload => element('div', { 'data-testid': 'assistant-message' }, payload)

test('the screenshot Windows login request recovers its entire path and stays in background mode exactly once', () => {
  const path = ['C:', 'Users', '24196', 'AppData', 'Local', 'Programs', 'GitHub CLI', 'bin', 'gh.exe'].join(slash)
  const command = "& '" + path + "' auth login --hostname github.com --web --skip-ssh-key"
  const app = fixture([protocolReply(rawPathReply(command))])
  app.controller.checkNow()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].command, command)
  assert.equal(app.commands()[0].background, true)
  assert.equal(app.commands()[0].parseRepair, 'windows-path')
  assert.equal(JSON.parse(app.commands()[0].rawJson).command, command)
  app.scan()
  assert.equal(app.commands().length, 1)
})

test('path recovery preserves bin, temp, new and UNC separators without decoding them as controls', () => {
  for (const path of [
    ['C:', 'Users', 'runner', 'bin', 'temp', 'new', 'gh.exe'].join(slash),
    slash + slash + ['server', 'share', 'bin', 'temp', 'new', 'gh.exe'].join(slash)
  ]) {
    const command = "& '" + path + "' auth login --web"
    const app = fixture([protocolReply(rawPathReply(command))])
    app.controller.checkNow()
    assert.equal(app.commands()[0].command, command)
    assert.equal(app.commands()[0].background, true)
    assert.equal(app.commands()[0].command.includes(String.fromCharCode(9)), false)
    assert.equal(app.commands()[0].command.includes(String.fromCharCode(10)), false)
  }
})

test('strict JSON and multiline commands retain their original contents', () => {
  const command = "& '" + ['C:', 'Users', 'temp', 'gh.exe'].join(slash) + "' --version\nWrite-Output ',}'"
  const app = fixture([protocolReply(JSON.stringify({ command, background: true }))])
  app.controller.checkNow()
  assert.equal(app.commands()[0].command, command)
  assert.equal(app.commands()[0].parseRepair, undefined)
})

test('foreground requests share the same literal-path preservation and reject decoded path controls', () => {
  const path = ['C:', 'Users', 'runner', 'bin', 'temp', 'new', 'tool.exe'].join(slash)
  const command = "& '" + path + "' --version"
  const app = fixture([protocolReply(rawPathReply(command, false))])
  app.controller.checkNow()
  assert.equal(app.commands()[0].command, command)
  assert.equal(app.commands()[0].background, false)
  const controls = fixture([protocolReply(rawPathReply("& 'C:" + slash + 'temp' + slash + "new.exe'", false))])
  controls.controller.checkNow()
  assert.equal(controls.commands().length, 0)
})

test('code text takes priority over Markdown display text without including reasoning', () => {
  const command = "& '" + ['C:', 'Users', 'runner', 'gh.exe'].join(slash) + "' auth login --web"
  const payload = JSON.stringify({ command, background: true })
  const pre = element('pre', {}, [element('code', {}, payload)])
  const reply = element('div', { 'data-testid': 'assistant-message' }, [pre])
  const displayed = rawPathReply(command)
  Object.defineProperty(pre, 'innerText', { get: () => displayed })
  Object.defineProperty(reply, 'innerText', { get: () => displayed })
  const app = fixture([reply])
  app.controller.checkNow()
  assert.equal(app.commands()[0].command, command)
  assert.equal(app.commands()[0].commandSource, 'code')
  assert.equal(app.commands()[0].parseRepair, undefined)
})

test('duplicate flags, mixed path escaping and an invalid final request never run an older command', () => {
  const mixed = "& 'C:" + slash + "Users" + slash + slash + "runner" + slash + "gh.exe' auth login"
  for (const payload of [
    '{"command":"gh auth login","background":true,"background":false}',
    JSON.stringify({ command: mixed, background: true }).split(slash + slash + 'Users').join(slash + 'Users'),
    commandJson('old-command') + '\n{"command":"gh auth login","background":"true"}',
    commandJson('old-command') + '\n{"command":"gh auth login","background":true',
    '{"command":"Write-Host "oops"","back' + slash + 'u0067round":true}'
  ]) {
    const app = fixture([protocolReply(payload)])
    app.controller.checkNow()
    app.tick(1000)
    assert.equal(app.commands().length, 0)
    assert.equal(app.controller.status().awaitingReplySince, 0)
    assert.ok(app.events.some(event => event.event === 'parse-failed' && event.live))
  }
})

test('a malformed later prose request cannot be hidden by a valid earlier code block', () => {
  for (const tail of ['{"command":"gh auth login","background":"true"}', '{"background":true,"command"']) {
    const reply = element('div', { 'data-testid': 'assistant-message' }, [
      element('pre', {}, [element('code', {}, commandJson('old-command'))]), tail
    ])
    const app = fixture([reply])
    app.controller.checkNow()
    assert.equal(app.commands().length, 0)
  }
})

test('format recovery is bound to one unexecuted reply and automatically sends at most once per error chain', async () => {
  const app = fixture([protocolReply('{"command":"gh auth login","background":"true"}')])
  const sent = []
  app.controller.sendRaw = async (text, draft, options) => {
    assert.equal(draft, null)
    assert.equal(options.requireIdle, true)
    assert.equal(options.path, '/chat/offline-fixture')
    sent.push(text)
    return 'ok'
  }
  app.controller.checkNow()
  app.tick(1000)
  const failure = app.controller.status().failedCommand
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true), 'ok')
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true), 'stale')
  assert.equal(sent.length, 1)
  assert.match(sent[0], /未执行/)
  assert.match(sent[0], /保留原命令意图和 background/)
  app.replaceNodes([protocolReply('{"command":"gh auth login --web","background":1}')])
  app.controller.checkNow()
  app.tick(1000)
  const second = app.controller.status().failedCommand
  assert.equal(await app.controller.recoverCommand(second.token, second.generation, true), 'limit')
  assert.equal(sent.length, 1)
  assert.equal(await app.controller.recoverCommand(second.token, second.generation, true, true), 'ok')
  assert.equal(sent.length, 2, 'only an explicit manual retry can start another correction')
})

test('paused or draft-blocked recovery stays retryable while uncertain submission is never resubmitted', async () => {
  const app = fixture([protocolReply('{"command":"gh auth login","background":null}')])
  let calls = 0
  app.controller.sendRaw = async () => { calls++; return 'busy' }
  app.controller.checkNow()
  app.tick(1000)
  const failure = app.controller.status().failedCommand
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, false), 'busy')
  assert.equal(calls, 0)
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true, true), 'busy')
  assert.equal(app.controller.status().failedCommand.status, 'blocked')
  app.controller.sendRaw = async () => { calls++; throw new Error('channel lost') }
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true, true), 'stuck')
  assert.equal(await app.controller.recoverCommand(failure.token, failure.generation, true, true), 'stale')
  assert.equal(calls, 2)
})

test('history, changed route, changed generation and stopped tasks cannot send format feedback', async () => {
  for (const change of ['history', 'route', 'generation', 'stop']) {
    const app = fixture([protocolReply('{"command":"gh auth login","background":"true"}')])
    let calls = 0
    app.controller.sendRaw = async () => { calls++; return 'ok' }
    if (change === 'history') { app.controller.armBaseline(); app.scan() }
    else app.controller.checkNow()
    app.tick(1000)
    const failure = app.controller.status().failedCommand
    if (change === 'route') app.navigate('/chat/another')
    if (change === 'stop') app.controller.endTask()
    const result = await app.controller.recoverCommand(failure?.token ?? 1,
      (failure?.generation ?? 0) + (change === 'generation' ? 1 : 0), true)
    assert.equal(result, 'stale')
    assert.equal(calls, 0)
  }
})

test('the preferred answer container still excludes surrounding command-shaped text', () => {
  const answer = element('div', { class: 'font-claude-response' }, commandJson('pwd'))
  const reply = element('div', { 'data-testid': 'assistant-message' }, [
    commandJson('unrelated-before'), answer, commandJson('unrelated-after')
  ])
  const app = fixture([reply])
  app.controller.checkNow()
  assert.equal(app.commands()[0].command, 'pwd')
})

test('an answer marker on the turn itself also works', () => {
  const reply = element('div', { 'data-testid': 'assistant-message', class: 'font-claude-response' }, commandJson('pwd'))
  const app = fixture([reply])
  app.controller.checkNow()
  assert.equal(app.commands()[0].command, 'pwd')
})

test('explicit assistant roles exclude user turns even with answer-like descendants', () => {
  const user = element('div', { 'data-testid': 'user-message' }, [
    element('div', { class: 'font-claude-response' }, commandJson('user-input'))
  ])
  // Broaden discovery deliberately to exercise the role check independently.
  const app = fixture([user], { ...CLAUDE_PAGE, assistantSelectors: CLAUDE_PAGE.messageSelectors })
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'not-assistant-turn'))
})

test('a code-only reply waits for generation to stop before being reported', () => {
  const reply = codeReply()
  const stop = element('button', { 'aria-label': 'Stop response' })
  const app = fixture([reply, stop])
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'still-generating'))
  app.replaceNodes([reply])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].live, true)
})

test('restored Claude replies remain history rather than live commands', () => {
  const app = fixture([codeReply()])
  app.controller.armBaseline()
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].live, false)
})

test('terminal mode off suppresses a recognized code-only command', () => {
  const app = fixture([codeReply()])
  app.controller.configure({ enabled: false })
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'terminal-mode-off'))
})

test('reconfiguration clears Claude roles and retains DeepSeek answer-based recognition', () => {
  const user = element('div', { 'data-virtual-list-item-key': 'user' }, commandJson('user-input'))
  const app = fixture([user])
  app.controller.configure({ page: DEEPSEEK_PAGE })
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  const reply = element('div', { 'data-virtual-list-item-key': 'assistant' }, [
    element('div', { class: 'ds-assistant-message-main-content' }, commandJson('pwd'))
  ])
  app.replaceNodes([reply])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].command, 'pwd')
})

test('Claude thinking keeps the reply waiting without a stop button, so a later question is still live', () => {
  const thinking = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'true' }, '权衡中 Claude 正在思考')
  const app = fixture([thinking])
  app.controller.checkNow()
  const waiting = app.events.find((event) => event.reason === 'still-generating')
  assert.equal(waiting.awaitingReply, true)
  assert.equal(waiting.replyStreamingState, 'true')
  assert.equal(waiting.stopButtonFound, false)
  assert.equal(waiting.stopButtonOnPage, false)
  assert.equal(app.events.some(event => event.event === 'assistant-message' || event.event === 'task-finished'), false)
  assert.equal(app.controller.status().lastCommandMessageId, null)
  const question = JSON.stringify({ type: 'questions', questions: [{ question: '选择哪个安装方式？' }] })
  app.replaceNodes([element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, question)])
  app.scan()
  const detected = app.events.find((event) => event.event === 'question')
  assert.equal(detected.live, true)
  assert.equal(detected.replyKind, 'questions')
  assert.equal(detected.replyStreamingState, 'false')
  assert.equal(detected.replyTextLength, question.length)
  assert.equal(app.events.some(event => event.reason === 'question-not-live'), false)
})

test('Claude saves only the completed full answer after thinking and web search fragments', () => {
  const thinking = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'true' }, '确定问题具体指什么内容。运行中')
  const app = fixture([thinking])
  app.controller.checkNow()
  app.tick(250)
  for (const text of ['继续确定问题的具体内容', '搜索网页中', '搜索到了相关资料']) {
    app.replaceNodes([element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'true' }, text)])
    app.scan(); app.tick(250)
    assert.equal(app.events.some(event => event.event === 'assistant-message' || event.event === 'task-finished'), false)
    assert.notEqual(app.controller.status().awaitingReplySince, 0)
  }
  const fullAnswer = '没有找到 Day 16 的具体内容。以下是背景和已知信息，不能当作 Day 16 的改进清单。'
  const final = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, [element('p', {}, fullAnswer)])
  app.replaceNodes([final]); app.scan()
  assert.equal(app.events.some(event => event.event === 'assistant-message'), false, 'the final Markdown rendering pass has not completed yet')
  app.tick(250)
  const saved = app.events.filter(event => event.event === 'assistant-message')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].text, fullAnswer)
  assert.equal(saved[0].messageId, app.controller.questionSourceMessageId(final))
  assert.equal(saved[0].replyStreamingState, 'false')
  assert.equal(app.controller.status().awaitingReplySince, 0)
  app.scan(); app.tick(250)
  assert.equal(app.events.filter(event => event.event === 'assistant-message').length, 1)
  assert.equal(app.events.filter(event => event.event === 'task-finished').length, 1)
})

test('Claude streaming-state changes are observed after configuring the adapter, even with no text change', () => {
  const reply = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'true' }, '最终回答内容')
  const app = fixture([reply])
  assert.ok(app.observation().attributeFilter.includes('data-is-streaming'))
  app.controller.checkNow()
  app.tick(250)
  assert.equal(app.events.some(event => event.event === 'assistant-message'), false)
  reply.attributes['data-is-streaming'] = 'false'
  app.scan(); app.tick(250)
  assert.equal(app.events.filter(event => event.event === 'assistant-message').length, 1)
  app.controller.configure({ page: CHATGPT_PAGE })
  assert.equal(app.observation().attributeFilter.includes('data-is-streaming'), false)
  assert.ok(app.observation().attributeFilter.includes(CHATGPT_PAGE.messageIdAttr))
})

test('a reply that resumes streaming during the delayed Markdown read never saves a partial turn', () => {
  const reply = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, '刚刚生成的片段')
  const app = fixture([reply])
  app.controller.checkNow()
  assert.notEqual(app.controller.status().awaitingReplySince, 0)
  reply.attributes['data-is-streaming'] = 'true'
  app.tick(250)
  assert.equal(app.events.some(event => event.event === 'assistant-message' || event.event === 'task-finished'), false)
  assert.notEqual(app.controller.status().awaitingReplySince, 0)
  app.replaceNodes([element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, '完整的最终回答')])
  app.scan(); app.tick(250)
  assert.equal(app.events.filter(event => event.event === 'assistant-message').length, 1)
  assert.equal(app.events.find(event => event.event === 'assistant-message').text, '完整的最终回答')
})

test('a delayed answer keeps its Markdown formatting and is cancelled when the source wait is reset', () => {
  for (const cancelled of [false, true]) {
    const initial = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, '【任务完成】最终回答')
    const app = fixture([initial])
    app.controller.checkNow()
    const formatted = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'false' }, [
      element('p', {}, ['【任务完成】', element('strong', {}, '最终回答')])
    ])
    app.replaceNodes([formatted])
    if (cancelled) app.controller.armBaseline()
    app.tick(250)
    const saved = app.events.filter(event => event.event === 'assistant-message')
    assert.equal(saved.length, cancelled ? 0 : 1)
    if (!cancelled) {
      assert.equal(saved[0].text, '【任务完成】**最终回答**')
      assert.equal(app.events.find(event => event.event === 'task-finished').completed, true)
    }
  }
})

test('Claude does not accept streamed commands, questions or file requests before the turn is complete', () => {
  for (const [event, text] of [
    ['command', commandJson('pwd')],
    ['question', JSON.stringify({ type: 'questions', questions: [{ question: '选哪个？' }] })],
    ['read-files', JSON.stringify({ type: 'read_files', files: [{ path: '/tmp/example.md' }], description: '读取文件' })]
  ]) {
    const reply = element('div', { 'data-testid': 'assistant-message', 'data-is-streaming': 'true' }, text)
    const app = fixture([reply])
    app.controller.checkNow(); app.tick(250)
    assert.equal(app.events.some(item => item.event === event), false)
    assert.notEqual(app.controller.status().awaitingReplySince, 0)
    reply.attributes['data-is-streaming'] = 'false'
    app.scan()
    assert.equal(app.events.filter(item => item.event === event).length, 1)
    assert.equal(app.events.find(item => item.event === event).live, true)
  }
})

test('question detection records its live-state transition and pending status', () => {
  const question = JSON.stringify({ type: 'questions', questions: [{ question: '选择哪个安装方式？' }] })
  const app = fixture([element('div', { 'data-testid': 'assistant-message' }, question)])
  app.controller.checkNow()
  const transition = app.events.find((event) => event.event === 'reply-state' && event.reason === 'question-detected')
  assert.equal(transition.awaitingReplyBefore, true)
  assert.equal(transition.awaitingReply, false)
  const detected = app.events.find((event) => event.event === 'question')
  assert.equal(detected.live, true)
  assert.equal(detected.pendingQuestionFound, true)
  assert.equal(detected.replyKind, 'questions')
})

test('question options written as {label, description} objects become one line each and keep the raw JSON', () => {
  const question = JSON.stringify({ type: 'questions', questions: [{
    question: '下一步怎么做？',
    options: [{ label: 'A: 寻找新增信息', description: '先证明信息增量' }, { label: 'B: 结束本轮' }, '自定义']
  }] })
  const app = fixture([element('div', { 'data-testid': 'assistant-message' }, question)])
  app.controller.checkNow()
  const detected = app.events.find((event) => event.event === 'question')
  assert.deepEqual(detected.questions[0].options, ['A: 寻找新增信息：先证明信息增量', 'B: 结束本轮', '自定义'])
  assert.equal(detected.rawJson, question)
})

test('a restored question is reported for history only and can be replayed as a live question', () => {
  const question = JSON.stringify({ type: 'questions', questions: [{ question: '选择哪个安装方式？', options: ['A', 'B'] }] })
  const app = fixture([element('div', { 'data-testid': 'assistant-message' }, question)])
  app.controller.armBaseline()
  app.scan()
  assert.equal(app.events.some((event) => event.event === 'question'), false)
  const history = app.events.find((event) => event.event === 'question-history')
  assert.equal(history.rawJson, question)
  assert.equal(app.controller.status().pendingQuestion, null)

  assert.equal(app.controller.replayQuestion(history.messageId, '{"type":"questions","questions":[]}'), 'invalid')
  assert.equal(app.controller.replayQuestion(history.messageId, question), 'ok')
  assert.equal(app.controller.status().pendingQuestion.messageId, history.messageId)
  const replayed = app.events.find((event) => event.event === 'question')
  assert.equal(replayed.live, true)
  assert.deepEqual(replayed.questions[0].options, ['A', 'B'])
})

test('unavailable diagnostic DOM metadata does not block command recognition', () => {
  const reply = codeReply()
  const getAttribute = reply.getAttribute.bind(reply)
  reply.getAttribute = (name) => {
    if (name === 'data-is-streaming') throw new Error('Unavailable diagnostic attribute')
    return getAttribute(name)
  }
  const app = fixture([reply])
  app.controller.checkNow()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].replySnapshotAvailable, false)
})

test('an already-handled reply logs changed content and generation state without repeating commands', () => {
  const app = fixture([chatgptReply('handled-message', 'pwd')], CHATGPT_PAGE)
  app.controller.checkNow()
  app.scan()
  const skipped = () => app.events.filter((event) => event.reason === 'already-handled')
  assert.equal(skipped().length, 1)
  app.scan()
  assert.equal(skipped().length, 1, 'unchanged scans are still suppressed')
  const changed = chatgptReply('handled-message', 'Get-Command mysqlsh')
  const stop = element('button', { 'aria-label': '停止' })
  app.replaceNodes([changed, stop])
  app.scan()
  assert.equal(skipped().length, 2)
  assert.equal(skipped()[1].replyTextLength, commandJson('Get-Command mysqlsh').length)
  assert.equal(skipped()[1].stopButtonFound, true)
  app.replaceNodes([changed])
  app.scan()
  assert.equal(skipped().length, 3)
  assert.equal(skipped()[2].stopButtonFound, false)
  assert.equal(app.commands().length, 1, 'diagnostic changes must not bypass command deduplication')
})

test('ChatGPT detects a new rendered reply before a hidden already-handled turn exactly once', () => {
  const oldReply = chatgptReply('old-message', 'pwd')
  const app = fixture([oldReply], CHATGPT_PAGE)
  app.controller.checkNow()
  oldReply.rendered = false
  app.replaceNodes([chatgptReply('new-message', 'Get-Command mysqlsh'), oldReply])
  app.scan()
  const detected = app.commands().at(-1)
  assert.equal(app.commands().length, 2)
  assert.equal(detected.messageId, 'new-message')
  assert.equal(detected.command, 'Get-Command mysqlsh')
  assert.equal(detected.hiddenTurnCount, 1)
  assert.equal(detected.lastMatchedMessageId, 'old-message')
  assert.equal(detected.selectedFromRenderedTurns, true)
  assert.equal(detected.selectedMatchesLastVisible, true)
  app.scan()
  assert.equal(app.commands().length, 2, 'repeated scans must not dispatch the new command again')
})

test('ChatGPT excludes turns hidden by an ancestor without relying on viewport position', () => {
  for (const attributes of [{ hidden: '' }, { inert: '' }, { 'aria-hidden': 'true' }]) {
    const hiddenBranch = element('div', attributes, [chatgptReply('hidden-message', 'old-command')])
    const current = chatgptReply('current-message', 'pwd')
    current.getBoundingClientRect = () => ({ top: -1000, bottom: -900 })
    const app = fixture([current, hiddenBranch], CHATGPT_PAGE)
    app.controller.checkNow()
    assert.equal(app.commands().length, 1)
    assert.equal(app.commands()[0].messageId, 'current-message')
    assert.equal(app.commands()[0].hiddenTurnCount, 1)
  }
})

test('an empty latest ChatGPT turn waits for its own content instead of executing an older reply', () => {
  for (const hasAnswerMarker of [false, true]) {
    const oldReply = chatgptReply('old-message', 'old-command')
    const placeholder = element('div', { 'data-chatgpt-selection-message-id': 'new-message' },
      hasAnswerMarker ? [element('div', { 'data-markdown-text-style': 'assistant-message' })] : [])
    const app = fixture([oldReply, placeholder], CHATGPT_PAGE)
    app.controller.checkNow()
    assert.equal(app.commands().length, 0)
    assert.equal(app.controller.status().awaitingReplySince !== 0, true)
    app.replaceNodes([oldReply, chatgptReply('new-message', 'Get-Command mysqlsh')])
    app.scan()
    assert.equal(app.commands().length, 1)
    assert.equal(app.commands()[0].messageId, 'new-message')
    assert.equal(app.commands()[0].live, true)
  }
})

test('a latest ChatGPT user turn never falls back to an older assistant command', () => {
  const user = element('div', { 'data-chatgpt-selection-message-id': 'user-message' }, '继续')
  const app = fixture([chatgptReply('old-message', 'old-command'), user], CHATGPT_PAGE)
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'not-assistant-turn' && event.messageId === 'user-message'))
})

test('a latest ChatGPT prose reply does not cause an earlier command to be executed', () => {
  const prose = element('div', { 'data-chatgpt-selection-message-id': 'new-message' }, [
    element('div', { 'data-markdown-text-style': 'assistant-message' }, '【任务完成】检查完毕')
  ])
  const app = fixture([chatgptReply('old-message', 'old-command'), prose], CHATGPT_PAGE)
  app.controller.checkNow()
  app.tick(250)
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.event === 'task-finished' && event.messageId === 'new-message'))
})

test('ChatGPT waits for a new rendered command to finish generating despite a hidden old turn', () => {
  const oldReply = chatgptReply('old-message', 'old-command')
  oldReply.rendered = false
  const current = chatgptReply('new-message', 'pwd')
  const stop = element('button', { 'aria-label': '停止' })
  const app = fixture([current, oldReply, stop], CHATGPT_PAGE)
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'still-generating' && event.messageId === 'new-message'))
  app.replaceNodes([current, oldReply])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].messageId, 'new-message')
})

test('ending a ChatGPT task baselines the rendered reply rather than the hidden last DOM node', () => {
  const oldReply = chatgptReply('old-message', 'old-command')
  oldReply.rendered = false
  const current = chatgptReply('current-message', 'pwd')
  const app = fixture([current, oldReply], CHATGPT_PAGE)
  app.controller.endTask()
  assert.equal(app.controller.status().lastCommandMessageId, 'current-message')
  app.scan()
  assert.equal(app.commands().length, 0, 'the visible reply at the task boundary must remain handled')
})

test('ChatGPT questions use the same rendered turn selection as commands', () => {
  const oldReply = chatgptReply('old-message', 'old-command')
  oldReply.rendered = false
  const question = JSON.stringify({ type: 'questions', questions: [{ question: '选择哪个安装方式？' }] })
  const current = element('div', { 'data-chatgpt-selection-message-id': 'question-message' }, [
    element('div', { 'data-markdown-text-style': 'assistant-message' }, question)
  ])
  const app = fixture([current, oldReply], CHATGPT_PAGE)
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  const detected = app.events.filter((event) => event.event === 'question')
  assert.equal(detected.length, 1)
  assert.equal(detected[0].messageId, 'question-message')
  assert.equal(detected[0].live, true)
})

test('reconfiguring the adapter does not carry ChatGPT hidden-node filtering into Claude', () => {
  const reply = codeReply('pwd')
  reply.rendered = false
  const app = fixture([], CHATGPT_PAGE)
  app.controller.configure({ page: CLAUDE_PAGE })
  app.replaceNodes([reply])
  app.controller.checkNow()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].selectedFromRenderedTurns, false)
})

test('diagnostics distinguish hidden cached turns from a visible answer missing its wrapper', () => {
  const oldReply = chatgptReply('old-message', 'pwd')
  const app = fixture([oldReply], CHATGPT_PAGE)
  app.controller.checkNow()
  oldReply.rendered = false
  app.replaceNodes([chatgptAnswer('Get-Command mysqlsh'), oldReply])
  app.scan()
  const skipped = app.events.find((event) => event.reason === 'no-visible-turns')
  assert.equal(skipped.messageId, '')
  assert.equal(skipped.lastMatchedMessageId, 'old-message')
  assert.equal(skipped.hiddenTurnCount, 1)
  assert.equal(skipped.selectedNodeVisible, false)
  assert.equal(skipped.selectedReplyVisible, false)
  assert.equal(skipped.visibleAssistantTurnCount, 0)
  assert.equal(skipped.lastVisibleMessageId, null)
  assert.equal(skipped.visibleAnswerMarkerCount, 1)
  assert.equal(skipped.visibleAnswerOwnerMessageId, null)
  assert.equal(skipped.visibleAnswerKind, 'command')
  assert.equal(skipped.visibleCodeBlockCount, 1)
  assert.equal(app.commands().length, 1)
})

test('all-hidden ChatGPT replies leave the task waiting until a rendered reply arrives', () => {
  const hidden = chatgptReply('hidden-message', 'old-command')
  hidden.rendered = false
  const app = fixture([hidden], CHATGPT_PAGE)
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.equal(app.controller.status().awaitingReplySince !== 0, true)
  assert.ok(app.events.some((event) => event.reason === 'no-visible-turns' && event.hiddenTurnCount === 1))
  app.replaceNodes([chatgptReply('new-message', 'pwd'), hidden])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].messageId, 'new-message')
  assert.equal(app.commands()[0].live, true)
})

test('a passive watchdog records a visible new reply while mutations keep the scanner pending', () => {
  const oldReply = chatgptReply('old-message', 'pwd')
  const app = fixture([oldReply], CHATGPT_PAGE)
  app.controller.checkNow()
  oldReply.rendered = false
  app.replaceNodes([chatgptReply('new-message', 'Get-Command mysqlsh'), oldReply])
  app.mutate() // Leave the 800 ms settle callback pending, as on a continually mutating page.
  app.tick(5000)
  const heartbeat = app.events.find((event) => event.event === 'reply-watchdog')
  assert.equal(heartbeat.messageId, 'new-message')
  assert.equal(heartbeat.lastMatchedMessageId, 'old-message')
  assert.equal(heartbeat.hiddenTurnCount, 1)
  assert.equal(heartbeat.lastVisibleMessageId, 'new-message')
  assert.equal(heartbeat.visibleAnswerOwnerMessageId, 'new-message')
  assert.equal(heartbeat.selectedMatchesLastVisible, true)
  assert.equal(heartbeat.replySettlePending, true)
  assert.equal(heartbeat.lastVisibleReplyKind, 'command')
  assert.equal(typeof heartbeat.lastScanAgeMs, 'number')
  assert.equal(typeof heartbeat.lastMutationAgeMs, 'number')
  assert.equal(app.commands().length, 1, 'the watchdog must never execute the new reply')
  app.scan()
  app.tick(5000)
  const settled = app.events.filter((event) => event.event === 'reply-watchdog').at(-1)
  assert.equal(settled.replySettlePending, false)
})

test('idle pages produce no watchdog records and diagnostic failures leave the timer alive', () => {
  const idle = fixture([])
  idle.tick(5000)
  assert.equal(idle.events.some((event) => event.event === 'reply-watchdog'), false)
  const reply = codeReply()
  const getAttribute = reply.getAttribute.bind(reply)
  reply.getAttribute = (name) => {
    if (name === 'data-is-streaming') throw new Error('Unavailable diagnostic attribute')
    return getAttribute(name)
  }
  const app = fixture([reply])
  app.controller.checkNow()
  app.tick(5000)
  app.tick(5000)
  const heartbeats = app.events.filter((event) => event.event === 'reply-watchdog')
  assert.equal(heartbeats.length, 2)
  assert.ok(heartbeats.every((event) => event.replySnapshotAvailable === false))
  assert.equal(app.commands().length, 1)
})
