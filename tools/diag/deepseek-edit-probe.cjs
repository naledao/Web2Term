/**
 * User-run, passive capture of DeepSeek's native edit-and-resend interaction.
 * See deepseek-edit-probe.md. The agent must never launch this probe.
 * No app imports, send interceptor, automated clicks, fetches or request replay.
 */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHmac, randomUUID } = require('node:crypto')
const vm = require('node:vm')

const ORIGIN = 'https://chat.deepseek.com'
const PARTITION = process.env.PROBE_PARTITION || 'persist:deepseek'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 https://chat.deepseek.com 同源页面。')
app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(directory, 'deepseek-edit-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const salt = randomUUID()
const TAG = '[deepseek-edit-' + randomUUID() + '] '
const KEY = '__deepseekEditProbe_' + randomUUID().replace(/-/g, '')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
const MAX_BODY = 2 * 1024 * 1024
const MAX_REQUESTS = 160
const alias = value => value == null || value === '' ? null : createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16)
let win, closing = false, timer, captureTimer, capturing = null, networkReady = false
let requestSequence = 0, snapshotSequence = 0, lastSignature = '', failures = 0, pageEvents = 0
const requests = new Map(), tasks = new Set(), reasons = new Set()
const coverage = { rows: false, rowEditor: false, editClick: false, cancelClick: false, rowSendClick: false, rowEnter: false,
  pagerSeen: false, pagerClick: false, regenerateClick: false, generating: false, safetyInDom: false, safetyInStream: false,
  requestBodies: 0, streamResponses: 0, historyResponses: 0, networkFailures: 0 }

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data })
  try { fs.appendFileSync(logPath, line + '\n', 'utf8') }
  catch { console.error('日志写入失败：' + logPath) }
  if (!['SNAPSHOT', 'STRUCTURE', 'PAGE-EVENT', 'REQUEST-BODY', 'RESPONSE-SUMMARY'].includes(event)) console.log(line)
}
function route(value) {
  try {
    const url = new URL(value)
    const match = /^\/a\/chat\/s\/([^/]+)/.exec(url.pathname)
    return { origin: url.origin, kind: match ? 'conversation' : url.pathname === '/' ? 'home' : 'other', conversation: match ? alias(match[1]) : null }
  } catch { return { kind: 'unavailable' } }
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

/** Self-contained page reader. Text is reported as lengths; icon paths only as short prefixes. */
function inspectEdit(target = null) {
  // Independent copies of the measured DeepSeek descriptor (src/shared/platforms.ts). The edit
  // controls are what this run discovers, so nothing here names them in advance.
  const ROW = '[data-virtual-list-item-key]'
  const ANSWER = '.ds-assistant-message-main-content'
  const THINK = '.ds-think-content'
  const EDITOR = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
  const STOP = '.ds-button--primary.ds-button--circle:has(svg path[d^="M2 4.88C2 3.68009"])'
  const SEND = ['.ds-button--primary.ds-button--circle:not(.ds-button--disabled)', '.ds-button--primary.ds-button--filled', 'button[type="submit"]']
  const CONTROL = 'button, [role="button"], [tabindex], .ds-icon-button, .ds-button'
  const SAFE_LABEL = /^(编辑|编辑消息|修改|取消|发送|保存|确定|确认|提交|复制|重新生成|继续生成|分享|上一个|下一个|点赞|点踩|朗读|已停止|Edit|Cancel|Send|Save|Copy|Regenerate)$/i
  const PAGER = /^\d{1,3}\s*\/\s*\d{1,3}$/
  const query = (selector, root = document) => [...root.querySelectorAll(selector)]
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const label = value => { const text = collapse(value); return !text ? null : SAFE_LABEL.test(text) || PAGER.test(text) ? text : '[label chars=' + text.length + ']' }
  const textOf = node => String(typeof node.value === 'string' ? node.value : node.innerText || node.textContent || '')
  const visible = node => {
    const box = node.getBoundingClientRect(), css = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none' && !node.closest('[hidden], [aria-hidden="true"], [inert]')
  }
  const rect = node => { const box = node.getBoundingClientRect(); return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) } }
  const attributes = node => {
    const result = {}
    for (const { name, value } of node.attributes) {
      if (name === 'class') result.class = value.slice(0, 300)
      else if (name === 'data-virtual-list-item-key') result[name] = /^\d{1,6}$/.test(value) ? value : '[value chars=' + value.length + ']'
      else if (['aria-label', 'title', 'placeholder'].includes(name)) result[name] = label(value)
      else if (['role', 'type', 'tabindex', 'contenteditable', 'aria-expanded', 'aria-hidden', 'aria-disabled', 'aria-pressed',
        'disabled', 'readonly', 'rows', 'enterkeyhint', 'dir'].includes(name)) result[name] = /^[\w:. -]{0,60}$/.test(value) ? value : '[value chars=' + value.length + ']'
      else if (name === 'id') result.id = '[id chars=' + value.length + ']'
      else if (name.startsWith('data-')) result[name] = /^[\w:. -]{0,40}$/.test(value) ? value : '[value chars=' + value.length + ']'
    }
    return result
  }
  const rowOf = node => node instanceof Element ? node.closest(ROW) : null
  const roleOf = row => row.querySelector(ANSWER) || row.querySelector(THINK) ? 'assistant' : 'user'
  const rowKey = row => row ? row.getAttribute('data-virtual-list-item-key') : null
  const describe = node => {
    if (!(node instanceof Element)) return null
    return { tag: node.tagName.toLowerCase(), attrs: attributes(node), visible: visible(node), rect: rect(node), textChars: textOf(node).length,
      disabled: 'disabled' in node ? node.disabled : null, focused: node === document.activeElement || node.contains(document.activeElement) }
  }
  const control = node => ({ ...describe(node), label: label(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText),
    icon: query('svg path', node).slice(0, 2).map(item => String(item.getAttribute('d') || '').slice(0, 24)),
    sendMatches: SEND.filter(selector => node.matches(selector)), stopMatch: node.matches(STOP), nested: !!node.parentElement?.closest(CONTROL) })
  const chain = node => {
    const result = []
    for (let item = node; item && item !== document.body && result.length < 12; item = item.parentElement) {
      result.push({ ...describe(item), editors: item.querySelectorAll(EDITOR).length, controls: item.querySelectorAll(CONTROL).length })
      if (item.matches(ROW)) break
    }
    return result
  }
  const structure = (node, budget, depth = 0) => {
    if (budget.left-- <= 0) return null
    if (node.nodeType === Node.TEXT_NODE) {
      const text = collapse(node.textContent)
      return text ? (PAGER.test(text) || SAFE_LABEL.test(text) ? { text } : { textChars: node.textContent.length }) : null
    }
    if (!(node instanceof Element) || /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|LINK|META|IMG|PATH)$/.test(node.tagName)) return null
    if (node.tagName.toLowerCase() === 'svg') return { tag: 'svg', icon: query('path', node).slice(0, 1).map(item => String(item.getAttribute('d') || '').slice(0, 24)) }
    const result = describe(node)
    if (node.matches(EDITOR)) return { ...result, valueChars: textOf(node).length }
    if (node.matches(ANSWER) || node.matches(THINK)) return { ...result, bodyOmitted: true }
    if (depth >= 16) return { ...result, depthLimit: true }
    result.children = []
    for (const child of node.childNodes) { if (budget.left <= 0) break; const item = structure(child, budget, depth + 1); if (item) result.children.push(item) }
    return result
  }
  const safety = row => {
    const answer = row.querySelector(ANSWER), think = row.querySelector(THINK)
    const has = node => !!node && textOf(node).includes('<ds_safety')
    const answerText = answer ? collapse(textOf(answer)) : ''
    return { inAnswer: has(answer), inThink: has(think), inRow: textOf(row).includes('<ds_safety'),
      // The exact shape matters for detection: a lone block followed by a verdict word.
      answerIsOnlySafety: /^<ds_safety>[\s\S]*<\/ds_safety>\s*(?:Safe|Unsafe)?$/i.test(answerText),
      verdict: /<\/ds_safety>\s*(Safe|Unsafe)\s*$/i.exec(answerText)?.[1] || null }
  }
  const rows = query(ROW)
  const targetRow = rowOf(target)
  const sampled = rows.slice(-8)
  if (targetRow && !sampled.includes(targetRow)) sampled.unshift(targetRow)
  const rowInfo = row => {
    const role = roleOf(row), budget = { left: 400 }
    const pagers = query('*', row).filter(node => node.children.length === 0 && PAGER.test(collapse(node.textContent))).slice(0, 4)
    return { key: rowKey(row), role, visible: visible(row), rect: rect(row), textChars: textOf(row).length,
      answerChars: row.querySelector(ANSWER) ? textOf(row.querySelector(ANSWER)).length : null,
      thinkChars: row.querySelector(THINK) ? textOf(row.querySelector(THINK)).length : null,
      safety: role === 'assistant' ? safety(row) : null,
      pagers: pagers.map(node => ({ text: collapse(node.textContent), chain: chain(node).slice(0, 4) })),
      controls: query(CONTROL, row).slice(0, 36).map(control),
      editors: query(EDITOR, row).map(node => ({ ...describe(node), valueChars: textOf(node).length })),
      // The user side is small; the assistant side is reduced to its controls above.
      structure: role === 'user' || query(EDITOR, row).length ? structure(row, budget) : null, truncated: budget.left <= 0 }
  }
  const editors = query(EDITOR).slice(0, 12).map(node => {
    const row = rowOf(node), text = textOf(node)
    let scope = node
    for (let depth = 0; depth < 6 && scope.parentElement && scope !== row; depth++) scope = scope.parentElement
    return { ...describe(node), inRow: !!row, rowKey: rowKey(row), rowRole: row ? roleOf(row) : null, valueChars: text.length,
      lines: text.split('\n').length, selection: typeof node.selectionStart === 'number' ? { start: node.selectionStart, end: node.selectionEnd } : null,
      inForm: !!node.closest('form'), chain: chain(node), nearbyControls: query(CONTROL, row || scope).slice(0, 24).map(control) }
  })
  return { route: location.href, counts: { rows: rows.length, editors: editors.length, visibleEditors: editors.filter(item => item.visible).length },
    rowKeys: rows.map(rowKey).slice(-40), generating: query(STOP).some(visible),
    continueVisible: query(CONTROL).some(node => collapse(node.innerText) === '继续生成' && visible(node)),
    active: describe(document.activeElement), target: target instanceof Element ? { node: describe(target), rowKey: rowKey(targetRow),
      rowRole: targetRow ? roleOf(targetRow) : null, chain: chain(target) } : null,
    editors, rows: sampled.map(rowInfo) }
}

/** Passive listeners, installed once per document; no preventDefault or DOM writes. */
function observeEdit(config, inspect) {
  if (window[config.key]) return 'already-installed'
  const ROW = '[data-virtual-list-item-key]'
  const CONTROL = 'button, [role="button"], [tabindex], .ds-icon-button, .ds-button'
  const disposers = []
  let mutationTimer, inputTimer
  const emit = (action, data = {}, snapshot = false, target = null) => console.log(config.tag + JSON.stringify({ action, ...data,
    snapshot: snapshot ? inspect(target) : null, route: location.href }))
  const on = (name, handler) => {
    const options = { capture: true, passive: true }
    document.addEventListener(name, handler, options)
    disposers.push(() => document.removeEventListener(name, handler, options))
  }
  const editorOf = target => target instanceof Element ? target.closest('textarea, [contenteditable="true"], [role="textbox"]') : null
  on('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const node = event.target.closest(CONTROL)
    if (!node) return
    const text = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '').replace(/\s+/g, ' ').trim()
    const kind = /^(编辑|编辑消息|修改|Edit)$/i.test(text) ? 'edit' : /^(取消|Cancel)$/i.test(text) ? 'cancel'
      : /^(发送|保存|确定|确认|提交|Send|Save)$/i.test(text) ? 'send' : /^重新生成$/.test(text) ? 'regenerate'
        : /^\d{1,3}\s*\/\s*\d{1,3}$/.test(text) ? 'pager' : 'other'
    const row = node.closest(ROW)
    // Icon buttons carry no text: keep every control click inside a row, labelled by its icon.
    if (kind !== 'other' || row) emit('click', { kind, inRow: !!row, rowKey: row ? row.getAttribute('data-virtual-list-item-key') : null,
      icon: [...node.querySelectorAll('svg path')].slice(0, 2).map(item => String(item.getAttribute('d') || '').slice(0, 24)) }, true, node)
  })
  on('keydown', event => {
    if (!event.isTrusted || event.repeat || !['Enter', 'Escape'].includes(event.key) || !editorOf(event.target)) return
    const row = event.target.closest(ROW)
    emit('key', { key: event.key, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
      composing: event.isComposing, defaultPrevented: event.defaultPrevented, inRow: !!row,
      rowKey: row ? row.getAttribute('data-virtual-list-item-key') : null }, true, event.target)
  })
  on('submit', event => { if (event.isTrusted) emit('submit', {}, true, event.target) })
  on('focusin', event => { if (editorOf(event.target)) emit('editor-focus', { inRow: !!event.target.closest(ROW) }, true, event.target) })
  on('input', event => {
    if (!event.isTrusted || !editorOf(event.target)) return
    clearTimeout(inputTimer)
    inputTimer = setTimeout(() => emit('editor-input', { inRow: !!event.target.closest(ROW) }, true, event.target), 500)
  })
  const observer = new MutationObserver(() => {
    if (!mutationTimer) mutationTimer = setTimeout(() => { mutationTimer = null; emit('dom-change') }, 300)
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['contenteditable', 'disabled', 'aria-disabled', 'hidden', 'data-virtual-list-item-key'] })
  window[config.key] = () => { observer.disconnect(); clearTimeout(mutationTimer); clearTimeout(inputTimer); disposers.forEach(dispose => dispose()); delete window[config.key] }
  return 'installed'
}

const readerSource = '(' + inspectEdit.toString() + ')()'
const observerSource = '(' + observeEdit.toString() + ')(' + JSON.stringify({ key: KEY, tag: TAG }) + ', ' + inspectEdit.toString() + ')'
new vm.Script(readerSource, { filename: 'deepseek-edit-reader.js' })
new vm.Script(observerSource, { filename: 'deepseek-edit-observer.js' })

function saveSnapshot(raw, reason) {
  if (!raw || !win || win.isDestroyed() || raw.route !== win.webContents.getURL()) return
  const { route: rawRoute, ...metadata } = raw
  const snapshot = { route: route(rawRoute), ...metadata }
  coverage.rows ||= snapshot.counts.rows > 0
  coverage.generating ||= snapshot.generating
  coverage.rowEditor ||= snapshot.editors.some(editor => editor.inRow && editor.visible)
  coverage.pagerSeen ||= snapshot.rows.some(row => row.pagers.length > 0)
  coverage.safetyInDom ||= snapshot.rows.some(row => row.safety?.inRow)
  // Positions and sizes move with every scroll; leave them out of the change signature.
  const signature = alias(JSON.stringify(snapshot, (key, value) => key === 'rect' ? undefined : value))
  if (signature === lastSignature && reason !== 'final') return
  lastSignature = signature
  const sequence = ++snapshotSequence
  const { rows, ...info } = snapshot
  log('SNAPSHOT', { sequence, reason, ...info, rows: rows.map(({ structure, ...row }) => row) })
  log('STRUCTURE', { sequence, rows: rows.filter(row => row.structure).map(row => ({ key: row.key, role: row.role, structure: row.structure, truncated: row.truncated })) })
}
function requestCapture(reason) {
  if (closing) return
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
    if (!win || win.isDestroyed() || new URL(win.webContents.getURL()).origin !== ORIGIN) return
    saveSnapshot(await bounded(win.webContents.executeJavaScript(readerSource)), reason)
  } catch { failures++; log('CAPTURE-UNAVAILABLE', { reason }) }
}

// DeepSeek message ids are small per-session integers; session ids are UUIDs and are aliased.
const ID_FIELD = /^(id|.*_id|.*_ids|parent|children|current_node|messageId|parentId)$/
const ENUMS = new Set(['USER', 'ASSISTANT', 'user', 'assistant', 'WIP', 'FINISHED', 'INCOMPLETE', 'CONTENT_FILTER', 'TIMEOUT',
  'APPEND', 'SET', 'BATCH', 'RESPONSE', 'THINK', 'SEARCH', 'TIP', 'READY', 'update_session', 'title', 'close', 'finish', 'ready'])
const ENUM_FIELD = /^(role|status|o|op|type|event|kind|model_type|model_class|finish_reason)$/
function schema(value, field = '', depth = 0, budget = { left: 1100 }) {
  if (budget.left-- <= 0 || depth > 10) return { omitted: 'limit' }
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'string', chars: value.length,
    ...(ID_FIELD.test(field) ? { ref: alias(value) } : ENUM_FIELD.test(field) && ENUMS.has(value) ? { enum: value } : {}) }
  if (typeof value === 'number') return { type: 'number', ...(ID_FIELD.test(field) && Number.isSafeInteger(value) && Math.abs(value) < 1e9 ? { value } : {}) }
  if (typeof value === 'boolean') return { type: 'boolean', value }
  if (Array.isArray(value)) return { type: 'array', count: value.length,
    items: value.slice(0, 12).map(item => schema(item, field, depth + 1, budget)), truncated: value.length > 12 }
  if (!value || typeof value !== 'object') return { type: typeof value }
  const entries = Object.entries(value)
  return { type: 'object', fields: Object.fromEntries(entries.slice(0, 70).map(([key, item]) => [
    /^[a-zA-Z_][a-zA-Z0-9_]{0,70}$/.test(key) ? key : '[key:' + alias(key) + ']', schema(item, key, depth + 1, budget)])), truncated: entries.length > 70 }
}
function endpoint(value) {
  const url = new URL(value)
  const known = new Set(['api', 'v0', 'chat', 'chat_session', 'completion', 'edit_message', 'regenerate', 'resume_stream', 'stop_stream',
    'history_messages', 'create', 'fetch_page', 'update_title', 'message', 'messages', 'feedback', 'continue', 'create_pow_challenge'])
  return { path: url.pathname.split('/').map(segment => !segment || known.has(segment) ? segment : '{' + alias(segment) + '}').join('/'),
    queryNames: [...new Set(url.searchParams.keys())].filter(key => /^[a-zA-Z_]{1,40}$/.test(key)).slice(0, 20) }
}
function relevantRequest(value) {
  try {
    const url = new URL(value)
    return url.origin === ORIGIN && url.pathname.startsWith('/api/') && /chat|message|session|completion|edit|regenerate|resume|history|continue/.test(url.pathname)
  } catch { return false }
}
function responseSummary(body, mimeType) {
  const messages = new Map(), ids = new Map(), paths = new Map(), events = new Map(), shapes = new Map()
  let records = 0, malformed = 0, safetyRecords = 0, visited = 0
  const safetyPaths = new Set()
  const numberOrRef = value => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) < 1e9 ? value : alias(value)
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || ++visited > 30000) return
    if (Array.isArray(value)) { value.slice(0, 200).forEach(item => walk(item, depth + 1)); return }
    if (typeof value.role === 'string' && ('message_id' in value || 'id' in value)) {
      const id = numberOrRef(value.message_id ?? value.id)
      const content = typeof value.content === 'string' ? value.content : ''
      messages.set(String(id), { id, parent: numberOrRef(value.parent_id ?? null), role: ENUMS.has(value.role) ? value.role : 'other',
        status: ENUMS.has(value.status) ? value.status : null, contentChars: content.length,
        thinkingChars: typeof value.thinking_content === 'string' ? value.thinking_content.length : null,
        fragments: Array.isArray(value.fragments) ? value.fragments.slice(0, 8).map(item => ({ type: ENUMS.has(item?.type) ? item.type : 'other',
          chars: typeof item?.content === 'string' ? item.content.length : null, safety: typeof item?.content === 'string' && item.content.includes('<ds_safety') })) : null,
        safety: content.includes('<ds_safety') })
    }
    for (const [key, item] of Object.entries(value)) {
      if (ID_FIELD.test(key) && (typeof item === 'number' || typeof item === 'string') && ids.size < 200) ids.set(key + ':' + item, { field: key, value: numberOrRef(item) })
    }
    for (const [key, item] of Object.entries(value)) if (!['content', 'thinking_content'].includes(key)) walk(item, depth + 1)
  }
  const consume = (value, text) => {
    records++
    if (value && typeof value === 'object' && typeof value.p === 'string' && /^[\w/\-.]{1,80}$/.test(value.p)) paths.set(value.p, (paths.get(value.p) || 0) + 1)
    if (text.includes('ds_safety')) { safetyRecords++; if (typeof value?.p === 'string') safetyPaths.add(value.p.slice(0, 80)) }
    walk(value)
    if (shapes.size < 6) {
      const shape = schema(value)
      const signature = JSON.stringify(shape).replace(/"chars":\d+/g, '').replace(/"(?:ref|value)":(?:"[a-f0-9]+"|\d+)/g, '')
      if (!shapes.has(signature)) shapes.set(signature, shape)
    }
  }
  if (/event-stream/i.test(mimeType) || /^\s*(?:event:|data:)/.test(body)) {
    for (const block of body.split(/\r?\n\r?\n/).slice(0, 20000)) {
      const lines = block.split(/\r?\n/)
      const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
      if (name && /^[\w-]{1,40}$/.test(name)) events.set(name, (events.get(name) || 0) + 1)
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      try { consume(JSON.parse(data), data) } catch { malformed++ }
    }
  } else { try { consume(JSON.parse(body), body) } catch { malformed++ } }
  return { records, malformed, events: Object.fromEntries(events), paths: Object.fromEntries([...paths].slice(0, 40)),
    safetyRecords, safetyPaths: [...safetyPaths], messages: [...messages.values()].slice(0, 120), ids: [...ids.values()].slice(0, 120),
    sampleSchemas: [...shapes.values()] }
}
function observeNetwork(wc) {
  wc.debugger.attach('1.3')
  log('NETWORK-ATTACHED')
  wc.debugger.on('detach', () => { networkReady = false; log('NETWORK-DETACHED') })
  wc.debugger.on('message', (_event, method, params) => {
    if (closing) return
    if (method === 'Network.requestWillBeSent') {
      if (!['XHR', 'Fetch'].includes(params.type) || !relevantRequest(params.request.url)) return
      if (requestSequence >= MAX_REQUESTS) { if (requestSequence++ === MAX_REQUESTS) log('NETWORK-LIMIT', { limit: MAX_REQUESTS }); return }
      const record = { sequence: ++requestSequence, endpoint: endpoint(params.request.url), method: params.request.method,
        page: route(wc.getURL()), status: null, mimeType: '', hasPostData: params.request.hasPostData === true }
      requests.set(params.requestId, record)
      log('REQUEST', record)
      requestCapture('request')
      if (record.hasPostData || typeof params.request.postData === 'string') track((async () => {
        try {
          const body = typeof params.request.postData === 'string' ? params.request.postData
            : (await bounded(wc.debugger.sendCommand('Network.getRequestPostData', { requestId: params.requestId }))).postData
          if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BODY) { log('REQUEST-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'absent-or-oversize' }); return }
          let json
          try { json = JSON.parse(body) } catch { log('REQUEST-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'not-json', chars: body.length }); return }
          coverage.requestBodies++
          log('REQUEST-BODY', { sequence: record.sequence, chars: body.length, schema: schema(json) })
        } catch { log('REQUEST-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'cdp-unavailable' }) }
      })())
    } else if (method === 'Network.responseReceived' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId)
      record.status = params.response.status
      record.mimeType = params.response.mimeType
      log('RESPONSE', { sequence: record.sequence, status: record.status, mimeType: /^[\w.+/-]{1,100}$/.test(record.mimeType) ? record.mimeType : 'other' })
    } else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId); requests.delete(params.requestId)
      if (!/json|event-stream|text\/plain|octet-stream/i.test(record.mimeType) || params.encodedDataLength > MAX_BODY) {
        log('RESPONSE-BODY-SKIPPED', { sequence: record.sequence, category: 'type-or-size-limit' }); return
      }
      track((async () => {
        try {
          const result = await bounded(wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }))
          const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
          if (Buffer.byteLength(body) > MAX_BODY) { log('RESPONSE-BODY-SKIPPED', { sequence: record.sequence, category: 'decoded-size-limit' }); return }
          const summary = responseSummary(body, record.mimeType)
          if (/event-stream/i.test(record.mimeType)) coverage.streamResponses++
          if (/history_messages/.test(record.endpoint.path)) coverage.historyResponses++
          coverage.safetyInStream ||= summary.safetyRecords > 0
          log('RESPONSE-SUMMARY', { sequence: record.sequence, ...summary })
          requestCapture('response-finished')
        } catch { log('RESPONSE-BODY-UNAVAILABLE', { sequence: record.sequence, category: 'cdp-or-parser-unavailable' }) }
      })())
    } else if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId); requests.delete(params.requestId)
      coverage.networkFailures++
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
  // Exactly one header listener; same identity treatment as deepseek-chat-view-probe.cjs.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) if (/^user-agent$|^sec-ch-ua(?:-full-version-list)?$/i.test(name)) delete headers[name]
    const major = process.versions.chrome.split('.')[0]
    headers['User-Agent'] = UA
    headers['sec-ch-ua'] = '"Google Chrome";v="' + major + '", "Chromium";v="' + major + '", "Not(A:Brand";v="24"'
    headers['sec-ch-ua-full-version-list'] = '"Google Chrome";v="' + process.versions.chrome + '", "Chromium";v="' + process.versions.chrome + '", "Not(A:Brand";v="24.0.0.0"'
    callback({ requestHeaders: headers })
  })
  const proxy = process.env.PROBE_PROXY
  if (proxy) await ses.setProxy(proxy === 'direct' ? { mode: 'direct' } : { mode: 'fixed_servers', proxyRules: proxy })
  log('PROXY', { mode: proxy === 'direct' ? 'direct' : proxy ? 'explicit-probe-proxy' : 'system-default', note: '不会读取或修改应用已保存的代理设置。' })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '采集', submenu: [{ label: '手动快照 F6', accelerator: 'F6', click: () => requestCapture('manual-F6') },
      { label: '刷新页面 F5', accelerator: 'F5', click: () => { if (!closing) win.webContents.reload() } }] }
  ]))
  win = new BrowserWindow({ width: 1400, height: 960, minWidth: 800, minHeight: 650,
    title: 'DeepSeek 编辑消息探针 — 按说明手动编辑，结束后关闭窗口',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } })
  const wc = win.webContents
  wc.setUserAgent(UA)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('page-title-updated', event => event.preventDefault())
  const install = () => {
    if (closing || wc.isDestroyed()) return
    try { if (new URL(wc.getURL()).origin !== ORIGIN) return } catch { return }
    track(bounded(wc.executeJavaScript(observerSource)).then(status => {
      if (status === 'installed') log('OBSERVER-READY', { page: route(wc.getURL()) })
      requestCapture('observer-ready')
    }).catch(() => log('OBSERVER-UNAVAILABLE')))
  }
  wc.on('console-message', details => {
    if (closing || !details.message.startsWith(TAG) || details.message.length > 2 * MAX_BODY) return
    try {
      const report = JSON.parse(details.message.slice(TAG.length))
      if (report.route !== wc.getURL() || new URL(report.route).origin !== ORIGIN) return
      if (!['click', 'key', 'submit', 'editor-focus', 'editor-input', 'dom-change'].includes(report.action)) return
      if (report.action !== 'dom-change') {
        pageEvents++
        const rowEditorOpen = report.snapshot?.editors?.some(editor => editor.inRow && editor.visible) === true
        coverage.editClick ||= report.action === 'click' && report.kind === 'edit'
        coverage.cancelClick ||= report.action === 'click' && report.kind === 'cancel'
        coverage.pagerClick ||= report.action === 'click' && report.kind === 'pager'
        coverage.regenerateClick ||= report.action === 'click' && report.kind === 'regenerate'
        coverage.rowSendClick ||= report.action === 'click' && report.kind === 'send' && rowEditorOpen
        coverage.rowEnter ||= report.action === 'key' && report.key === 'Enter' && report.inRow && !report.shift && !report.composing
        const { route: rawRoute, snapshot, ...event } = report
        log('PAGE-EVENT', { ...event, page: route(rawRoute), rowEditorOpen, target: snapshot?.target ?? null })
        if (snapshot) saveSnapshot(snapshot, 'before-' + report.action + (report.kind ? '-' + report.kind : ''))
      }
      requestCapture(report.action)
    } catch { log('PAGE-EVENT-UNAVAILABLE') }
  })
  wc.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && ['Enter', 'Escape'].includes(input.key) && !input.isAutoRepeat) {
      log('NATIVE-KEY', { key: input.key, shift: input.shift, ctrl: input.control, alt: input.alt, meta: input.meta })
    }
  })
  wc.on('dom-ready', () => { log('DOM-READY', { page: route(wc.getURL()) }); install() })
  wc.on('did-finish-load', () => { log('PAGE-LOADED', { page: route(wc.getURL()) }); install() })
  wc.on('did-navigate-in-page', (_event, url, isMain) => { if (isMain) { log('NAVIGATE', { page: route(url) }); requestCapture('navigation') } })
  wc.on('did-fail-load', (_event, code, _description, url, isMain) => { if (isMain && code !== -3) log('LOAD-FAILED', { code, page: route(url) }) })
  wc.on('render-process-gone', (_event, details) => log('RENDER-PROCESS-GONE', { reason: details.reason, exitCode: details.exitCode }))
  timer = setInterval(() => requestCapture('periodic'), 1500)
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true
    clearInterval(timer); clearTimeout(captureTimer); reasons.clear()
    win.setTitle('DeepSeek 编辑消息探针 — 正在保存最后的日志…')
    void (async () => {
      try {
        await bounded((async () => {
          if (capturing) await capturing
          await capture('final')
          await Promise.allSettled([...tasks])
          if (!wc.isDestroyed()) await bounded(wc.executeJavaScript('window[' + JSON.stringify(KEY) + ']?.()'))
        })(), 6000)
      } catch { log('FINAL-INCOMPLETE', { category: 'close-timeout' }) }
      finally {
        log('COVERAGE', { snapshots: snapshotSequence, pageEvents, failures, networkReady, pendingRequests: requests.size, ...coverage,
          note: '记录的是原网页行为；事件出现不等于重发成功，须结合请求、回复及刷新后的版本切换。未观察状态不算已覆盖。' })
        console.log('\n日志已保存：' + logPath + '\n把这个路径发给智能体即可。\n')
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
        if (!win.isDestroyed()) win.destroy()
      }
    })()
  })
  console.log('\n按 tools/diag/deepseek-edit-probe.md 操作；探针只观察，由你手动编辑和发送。\n日志：' + logPath + '\n')
  // Navigation first; observing the network stays optional (see chatgpt-edit-probe.cjs).
  log('PAGE-LOAD-START', { page: route(start.href) })
  const pageLoad = wc.loadURL(start.href).catch(() => log('PAGE-LOAD-REJECTED', { page: route(start.href) }))
  track((async () => {
    try { await bounded(observeNetwork(wc), 5000) }
    catch (error) {
      log('NETWORK-UNAVAILABLE', { category: error?.message === 'probe-timeout' ? 'enable-timeout' : 'attach-or-enable-failed',
        note: '网页继续加载，DOM 仍可采集；网络状态以 NETWORK-READY 为准。' })
    }
  })())
  await pageLoad
}).catch(() => { log('FATAL', { category: 'probe-startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
