// User-run only: node --test tests/chatgpt-response-preference.test.mjs
// Actual injected script with synthetic DOM/time; no Electron, real session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const platforms = {}
new Script(ts.transpileModule(readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: platforms, require(name) {
  assert.equal(name, './types')
  return { chatgptConversationIdFromPath: () => null, isConversationId: () => false }
} })
const rules = platforms.CHATGPT_PAGE.responsePreference
const script = new Script(readFileSync(new URL('../src/main/injected/response-preference.js', import.meta.url), 'utf8'))

function fixture({ config = rules, language = 'zh', titleTag = 'h2', wrappedTitle = false } = {}) {
  let now = 10_000, serial = 0, covered = false
  const timers = new Map(), observers = [], events = []
  let html
  class Element {
    constructor(tag, text = '', attrs = {}) {
      Object.assign(this, { tag, text, attrs, children: [], parentElement: null, clicks: 0, style: {} })
    }
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this)
      this.parentElement = null
    }
    matches(selectors) {
      return selectors.split(',').some(value => {
        const selector = value.trim()
        const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
        if (attribute) return attribute[1] in this.attrs && (attribute[2] === undefined || this.attrs[attribute[1]] === attribute[2])
        return selector.startsWith('#') ? this.attrs.id === selector.slice(1) : this.tag === selector
      })
    }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    get isConnected() { return html.contains(this) }
    get disabled() { return 'disabled' in this.attrs }
    get textContent() { return this.text + this.children.map(child => child.textContent).join('') }
    get innerText() { return this.textContent }
    getClientRects() {
      for (let node = this; node; node = node.parentElement) if (node.style.display === 'none' || 'hidden' in node.attrs) return []
      return this.isConnected ? [{}] : []
    }
    getBoundingClientRect() { return { left: 10, top: 10, width: 100, height: 30 } }
    click() { this.clicks++; this.onClick?.() }
  }
  const el = (tag, text = '', attrs) => new Element(tag, text, attrs)
  html = el('html')
  const body = el('body'), main = el('main'), survey = el('div')
  html.append(body); body.append(main); main.append(survey)
  const en = language === 'en'
  const title = el(titleTag, wrappedTitle ? '' : en ? 'Which response do you prefer?' : '你更喜欢哪个选项?')
  if (wrappedTitle) title.append(el('span', en ? 'Which response do you prefer?' : '你更喜欢哪个选项？'))
  const skip = el('button', en ? 'Skip' : '跳过'), choose = el('button', en ? 'I prefer this response' : '我更喜欢这个选项')
  const actions = el('div'); actions.append(skip, choose); survey.append(title, actions)
  const mutate = () => { for (const observer of observers) if (observer.active) observer.callback([]) }
  const context = createContext({
    window: {}, location: { pathname: '/c/conversation-one' }, Date: { now: () => now },
    document: { documentElement: html, querySelectorAll: selector => html.querySelectorAll(selector),
      elementFromPoint: () => covered ? body : skip },
    getComputedStyle: element => ({ display: element.style.display || 'block', visibility: element.style.visibility || 'visible' }),
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() { this.active = true }
      disconnect() { this.active = false }
    },
    console: { info: message => events.push(message) }
  })
  script.runInContext(context)
  const configure = value => context.window.__cmdTerminalResponsePreference.configure(value)
  configure(config)
  return { body, main, survey, title, skip, choose, actions, el, mutate, events, context, configure,
    timers, observers, cover: value => { covered = value }, reinject: () => script.runInContext(context),
    advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0]); now = next[1].at; next[1].callback()
      }
      now = end
    }
  }
}

test('the Chinese survey in the screenshot is skipped after settling, without selecting a response', () => {
  for (const [titleTag, wrappedTitle] of [['h2', false], ['div', true]]) {
    const f = fixture({ titleTag, wrappedTitle })
    f.skip.onClick = () => { f.survey.remove(); f.mutate() }
    f.advance(500)
    assert.equal(f.skip.clicks, 0, 'allow React to attach the survey handlers')
    f.advance(100)
    assert.equal(f.skip.clicks, 1)
    assert.equal(f.choose.clicks, 0)
    f.advance(10_000)
    assert.equal(f.skip.clicks, 1)
    assert.match(f.events[0], /skip-clicked/)
  }
})

test('an English survey also uses only its Skip action', () => {
  const f = fixture({ language: 'en' })
  f.advance(600)
  assert.equal(f.skip.clicks, 1)
  assert.equal(f.choose.clicks, 0)
})

test('ordinary Skip buttons, incomplete surveys and ambiguous actions are untouched', () => {
  for (const alter of [f => f.title.remove(), f => f.choose.remove(),
    f => { f.title.text = '跳过这一步' }, f => f.actions.append(f.el('button', '跳过'))]) {
    const f = fixture(); alter(f); f.advance(10_000)
    assert.equal(f.skip.clicks, 0)
    assert.equal(f.choose.clicks, 0)
  }
})

test('quoted survey controls and matching text inside replies, code or the composer are ignored', () => {
  for (const attrs of [{ 'data-message-author-role': 'assistant' }, { 'data-chatgpt-selection-message-id': 'answer' },
    { 'data-content-search-unit-key': 'turn:assistant' }, { 'data-markdown-text-style': 'assistant-message' }, { contenteditable: 'true' }]) {
    const f = fixture(); Object.assign(f.survey.attrs, attrs); f.advance(10_000)
    assert.equal(f.skip.clicks, 0)
  }
  const f = fixture(); const code = f.el('pre'); f.main.append(code); code.append(f.title); f.advance(10_000)
  assert.equal(f.skip.clicks, 0, 'a quoted title cannot authorize a separate Skip button')
})

test('hidden, disabled, inert and covered surveys are not clicked', () => {
  for (const alter of [f => { f.survey.attrs.hidden = '' }, f => { f.survey.attrs.inert = '' },
    f => { f.survey.attrs['aria-hidden'] = 'true' }, f => { f.skip.attrs.disabled = '' },
    f => { f.skip.attrs['aria-disabled'] = 'true' }, f => { f.skip.style.visibility = 'hidden' },
    f => { f.survey.style.display = 'none' }, f => f.cover(true)]) {
    const f = fixture(); alter(f); f.advance(10_000)
    assert.equal(f.skip.clicks, 0)
  }
})

test('a survey appearing later is detected even while unrelated streaming mutations continue', () => {
  const f = fixture(); f.survey.remove(); f.advance(1000)
  assert.equal(f.skip.clicks, 0)
  f.main.append(f.survey)
  for (let index = 0; index < 15; index++) { f.mutate(); f.advance(50) }
  assert.equal(f.skip.clicks, 1)
})

test('a control replaced during hydration must settle before it can be clicked', () => {
  const f = fixture(); f.advance(200)
  const old = f.skip, replacement = f.el('button', '跳过')
  old.remove(); f.actions.append(replacement)
  f.context.document.elementFromPoint = () => replacement
  f.mutate(); f.advance(400)
  assert.equal(old.clicks, 0)
  assert.equal(replacement.clicks, 0)
  f.advance(400)
  assert.equal(replacement.clicks, 1)
  assert.equal(f.choose.clicks, 0)
})

test('ignored clicks have a bounded retry budget and reinjection never stacks observers', () => {
  const f = fixture(); f.reinject(); f.configure(rules); f.advance(10_000)
  assert.equal(f.skip.clicks, 3)
  assert.equal(f.choose.clicks, 0)
  assert.equal(f.observers.length, 1)
  assert.equal(f.timers.size, 0)
  f.configure(rules); f.advance(10_000)
  assert.equal(f.skip.clicks, 3, 'reconfiguring the same visible survey must not restart retries')
})

test('disabling the rules cancels a pending click, and other platforms have no rules', () => {
  for (const platform of platforms.CHAT_PLATFORMS.filter(platform => platform.id !== 'chatgpt')) {
    assert.equal(platform.page.responsePreference, undefined)
  }
  const f = fixture(); f.advance(200); f.configure(null); f.advance(10_000)
  assert.equal(f.skip.clicks, 0)
  assert.equal(f.observers.filter(observer => observer.active).length, 0)
})
