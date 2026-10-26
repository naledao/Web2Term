// User-run only: node --test tests/focus-send-retry.test.mjs tests/focus-page.test.mjs
// Actual page helpers and runtime methods, synthetic DOM and input events only.
// No Electron launch, UI automation, shell command, user files or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const platformExports = {}
new Script(compile(readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8'))).runInNewContext({
  exports: platformExports, require: () => ({ isConversationId: () => true })
})
const pageSource = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function find(node, predicate) {
  if (predicate(node)) return node
  return ts.forEachChild(node, child => find(child, predicate))
}
function pageFunction(name, context, method = false) {
  const node = find(pageSource, node => method
    ? ts.isMethodDeclaration(node) && node.name.getText(pageSource) === name
    : ts.isVariableDeclaration(node) && node.name.getText(pageSource) === name)
  assert.ok(node, name)
  const code = method ? node.getText(pageSource).replace(/^(async )?/, '$1function ') : node.initializer.getText(pageSource)
  return new Script('(' + code + ')').runInContext(context)
}
function classMethod(relative, name, dependencies) {
  const source = ts.createSourceFile('class.ts', readFileSync(new URL(relative, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const node = find(source, node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)
  assert.ok(node, name)
  return new Script(compile('class Fixture {' + node.getText(source) + '}\nnew Fixture()')).runInNewContext(dependencies)
}
const errorText = '消息发送过于频繁，请稍后重试'
const controlSelector = platformExports.DEEPSEEK_PAGE.focus.sendFailure.controlSelector
class Element {
  children = []
  parentElement = null
  visible = true
  disabled = false
  quoted = false
  control = false
  constructor(text = '', order = 0, attrs = {}) { this.text = text; this.order = order; this.attrs = attrs }
  get innerText() { return this.text + this.children.map(child => child.innerText).join('\n') }
  append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; return this }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  getAttribute(name) { return this.attrs[name] ?? null }
  querySelectorAll(selector) {
    const nodes = this.children.flatMap(child => [child, ...child.querySelectorAll('*')])
    return selector === '*' ? nodes : selector === controlSelector ? nodes.filter(node => node.control) : []
  }
  closest() { return this.quoted ? this : this.parentElement?.closest() ?? null }
  compareDocumentPosition(other) { return this.order < other.order ? 4 : 2 }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 20, top: 40, width: 30, height: 30 } }
  click() { throw new Error('Native retry must never synthesize a click') }
}
function fixture() {
  const retry = new Element('', 1), error = new Element(errorText, 3)
  retry.control = true
  const copy = new Element('', 4, { 'aria-label': '复制' }), edit = new Element('', 5, { 'aria-label': '编辑' })
  copy.control = edit.control = true
  const row = new Element('', 0, { 'data-virtual-list-item-key': '12' }).append(retry, new Element('命令结果：OK', 2), error, copy, edit)
  row.key = 'user-result'
  const world = { rows: [row], hit: retry, stop: null, assistant: 'previous-command', tick() {} }
  const listeners = new Set(), waiting = [], composer = { draft: '' }
  let clock = 0
  const context = createContext({
    PAGE: platformExports.DEEPSEEK_PAGE, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    state: { taskPromptGeneration: 1, programmatic: false, awaitingReplySince: 100, taskActive: true, replyActionDetected: true },
    focusSendRetry: null, focusEditing: null, fileSend: null,
    Date: { now: () => clock }, location: { pathname: '/a/chat/s/one' },
    setTimeout(resolve, delay) { clock += delay; Promise.resolve().then(() => { world.tick(); resolve() }) },
    queryAllMessages: () => world.rows, isVisibleElement: node => node.visible,
    isAssistantTurn: node => !!node.assistant, turnKeyOf: node => node.key,
    collapse: text => String(text ?? '').replace(/\s+/g, ' ').trim(), controlDisabled: node => node.disabled,
    getComposer: () => composer, readComposer: node => node.draft,
    findStopButton: () => world.stop, lastAssistantId: () => world.assistant,
    draftAttachmentEvidence: () => false, hasDraftImageAttachment: () => false,
    setReplyWaiting: (...args) => waiting.push(args), scheduleScrollToBottom() {},
    insertText() { throw new Error('Never replace the composer on retry') },
    submitWithRetry() { throw new Error('Never submit a new message on retry') },
    document: {
      elementFromPoint: () => world.hit,
      addEventListener(type, callback) { assert.equal(type, 'click'); listeners.add(callback) },
      removeEventListener(type, callback) { assert.equal(type, 'click'); listeners.delete(callback) }
    }
  })
  context.focusSendFailureOf = pageFunction('focusSendFailureOf', context)
  context.releaseFocusSendRetry = pageFunction('releaseFocusSendRetry', context)
  const prepare = pageFunction('prepareFocusSendRetry', context, true), finish = pageFunction('finishFocusSendRetry', context, true)
  return { context, world, row, retry, error, composer, listeners, waiting,
    failure: () => context.focusSendFailureOf(),
    prepare: (id = context.focusSendFailureOf()?.data.id, pathname = context.location.pathname) => prepare(id, pathname, 'retry-token'),
    finish: dispatched => finish('retry-token', dispatched),
    click: (trusted = true) => { for (const callback of listeners) callback({ isTrusted: trusted, target: retry }) }
  }
}

test('reads the newest rejected user message and excludes its later copy/edit actions', () => {
  const f = fixture(), failure = f.failure()
  assert.equal(failure.data.message, errorText)
  assert.equal(failure.button, f.retry)
  assert.equal(failure.data.retryable, true)
  assert.equal(f.failure().data.id, failure.data.id)
  assert.equal(f.listeners.size, 0, 'reading the state never arms a click')
})
test('quoted errors, older failures and ambiguous retry controls cannot trigger a native retry', () => {
  const quoted = fixture(); quoted.error.quoted = true
  assert.equal(quoted.failure(), null)
  const old = fixture(); old.world.rows.push(Object.assign(new Element('新回答', 10), { assistant: true }))
  assert.equal(old.failure(), null)
  const ambiguous = fixture(), other = new Element('', 2); other.control = true
  ambiguous.row.append(other)
  assert.equal(ambiguous.failure().data.retryable, false)
  assert.equal(ambiguous.prepare().ok, false)
  const disabled = fixture(); disabled.retry.disabled = true
  assert.equal(disabled.failure().data.retryable, false)
})
test('stale messages, changed conversations, drafts, generation and busy sends are protected', () => {
  for (const condition of ['id', 'path', 'draft', 'generating', 'busy', 'covered', 'upload', 'question']) {
    const f = fixture()
    const id = f.failure().data.id
    if (condition === 'draft') f.composer.draft = '保留草稿'
    if (condition === 'generating') f.world.stop = {}
    if (condition === 'busy') f.context.state.programmatic = true
    if (condition === 'covered') f.world.hit = new Element('遮挡')
    if (condition === 'upload') f.context.fileSend = {}
    if (condition === 'question') f.context.state.pendingQuestion = {}
    assert.equal(f.prepare(condition === 'id' ? 'old-id' : id, condition === 'path' ? '/other' : undefined).ok, false, condition)
    assert.equal(f.listeners.size, 0, condition)
    assert.equal(f.waiting.length, 0, condition)
  }
})
test('one trusted retry resumes waiting only after native generation is confirmed', async () => {
  const f = fixture(), point = f.prepare()
  assert.equal(point.ok, true)
  assert.equal(point.x, 35); assert.equal(point.y, 55)
  assert.equal(f.context.state.programmatic, true)
  assert.equal(f.prepare().outcome, 'busy', 'a double click cannot arm a second retry')
  f.click()
  f.world.tick = () => { f.world.rows = []; f.world.stop = {} }
  assert.equal(await f.finish(true), 'ok')
  assert.equal(f.waiting.length, 1)
  assert.equal(f.waiting[0][1], 'message-retry')
  assert.equal(f.context.state.programmatic, false)
  assert.equal(f.context.state.replyActionDetected, false)
  assert.equal(f.listeners.size, 0)
})
test('rejection persists without automatic retries and an untrusted click cannot confirm delivery', async () => {
  const rejected = fixture(); rejected.prepare(); rejected.click()
  assert.equal(await rejected.finish(true), 'stuck')
  assert.equal(rejected.waiting.length, 0)
  assert.equal(rejected.listeners.size, 0)
  const untrusted = fixture(); untrusted.prepare(); untrusted.click(false)
  untrusted.world.tick = () => { untrusted.world.rows = []; untrusted.world.stop = {} }
  assert.equal(await untrusted.finish(true), 'unknown')
  assert.equal(untrusted.waiting.length, 0)
  assert.equal(untrusted.listeners.size, 0)
})
test('changing the owner or cancelling an armed input releases its temporary state', async () => {
  const moved = fixture(); moved.prepare(); moved.click()
  moved.world.tick = () => { moved.context.location.pathname = '/other' }
  assert.equal(await moved.finish(true), 'cancelled')
  assert.equal(moved.context.state.programmatic, false)
  assert.equal(moved.waiting.length, 0)
  const cancelled = fixture(); cancelled.prepare()
  assert.equal(await cancelled.finish(false), 'cancelled')
  assert.equal(cancelled.listeners.size, 0)
  assert.equal(cancelled.context.state.programmatic, false)
})

test('the embed dispatches exactly one owned, zoom-corrected native click and cancels stale owners', async () => {
  for (const changedOwner of [false, true]) {
    let owned = true
    const inputs = [], scripts = [], view = {}
    const contents = {
      getURL: () => 'https://chat.deepseek.com/a/chat/s/one', isDestroyed: () => false, getZoomFactor: () => 1.5,
      sendInputEvent: event => inputs.push(event),
      async executeJavaScript(script) {
        scripts.push(script)
        if (script.includes('prepareFocusSendRetry')) {
          if (changedOwner) owned = false
          return { ok: true, x: 20, y: 40 }
        }
        return script.includes(',true)') ? 'ok' : 'cancelled'
      }
    }
    const embed = classMethod('../src/main/embed.ts', 'retryFocusSend', {
      randomUUID: () => 'native-token', BrowserWindow: { getFocusedWindow: () => ({ contentView: { children: [view] } }) }
    })
    Object.assign(embed, { focusPage: () => contents, platform: { page: { focus: { sendFailure: {} } } }, view })
    assert.equal(await embed.retryFocusSend('failure-id', () => owned), changedOwner ? 'cancelled' : 'ok')
    assert.equal(inputs.length, changedOwner ? 0 : 3)
    for (const event of inputs) { assert.equal(event.x, 30); assert.equal(event.y, 60) }
    assert.ok(scripts.at(-1).includes(',false)'), 'the page lock is released even after a workspace switch')
    assert.equal(embed.focusEditToken, null)
  }
})
test('the runtime retries message delivery without calling a terminal execution method', async () => {
  let release
  const calls = [], owner = { sessionId: 'one', platformId: 'deepseek', conversationId: 'chat' }
  const runtime = classMethod('../src/main/session-runtime.ts', 'retryFocusSend', { writeFocusDiagnostic() {} })
  Object.assign(runtime, {
    ownsFocus: value => value === owner,
    runner: new Proxy({}, { get(_target, property) {
      assert.equal(property, 'hasInFlightWork', 'retry must not execute or replay a shell command')
      return () => false
    } }),
    embed: { retryFocusSend(id, owns) { calls.push(id); assert.equal(owns(), true); return new Promise(resolve => { release = resolve }) } }
  })
  const first = runtime.retryFocusSend(owner, 'failure-id')
  assert.equal(await runtime.retryFocusSend(owner, 'failure-id'), 'busy')
  release('ok')
  assert.equal(await first, 'ok')
  assert.deepEqual(calls, ['failure-id'])
  assert.equal(runtime.focusSending, false)
})
