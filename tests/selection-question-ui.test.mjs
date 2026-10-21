// User-run only: node --test tests/selection-question-ui.test.mjs
// Exercises the actual injected script in a synthetic DOM. No Electron or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/injected/selection-question.js', import.meta.url), 'utf8')
const platformExports = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: platformExports, require: () => ({}) })

function fixture({ popoverError = false, platformId = 'gemini', codeOnly = false, userTurn = false, control = false } = {}) {
  const timers = new Map(), reports = [], elements = []
  let serial = 0
  const schedule = callback => { const id = ++serial; timers.set(id, callback); return id }
  const target = () => ({ listeners: new Map(), addEventListener(name, callback) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), callback])
  } })
  class Element {
    nodeType = 1
    isConnected = true
    style = {}
    dataset = {}
    attributes = {}
    children = []
    hidden = false
    value = ''
    innerText = ''
    constructor(tag) { this.tagName = tag.toUpperCase(); Object.assign(this, target()); elements.push(this) }
    append(...nodes) {
      for (const value of nodes) {
        const node = typeof value === 'string' ? { nodeType: 3, textContent: value } : value
        this.children.push(node); node.parentElement = this
      }
    }
    // Model Gemini's Trusted Types restriction on string HTML sinks.
    set innerHTML(_value) { throw new TypeError('This document requires TrustedHTML assignment') }
    setAttribute(name, value) { this.attributes[name] = value }
    removeAttribute(name) { delete this.attributes[name] }
    matches(selector) {
      if (selector === ':popover-open') return !!this.open
      if (selector === this.tagName.toLowerCase()) return true
      if (selector.startsWith('.')) return this.attributes.class?.split(' ').includes(selector.slice(1)) || false
      const match = /^\[([\w-]+)(?:(\*?=)"([^"]*)")?\]$/.exec(selector)
      if (!match || !(match[1] in this.attributes)) return false
      return !match[2] || (match[2] === '*=' ? this.attributes[match[1]].includes(match[3]) : this.attributes[match[1]] === match[3])
    }
    closest(selectors) {
      for (let node = this; node; node = node.parentElement) {
        if (selectors.split(',').some(selector => node.matches?.(selector.trim()))) return node
      }
      return null
    }
    contains(node) { return node === this || this.children.some(child => child === node || child.contains?.(node)) }
    querySelectorAll(selector) { return this.children.filter(child => child.nodeType === 1).flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
    ]) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    attachShadow() {
      const shadow = new Element('shadow-root')
      this.shadow = shadow
      return shadow
    }
    getBoundingClientRect() { return { left: 10, top: 10, width: 360, height: 180 } }
    showPopover() {
      if (popoverError) throw Object.assign(new Error('synthetic private page data'), { name: 'NotSupportedError' })
      this.open = true
    }
    hidePopover() { this.open = false }
    blur() {}
  }
  const body = new Element('body'), answer = new Element(platformId === 'claude' ? 'div' : 'message-content'), span = new Element(control ? 'button' : 'span')
  const page = platformId === 'claude' ? platformExports.CLAUDE_PAGE : platformExports.GEMINI_PAGE
  const turn = platformId === 'claude' ? new Element('div') : answer
  if (platformId === 'claude') {
    turn.setAttribute('data-testid', userTurn ? 'user-message' : 'assistant-message')
    if (!codeOnly) answer.setAttribute('class', 'font-claude-response')
  }
  answer.innerText = 'A synthetic answer for selection.'
  turn.innerText = platformId === 'claude' ? 'Claude responded: ' + answer.innerText : answer.innerText
  const textNode = { nodeType: 3, parentElement: span }
  span.append(textNode); answer.append(span)
  if (turn !== answer) turn.append(answer)
  body.append(turn)
  const expectedAnswer = codeOnly ? turn : answer
  const range = { startContainer: textNode, endContainer: textNode, startOffset: 2, endOffset: 11,
    cloneRange() { return this }, toString: () => 'synthetic',
    getClientRects: () => [{ left: 100, right: 200, top: 100, bottom: 120, width: 100, height: 20 }] }
  const selection = { anchorNode: textNode, focusNode: textNode, focusOffset: 11, rangeCount: 1, isCollapsed: false,
    toString: () => 'synthetic', getRangeAt: () => range }
  const window = { ...target(), getSelection: () => selection,
    __cmdTerminalInterceptor: { questionSourceMessageId: node => node === expectedAnswer ? 'synthetic-capture-key' : null } }
  const document = { ...target(), body, activeElement: body, documentElement: { clientWidth: 1200, clientHeight: 900 },
    createElement: tag => new Element(tag), createElementNS: (_namespace, tag) => new Element(tag),
    querySelectorAll: selector => elements.filter(element => element.matches(selector)) }
  const context = { window, document, Node: { ELEMENT_NODE: 1 }, location: { pathname: platformId === 'claude'
    ? '/chat/fa4e73a6-92b9-4b7b-832c-2de7b09e48bd' : '/app/0123456789abcdef' },
    setTimeout: schedule, clearTimeout: id => timers.delete(id), requestAnimationFrame: schedule, cancelAnimationFrame: id => timers.delete(id),
    console: { log: line => reports.push(JSON.parse(line.slice('[synthetic-question] '.length))) } }
  const script = new Script(source)
  script.runInNewContext(context)
  window.__cmdTerminalSelectionQuestion.configure({
    answerSelectors: page.assistantReplySelectors.length ? page.assistantReplySelectors : page.assistantSelectors,
    answerFallbackSelectors: page.assistantRoleSelectors ?? [], reportTag: '[synthetic-question] ', css: '', theme: 'light'
  })
  const dispatch = (surface, name, extra = {}) => {
    const event = { target: span, button: 0, buttons: 0, composedPath: () => [span, answer, body, document, window],
      stopImmediatePropagation() {}, preventDefault() {}, ...extra }
    for (const callback of surface.listeners.get(name) || []) callback(event)
  }
  return { window, document, answer, turn, textNode, range, reports,
    host: () => body.children.find(element => element.id === 'cmd-terminal-selection-question'),
    down() { dispatch(window, 'pointerdown'); dispatch(document, 'pointerdown') },
    release: (name = 'pointerup') => dispatch(window, name),
    selectionChange: () => dispatch(document, 'selectionchange'),
    reinject: () => script.runInNewContext(context),
    flush() { for (let count = 0; timers.size && count < 20; count++) { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()) } },
    submit() {
      const host = this.host(), input = host.shadow.querySelector('.question-input')
      input.value = 'Synthetic follow-up question'
      document.activeElement = host; host.shadow.activeElement = input
      dispatch(window, 'keydown', { key: 'Enter', isTrusted: true, composedPath: () => [host, body, document, window] })
    }
  }
}

test('Gemini selection opens with TrustedHTML sinks blocked and document-level pointerup intercepted', () => {
  const app = fixture()
  app.down(); app.selectionChange(); app.flush()
  assert.equal(app.host(), undefined, 'do not open while still dragging')
  app.release(); app.flush()
  assert.equal(app.host().open, true)
  assert.equal(app.host().shadow.querySelector('.question-input').tagName, 'TEXTAREA')
  assert.equal(app.host().shadow.querySelector('.question-close').attributes['aria-label'], '关闭询问 AI')
  assert.equal(app.window.__cmdTerminalSelectionQuestion.getDraft().selectedText, 'synthetic')
  assert.ok(app.reports.some(report => report.phase === 'shown'))
  app.submit()
  assert.ok(app.reports.some(report => report.event === 'question-submit'))
  assert.equal(app.window.__cmdTerminalSelectionQuestion.getSubmission().question, 'Synthetic follow-up question')
  assert.equal(JSON.stringify(app.reports).includes('Synthetic follow-up question'), false)
})

test('mouseup recovers a lost pointerup and repeated injection keeps one event handler', () => {
  const app = fixture()
  app.reinject()
  assert.equal(app.window.listeners.get('pointerup').length, 1)
  app.down(); app.release('mouseup'); app.flush()
  assert.equal(app.host().open, true)
  app.release(); app.flush()
  assert.equal(app.reports.filter(report => report.phase === 'shown').length, 1)
})

test('a selection crossing answer boundaries is rejected with metadata rather than message content', () => {
  const app = fixture()
  app.range.endContainer = { nodeType: 3, parentElement: { closest: () => null } }
  app.down(); app.release(); app.flush()
  assert.equal(app.host(), undefined)
  const rejected = app.reports.find(report => report.phase === 'answer-rejected')
  assert.equal(rejected.startAnswerFound, true)
  assert.equal(rejected.endAnswerFound, false)
  assert.equal(rejected.selectedLength, 9)
  assert.equal('selectedText' in rejected, false)
})

test('popover failures are diagnosed without recording the page exception text', () => {
  const app = fixture({ popoverError: true })
  app.down(); app.release(); app.flush()
  assert.ok(app.reports.some(report => report.phase === 'selection-error' && report.errorName === 'NotSupportedError'))
  assert.ok(app.reports.some(report => report.errorStage === 'popover-open' && report.trustedTypesBlocked === false))
  assert.equal(JSON.stringify(app.reports).includes('synthetic private page data'), false)
})

test('Claude prose and code-only selections use the same answer root and capture identity as the local transcript', () => {
  for (const codeOnly of [false, true]) {
    const app = fixture({ platformId: 'claude', codeOnly })
    app.down(); app.release(); app.flush()
    assert.equal(app.host().open, true)
    app.submit()
    const submission = app.window.__cmdTerminalSelectionQuestion.getSubmission()
    assert.equal(submission.sourceMessageId, 'synthetic-capture-key')
    assert.equal(submission.answerText, codeOnly ? app.turn.innerText : app.answer.innerText)
    assert.equal(submission.sourcePath, '/chat/fa4e73a6-92b9-4b7b-832c-2de7b09e48bd')
  }
})

test('Claude user messages and assistant action controls never open the selection popup', () => {
  for (const options of [{ userTurn: true }, { codeOnly: true, userTurn: true }, { codeOnly: true, control: true }]) {
    const app = fixture({ platformId: 'claude', ...options })
    app.down(); app.release(); app.flush()
    assert.equal(app.host(), undefined)
    assert.ok(app.reports.some(report => report.phase === 'answer-rejected'))
  }
})

test('Claude preferred answer scope excludes surrounding text and ranges crossing assistant turns', () => {
  for (const crossing of [false, true]) {
    const app = fixture({ platformId: 'claude' })
    const endParent = crossing ? new app.turn.constructor('div') : app.turn
    if (crossing) endParent.setAttribute('data-testid', 'assistant-message')
    app.range.endContainer = { nodeType: 3, parentElement: endParent }
    app.down(); app.release(); app.flush()
    assert.equal(app.host(), undefined)
    assert.ok(app.reports.some(report => report.phase === 'answer-rejected'))
  }
})
