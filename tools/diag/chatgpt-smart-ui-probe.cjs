/**
 * User-run passive discovery of ChatGPT's generated interactive answer components.
 * See chatgpt-smart-ui-probe.md. Never launch this probe from an agent.
 * Standalone: no app imports, send interceptor, automatic clicks, sends or API fetches.
 */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHmac, randomUUID } = require('node:crypto')
const vm = require('node:vm')

const ORIGIN = 'https://chatgpt.com'
const PARTITION = process.env.PROBE_PARTITION || 'persist:chatgpt'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 https://chatgpt.com 同源页面。')
app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(directory, 'chatgpt-smart-ui-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const salt = randomUUID(), TAG = '[chatgpt-smart-ui-' + randomUUID() + '] '
const KEY = '__chatgptSmartUIProbe_' + randomUUID().replace(/-/g, '')
const CONFIG = { key: KEY, tag: TAG }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
const MAX_BODY = 2 * 1024 * 1024, MAX_REQUESTS = 160, MAX_LOG = 32 * 1024 * 1024
const alias = value => value == null || value === '' ? null : createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16)
let win, closing = false, timer, captureTimer, capturing = null, networkReady = false, logLimited = false, logBytes = 0
let snapshotSequence = 0, requestSequence = 0, failures = 0, pageEvents = 0
const tasks = new Set(), reasons = new Set(), signatures = new Map(), requests = new Map()
const coverage = { optionControls: false, actionButtons: false, selectedState: false, choiceEvent: false,
  componentClick: false, submitEvent: false, composerChanged: false, iframeSeen: false, childFrameRead: false,
  shadowRootSeen: false, requestBodies: 0, responseBodies: 0, uiSignals: 0, networkFailures: 0 }

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
  const bytes = Buffer.byteLength(line)
  if (logBytes + bytes > MAX_LOG && !['LIMIT', 'COVERAGE', 'FINAL-INCOMPLETE', 'FATAL'].includes(event)) {
    if (!logLimited) { logLimited = true; log('LIMIT', { category: 'log-size', maxBytes: MAX_LOG }) }
    return
  }
  try { fs.appendFileSync(logPath, line, 'utf8'); logBytes += bytes }
  catch { console.error('日志写入失败：' + logPath) }
  if (!['SNAPSHOT', 'STRUCTURE', 'PAGE-EVENT', 'REQUEST-BODY', 'RESPONSE-SUMMARY'].includes(event)) console.log(line.trimEnd())
}
function route(value) {
  try {
    const url = new URL(value), match = /^\/(?:g\/[^/]+\/)?c\/([^/]+)/.exec(url.pathname)
    return { origin: url.origin, kind: match ? 'conversation' : url.pathname === '/' ? 'home' : 'other',
      conversation: match ? alias(match[1]) : null, pathRef: alias(url.pathname) }
  } catch { return { kind: 'unavailable' } }
}
function redact(value) {
  if (!value || typeof value !== 'object') return value
  if (Object.keys(value).length === 1 && typeof value.__probeRef === 'string') return alias(value.__probeRef)
  if (Array.isArray(value)) return value.map(redact)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
}
async function bounded(promise, ms = 4500) {
  let timeout
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('probe-timeout')), ms) })]) }
  finally { clearTimeout(timeout) }
}
function track(promise) {
  tasks.add(promise)
  void promise.finally(() => tasks.delete(promise)).catch(() => {})
}

/** Browser-side reader: discovered semantics/attributes, no replacement adapter selectors. */
function inspectSmartUI(config, target = null) {
  const cache = window[config.key]
  const ref = value => value ? { __probeRef: String(value) } : null
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const round = value => Math.round(value * 10) / 10
  // Independent copies of the shipped ChatGPT answer/identity markers. Component roots
  // below are discoveries: the log, rather than guessed genui classes, defines the adapter.
  const ANSWER = '[data-markdown-text-style="assistant-message"]'
  const ID = '[data-chatgpt-selection-message-id]'
  const GROUP = '[data-turn-key], [data-content-search-turn-key], article[data-testid^="conversation-turn-"]'
  const USER = '[data-content-search-unit-key$=":user"], [class~="group/user-message"], [data-message-author-role="user"]'
  const COMPOSER = '[data-chatgpt-composer], [data-composer-body], [data-composer-placement]'
  const CHOICE = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="switch"], select, [role="option"], [aria-checked], [aria-selected]'
  const CONTROL = 'button, input:not([type="hidden"]):not([type="password"]), textarea, select, [role="button"], [role="radio"], [role="checkbox"], [role="option"], [role="switch"], [role="combobox"], [contenteditable="true"]'
  const FIXED_LABEL = /^(复制|复制消息|分享|编辑|编辑消息|重试|重新生成|发送|停止|停止生成|取消|提交|确定|显示更多|显示更少|Copy|Copy message|Share|Edit|Edit message|Retry|Regenerate|Send|Stop|Stop generating|Cancel|Submit|Confirm|Show more|Show less)$/i
  const STRUCTURAL = /^(?:[a-zA-Z_][a-zA-Z0-9_:./-]{0,119})?$/
  const sensitive = node => /password|credential|secret|token|authorization|cookie/i.test(
    [node.getAttribute('type'), node.getAttribute('name'), node.getAttribute('id'), node.getAttribute('autocomplete')].join(' '))
  const parent = node => node.parentElement || node.getRootNode?.().host || null
  const ancestor = (node, selector) => {
    for (let depth = 0; node && depth < 35; depth++, node = parent(node)) if (node.matches?.(selector)) return node
    return null
  }
  const contains = (root, node) => {
    for (let depth = 0; node && depth < 50; depth++, node = parent(node)) if (root === node) return true
    return false
  }
  const roots = [document]
  let scanned = 0, rootLimit = false
  for (let index = 0; index < roots.length; index++) {
    const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT)
    let node
    while ((node = walker.nextNode())) {
      if (++scanned > 10000 || roots.length > 24) { rootLimit = true; break }
      if (node.shadowRoot) roots.push(node.shadowRoot)
    }
    if (rootLimit) break
  }
  const query = (selector, root = null) => roots.flatMap(item => [...item.querySelectorAll(selector)]).filter(node => !root || contains(root, node))
  const within = (root, selector) => [...(root.matches?.(selector) ? [root] : []), ...query(selector, root)]
  const visible = node => {
    const box = node.getBoundingClientRect(), css = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && css.display !== 'none' && css.visibility !== 'hidden' && !ancestor(node, '[hidden], [aria-hidden="true"], [inert]')
  }
  const idOf = node => {
    if (!cache.ids.has(node)) cache.ids.set(node, 'node-' + (++cache.serial))
    return cache.ids.get(node)
  }
  const textSummary = value => {
    const text = collapse(value)
    return { chars: text.length, ref: text.length <= 4000 ? ref(text) : null,
      ...(text.length > 4000 ? { omitted: 'text-hash-limit' } : {}), ...(text && FIXED_LABEL.test(text) ? { fixed: text } : {}) }
  }
  const attrs = node => {
    const result = {}
    for (const { name, value } of [...node.attributes].slice(0, 45)) {
      if (/token|secret|password|authorization|cookie|nonce/i.test(name) || sensitive(node) && /value/i.test(name)) { result[name] = { omitted: true }; continue }
      if (name === 'class') result.class = value.slice(0, 700).replace(/(?:https?:|data:)[^\s\]]+/g, '[url]').replace(/content-\[[^\]]*\]/g, 'content-[omitted]')
      else if (['id', 'for', 'name', 'value', 'aria-controls', 'aria-describedby', 'aria-labelledby', 'form'].includes(name) || /(?:^data-.*(?:id|key|value|name|state|selection|choice|option|component|widget))$/.test(name)) {
        result[name] = { chars: value.length, ref: ref(value),
          ...(name === 'data-state' && /^(checked|unchecked|on|off|selected|unselected|open|closed|active|inactive|disabled|enabled|idle|submitted|pending|complete)$/.test(value) ? { enum: value } : {}),
          ...(['aria-controls', 'aria-describedby', 'aria-labelledby'].includes(name) ? { refs: value.split(/\s+/).filter(Boolean).slice(0, 12).map(ref) } : {}) }
      } else if (['title', 'aria-label', 'placeholder', 'alt'].includes(name)) result[name] = textSummary(value)
      else if (['role', 'type', 'data-testid', 'data-message-author-role', 'data-markdown-text-style', 'contenteditable', 'tabindex', 'dir', 'autocomplete'].includes(name)) {
        result[name] = STRUCTURAL.test(value) ? value : { chars: value.length, ref: ref(value) }
      } else if (['checked', 'selected', 'disabled', 'hidden', 'multiple', 'required', 'readonly', 'open'].includes(name)) result[name] = true
      else if (/^aria-(?:checked|selected|pressed|expanded|disabled|hidden|busy|invalid|multiselectable|orientation|live)$/.test(name)) result[name] = /^(true|false|mixed|horizontal|vertical|polite|assertive|off)$/.test(value) ? value : { chars: value.length }
      else if (name.startsWith('data-')) result[name] = { chars: value.length, ref: ref(value) }
      else if (['href', 'src', 'action', 'srcdoc', 'style'].includes(name)) result[name] = { chars: value.length, ref: ref(value) }
    }
    return result
  }
  const describe = node => {
    if (!node || !(node instanceof Element)) return null
    const box = node.getBoundingClientRect(), css = getComputedStyle(node)
    const result = { node: idOf(node), tag: node.tagName.toLowerCase(), attrs: attrs(node), visible: visible(node),
      text: node.matches(CONTROL + ', label, legend') ? textSummary(node.textContent) : { chars: collapse(node.textContent).length },
      bounds: { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) },
      style: Object.fromEntries(['display', 'position', 'flexDirection', 'alignItems', 'justifyContent', 'gap', 'gridTemplateColumns',
        'padding', 'margin', 'border', 'borderRadius', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
        'boxShadow', 'outline', 'cursor', 'opacity', 'pointerEvents', 'appearance'].map(key => [key, css[key]])) }
    if (node.matches(CONTROL)) {
      result.disabled = node.disabled === true || node.getAttribute('aria-disabled') === 'true'
      result.checked = typeof node.checked === 'boolean' ? node.checked : null
      result.indeterminate = typeof node.indeterminate === 'boolean' ? node.indeterminate : null
      result.selected = typeof node.selected === 'boolean' ? node.selected : null
      if (!sensitive(node) && typeof node.value === 'string') result.value = textSummary(node.value)
      result.labels = [...(node.labels || [])].slice(0, 8).map(label => ({ node: idOf(label), text: textSummary(label.textContent) }))
      result.form = node.form ? idOf(node.form) : null
      result.inMarkdown = !!ancestor(node, ANSWER)
      result.inComposer = !!ancestor(node, COMPOSER)
    }
    if (node.tagName === 'SELECT') result.options = [...node.options].slice(0, 24).map(option => ({ text: textSummary(option.textContent), value: textSummary(option.value), selected: option.selected, disabled: option.disabled }))
    return result
  }
  const chain = node => {
    const result = []
    for (let depth = 0; node && node !== document.body && depth < 13; depth++, node = parent(node)) result.push(describe(node))
    return result
  }
  const tree = (node, budget, depth = 0) => {
    if (budget.left-- <= 0) return { omitted: 'node-limit' }
    if (node.nodeType === Node.TEXT_NODE) return collapse(node.textContent) ? { text: textSummary(node.textContent) } : null
    if (!(node instanceof Element) || /^(SCRIPT|STYLE|NOSCRIPT|LINK|META)$/.test(node.tagName)) return null
    const result = describe(node)
    if (node.tagName === 'SVG' || node.tagName.toLowerCase() === 'svg') return { ...result, svg: { viewBox: node.getAttribute('viewBox'), paths: node.querySelectorAll('path').length, uses: node.querySelectorAll('use').length } }
    if (/^(IFRAME|CANVAS|IMG|VIDEO|AUDIO|OBJECT|EMBED)$/.test(node.tagName) || sensitive(node)) return result
    if (depth >= 14) return { ...result, omitted: 'depth-limit' }
    result.children = []
    for (const child of node.childNodes) {
      if (budget.left <= 0) break
      const item = tree(child, budget, depth + 1)
      if (item) result.children.push(item)
    }
    if (node.shadowRoot && budget.left > 0) result.shadowChildren = [...node.shadowRoot.childNodes].slice(0, 30).map(child => tree(child, budget, depth + 1)).filter(Boolean)
    return result
  }
  const assistantGroups = [...new Set(query(ID + ', ' + ANSWER).map(node => ancestor(node, GROUP) || ancestor(node, ID) || node))].filter(visible)
  const componentFrame = window !== window.top
  // An embedded widget need not repeat ChatGPT's outer message markers.
  if (!assistantGroups.length && componentFrame && document.body) assistantGroups.push(document.body)
  const inAnswer = node => !ancestor(node, USER + ', ' + COMPOSER) && assistantGroups.some(root => contains(root, node))
  const choices = query(CHOICE).filter(node => visible(node) && !ancestor(node, USER + ', ' + COMPOSER))
  const candidates = new Set()
  const rootOf = control => {
    const scope = ancestor(control, GROUP) || ancestor(control, ID) || ancestor(control, ANSWER)
    let fallback = parent(control) || control
    for (let node = control, depth = 0; node && node !== document.body && depth < 10; node = parent(node), depth++) {
      if (scope && !contains(scope, node)) break
      if (node.matches('form, fieldset, [role="radiogroup"], [role="group"], [role="listbox"]')) fallback = node
      if (within(node, CHOICE).length > 0 && within(node, 'button, [role="button"], input[type="submit"]').length > 0) return node
    }
    return fallback
  }
  for (const node of choices.slice(-50)) candidates.add(rootOf(node))
  // Non-native UI can use custom buttons without radio/checkbox semantics. Keep those
  // alongside semantic choices, so an absent role is evidence rather than a blind spot.
  const customHints = query('[data-testid], [data-component], [data-widget], [data-genui], form').filter(node =>
    visible(node) && inAnswer(node) && (node.tagName === 'FORM' || [...node.attributes].some(attr => /genui|generative|interactive|choice|radio|widget|form/i.test(attr.name + ' ' + attr.value))))
  for (const node of customHints.slice(-20)) candidates.add(node)
  for (const node of query('button, [role="button"]').filter(node => visible(node) && inAnswer(node) &&
    !FIXED_LABEL.test(collapse(node.getAttribute('aria-label') || node.textContent))).slice(-12)) candidates.add(rootOf(node))
  const targetElement = target instanceof Element ? target : null
  if (targetElement && !ancestor(targetElement, USER + ', ' + COMPOSER) && (inAnswer(targetElement) || choices.length)) candidates.add(rootOf(targetElement))
  const selectedRoots = [...candidates].filter(node => ![...candidates].some(other => other !== node && contains(other, node))).slice(-8)
  const components = selectedRoots.map(root => {
    const budget = { left: 360 }, scope = ancestor(root, GROUP), message = ancestor(root, ID) || scope?.querySelector(ID)
    return { root: describe(root), chain: chain(root), group: scope ? attrs(scope) : null, message: message ? attrs(message) : null,
      controls: within(root, CONTROL).slice(0, 50).map(describe), choiceCount: within(root, CHOICE).length,
      form: ancestor(root, 'form') ? describe(ancestor(root, 'form')) : null,
      structure: tree(root, budget), truncated: budget.left <= 0 }
  })
  const composers = query('[contenteditable="true"][data-composer-markdown], textarea#pending-home-input, #prompt-textarea').filter(node => !ancestor(node, GROUP)).slice(0, 4).map(node => ({
    node: idOf(node), tag: node.tagName.toLowerCase(), chars: String(typeof node.value === 'string' ? node.value : node.innerText || '').length,
    textRef: sensitive(node) ? null : ref(collapse(typeof node.value === 'string' ? node.value : node.innerText || '')) }))
  return { route: location.href, document: { readyState: document.readyState, origin: location.origin },
    discovery: { assistantGroups: assistantGroups.length, componentFrame, choices: choices.length, candidates: candidates.size, sampled: components.length,
      shadowRoots: roots.length - 1, scanned, scanLimited: rootLimit }, components, composers,
    target: targetElement ? { node: describe(targetElement), chain: chain(targetElement), inAnswer: inAnswer(targetElement) } : null,
    assistantControls: assistantGroups.slice(-4).map(root => ({ root: describe(root), controls: query(CONTROL, root).filter(node => !ancestor(node, USER + ', ' + COMPOSER)).slice(0, 45).map(describe) })),
    iframes: query('iframe').slice(0, 16).map(node => ({ node: describe(node), sourceOrigin: (() => { try { return new URL(node.src, location.href).origin } catch { return null } })(), hasSrcdoc: node.hasAttribute('srcdoc'), sameOriginReadable: (() => { try { return !!node.contentDocument } catch { return false } })() })) }
}

/** Bookkeeping and passive listeners only. No preventDefault, mutation of UI or fetch. */
function observeSmartUI(config, inspect) {
  if (window[config.key]) return 'already-installed'
  const timers = new Set(), observers = [], removers = []
  const cache = { ids: new WeakMap(), serial: 0, inspect: target => inspect(config, target), dispose: null }
  window[config.key] = cache
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer) }
  const emit = (action, phase, target, details = {}) => {
    try { console.log(config.tag + JSON.stringify({ action, phase, ...details, route: location.href, snapshot: cache.inspect(target) })) }
    catch { console.log(config.tag + JSON.stringify({ action: 'capture-error', route: location.href })) }
  }
  const listen = (root, event, callback) => {
    root.addEventListener(event, callback, { capture: true, passive: true })
    removers.push(() => root.removeEventListener(event, callback, { capture: true }))
  }
  const controlOf = event => event.composedPath().find(node => node instanceof Element && node.matches(
    'button, input:not([type="password"]), textarea, select, label, [role="radio"], [role="checkbox"], [role="switch"], [role="option"], [role="button"], [role="combobox"], form'))
  const observedRoots = new WeakSet(), observedEvents = new WeakSet()
  const connect = root => {
    if (observedRoots.has(root)) return
    observedRoots.add(root)
    for (const name of ['click', 'change', 'input', 'submit', 'keydown']) listen(root, name, event => {
      if (!event.isTrusted || observedEvents.has(event)) return
      if (name === 'keydown' && (!['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key) || event.repeat)) return
      const target = controlOf(event)
      if (!target || target.closest('[data-composer-body], [data-chatgpt-composer], [data-composer-placement]') && name === 'keydown') return
      // A composed event reaches both a shadow root and document; observe it just once.
      observedEvents.add(event)
      const details = name === 'keydown' ? { key: event.key === ' ' ? 'Space' : event.key, shift: event.shiftKey, composing: event.isComposing } : {}
      emit(name, name === 'input' || name === 'change' ? 'event' : 'before', target, details)
      later(() => emit(name, 'after-120ms', target.isConnected ? target : null, details), 120)
      later(() => emit(name, 'after-700ms', target.isConnected ? target : null, details), 700)
    })
    let pending = false
    const observer = new MutationObserver(() => {
      if (pending) return
      pending = true
      later(() => { pending = false; discover(); console.log(config.tag + JSON.stringify({ action: 'dom-change', route: location.href })) }, 400)
    })
    observer.observe(root === document ? document.documentElement : root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['checked', 'selected', 'disabled', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-disabled', 'aria-busy', 'data-state'] })
    observers.push(observer)
  }
  const discover = () => {
    const roots = [document]
    let scanned = 0
    for (let index = 0; index < roots.length && index < 24; index++) {
      connect(roots[index])
      const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT)
      let node
      while ((node = walker.nextNode()) && ++scanned < 10000) if (node.shadowRoot) roots.push(node.shadowRoot)
      if (scanned >= 10000) break
    }
  }
  discover()
  listen(window, 'message', event => {
    const data = event.data
    if (!data || typeof data !== 'object' || !/genui|widget|component|form|choice|interact|selection/i.test(Object.keys(data).join(' ') + ' ' + String(data.type || ''))) return
    // Do not forward raw postMessage values, including any embedded credentials.
    const shape = (value, depth = 0) => {
      if (depth > 4) return { omitted: 'depth-limit' }
      if (typeof value === 'string') return { type: 'string', chars: value.length }
      if (value === null || typeof value !== 'object') return { type: value === null ? 'null' : typeof value }
      if (Array.isArray(value)) return { type: 'array', count: value.length, items: value.slice(0, 5).map(item => shape(item, depth + 1)) }
      return { type: 'object', fields: Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [
        /^[a-zA-Z_][a-zA-Z0-9_]{0,70}$/.test(key) ? key : '[key chars=' + key.length + ']',
        /token|password|secret|authorization|cookie/i.test(key) ? { omitted: 'credential-field' } : shape(item, depth + 1)])) }
    }
    console.log(config.tag + JSON.stringify({ action: 'component-message', route: location.href,
      sourceOrigin: event.origin, fromParent: event.source === parent, shape: shape(data) }))
  })
  cache.dispose = () => { for (const timer of timers) clearTimeout(timer); observers.forEach(item => item.disconnect()); removers.forEach(fn => fn()); delete window[config.key] }
  return 'installed'
}
const observerSource = '(' + observeSmartUI.toString() + ')(' + JSON.stringify(CONFIG) + ', ' + inspectSmartUI.toString() + ')'
const readerSource = 'window[' + JSON.stringify(KEY) + ']?.inspect(null) ?? null'
new vm.Script(observerSource, { filename: 'chatgpt-smart-ui-observer.js' })
new vm.Script(readerSource, { filename: 'chatgpt-smart-ui-reader.js' })

function framesOf(wc) {
  if (new URL(wc.getURL()).origin !== ORIGIN) return []
  return wc.mainFrame.framesInSubtree.slice(0, 12).filter(frame => {
    try {
      const url = new URL(frame.url)
      return frame === wc.mainFrame || url.origin === ORIGIN || url.hostname.endsWith('.oaiusercontent.com')
    } catch { return frame.url === 'about:blank' || frame.url === 'about:srcdoc' }
  })
}
const frameKey = frame => frame.processId + ':' + frame.routingId
function saveSnapshot(raw, reason, frame) {
  if (!raw || raw.route !== frame.url) return
  const { route: rawRoute, ...metadata } = raw
  const snapshot = { page: route(rawRoute), frame: frameKey(frame), ...redact(metadata) }
  coverage.optionControls ||= snapshot.discovery.choices > 0
  coverage.shadowRootSeen ||= snapshot.discovery.shadowRoots > 0
  coverage.iframeSeen ||= snapshot.iframes.length > 0
  coverage.childFrameRead ||= frame !== win.webContents.mainFrame
  coverage.actionButtons ||= snapshot.components.some(component => component.controls.some(control => control.tag === 'button'))
  coverage.selectedState ||= snapshot.components.some(component => component.controls.some(control => control.checked === true || control.attrs['aria-checked'] === 'true' || control.attrs['aria-selected'] === 'true'))
  const signature = alias(JSON.stringify(snapshot)), key = frameKey(frame)
  if (signatures.get(key) === signature && !/manual|final|before|after/.test(reason)) return
  signatures.set(key, signature)
  const sequence = ++snapshotSequence, { components, ...info } = snapshot
  log('SNAPSHOT', { sequence, reason, ...info, components: components.map(({ structure, ...component }) => component) })
  if (components.length) log('STRUCTURE', { sequence, frame: key, components: components.map(component => ({ rootNode: component.root.node, structure: component.structure, truncated: component.truncated })) })
}
function requestCapture(reason) {
  if (closing || logLimited) return
  reasons.add(reason)
  if (captureTimer || capturing) return
  captureTimer = setTimeout(() => {
    captureTimer = null
    const reason = [...reasons].join(','); reasons.clear()
    capturing = capture(reason).finally(() => { capturing = null; if (reasons.size && !closing) requestCapture('follow-up') })
  }, 250)
}
async function capture(reason) {
  try {
    if (!win || win.isDestroyed()) return
    const wc = win.webContents, frames = framesOf(wc)
    if (!frames.length) return
    for (const frame of frames) {
      try {
        const status = await bounded(frame.executeJavaScript(observerSource), 2000)
        if (status === 'installed') log('OBSERVER-READY', { frame: frameKey(frame), page: route(frame.url), main: frame === wc.mainFrame })
        saveSnapshot(await bounded(frame.executeJavaScript(readerSource), 2500), reason, frame)
      } catch { failures++; log('CAPTURE-UNAVAILABLE', { reason, frame: frameKey(frame) }) }
    }
  } catch { failures++; log('CAPTURE-UNAVAILABLE', { reason, category: 'page-or-frame-unavailable' }) }
}

const ENUMS = new Set(['next', 'continue', 'user', 'assistant', 'system', 'tool', 'text', 'multimodal_text', 'analysis', 'final', 'commentary',
  'add', 'append', 'replace', 'remove', 'patch', 'radio', 'checkbox', 'select', 'button', 'form', 'radiogroup', 'single_select', 'multi_select',
  'choice', 'choices', 'options', 'submit', 'change', 'select_option', 'in_progress', 'finished_successfully'])
const SIGNAL = /genui|gen_ui|widget|component|interaction|selection|choice|form_state|state_snapshot|selected|options/i
const fieldName = key => /^[a-zA-Z_$][a-zA-Z0-9_$.-]{0,80}$/.test(key) ? key : '[key:' + alias(key) + ']'
function schema(value, field = '', depth = 0, budget = { left: 900 }) {
  if (budget.left-- <= 0 || depth > 9) return { omitted: 'limit' }
  if (/token|secret|password|authorization|cookie|credential/i.test(field)) return { omitted: 'credential-field' }
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'string', chars: value.length, ref: alias(value), ...(ENUMS.has(value) ? { enum: value } : {}) }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (typeof value === 'number') return { type: 'number' }
  if (Array.isArray(value)) return { type: 'array', count: value.length, items: value.slice(0, 8).map(item => schema(item, field, depth + 1, budget)), truncated: value.length > 8 }
  if (typeof value !== 'object') return { type: typeof value }
  const entries = Object.entries(value)
  return { type: 'object', fields: Object.fromEntries(entries.slice(0, 55).map(([key, item]) => [fieldName(key), schema(item, key, depth + 1, budget)])), truncated: entries.length > 55 }
}
function endpoint(value) {
  const url = new URL(value)
  const known = new Set(['backend-api', 'backend-anon', 'f', 'conversation', 'conversations', 'message', 'messages', 'prepare', 'resume', 'stream',
    'genui', 'gen_ui', 'widgets', 'widget', 'components', 'component', 'interaction', 'interactions', 'submit', 'action', 'actions', 'forms', 'state', 'feedback'])
  return { origin: url.origin, path: url.pathname.split('/').map(part => !part || known.has(part) ? part : '{' + alias(part) + '}').join('/'),
    queryNames: [...new Set(url.searchParams.keys())].slice(0, 20).map(fieldName) }
}
function relevantRequest(value) {
  try {
    const url = new URL(value)
    return url.origin === ORIGIN && /^\/backend-(api|anon)\//.test(url.pathname) && /conversation|message|genui|widget|component|interact|choice|submit|action|form|prepare|resume/i.test(url.pathname)
  } catch { return false }
}
function bodySummary(body, mimeType) {
  const shapes = [], signals = [], messages = [], references = []
  let records = 0, malformed = 0, visited = 0, done = false
  const walk = (value, at = '$', depth = 0) => {
    if (value === null || typeof value !== 'object' || depth > 14 || ++visited > 16000) return
    if (Array.isArray(value)) { value.slice(0, 120).forEach((item, index) => walk(item, at + '[' + index + ']', depth + 1)); return }
    if (value.author && typeof value.id === 'string' && messages.length < 80) messages.push({ ref: alias(value.id), role: ENUMS.has(value.author.role) ? value.author.role : 'other', content: schema(value.content, 'content', 0, { left: 200 }) })
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/token|secret|password|authorization|cookie|credential/i.test(key)) continue
      const next = at + '.' + fieldName(key)
      if (SIGNAL.test(key) && signals.length < 45) signals.push({ path: next, schema: schema(item, key, 0, { left: 220 }) })
      if (/^(?:id|.*_id|.*_ids|.*Id|current_node|parent|children)$/.test(key) && typeof item === 'string' && references.length < 160) references.push({ path: next, ref: alias(item) })
      // JSON patch values may contain serialized component descriptions.
      if (typeof item === 'string' && /^[\s]*[\[{]/.test(item) && item.length < 250000 && signals.length < 45) {
        try { const decoded = JSON.parse(item); if (/genui|widget|component|options|selected/i.test(item)) signals.push({ path: next, embeddedJSON: schema(decoded, '', 0, { left: 250 }) }) } catch { /* ordinary text */ }
      }
      walk(item, next, depth + 1)
    }
  }
  const consume = value => { records++; if (shapes.length < 5) shapes.push(schema(value)); walk(value) }
  if (/event-stream/i.test(mimeType) || /^\s*(?:event:|data:)/.test(body)) {
    for (const block of body.split(/\r?\n\r?\n/).slice(0, 10000)) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      if (data === '[DONE]') { done = true; continue }
      try { consume(JSON.parse(data)) } catch { malformed++ }
    }
  } else { try { consume(JSON.parse(body)) } catch { malformed++ } }
  return { records, malformed, done, shapes, signals, messages, references, traversalLimited: visited > 16000 }
}
function observeNetwork(wc) {
  wc.debugger.attach('1.3')
  log('NETWORK-ATTACHED')
  wc.debugger.on('detach', () => { networkReady = false; log('NETWORK-DETACHED') })
  wc.debugger.on('message', (_event, method, params) => {
    if (closing || logLimited) return
    if (method === 'Network.requestWillBeSent') {
      if (!['XHR', 'Fetch'].includes(params.type) || !relevantRequest(params.request.url)) return
      if (requestSequence >= MAX_REQUESTS) { if (requestSequence++ === MAX_REQUESTS) log('LIMIT', { category: 'request-count', limit: MAX_REQUESTS }); return }
      const record = { sequence: ++requestSequence, endpoint: endpoint(params.request.url), method: params.request.method, mimeType: '', status: null }
      requests.set(params.requestId, record)
      log('REQUEST', record); requestCapture('request')
      if (params.request.hasPostData || typeof params.request.postData === 'string') track((async () => {
        try {
          const body = params.request.postData ?? (await bounded(wc.debugger.sendCommand('Network.getRequestPostData', { requestId: params.requestId }))).postData
          if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) { log('REQUEST-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'absent-or-oversize' }); return }
          const summary = bodySummary(body, 'application/json')
          coverage.requestBodies++; coverage.uiSignals += summary.signals.length
          log('REQUEST-BODY', { sequence: record.sequence, chars: body.length, ...summary })
        } catch { log('REQUEST-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'cdp-unavailable' }) }
      })())
    } else if (method === 'Network.responseReceived' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId)
      record.status = params.response.status; record.mimeType = params.response.mimeType
      log('RESPONSE', { sequence: record.sequence, status: record.status, mimeType: /^[\w.+/-]{1,100}$/.test(record.mimeType) ? record.mimeType : 'other' })
    } else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId); requests.delete(params.requestId)
      if (!/json|event-stream|text\/plain|octet-stream/i.test(record.mimeType) || params.encodedDataLength > MAX_BODY) { log('RESPONSE-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'type-or-size-limit' }); return }
      track((async () => {
        try {
          const result = await bounded(wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }))
          const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
          if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) { log('RESPONSE-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'decoded-size-limit' }); return }
          const summary = bodySummary(body, record.mimeType)
          coverage.responseBodies++; coverage.uiSignals += summary.signals.length
          log('RESPONSE-SUMMARY', { sequence: record.sequence, chars: body.length, ...summary }); requestCapture('response-finished')
        } catch { log('RESPONSE-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'cdp-unavailable' }) }
      })())
    } else if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId); requests.delete(params.requestId); coverage.networkFailures++
      log('REQUEST-FAILED', { sequence: record.sequence, canceled: params.canceled === true })
    }
  })
  return wc.debugger.sendCommand('Network.enable', { maxPostDataSize: MAX_BODY, maxResourceBufferSize: MAX_BODY, maxTotalBufferSize: 4 * MAX_BODY })
    .then(() => { networkReady = true; log('NETWORK-READY', { passive: true }) })
}

app.whenReady().then(async () => {
  log('START', { logPath, electron: process.versions.electron, chrome: process.versions.chrome, partition: PARTITION,
    observationOnly: true, pageScriptsParsed: true, rawTextLogged: false, requestReplay: false })
  const ses = session.fromPartition(PARTITION)
  ses.setUserAgent(UA)
  // Electron has only one onBeforeSendHeaders slot; register it exactly once.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    let headers = details.requestHeaders
    try {
      if (new URL(details.url).hostname === 'chatgpt.com') {
        headers = { ...headers }
        for (const name of Object.keys(headers)) if (/^user-agent$|^sec-ch-ua(?:-full-version-list)?$/i.test(name)) delete headers[name]
        const major = process.versions.chrome.split('.')[0]
        headers['User-Agent'] = UA
        headers['sec-ch-ua'] = '"Google Chrome";v="' + major + '", "Chromium";v="' + major + '", "Not(A:Brand";v="24"'
        headers['sec-ch-ua-full-version-list'] = '"Google Chrome";v="' + process.versions.chrome + '", "Chromium";v="' + process.versions.chrome + '", "Not(A:Brand";v="24.0.0.0"'
      }
    } finally { callback({ requestHeaders: headers }) }
  })
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  await ses.setProxy(proxy === 'direct' ? { mode: 'direct' } : { mode: 'fixed_servers', proxyRules: proxy })
  log('PROXY', { mode: proxy === 'direct' ? 'direct' : process.env.PROBE_PROXY ? 'explicit-probe-proxy' : 'default-local-proxy' })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '采集', submenu: [{ label: '手动快照 F6', accelerator: 'F6', click: () => requestCapture('manual-F6') },
      { label: '刷新页面 F5', accelerator: 'F5', click: () => { if (!closing) win.webContents.reload() } }] }
  ]))
  win = new BrowserWindow({ width: 1400, height: 960, minWidth: 800, minHeight: 650,
    title: 'ChatGPT 智能 UI 探针 — 手动选择、提交，结束后关闭窗口',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } })
  const wc = win.webContents
  wc.setUserAgent(UA)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('page-title-updated', event => event.preventDefault())
  wc.on('console-message', details => {
    if (closing || logLimited || !details.message.startsWith(TAG) || details.message.length > 3 * MAX_BODY) return
    try {
      const report = JSON.parse(details.message.slice(TAG.length))
      const frame = framesOf(wc).find(item => frameKey(item) === (details.frame ? frameKey(details.frame) : frameKey(wc.mainFrame)) && item.url === report.route)
      if (!frame) return
      if (report.action === 'dom-change') { requestCapture('dom-change'); return }
      if (!['click', 'change', 'input', 'submit', 'keydown', 'component-message', 'capture-error'].includes(report.action)) return
      if (report.action === 'capture-error') failures++
      pageEvents++
      const { route: rawRoute, snapshot, ...event } = report
      const target = snapshot?.target?.node
      const inComponent = snapshot?.components.some(component => component.controls.some(control => control.node === target?.node)) === true
      coverage.choiceEvent ||= report.action === 'change' && inComponent
      coverage.componentClick ||= report.action === 'click' && inComponent
      coverage.submitEvent ||= report.action === 'submit'
      coverage.composerChanged ||= report.action === 'input' && target?.inComposer === true
      log('PAGE-EVENT', { ...redact(event), frame: frameKey(frame), page: route(rawRoute), inComponent, target: redact(snapshot?.target) })
      if (snapshot) saveSnapshot(snapshot, report.phase + '-' + report.action, frame)
      requestCapture(report.action)
    } catch { failures++; log('PAGE-EVENT-UNAVAILABLE') }
  })
  wc.on('dom-ready', () => { log('DOM-READY', { page: route(wc.getURL()) }); requestCapture('dom-ready') })
  wc.on('did-finish-load', () => { log('PAGE-LOADED', { page: route(wc.getURL()) }); requestCapture('page-loaded') })
  wc.on('did-frame-finish-load', (_event, main, processId, routingId) => {
    if (!main) { log('FRAME-LOADED', { frame: processId + ':' + routingId }); requestCapture('frame-loaded') }
  })
  wc.on('did-navigate-in-page', (_event, url, main) => { if (main) { log('NAVIGATE', { page: route(url) }); requestCapture('navigation') } })
  wc.on('did-fail-load', (_event, code, _description, url, main) => { if (main && code !== -3) log('LOAD-FAILED', { code, page: route(url) }) })
  wc.on('render-process-gone', (_event, details) => log('RENDER-PROCESS-GONE', { reason: details.reason, exitCode: details.exitCode }))
  timer = setInterval(() => requestCapture('periodic'), 2000)
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true
    clearInterval(timer); clearTimeout(captureTimer); reasons.clear()
    win.setTitle('ChatGPT 智能 UI 探针 — 正在保存最后的日志…')
    void (async () => {
      try {
        await bounded((async () => {
          if (capturing) await capturing
          await capture('final')
          await Promise.allSettled([...tasks])
          for (const frame of framesOf(wc)) await bounded(frame.executeJavaScript('window[' + JSON.stringify(KEY) + ']?.dispose()'), 1000)
        })(), 6000)
      } catch { log('FINAL-INCOMPLETE', { category: 'close-timeout' }) }
      finally {
        log('COVERAGE', { snapshots: snapshotSequence, pageEvents, failures, networkReady, pendingRequests: requests.size, logLimited, ...coverage,
          note: '选项变化、提交事件、请求正文和刷新恢复需结合判断；未捕获的状态不算已覆盖。' })
        console.log('\n日志已保存：' + logPath + '\n把这个路径发给智能体即可。\n')
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
        if (!win.isDestroyed()) win.destroy()
      }
    })()
  })
  console.log('\n按 tools/diag/chatgpt-smart-ui-probe.md 操作；由你手动选择和提交，探针只观察。\n日志：' + logPath + '\n')
  // Loading must not await Network.enable: an uncreated renderer can leave a blank window.
  log('PAGE-LOAD-START', { page: route(start.href) })
  const load = wc.loadURL(start.href).catch(() => log('PAGE-LOAD-REJECTED', { page: route(start.href) }))
  track((async () => {
    try { await bounded(observeNetwork(wc), 5000) }
    catch { log('NETWORK-UNAVAILABLE', { category: 'attach-or-enable-timeout-or-failure', note: '网页继续加载，DOM 仍可采集。' }) }
  })())
  await load
}).catch(() => { log('FATAL', { category: 'probe-startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
