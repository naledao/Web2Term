/**
 * User-run ChatGPT reasoning-structure capture, for the focus view's 思考过程.
 *
 * The focus view reads ChatGPT's answer through the measured CHATGPT_PAGE selectors, but
 * the "Thought for …" block has never been measured, so `focus.reasoningSelectors` is
 * empty. This probe records WHERE that block sits relative to the measured turn and
 * answer elements, what marks it, and how it changes while streaming, expanding and
 * collapsing. The user chats and clicks; the probe only reads.
 *
 * Run instructions: chatgpt-reasoning-probe.md. Never run this as an agent.
 */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const vm = require('node:vm')

const ORIGIN = 'https://chatgpt.com'
const PARTITION = process.env.PROBE_PARTITION || 'persist:chatgpt'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) {
  throw new Error('PROBE_START_URL 必须是 https://chatgpt.com 的页面。')
}
app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
const logPath = path.join(directory, 'chatgpt-reasoning-' + stamp + '.log')
const EVENT_TAG = '[chatgpt-reasoning-' + randomUUID() + '] '
const OBSERVER_KEY = '__chatgptReasoningProbe_' + randomUUID().replace(/-/g, '')
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

/** Synchronous append: a write stream can lose the end of a run when the window closes. */
function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data })
  try { fs.appendFileSync(logPath, line + '\n', 'utf8') }
  catch { console.error('诊断日志写入失败：', logPath) }
  if (!['SNAPSHOT', 'STRUCTURE', 'PAGE-EVENT'].includes(event)) console.log(line)
}

function routeForLog(value) {
  try {
    const url = new URL(value)
    const match = /^\/(?:g\/[^/]+\/)?c\/([^/]+)/.exec(url.pathname)
    return { origin: url.origin, kind: match ? 'conversation' : url.pathname === '/' ? 'home' : 'other', conversationAlias: match ? digest(match[1]) : null }
  } catch { return { kind: 'unavailable' } }
}

/** Self-contained page function: no page mutations, storage, credentials or fetches. */
function inspectReasoning() {
  // Independent copies of the shipped CHATGPT_PAGE selectors (src/shared/platforms.ts).
  // Change them together; a miss means "absent right now", not by itself "broken".
  const ID_TURN = '[data-chatgpt-selection-message-id]'
  const ANSWER = '[data-markdown-text-style="assistant-message"]'
  const UNIT_ASSISTANT = '[data-content-search-unit-key$=":assistant"]'
  const TURN_GROUP = '[data-content-search-turn-key]'
  const STOP = ['[data-composer-footer-responsive] button[aria-label="停止"]', 'button[aria-label="停止"]', '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="停止生成"]']
  // REASONING_LIKE finds candidates; only REASONING_SAFE text is ever written verbatim. A
  // header such as "Thinking about <topic>" is model output, so it is reduced to its length.
  // 2026-10-22 screenshots: the agent-style header reads 已处理 23秒, with 跳过 beside it and
  // steps such as 正在搜索 8 个网站. A step title like 编写监控程序 is model output: length only.
  const REASONING_LIKE = /^(已思考|思考了|思考中|正在思考|深度思考|已推理|推理中|正在推理|已处理|处理中|正在处理|正在搜索|已搜索|搜索了|Thinking|Thought for|Thought|Reasoned for|Reasoning|Worked for|Working|Searching|Searched)/i
  const REASONING_SAFE = /^(?:(?:已思考|思考了|已推理|推理了|已处理|处理了)\s*(?:用时)?\s*(?:[\d.]+\s*(?:秒|秒钟|分钟|分|s|m)\s*)+|(?:Thought|Reasoned|Worked) for (?:[\d.]+\s*(?:s|sec|secs|seconds?|m|min|minutes?)\s*)+|(?:正在搜索|已搜索|搜索了)\s*\d+\s*个(?:网站|来源|网页)|(?:Searching|Searched)\s*\d+\s*(?:sites?|sources?|websites?)|思考中|正在思考|深度思考|推理中|正在推理|处理中|正在处理|Thinking|Reasoning|Working)[.…]*$/i
  const UI_LABEL = /^(发送|停止|停止生成|重新生成|复制|编辑|分享|搜索|展开|收起|显示更多|显示更少|跳过|Send|Stop|Copy|Edit|Share|Search|Show more|Show less|Expand|Collapse|Skip)$/i
  const NAME_HINT = /reason|thought|think|cot|summar|collaps|expand|disclos|accordion/i
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const label = value => {
    const text = collapse(value)
    if (!text) return ''
    if (text.length <= 40 && (REASONING_SAFE.test(text) || UI_LABEL.test(text))) return text
    return (REASONING_LIKE.test(text) ? '[reasoning-like label chars=' : '[label chars=') + text.length + ']'
  }
  const query = (selector, root = document) => [...root.querySelectorAll(selector)]
  const round = number => Math.round(number * 10) / 10
  const visible = element => {
    const rect = element.getBoundingClientRect()
    const css = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'
  }
  const attrs = element => {
    const result = {}
    for (const attr of element.attributes || []) {
      const name = attr.name
      if (name === 'class') result.class = attr.value.slice(0, 400)
      else if (['role', 'type', 'aria-expanded', 'aria-hidden', 'aria-busy', 'aria-live', 'aria-controls', 'open', 'hidden', 'disabled', 'data-state', 'data-testid'].includes(name)) {
        // Test ids and states are structural names; still cap and redact anything sentence-like.
        result[name] = /^[\w:.\- ]{0,80}$/.test(attr.value) ? attr.value : '[value chars=' + attr.value.length + ']'
      } else if (['aria-label', 'title'].includes(name)) result[name] = label(attr.value)
      else if (name.startsWith('data-')) result[name] = '[value chars=' + attr.value.length + ']'
      else if (name === 'id') result.id = '[id chars=' + attr.value.length + ']'
    }
    return result
  }
  const describe = element => {
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { tag: element.tagName.toLowerCase(), attrs: attrs(element), visible: visible(element),
      bounds: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
      textChars: collapse(element.textContent).length }
  }
  const pathBetween = (element, root) => {
    const steps = []
    for (let node = element; node && node !== root && steps.length < 14; node = node.parentElement) {
      steps.push({ tag: node.tagName.toLowerCase(), class: String(node.getAttribute('class') || '').slice(0, 160),
        dataNames: [...node.attributes].filter(attr => attr.name.startsWith('data-')).map(attr => attr.name) })
    }
    return steps
  }
  const relation = (a, b) => {
    if (!a || !b) return null
    if (a === b) return 'same'
    if (a.contains(b)) return 'contains'
    if (b.contains(a)) return 'inside'
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after'
  }
  const stopFound = STOP.some(selector => query(selector).some(visible))

  // The turn group is the measured outer wrapper; the reasoning block may sit outside the id element.
  const idTurns = query(ID_TURN)
  const groups = [...new Set(idTurns.map(turn => turn.closest(TURN_GROUP) || turn.parentElement).filter(Boolean))]
  const assistantGroups = groups.filter(group => group.querySelector(ANSWER) || group.querySelector(UNIT_ASSISTANT))
  const sampled = assistantGroups.slice(-4)

  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const structure = (node, budget, depth = 0) => {
    if (budget.left-- <= 0) return ''
    if (node.nodeType === Node.TEXT_NODE) {
      const text = collapse(node.textContent)
      if (!text) return ''
      return escape(text.length <= 40 && REASONING_SAFE.test(text) ? '[reasoning label: ' + text + ']'
        : REASONING_LIKE.test(text) ? '[reasoning-like text chars=' + text.length + ']' : '[text chars=' + text.length + ']')
    }
    if (node.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|LINK|META|IMG|PATH)$/i.test(node.tagName)) return ''
    const tag = node.tagName.toLowerCase()
    if (tag === 'svg') return '<svg/>'
    const marks = [node.matches(ID_TURN) && 'ID-TURN', node.matches(ANSWER) && 'ANSWER', node.matches(UNIT_ASSISTANT) && 'UNIT-ASSISTANT'].filter(Boolean)
    const attributes = Object.entries(attrs(node)).map(([name, value]) => ' ' + name + '="' + escape(value) + '"').join('') +
      (marks.length ? ' probe-mark="' + marks.join(' ') + '"' : '')
    // The answer's inside is already measured; keep its shape out of the budget.
    if (node.matches(ANSWER)) return '<' + tag + attributes + '>[answer body chars=' + collapse(node.textContent).length + ']</' + tag + '>'
    if (depth >= 22) return '<' + tag + attributes + '>[depth limit]</' + tag + '>'
    return '<' + tag + attributes + '>' + [...node.childNodes].map(child => structure(child, budget, depth + 1)).join('') + '</' + tag + '>'
  }

  /*
   * Smart components inside the id turn's answer (charts, canvases, frames, figures). The
   * focus view turns the answer into Markdown and spelled a chart out as axis labels plus a
   * 29-line data list; this records what such a component is made of. Text is reduced to a
   * length, marked numeric when it is only digits, units and separators.
   */
  const MARKDOWN_BLOCK = /^(P|UL|OL|TABLE|PRE|H[1-6]|BLOCKQUOTE|HR)$/
  const SEEDS = 'svg, canvas, iframe, figure, [role="img"], [role="figure"], [role="application"], [role="graphics-document"]'
  const redactText = text => (/^[\d\s.,%:+\-−/()]+$/.test(text) ? '[num chars=' : '[text chars=') + text.length + ']'
  const visuallyHidden = element => {
    const css = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return css.display === 'none' || css.visibility === 'hidden' || (rect.width <= 1 && rect.height <= 1) ||
      /(^|\s)sr-only(\s|$)/.test(String(element.getAttribute('class') || '')) || !!element.closest('[aria-hidden="true"]')
  }
  const svgSummary = svg => {
    const counts = {}
    for (const element of svg.querySelectorAll('*')) counts[element.tagName.toLowerCase()] = (counts[element.tagName.toLowerCase()] || 0) + 1
    const rect = svg.getBoundingClientRect()
    return { viewBox: svg.getAttribute('viewBox'), width: round(rect.width), height: round(rect.height), counts,
      class: String(svg.getAttribute('class') || '').slice(0, 200), role: svg.getAttribute('role'),
      dataNames: [...svg.attributes].filter(attr => attr.name.startsWith('data-')).map(attr => attr.name) }
  }
  const frameHost = element => {
    try { return new URL(element.getAttribute('src') || '', location.href).host || null } catch { return null }
  }
  const widgetMarkup = (node, budget, depth = 0) => {
    if (budget.left-- <= 0) return ''
    if (node.nodeType === Node.TEXT_NODE) {
      const text = collapse(node.textContent)
      return text ? escape(redactText(text)) : ''
    }
    if (node.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|IMG)$/i.test(node.tagName)) return ''
    const tag = node.tagName.toLowerCase()
    if (tag === 'svg') {
      const summary = svgSummary(node)
      return '<svg probe-svg="' + escape(summary.width + 'x' + summary.height + ' ' +
        Object.entries(summary.counts).map(([name, count]) => name + ':' + count).join(',')) + '"/>'
    }
    const attributes = Object.entries(attrs(node)).map(([name, value]) => ' ' + name + '="' + escape(value) + '"').join('') +
      (visuallyHidden(node) ? ' probe-hidden="1"' : '') + (tag === 'iframe' ? ' probe-frame-host="' + escape(frameHost(node) || '') + '"' : '')
    if (depth >= 30) return '<' + tag + attributes + '>[depth limit]</' + tag + '>'
    return '<' + tag + attributes + '>' + [...node.childNodes].map(child => widgetMarkup(child, budget, depth + 1)).join('') + '</' + tag + '>'
  }
  const answerParts = answer => {
    if (!answer) return { children: [], widgets: [] }
    const children = [...answer.children].slice(0, 80).map(child => ({ tag: child.tagName.toLowerCase(),
      class: String(child.getAttribute('class') || '').slice(0, 160),
      dataNames: [...child.attributes].filter(attr => attr.name.startsWith('data-')).map(attr => attr.name),
      textChars: collapse(child.textContent).length,
      plainMarkdown: MARKDOWN_BLOCK.test(child.tagName) && !child.querySelector(SEEDS) }))
    const seeds = query(SEEDS, answer).filter(element => {
      if (element.tagName.toLowerCase() !== 'svg') return true
      const rect = element.getBoundingClientRect()
      return rect.width >= 80 && rect.height >= 60 // icons are not components
    })
    const roots = [...new Set(seeds.map(element => {
      let node = element
      while (node.parentElement && node.parentElement !== answer) node = node.parentElement
      return node
    }))].slice(0, 6)
    return { children, widgets: roots.map(root => {
      const inside = seeds.filter(seed => root.contains(seed))
      const budget = { left: 900 }
      return { root: describe(root), pathFromSeed: pathBetween(inside[0], answer),
        seeds: inside.slice(0, 8).map(seed => ({ ...describe(seed),
          svg: seed.tagName.toLowerCase() === 'svg' ? svgSummary(seed) : null,
          frameHost: seed.tagName.toLowerCase() === 'iframe' ? frameHost(seed) : null })),
        listItems: root.querySelectorAll('li').length, tables: root.querySelectorAll('table').length,
        hiddenTextLeaves: query('*', root).filter(element => !element.children.length && collapse(element.textContent) && visuallyHidden(element)).length,
        buttons: query('button, [role="button"]', root).slice(0, 12).map(button => ({ label: label(button.getAttribute('aria-label') || button.textContent) })),
        markup: widgetMarkup(root, budget), truncated: budget.left < 0 }
    }) }
  }

  const turns = sampled.map((group, index) => {
    const idTurn = group.matches(ID_TURN) ? group : group.querySelector(ID_TURN)
    const answer = group.querySelector(ANSWER)
    const unit = group.querySelector(UNIT_ASSISTANT)
    // Candidates: outside the answer, either captioned like a reasoning header or named like one.
    const candidates = []
    for (const element of query('*', group)) {
      if (candidates.length >= 24) break
      if (answer && answer.contains(element)) continue
      const own = collapse([...element.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(' '))
      const whole = collapse(element.textContent)
      const captionText = own && REASONING_LIKE.test(own) && own.length <= 80 ? own
        : whole && whole.length <= 80 && REASONING_LIKE.test(whole) && element.children.length <= 3 ? whole : ''
      const named = [...element.attributes].some(attr => NAME_HINT.test(attr.name) || (attr.name === 'class' && NAME_HINT.test(attr.value)))
      if (!captionText && !named) continue
      candidates.push({ why: [captionText && 'caption', named && 'name'].filter(Boolean), node: describe(element),
        caption: captionText ? label(captionText) : null,
        interactive: element.matches('button, [role="button"], summary, details') || !!element.closest('button, [role="button"], summary'),
        relationToAnswer: relation(element, answer), relationToIdTurn: relation(element, idTurn),
        pathToGroup: pathBetween(element, group),
        // An expanded panel usually follows its header: record the next siblings' sizes only.
        nextSiblings: [...(element.parentElement?.children || [])].filter(sibling => sibling !== element &&
          (element.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING)).slice(0, 3).map(describe) })
    }
    const budget = { left: 900 }
    return { index, group: describe(group), idTurn: describe(idTurn), answer: describe(answer), unitAssistant: describe(unit),
      answerInsideIdTurn: !!(idTurn && answer && idTurn.contains(answer)),
      groupTextChars: collapse(group.textContent).length, answerTextChars: collapse(answer?.textContent).length,
      candidates, markup: structure(group, budget), markupTruncated: budget.left < 0,
      answerParts: answerParts(idTurn ? idTurn.querySelector(ANSWER) : null) }
  })

  const dataHistogram = {}, hintClasses = {}
  for (const group of assistantGroups.slice(-6)) {
    for (const element of query('*', group)) {
      for (const attr of element.attributes) if (attr.name.startsWith('data-')) dataHistogram[attr.name] = (dataHistogram[attr.name] || 0) + 1
      for (const cls of element.classList) if (NAME_HINT.test(cls)) hintClasses[cls] = (hintClasses[cls] || 0) + 1
    }
  }
  return {
    route: location.href, readyState: document.readyState, stopFound,
    viewport: { width: innerWidth, height: innerHeight },
    counts: { idTurns: idTurns.length, groups: groups.length, assistantGroups: assistantGroups.length, answers: document.querySelectorAll(ANSWER).length,
      unitAssistant: document.querySelectorAll(UNIT_ASSISTANT).length, detailsElements: document.querySelectorAll('details').length },
    turns, dataHistogram, hintClasses,
    note: 'Candidates are discovery evidence (caption or attribute-name hints), not a selector verdict. Reasoning text is reduced to lengths.'
  }
}

/** Passive observation only. Never cancel events or modify the site's UI. */
function observeReasoning(config) {
  if (window[config.key]) return 'already-installed'
  const listeners = []
  let mutationTimer, counts = { attributes: 0, childList: 0, characterData: 0 }
  // Same two patterns as the page reader: only fixed-format captions are kept verbatim.
  const REASONING_LIKE = /^(已思考|思考了|思考中|正在思考|深度思考|已推理|推理中|正在推理|已处理|处理中|正在处理|正在搜索|已搜索|搜索了|Thinking|Thought for|Thought|Reasoned for|Reasoning|Worked for|Working|Searching|Searched)/i
  const REASONING_SAFE = /^(?:(?:已思考|思考了|已推理|推理了|已处理|处理了)\s*(?:用时)?\s*(?:[\d.]+\s*(?:秒|秒钟|分钟|分|s|m)\s*)+|(?:Thought|Reasoned|Worked) for (?:[\d.]+\s*(?:s|sec|secs|seconds?|m|min|minutes?)\s*)+|(?:正在搜索|已搜索|搜索了)\s*\d+\s*个(?:网站|来源|网页)|(?:Searching|Searched)\s*\d+\s*(?:sites?|sources?|websites?)|思考中|正在思考|深度思考|推理中|正在推理|处理中|正在处理|Thinking|Reasoning|Working)[.…]*$/i
  const emit = (event, data = {}) => console.log(config.tag + JSON.stringify({ event, ...data, route: location.href }))
  const on = (target, event, handler) => {
    const options = { capture: true, passive: true }
    target.addEventListener(event, handler, options)
    listeners.push(() => target.removeEventListener(event, handler, options))
  }
  on(document, 'click', event => {
    if (!(event.target instanceof Element)) return
    const control = event.target.closest('button, [role="button"], summary') || event.target
    const text = String(control.textContent || control.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    emit('click', { tag: control.tagName.toLowerCase(), class: String(control.getAttribute('class') || '').slice(0, 200),
      role: control.getAttribute('role'), expanded: control.getAttribute('aria-expanded'),
      label: text.length <= 40 && REASONING_SAFE.test(text) ? text
        : (REASONING_LIKE.test(text) ? '[reasoning-like label chars=' : '[label chars=') + text.length + ']',
      insideAnswer: !!control.closest('[data-markdown-text-style="assistant-message"]'),
      insideIdTurn: !!control.closest('[data-chatgpt-selection-message-id]') })
  })
  on(document, 'keydown', event => {
    if (event.key === 'Enter' && !event.repeat && event.target instanceof Element && event.target.closest('[contenteditable="true"], textarea')) {
      emit('enter', { shift: event.shiftKey, composing: event.isComposing === true })
    }
  })
  on(document, 'toggle', event => { if (event.target instanceof HTMLDetailsElement) emit('details-toggle', { open: event.target.open }) })
  const observer = new MutationObserver(records => {
    for (const record of records) counts[record.type]++
    if (!mutationTimer) mutationTimer = setTimeout(() => {
      mutationTimer = null
      emit('dom-change', { counts })
      counts = { attributes: 0, childList: 0, characterData: 0 }
    }, 400)
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden', 'data-state'] })
  window[config.key] = () => {
    observer.disconnect()
    clearTimeout(mutationTimer)
    for (const dispose of listeners) dispose()
    delete window[config.key]
  }
  return 'installed'
}

const pageSource = '(' + inspectReasoning.toString() + ')()'
const observerSource = '(' + observeReasoning.toString() + ')(' + JSON.stringify({ tag: EVENT_TAG, key: OBSERVER_KEY }) + ')'
// Parse the serialized page code itself, not only this outer CommonJS file.
new vm.Script(pageSource, { filename: 'chatgpt-reasoning-page.js' })
new vm.Script(observerSource, { filename: 'chatgpt-reasoning-observer.js' })

let win, timer, captureTimer, activeCapture = null, closing = false
let lastSignature = '', lastStructureSignature = '', lastCaptureAt = 0
let sequence = 0, structureCount = 0, eventCount = 0, captureFailures = 0
const pendingReasons = new Set()
const observed = { streaming: false, idle: false, assistantTurns: false, candidates: false, captionedCandidates: false, answerWidgets: false, reasoningClicks: 0, events: {} }

async function bounded(promise, timeout = 4500) {
  let timeoutId
  try { return await Promise.race([promise, new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('capture-timeout')), timeout) })]) }
  finally { clearTimeout(timeoutId) }
}

function requestCapture(reason) {
  if (closing) return
  pendingReasons.add(reason)
  if (activeCapture || captureTimer) return
  // Coalesce streaming mutations: at most one full read per ~800 ms.
  captureTimer = setTimeout(() => {
    captureTimer = null
    const reasons = [...pendingReasons]
    pendingReasons.clear()
    void capture(reasons.join(','))
  }, Math.max(100, 800 - (Date.now() - lastCaptureAt)))
}

function capture(reason, final = false) {
  if ((closing && !final) || !win || win.isDestroyed()) return Promise.resolve()
  if (activeCapture) return activeCapture
  lastCaptureAt = Date.now()
  activeCapture = captureNow(reason).finally(() => {
    activeCapture = null
    if (pendingReasons.size && !closing) requestCapture('follow-up')
  })
  return activeCapture
}

async function captureNow(reason) {
  const wc = win.webContents
  try {
    if (new URL(wc.getURL()).origin !== ORIGIN) return
    const capturedUrl = wc.getURL()
    const raw = await bounded(wc.executeJavaScript(pageSource))
    if (wc.isDestroyed() || capturedUrl !== wc.getURL() || raw.route !== capturedUrl) {
      log('CAPTURE-DISCARDED', { reason, cause: 'navigation-during-capture' })
      return
    }
    const { route, turns, ...info } = raw
    // Markup goes to STRUCTURE only; the snapshot keeps the summaries.
    const summary = { ...info, route: routeForLog(route),
      turns: turns.map(({ markup, answerParts, ...turn }) => ({ ...turn, answerChildren: answerParts.children,
        widgets: answerParts.widgets.map(({ markup: _markup, ...widget }) => widget) })) }
    // Text lengths change on every streamed token; compare shape without them.
    const shape = JSON.stringify(summary).replace(/"(textChars|groupTextChars|answerTextChars)":\d+/g, '').replace(/\[(?:text|num|label|value|id) chars=\d+\]/g, '')
    const signature = digest(JSON.stringify(summary))
    const redact = markup => markup.replace(/\[(?:text|num|label|value|id|answer body) chars=\d+\]/g, '[redacted]')
    const markups = turns.map(turn => [redact(turn.markup), ...turn.answerParts.widgets.map(widget => redact(widget.markup))])
    const structureSignature = digest(JSON.stringify([summary.route, markups]))
    const isFinal = reason === 'final'
    if (!isFinal && signature === lastSignature && structureSignature === lastStructureSignature) return
    lastSignature = signature
    const id = ++sequence
    observed.streaming ||= info.stopFound
    observed.idle ||= !info.stopFound
    observed.assistantTurns ||= info.counts.assistantGroups > 0
    observed.candidates ||= turns.some(turn => turn.candidates.length > 0)
    observed.captionedCandidates ||= turns.some(turn => turn.candidates.some(candidate => candidate.why.includes('caption')))
    observed.answerWidgets ||= turns.some(turn => turn.answerParts.widgets.length > 0)
    log('SNAPSHOT', { id, reason, shapeDigest: digest(shape), ...summary })
    if (structureSignature !== lastStructureSignature || isFinal) {
      log('STRUCTURE', { id, turns: turns.map(turn => ({ index: turn.index, markup: turn.markup, truncated: turn.markupTruncated,
        widgets: turn.answerParts.widgets.map(widget => ({ markup: widget.markup, truncated: widget.truncated })) })) })
      lastStructureSignature = structureSignature
      structureCount++
    }
  } catch (error) {
    captureFailures++
    log('CAPTURE-FAILED', { reason, category: error?.message === 'capture-timeout' ? 'timeout' : 'page-or-file-unavailable', errorName: error?.name })
  }
}

app.whenReady().then(async () => {
  log('START', { logPath, electron: process.versions.electron, chrome: process.versions.chrome, partition: PARTITION,
    observationOnly: true, screenshots: false, pageScriptsParsed: true })
  const ses = session.fromPartition(PARTITION)
  ses.setUserAgent(USER_AGENT)
  // Exactly ONE header hook for this partition: a second registration would replace it.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) if (/^user-agent$|^sec-ch-ua(?:-full-version-list)?$/i.test(name)) delete headers[name]
    const major = process.versions.chrome.split('.')[0]
    headers['User-Agent'] = USER_AGENT
    headers['sec-ch-ua'] = '"Google Chrome";v="' + major + '", "Chromium";v="' + major + '", "Not(A:Brand";v="24"'
    headers['sec-ch-ua-full-version-list'] = '"Google Chrome";v="' + process.versions.chrome + '", "Chromium";v="' + process.versions.chrome + '", "Not(A:Brand";v="24.0.0.0"'
    callback({ requestHeaders: headers })
  })
  // Same default as the other ChatGPT probes; never reads the app's saved proxy settings.
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  await ses.setProxy(proxy === 'direct' ? { mode: 'direct' } : { mode: 'fixed_servers', proxyRules: proxy })
  log('PROXY', { mode: proxy === 'direct' ? 'direct' : process.env.PROBE_PROXY ? 'explicit-probe-proxy' : 'default-local-proxy' })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]))
  win = new BrowserWindow({ width: 1320, height: 930, minWidth: 760, minHeight: 600,
    title: 'ChatGPT 思考过程 — 日志自动记录中，按说明操作后关闭窗口即可',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } })
  const wc = win.webContents
  wc.setUserAgent(USER_AGENT)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('page-title-updated', event => event.preventDefault())
  const installObserver = () => {
    if (closing || wc.isDestroyed() || new URL(wc.getURL()).origin !== ORIGIN) return
    void bounded(wc.executeJavaScript(observerSource)).then(status => {
      if (status === 'installed') log('OBSERVER-READY', { route: routeForLog(wc.getURL()) })
      requestCapture('observer-ready')
    }).catch(error => log('OBSERVER-FAILED', { errorName: error?.name, fallback: 'periodic-snapshots' }))
  }
  wc.on('console-message', details => {
    if (closing || !details.message.startsWith(EVENT_TAG) || details.message.length > 8000) return
    try {
      const report = JSON.parse(details.message.slice(EVENT_TAG.length))
      if (report.route !== wc.getURL() || new URL(report.route).origin !== ORIGIN) return
      if (!['click', 'enter', 'details-toggle', 'dom-change'].includes(report.event)) return
      const { route, event, ...metadata } = report
      log('PAGE-EVENT', { action: event, route: routeForLog(route), ...metadata })
      eventCount++
      observed.events[event] = (observed.events[event] || 0) + 1
      if (event === 'click' && typeof metadata.label === 'string' && !metadata.label.startsWith('[label chars')) observed.reasoningClicks++
      requestCapture(event)
    } catch { log('PAGE-EVENT-INVALID') }
  })
  wc.on('dom-ready', installObserver)
  wc.on('did-finish-load', () => {
    log('PAGE-LOADED', { route: routeForLog(wc.getURL()) })
    installObserver()
    requestCapture('page-loaded')
  })
  wc.on('did-navigate-in-page', (_event, url, isMain) => {
    if (isMain) { log('NAVIGATE', { route: routeForLog(url) }); requestCapture('navigation') }
  })
  wc.on('did-fail-load', (_event, code, _description, url, isMain) => { if (isMain && code !== -3) log('LOAD-FAILED', { code, route: routeForLog(url) }) })
  wc.on('render-process-gone', (_event, details) => log('RENDER-PROCESS-GONE', { reason: details.reason, exitCode: details.exitCode }))
  timer = setInterval(() => requestCapture('periodic'), 1500)
  win.on('close', event => {
    if (closing) return
    event.preventDefault()
    closing = true
    clearInterval(timer)
    clearTimeout(captureTimer)
    pendingReasons.clear()
    win.setTitle('ChatGPT 思考过程 — 正在完成日志…')
    void (async () => {
      try {
        await bounded((async () => {
          if (activeCapture) await activeCapture
          await capture('final', true)
        })(), 5500)
      } catch {
        log('FINAL-INCOMPLETE', { cause: 'close-timeout', note: '已保存此前自动日志。' })
      } finally {
        log('COVERAGE', { snapshots: sequence, structures: structureCount, pageEvents: eventCount, captureFailures, ...observed,
          verdict: '候选元素只是发现线索；没有观察到的状态（生成中、展开、收起）不算已覆盖。' })
        console.log('\n本轮日志已保存：' + logPath + '\n把这个日志路径发给智能体即可，无需截图。\n')
        if (!win.isDestroyed()) win.destroy()
      }
    })()
  })
  console.log('\n日志自动记录中。按 chatgpt-reasoning-probe.md 的步骤操作，结束后直接关闭窗口。\n日志：' + logPath + '\n')
  await wc.loadURL(start.href).catch(() => log('PAGE-LOAD-REJECTED', { route: routeForLog(start.href) }))
}).catch(error => { log('FATAL', { errorName: error?.name, category: 'startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
