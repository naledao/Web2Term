import { progressVmModules } from './fixtures/progress-vm-modules.mjs'
// User-run only: node --test tests/deepseek-computer-requests.test.mjs
// Actual injected scanner and main bridge/coordinator with synthetic DOM, timers and storage.
// No Electron, real page/session, desktop input, network or child process is used.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function load(path, dependencies = {}) {
  const exports = {}
  new Script(compile(readFileSync(new URL(path, import.meta.url), 'utf8'))).runInNewContext({
    exports, structuredClone, require(name) { if (Object.hasOwn(progressVmModules, name)) return progressVmModules[name];
      if (name === '../shared/computer-actions') return load('../src/shared/computer-actions.ts')
      assert.ok(Object.hasOwn(dependencies, name), name)
      return dependencies[name]
    }
  })
  return exports
}
const platforms = load('../src/shared/platforms.ts', { './types': { isConversationId: id => typeof id === 'string' && !!id } })
const { parseAutonomousTask } = load('../src/shared/autonomous-task.ts')
const protocol = load('../src/shared/computer-use-protocol.ts')
const { TaskCoordinator } = load('../src/main/task-coordinator.ts', { 'node:crypto': { createHash, randomUUID } })
const { TaskProgression } = load('../src/main/task-progression.ts', { 'node:crypto': { createHash, randomUUID } })
const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
// Test-only access to the real confirmed-send reporting/baseline helpers. The shipped source
// has no testing hook. UI submit/acknowledgement itself is outside this offline scanner test.
const hook = 'window[STATE_KEY] = {'
assert.equal(source.split(hook).length, 2)
const instrumented = `window.__computerUseProtocol = (${protocol.createComputerUseProtocol.toString()})();\n` + source.replace(hook,
  'window.__computerFixture = { report, setReplyWaiting, computerBaselineOf, lastAssistantId, legacyTaskSource, state };\n' + hook)

class ElementFixture {
  nodeType = 1
  isConnected = true
  parentElement = null
  position = 0
  rendered = true
  constructor(tag, attributes = {}, content = []) {
    this.tagName = tag.toUpperCase()
    this.attributes = attributes
    this.childNodes = (Array.isArray(content) ? content : [content]).map(child => typeof child === 'string'
      ? { nodeType: 3, nodeValue: child } : child)
    for (const child of this.childNodes) child.parentElement = this
  }
  get className() { return this.attributes.class || '' }
  get textContent() { return this.childNodes.map(child => child.nodeType === 3 ? child.nodeValue : child.textContent).join('') }
  get innerText() { return this.textContent }
  getAttribute(name) { return this.attributes[name] ?? null }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) if (!node.rendered) return []
    return [{}]
  }
  compareDocumentPosition(other) { return this.position < other.position ? 4 : this.position > other.position ? 2 : 0 }
  getBoundingClientRect() { return { left: 0, top: this.position * 10, width: 10, height: 10 } }
  scrollIntoView() {}
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()))
    if (/^[a-z]+$/i.test(selector)) return this.tagName.toLowerCase() === selector.toLowerCase()
    if (/^\.[\w-]+$/.test(selector)) return this.className.split(/\s+/).includes(selector.slice(1))
    const match = /^(\w+)?\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]$/.exec(selector)
    if (!match || (match[1] && this.tagName.toLowerCase() !== match[1])) return false
    const value = this.getAttribute(match[2])
    if (value === null) return false
    if (!match[3]) return true
    if (match[3] === '*=') return value.includes(match[4])
    if (match[3] === '^=') return value.startsWith(match[4])
    return value === match[4]
  }
  descendants() { return this.childNodes.filter(child => child.nodeType === 1).flatMap(child => [child, ...child.descendants()]) }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node
    return null
  }
  contains(other) { return this === other || this.descendants().includes(other) }
}
const element = (tag, attributes, content) => new ElementFixture(tag, attributes, content)
const code = raw => element('pre', {}, [element('code', {}, raw)])
const turn = (key, content, extra = []) => element('div', { 'data-virtual-list-item-key': key }, [
  ...extra, element('div', { class: 'ds-assistant-message-main-content' }, content)
])
const requestJson = JSON.stringify({ type: 'computer', version: 1, action: 'observe', step_token: 'token-from-future-validator' })
function pageFixture(initial = [element('div', { 'data-virtual-list-item-key': '1' }, '先前的用户消息')], page = platforms.DEEPSEEK_PAGE) {
  const events = [], timers = new Map(), window = {}, body = element('body', {}, initial)
  const location = { pathname: '/a/chat/s/chat-A' }
  let mutation, timerSerial = 0, now = 100_000
  const document = {
    body, activeElement: null, addEventListener() {},
    querySelectorAll(selector) {
      ;[body, ...body.descendants()].forEach((node, index) => { node.position = index })
      return body.querySelectorAll(selector)
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null },
    elementFromPoint: () => null
  }
  class FakeDate extends Date { static now() { return now } }
  new Script(instrumented).runInNewContext({
    window, document, location, Date: FakeDate, Element: ElementFixture,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    MutationObserver: class { constructor(callback) { mutation = callback } observe() {} },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout(callback, delay) { const id = ++timerSerial; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    console: { log(line) { events.push(JSON.parse(line.slice('[cmd-terminal] '.length))) } }
  })
  const controller = window.__cmdTerminalInterceptor, helpers = window.__computerFixture
  controller.configure({ enabled: true, computerUseEnabled: true, page, taskPromptGeneration: 3, computerPageEpoch: 'document-a' })
  const fixture = {
    events, controller, location, helpers,
    advance(ms) { now += ms },
    requests: () => events.filter(event => event.event === 'computer-request'),
    actions: () => events.filter(event => ['command', 'read-files', 'question'].includes(event.event)),
    replace(nodes) {
      body.childNodes = nodes
      for (const node of nodes) node.parentElement = body
    },
    tick(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback() }
    },
    scan() { mutation(); fixture.tick(800) },
    settle() { fixture.scan(); fixture.tick(250) },
    confirm(kind = 'goal') {
      const baseline = helpers.computerBaselineOf()
      helpers.state.lastCommandMessageId = helpers.lastAssistantId()
      helpers.state.replyActionDetected = false
      helpers.setReplyWaiting(++now, 'user-sent', null, baseline)
      helpers.report({ event: 'user-message', submissionKind: kind, text: '整理并检查报表。' })
      return events.filter(event => event.event === 'user-message').at(-1).submissionId
    },
    result() {
      const baseline = helpers.computerBaselineOf()
      helpers.state.lastCommandMessageId = helpers.lastAssistantId()
      helpers.state.replyActionDetected = false
      helpers.setReplyWaiting(++now, 'result-sent', null, baseline)
    }
  }
  return fixture
}

test('legacy task provenance requires a new confirmed reply and consumes the same reply boundary only once', () => {
  const f = pageFixture(), submission = f.confirm()
  assert.deepEqual(Object.keys(f.helpers.legacyTaskSource(turn('1', code('{"command":"history"}')))), [])
  const reply = turn('2', code('{"command":"prepare report","description":"prepare"}')); f.replace([reply])
  const source = f.helpers.legacyTaskSource(reply)
  assert.equal(source.sourceSubmissionId, submission); assert.equal(source.taskPromptGeneration, 3); assert.equal(source.pagePath, f.location.pathname)
  assert.deepEqual(Object.keys(f.helpers.legacyTaskSource(reply)), [])
  f.result(); const next = turn('3', code('{"type":"read_files","files":[{"path":"report.xlsx"}],"description":"inspect"}')); f.replace([next])
  assert.equal(f.helpers.legacyTaskSource(next).sourceSubmissionId, submission)
})

test('a document epoch change cancels a pending settled recognition and cannot re-arm restored history', () => {
  const f = pageFixture(); f.confirm(); f.replace([turn('2', code(requestJson))]); f.scan()
  f.controller.configure({ computerPageEpoch: 'document-b' }); f.tick(250); f.settle()
  assert.equal(f.requests().length, 0)
  f.controller.checkNow(); f.tick(250); assert.equal(f.requests().length, 0)
  f.confirm(); f.replace([turn('4', code(requestJson))]); f.settle()
  assert.equal(f.requests().length, 1); assert.equal(f.requests()[0].computerPageEpoch, 'document-b')
})

test('recycled virtual row numbers do not become durable identities for separate confirmed replies', () => {
  const f = pageFixture(); f.confirm(); f.replace([turn('2', code(requestJson))]); f.settle()
  const first = f.requests()[0]
  // The virtual list is renumbered before the next confirmed result send.
  f.replace([turn('1', 'previous reply')]); f.result(); f.replace([turn('2', code(requestJson))]); f.settle()
  assert.equal(f.requests().length, 2); assert.notEqual(f.requests()[1].messageId, first.messageId)
  assert.equal(f.requests()[1].sourceSubmissionId, first.sourceSubmissionId)
})

test('a confirmed goal produces one computer event from the final answer, with untouched JSON bytes', () => {
  const raw = String.raw`{"type":"computer","version":1,"action":"type_text","step_token":"token","text":"C:\\报表\\a.xlsx\n{内容}"}`
  const f = pageFixture()
  const submission = f.confirm()
  f.replace([turn('2', code(raw))])
  f.scan()
  assert.equal(f.requests().length, 0, 'one further settled read is required')
  f.tick(250)
  assert.equal(f.requests().length, 1)
  const event = f.requests()[0]
  assert.equal(event.rawJson, raw)
  assert.equal(event.computerOutcome, 'candidate')
  assert.equal(event.sourceSubmissionId, submission)
  assert.equal(event.taskPromptGeneration, 3)
  assert.equal(event.pagePath, '/a/chat/s/chat-A')
  assert.match(event.messageId, /^computer:/)
  assert.equal(f.actions().length, 0)
  f.settle()
  f.replace([turn('2', [element('span', {}, 'JSON'), code(raw), element('button', {}, '复制代码')])])
  f.settle()
  assert.equal(f.requests().length, 1, 'remounting or rescanning one reply cannot emit it again')
})

test('the current code-block banner (json · 复制 · 下载) is not read as text around the request', () => {
  // Two renderings of the banner controls: div[role=button] with an icon, and bare labels.
  const control = label => element('div', { role: 'button', class: 'ds-button' }, [element('svg', {}, 'icon'), element('span', {}, label)])
  const banners = [
    element('div', { class: 'md-code-block-banner' }, [element('span', {}, 'json'), element('div', {}, [control('复制'), control('下载')])]),
    element('div', { class: 'md-code-block-banner' }, [element('span', {}, 'json'), element('span', {}, '复制'), element('span', {}, '下载')])
  ]
  for (const banner of banners) {
    const f = pageFixture()
    f.confirm()
    f.replace([turn('2', element('div', { class: 'md-code-block' }, [banner, code(requestJson)]))])
    f.settle()
    assert.equal(f.requests().length, 1)
    assert.equal(f.requests()[0].computerOutcome, 'candidate')
    assert.equal(f.requests()[0].computerIssue, null)
    assert.equal(f.requests()[0].rawJson, requestJson)
  }
})

test('reasoning, quotations, examples and nested discriminator data never become desktop input', () => {
  const bodies = [
    [turn('2', '这是最终回答。', [element('div', { class: 'ds-think-content' }, code(requestJson))])],
    [element('div', { 'data-virtual-list-item-key': '2' }, [element('div', { class: 'ds-think-content' }, code(requestJson))])],
    [turn('2', element('blockquote', {}, code(requestJson)))],
    [turn('2', element('q', {}, requestJson))],
    [turn('2', element('cite', {}, requestJson))],
    [turn('2', code(JSON.stringify({ note: { type: 'computer', action: 'observe' } })))]
  ]
  for (const nodes of bodies) {
    const f = pageFixture()
    f.confirm()
    f.replace(nodes)
    f.settle()
    assert.equal(f.requests().length, 0)
    assert.equal(f.actions().length, 0)
  }
  const example = pageFixture()
  example.confirm()
  example.replace([turn('2', [element('p', {}, '下面是调用示例：'), code(requestJson)])])
  example.settle()
  assert.equal(example.requests()[0].computerOutcome, 'invalid')
  assert.equal(example.requests()[0].computerIssue, 'ambiguous-request')
})

test('history and the legacy manual-resume button cannot arm a computer request', () => {
  const f = pageFixture([turn('2', code(requestJson))])
  f.settle()
  f.controller.checkNow()
  f.tick(250)
  f.controller.configure({ armBaseline: true })
  f.settle()
  assert.equal(f.requests().length, 0)
  assert.equal(f.actions().length, 0)
})

test('the pre-send virtual-row baseline rejects an old row even when its DOM node was recreated', () => {
  const f = pageFixture([turn('4', code(requestJson))])
  f.confirm()
  f.replace([turn('4', code(requestJson))])
  f.settle()
  f.replace([turn('2', code(requestJson))])
  f.settle()
  assert.equal(f.requests().length, 0)
  f.replace([turn('6', code(requestJson))])
  f.settle()
  assert.equal(f.requests().length, 1)
})

test('an unrendered existing conversation cannot treat an unknown restored row as a new reply', () => {
  const f = pageFixture([])
  f.confirm()
  f.replace([turn('2', code(requestJson))])
  f.settle()
  assert.equal(f.requests().length, 0)
})

test('identical JSON in a genuinely new result round gets a new identity and stays under the original goal', () => {
  const f = pageFixture()
  const goal = f.confirm()
  f.replace([turn('2', code(requestJson))])
  f.settle()
  f.result()
  f.replace([turn('2', code(requestJson)), turn('4', code(requestJson))])
  f.settle()
  assert.equal(f.requests().length, 2)
  assert.notEqual(f.requests()[0].messageId, f.requests()[1].messageId)
  assert.equal(f.requests()[1].sourceSubmissionId, goal)
})

test('generation guards and a second stable read reject streamed or changing JSON', () => {
  const page = { ...platforms.DEEPSEEK_PAGE, replyStreamingAttribute: 'data-streaming' }
  const f = pageFixture(undefined, page)
  f.confirm()
  const partial = turn('2', code(requestJson))
  partial.attributes['data-streaming'] = 'true'
  f.replace([partial])
  f.settle()
  assert.equal(f.requests().length, 0)
  partial.attributes['data-streaming'] = 'false'
  f.scan()
  const final = requestJson.replace('observe', 'list_windows')
  f.replace([turn('2', code(final))])
  f.tick(250)
  assert.equal(f.requests().length, 0)
  f.settle()
  assert.equal(f.requests()[0].rawJson, final)
})

test('path changes, ending a task and disabling the tool invalidate a pending recognition', () => {
  for (const change of [f => { f.location.pathname = '/a/chat/s/chat-B' },
    f => f.controller.configure({ taskPromptGeneration: 4 }),
    f => f.controller.configure({ computerUseEnabled: false }),
    f => f.controller.endTask()]) {
    const f = pageFixture()
    f.confirm()
    f.replace([turn('2', code(requestJson))])
    f.scan()
    change(f)
    f.tick(250)
    assert.equal(f.requests().length, 0)
    assert.equal(f.actions().length, 0)
  }
})

test('the first confirmed message may bind the root route once, and clarification keeps its original source', () => {
  const f = pageFixture()
  f.location.pathname = '/'
  f.replace([])
  const goal = f.confirm()
  f.location.pathname = '/a/chat/s/created-chat'
  f.replace([turn('2', code(requestJson))])
  f.settle()
  assert.equal(f.requests()[0].pagePath, '/a/chat/s/created-chat')
  f.confirm('clarification')
  f.replace([turn('2', code(requestJson)), turn('4', code(requestJson))])
  f.settle()
  assert.equal(f.requests()[1].sourceSubmissionId, goal)
})

test('malformed, mixed and multiple computer envelopes cannot fall through to legacy tools', () => {
  const cases = [
    ['{"type":"computer","command":"must-not-run",}', 'invalid-json'],
    [requestJson + '\n' + JSON.stringify({ command: 'must-not-run', description: 'x' }), 'ambiguous-request'],
    [requestJson + '\n' + requestJson, 'ambiguous-request'],
    [JSON.stringify({ type: 'computer', version: 1, action: 'observe', command: 'must-not-run', questions: ['x'], files: [] }), null]
  ]
  for (const [raw, issue] of cases) {
    const f = pageFixture()
    f.confirm()
    f.replace([turn('2', code(raw))])
    f.settle()
    assert.equal(f.requests().length, 1)
    assert.equal(f.requests()[0].rawJson, raw)
    assert.equal(f.requests()[0].computerIssue, issue)
    assert.equal(f.actions().length, 0)
    assert.equal(f.events.some(event => event.event === 'parse-failed'), false, 'never starts legacy command recovery')
  }
})

test('duplicate fields and escaped discriminators remain unchanged for strict protocol validation', () => {
  for (const raw of ['{"type":"computer","action":"observe","action":"click"}',
    String.raw`{"ty\u0070e":"comp\u0075ter","action":"observe"}`]) {
    const f = pageFixture()
    f.confirm()
    f.replace([turn('2', code(raw))])
    f.settle()
    assert.equal(f.requests()[0].rawJson, raw)
    assert.equal(f.actions().length, 0)
  }
})

test('the page runs the shared strict validator and reports its diagnostic without altering raw bytes', () => {
  const currentToken = 'cu_' + 'a'.repeat(32)
  const definition = { action: 'observe', description: 'Synthetic', parameters: [], example: {} }
  const base = { type: 'computer', version: 1, action: 'observe', step_token: currentToken }
  const cases = [
    [JSON.stringify(base), null],
    [JSON.stringify({ ...base, version: 2 }), 'unsupported_version'],
    [JSON.stringify({ ...base, step_token: 'cu_' + 'b'.repeat(32) }), 'stale_step_token'],
    [JSON.stringify(base).replace(/}$/, ',"action":"observe"}'), 'duplicate_field'],
    [JSON.stringify({ ...base, x: 1 }), 'invalid_parameters']
  ]
  for (const [raw, expected] of cases) {
    const f = pageFixture()
    f.controller.configure({ computerProtocol: { definitions: [definition], stepToken: currentToken } })
    f.confirm(); f.replace([turn('2', code(raw))]); f.settle()
    assert.equal(f.requests()[0].computerProtocolCode, expected)
    assert.equal(f.requests()[0].rawJson, raw)
    assert.equal(f.actions().length, 0)
  }
})

test('a cut-off answer is never accepted after the existing continue retry limit', () => {
  const f = pageFixture()
  f.confirm()
  // Exhaustion lets legacy prose settle, but the persistent Continue control is still
  // evidence that computer JSON is unfinished.
  const button = element('div', { role: 'button' }, '继续生成')
  f.replace([turn('2', [code(requestJson), button])])
  for (let index = 0; index < 7; index++) { f.scan(); f.advance(5000); f.tick(5000); f.tick(250) }
  assert.equal(f.requests().length, 0)
})

test('a disabled computer tool still claims its envelopes, while legacy command handling stays available', () => {
  const f = pageFixture()
  f.confirm()
  f.controller.configure({ computerUseEnabled: false })
  f.replace([turn('2', code('{"type":"computer","command":"must-not-run"}'))])
  f.settle()
  assert.equal(f.requests().length, 0)
  assert.equal(f.actions().length, 0)
  f.replace([turn('4', code('{"command":"echo synthetic","description":"legacy","timeout_seconds":3}'))])
  f.controller.checkNow()
  assert.equal(f.actions()[0].event, 'command')
  assert.equal(f.actions()[0].command, 'echo synthetic')
})

function actualClass(path, className, names, globals = {}) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true)
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className)
  const methods = names.map(name => {
    const node = declaration.members.find(member => member.name?.getText(ast) === name)
    assert.ok(node, name)
    return node.getText(ast)
  }).join('\n')
  return new Script(compile(`class Actual { ${methods} }; Actual`)).runInNewContext({ structuredClone, URL, ...globals })
}
const Runtime = actualClass('../src/main/session-runtime.ts', 'SessionRuntime', ['receiveComputerUseRequest', 'syncAutonomousTask', 'advanceComputerUse'], {
  computerUseProtocol: protocol.computerUseProtocol
})
const Embed = actualClass('../src/main/embed.ts', 'ChatGptEmbed', ['handlePageReport', 'taskActionSource', 'invalidateComputerDocument', 'getComputerUsePageEpoch'], {
  randomUUID,
  INTERCEPTOR_LOG_TAG: '[cmd-terminal] ', console: { info() {}, warn() {} }, writeReplyDiagnostic() {}, writePromptDiagnostic() {},
  conversationIdOf: (platform, url) => platform.conversationIdFromPath(new URL(url).pathname)
})
function mainFixture(conversationId = 'chat-A') {
  const records = new Map(), writes = [], receipts = []
  const store = {
    autonomousTaskGeneration: () => Math.max(0, ...[...records.values()].map(task => task.generation)),
    autonomousTaskBySubmission: (_session, _platform, id) => [...records.values()].find(task => task.sourceSubmissionId === id) ?? null,
    latestAutonomousTask: (_session, _platform, id) => [...records.values()].filter(task => task.conversationId === id).sort((a, b) => b.generation - a.generation)[0] ?? null,
    saveAutonomousTasks(tasks) {
      for (const task of tasks) {
        const parsed = parseAutonomousTask(JSON.stringify(task))
        assert.ok(parsed)
        writes.push(parsed)
        records.set(task.id, parsed)
      }
    }
  }
  let progression
  const coordinator = new TaskCoordinator('session-A', store, () => progression?.reconcile())
  const capability = { scopeSupported: true, computerUseEnabled: true, available: false, desktopControlEnabled: false,
    actionDefinitions: [], actions: [], message: '桌面执行器尚未接入。', context: { sessionId: 'session-A', platformId: 'deepseek' } }
  const submit = (id = 'user:page:1') => coordinator.submit({
    platformId: 'deepseek', conversationId, submission: { id, kind: 'goal' }, text: '处理报表。', attachments: [], capability,
    machine: { id: 'machine-A', label: '本机', platform: 'win32', arch: 'x64', connection: 'local', workingDirectory: 'C:\\reports' }
  })
  const goal = submit()
  const entry = { platform: platforms.DEEPSEEK_PLATFORM, conversationId, embed: { getState: () => ({ conversationId: 'chat-A' }), getComputerUsePageEpoch: () => 'document-a' } }
  const runtime = Object.assign(new Runtime(), { id: 'session-A', active: true, disposed: false, activePlatformId: 'deepseek',
    embeds: new Map([['deepseek', entry]]), taskCoordinator: coordinator, backgroundTaskResults: { isSending: false }, getComputerUseCapability: () => capability,
    invokeComputerUseTool() { assert.fail('raw wire JSON must not invoke a desktop action') } })
  progression = new TaskProgression({ coordinator, isCurrent: lease => runtime.active && coordinator.owns(lease), canRun: () => true,
    invoke: async () => assert.fail('an unavailable backend must never receive a desktop call'),
    send: async () => 'busy', schedule: () => () => {}, onError: lease => coordinator.fail(lease.platformId, lease.conversationId) })
  runtime.taskProgression = progression
  let url = 'https://chat.deepseek.com/a/chat/s/chat-A'
  const embed = Object.assign(new Embed(), { platform: platforms.DEEPSEEK_PLATFORM, computerUseRecognitionEnabled: true,
    taskPromptGeneration: 3, computerPageEpoch: 'document-a', liveContents: () => ({ getURL: () => url }), interceptor: { pendingQuestion: null },
    getInterceptorStatus: () => ({}), handlers: {
      onComputerRequest(request) { receipts.push(request); return runtime.receiveComputerUseRequest('deepseek', request) }, onInterceptor() {}
    } })
  const event = { event: 'computer-request', messageId: 'computer:page:1', sourceSubmissionId: 'user:page:1',
    taskPromptGeneration: 3, computerPageEpoch: 'document-a', pagePath: '/a/chat/s/chat-A', rawJson: requestJson, computerOutcome: 'candidate', computerIssue: null, live: true }
  return { runtime, embed, coordinator, records, writes, receipts, event, goal, entry, submit,
    report(patch = {}) { embed.handlePageReport('[cmd-terminal] ' + JSON.stringify({ ...event, ...patch })) },
    setURL(value) { url = value }
  }
}

test('the actual bridge preserves recognition and returns a protocol result without running an unavailable desktop', () => {
  const f = mainFixture()
  f.report()
  const current = f.coordinator.current('deepseek')
  assert.equal(current.id, f.goal.id)
  assert.equal(current.generation, f.goal.generation)
  assert.equal(current.progress.computerRequest.rawJson, requestJson)
  assert.equal(current.progress.phase, 'waiting-delivery')
  assert.equal(current.progress.stepCount, 1)
  assert.equal(current.progress.currentStep.execution, 'not_executed')
  const count = f.writes.length
  f.report()
  assert.equal(f.writes.length, count, 'duplicate events cannot record another step')
})

test('a full document change rejects late events from the previous document on the same route', () => {
  const f = mainFixture(); let interrupted = 0
  f.embed.handlers.onComputerDocumentChanged = () => { interrupted++; f.coordinator.stop('deepseek', 'interrupted') }
  f.embed.invalidateComputerDocument(); assert.notEqual(f.embed.getComputerUsePageEpoch(), 'document-a')
  f.report(); assert.equal(f.receipts.length, 0); assert.equal(interrupted, 1)
  assert.equal(f.coordinator.current('deepseek'), null)
})

test('the bridge rejects stale generations, routes, origins, history events and oversized data', () => {
  const f = mainFixture()
  for (const patch of [{ live: false }, { taskPromptGeneration: 2 }, { computerPageEpoch: 'older-document' }, { computerPageEpoch: undefined }, { pagePath: '/a/chat/s/chat-B' },
    { rawJson: 'x'.repeat(64_001) }, { computerOutcome: 'unknown' }, { computerIssue: 'unrecognized' }]) f.report(patch)
  f.setURL('https://other.example/a/chat/s/chat-A')
  f.report()
  assert.equal(f.receipts.length, 0)
  assert.equal(f.writes.length, 1)
})

test('task ownership rejects a superseded source, inactive session, stopped goal or unsupported environment', () => {
  const f = mainFixture()
  f.submit('user:page:2')
  f.report()
  assert.equal(f.coordinator.current('deepseek').progress.computerRequest, undefined)
  f.runtime.active = false
  f.report({ sourceSubmissionId: 'user:page:2' })
  f.runtime.active = true
  f.coordinator.stop('deepseek')
  f.report({ sourceSubmissionId: 'user:page:2' })
  assert.equal(f.records.get(f.goal.id).status, 'superseded')
  assert.equal([...f.records.values()].some(task => task.progress.computerRequest), false)
  const g = mainFixture()
  g.runtime.getComputerUseCapability = () => ({ scopeSupported: false, computerUseEnabled: true })
  g.report()
  assert.equal(g.coordinator.current('deepseek').progress.computerRequest, undefined)
})

test('a first SPA reply binds the existing goal once, without restoring a different conversation', () => {
  const f = mainFixture(null)
  f.report()
  const task = f.coordinator.current('deepseek')
  assert.equal(task.id, f.goal.id)
  assert.equal(task.generation, f.goal.generation)
  assert.equal(task.conversationId, 'chat-A')
  assert.equal(task.progress.computerRequest.messageId, f.event.messageId)
})

test('restoring a recognition receipt retains history but never authorizes automatic execution', () => {
  const f = mainFixture()
  f.report()
  f.coordinator.stop('deepseek', 'interrupted')
  const saved = parseAutonomousTask(JSON.stringify(f.records.get(f.goal.id)))
  assert.equal(saved.status, 'interrupted')
  assert.equal(saved.progress.computerRequest.rawJson, requestJson)
  assert.equal(saved.progress.stepCount, 1)
  f.report()
  assert.equal(f.coordinator.current('deepseek'), null)
})
