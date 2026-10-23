/**
 * User-run, passive capture of ChatGPT's edit-and-resend interaction.
 * See chatgpt-edit-probe.md. The agent must never launch this probe.
 * No app imports, send interceptor, automated clicks, fetches or request replay.
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
const logPath = path.join(directory, 'chatgpt-edit-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const salt = randomUUID()
const TAG = '[chatgpt-edit-' + randomUUID() + '] '
const KEY = '__chatgptEditProbe_' + randomUUID().replace(/-/g, '')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
const MAX_BODY = 2 * 1024 * 1024
const MAX_REQUESTS = 160
const alias = value => value == null || value === '' ? null : createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16)
let win, closing = false, timer, captureTimer, capturing = null, networkReady = false
let requestSequence = 0, snapshotSequence = 0, lastSignature = '', failures = 0, pageEvents = 0
const requests = new Map(), tasks = new Set(), reasons = new Set()
const coverage = { userTurns: false, editControl: false, historyEditor: false, editClick: false,
  cancelClick: false, historyEnter: false, historySendClick: false, generating: false, graphResponses: 0,
  requestBodies: 0, streamResponses: 0, networkFailures: 0 }

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data })
  try { fs.appendFileSync(logPath, line + '\n', 'utf8') }
  catch { console.error('日志写入失败：' + logPath) }
  if (!['SNAPSHOT', 'STRUCTURE', 'PAGE-EVENT', 'REQUEST-BODY', 'RESPONSE-SUMMARY'].includes(event)) console.log(line)
}
function route(value) {
  try {
    const url = new URL(value)
    const match = /^\/(?:g\/[^/]+\/)?c\/([^/]+)/.exec(url.pathname)
    return { origin: url.origin, kind: match ? 'conversation' : url.pathname === '/' ? 'home' : 'other', conversation: match ? alias(match[1]) : null }
  } catch { return { kind: 'unavailable' } }
}
// IDs are returned by the page only in this explicit wrapper. Replace them before logging;
// the same per-run salt correlates DOM attributes, request fields and response graph nodes.
function redactIds(value) {
  if (!value || typeof value !== 'object') return value
  if (Object.keys(value).length === 1 && typeof value.__probeId === 'string') return alias(value.__probeId)
  if (Array.isArray(value)) return value.map(redactIds)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactIds(item)]))
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

/** Self-contained page reader. All text/value fields are lengths; no raw HTML dumps. */
function inspectEdit(target = null) {
  // Independent copies of the measured ChatGPT descriptor. Edit controls are discoveries,
  // not adapter selectors: report their actual structure before implementing the feature.
  const GROUP = '[data-turn-key], [data-content-search-turn-key], article[data-testid^="conversation-turn-"]'
  const USER = '[class~="group/user-message"][data-chatgpt-search-unit-key], [data-content-search-unit-key$=":user"], [data-message-author-role="user"]'
  const ID = '[data-chatgpt-selection-message-id], [data-message-id]'
  const EDITOR = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'
  const COMPOSERS = ['div[contenteditable="true"][data-composer-markdown]', 'div[contenteditable="true"][role="textbox"]',
    'textarea#pending-home-input', '#prompt-textarea', 'div[contenteditable="true"]']
  const STOP = ['[data-composer-footer-responsive] button[aria-label="停止"]', 'button[aria-label="停止"]',
    '[data-testid="stop-button"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="停止生成"]']
  const CONTROL = 'button, [role="button"], [role="menuitem"]'
  const SAFE_LABEL = /^(编辑消息|编辑|修改消息|Edit message|Edit|取消|Cancel|发送|发送消息|保存并提交|保存并发送|提交|Send|Send message|Save\s*(?:&|and)\s*(?:submit|send)|停止|停止生成|Stop|Stop generating|复制|复制消息|Copy|Copy message|分享|Share|上一个|下一个|Previous|Next)$/i
  const ref = value => value ? { __probeId: String(value) } : null
  const query = (selector, root = document) => [...root.querySelectorAll(selector)]
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const label = value => { const text = collapse(value); return SAFE_LABEL.test(text) ? text : '[label chars=' + text.length + ']' }
  const textOf = node => String(typeof node.value === 'string' ? node.value : node.innerText || node.textContent || '')
  const visible = node => {
    const box = node.getBoundingClientRect(), css = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none' && !node.closest('[hidden], [aria-hidden="true"], [inert]')
  }
  const attributes = node => {
    const result = {}
    for (const { name, value } of node.attributes) {
      if (['data-turn-key', 'data-content-search-turn-key', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key',
        'data-chatgpt-selection-message-id', 'data-message-id', 'data-turn-id', 'aria-controls', 'aria-describedby'].includes(name)) {
        result[name] = { ref: ref(value), chars: value.length, roleSuffix: /:(user|assistant)$/.exec(value)?.[1] || null }
      } else if (name === 'data-chatgpt-search-message-ids') {
        result[name] = value.split(/\s+/).filter(Boolean).slice(0, 20).map(ref)
      } else if (name === 'class') result.class = value.slice(0, 600)
      else if (['aria-label', 'title', 'data-tooltip-content'].includes(name)) result[name] = label(value)
      else if (['role', 'type', 'contenteditable', 'aria-expanded', 'aria-hidden', 'aria-disabled', 'aria-busy',
        'aria-multiline', 'data-state', 'data-testid', 'data-message-author-role', 'dir', 'enterkeyhint'].includes(name)) {
        result[name] = /^[\w:. -]{0,100}$/.test(value) ? value : '[value chars=' + value.length + ']'
      } else if (name === 'id') result.id = /^(prompt-textarea|pending-home-input)$/.test(value) ? value : ref(value)
      else if (name.startsWith('data-')) result[name] = '[value chars=' + value.length + ']'
    }
    return result
  }
  const describe = node => {
    if (!(node instanceof Element)) return null
    const css = getComputedStyle(node)
    return { tag: node.tagName.toLowerCase(), attrs: attributes(node), visible: visible(node),
      opacity: css.opacity, pointerEvents: css.pointerEvents, textChars: textOf(node).length,
      disabled: 'disabled' in node ? node.disabled : null, readOnly: 'readOnly' in node ? node.readOnly : null,
      focused: node === document.activeElement || node.contains(document.activeElement) }
  }
  const chain = node => {
    const result = []
    for (let item = node; item && item !== document.body && result.length < 12; item = item.parentElement) {
      result.push({ ...describe(item), editors: item.querySelectorAll(EDITOR).length, userUnits: item.querySelectorAll(USER).length })
      if (item.matches('[data-turn-key], article[data-testid^="conversation-turn-"]')) break
    }
    return result
  }
  const groupOf = node => node?.closest('[data-turn-key]') || node?.closest('[data-content-search-turn-key]') ||
    node?.closest('article[data-testid^="conversation-turn-"]') || null
  const identity = node => {
    if (!node) return null
    const names = ['data-turn-key', 'data-chatgpt-selection-message-id', 'data-message-id', 'data-content-search-turn-key']
    return Object.fromEntries(names.map(name => [name, ref(node.getAttribute(name))]).filter(([, value]) => value))
  }
  const buttonInfo = node => ({ ...describe(node), label: label(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent),
    svg: query('svg, use', node).slice(0, 3).map(svg => ({ tag: svg.tagName.toLowerCase(), class: String(svg.getAttribute('class') || '').slice(0, 160),
      viewBox: svg.getAttribute('viewBox'), dataNames: [...svg.attributes].map(attr => attr.name).filter(name => name.startsWith('data-')) })) })
  const structure = (node, budget, depth = 0) => {
    if (budget.left-- <= 0) return null
    if (node.nodeType === Node.TEXT_NODE) return collapse(node.textContent) ? { textChars: node.textContent.length } : null
    if (!(node instanceof Element) || /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|LINK|META|IMG|PATH)$/.test(node.tagName)) return null
    if (node.tagName.toLowerCase() === 'svg') return { tag: 'svg', attrs: attributes(node) }
    const result = describe(node)
    if (node.matches(EDITOR)) return { ...result, valueChars: textOf(node).length }
    if (node.matches('[data-markdown-text-style="assistant-message"]')) return { ...result, answerBodyOmitted: true }
    if (depth >= 16) return { ...result, depthLimit: true }
    result.children = []
    for (const child of node.childNodes) { if (budget.left <= 0) break; const item = structure(child, budget, depth + 1); if (item) result.children.push(item) }
    return result
  }
  const allUsers = query(USER)
  const groups = [...new Set(allUsers.map(groupOf).filter(Boolean))]
  // Include an edit form even if replacing the user bubble removed its role attributes.
  for (const editor of query(EDITOR).filter(visible)) {
    const group = groupOf(editor)
    if (group && !groups.includes(group)) groups.push(group)
  }
  const targetGroup = target instanceof Element ? groupOf(target) : null
  const sampled = groups.slice(-12)
  if (targetGroup && !sampled.includes(targetGroup)) sampled.unshift(targetGroup)
  const editors = query(EDITOR).slice(0, 24).map(node => {
    const group = groupOf(node), form = node.closest('form'), text = textOf(node)
    return { ...describe(node), inHistory: !!group, group: identity(group), inForm: !!form,
      formAttrs: form ? attributes(form) : null, lines: text.split('\n').length, promptMarkerPresent: text.includes('\u0000\u0001'),
      selection: typeof node.selectionStart === 'number' ? { start: node.selectionStart, end: node.selectionEnd } : null,
      composerMatches: COMPOSERS.filter(selector => node.matches(selector)), chain: chain(node),
      nearbyControls: query(CONTROL, group || form || node.parentElement || node).slice(0, 24).map(buttonInfo) }
  })
  const turns = sampled.map(group => {
    const budget = { left: 450 }
    const users = query(USER, group)
    return { index: groups.indexOf(group), group: describe(group), identity: identity(group),
      userUnits: users.slice(0, 5).map(describe), messageIds: query(ID, group).slice(0, 24).map(node => ({ ...identity(node),
        role: node.querySelector('[data-markdown-text-style="assistant-message"]') ? 'assistant' : null })),
      controls: query(CONTROL, group).slice(0, 36).map(buttonInfo),
      editors: query(EDITOR, group).map(describe),
      // Keep the user side and its toolbar, not the possibly very large assistant subtree.
      structure: structure(users[0]?.closest('[class~="group/user-message"]') || users[0]?.parentElement || group, budget),
      truncated: budget.left <= 0 }
  })
  const identityOrder = query('[data-turn-key], [data-chatgpt-selection-message-id], [data-message-id]').slice(0, 400).map(node => ({
    ...identity(node), visible: visible(node), hasUserUnit: node.matches(USER) || !!node.querySelector(USER),
    hasAnswer: !!node.querySelector('[data-markdown-text-style="assistant-message"]') }))
  return { route: location.href, counts: { userUnits: allUsers.length, groups: groups.length, editors: editors.length },
    generating: STOP.some(selector => query(selector).some(visible)), active: describe(document.activeElement),
    target: target instanceof Element ? { node: describe(target), group: identity(targetGroup), chain: chain(target) } : null,
    composerMatches: COMPOSERS.map(selector => ({ selector, count: query(selector).length, visible: query(selector).filter(visible).length })),
    editors, turns, identityOrder,
    globalEditControls: query(CONTROL).filter(node => /^(编辑消息|编辑|修改消息|Edit message|Edit)$/i.test(collapse(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent))).slice(0, 30).map(buttonInfo) }
}

/** Passive listeners, installed once per document; no preventDefault or DOM writes. */
function observeEdit(config, inspect) {
  if (window[config.key]) return 'already-installed'
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
    const node = event.target.closest('button, [role="button"], [role="menuitem"]')
    if (!node) return
    const text = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim()
    const kind = /^(编辑消息|编辑|修改消息|Edit message|Edit)$/i.test(text) ? 'edit'
      : /^(取消|Cancel)$/i.test(text) ? 'cancel'
        : /^(发送|发送消息|保存并提交|保存并发送|提交|Send|Send message|Save\s*(?:&|and)\s*(?:submit|send))$/i.test(text) ? 'send' : 'other'
    if (kind !== 'other' || node.closest('[data-turn-key], [data-content-search-turn-key]')) emit('click', { kind }, true, node)
  })
  on('keydown', event => {
    if (!event.isTrusted || event.repeat || !['Enter', 'Escape'].includes(event.key) || !editorOf(event.target)) return
    emit('key', { key: event.key, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
      composing: event.isComposing, defaultPrevented: event.defaultPrevented }, true, event.target)
  })
  on('submit', event => { if (event.isTrusted) emit('submit', {}, true, event.target) })
  on('focusin', event => { if (editorOf(event.target)) emit('editor-focus', {}, true, event.target) })
  on('input', event => {
    if (!event.isTrusted || !editorOf(event.target)) return
    clearTimeout(inputTimer)
    inputTimer = setTimeout(() => emit('editor-input', {}, true, event.target), 500)
  })
  const observer = new MutationObserver(() => {
    if (!mutationTimer) mutationTimer = setTimeout(() => { mutationTimer = null; emit('dom-change') }, 300)
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['contenteditable', 'disabled', 'aria-disabled', 'aria-busy', 'hidden', 'data-turn-key', 'data-chatgpt-selection-message-id'] })
  window[config.key] = () => { observer.disconnect(); clearTimeout(mutationTimer); clearTimeout(inputTimer); disposers.forEach(dispose => dispose()); delete window[config.key] }
  return 'installed'
}

const readerSource = '(' + inspectEdit.toString() + ')()'
const observerSource = '(' + observeEdit.toString() + ')(' + JSON.stringify({ key: KEY, tag: TAG }) + ', ' + inspectEdit.toString() + ')'
new vm.Script(readerSource, { filename: 'chatgpt-edit-reader.js' })
new vm.Script(observerSource, { filename: 'chatgpt-edit-observer.js' })

function saveSnapshot(raw, reason) {
  if (!raw || !win || win.isDestroyed() || raw.route !== win.webContents.getURL()) return
  const { route: rawRoute, ...metadata } = raw
  const snapshot = { route: route(rawRoute), ...redactIds(metadata) }
  coverage.userTurns ||= snapshot.counts.userUnits > 0
  coverage.generating ||= snapshot.generating
  coverage.editControl ||= snapshot.globalEditControls.length > 0
  coverage.historyEditor ||= snapshot.editors.some(editor => editor.inHistory && editor.visible)
  const signature = alias(JSON.stringify(snapshot))
  if (signature === lastSignature && reason !== 'final') return
  lastSignature = signature
  const sequence = ++snapshotSequence
  const { turns, ...info } = snapshot
  log('SNAPSHOT', { sequence, reason, ...info, turns: turns.map(({ structure, ...turn }) => turn) })
  log('STRUCTURE', { sequence, turns: turns.map(turn => ({ index: turn.index, identity: turn.identity, structure: turn.structure, truncated: turn.truncated })) })
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

const ID_FIELD = /^(id|.*_id|.*_ids|parent|children|current_node|messageId|conversationId|parentMessageId|turnId)$/
const ENUMS = new Set(['next', 'variant', 'continue', 'edit', 'regenerate', 'rephrase', 'user', 'assistant', 'system', 'tool',
  'text', 'multimodal_text', 'image_asset_pointer', 'in_progress', 'finished_successfully', 'finished', 'complete',
  'analysis', 'final', 'commentary', 'all', 'append', 'replace', 'add', 'remove', 'patch'])
const ENUM_FIELD = /^(action|role|content_type|status|channel|recipient|o|op|operation|type)$/
function schema(value, field = '', depth = 0, budget = { left: 1100 }) {
  if (budget.left-- <= 0 || depth > 10) return { omitted: 'limit' }
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'string', chars: value.length,
    ...(ID_FIELD.test(field) ? { ref: alias(value) } : ENUM_FIELD.test(field) && ENUMS.has(value) ? { enum: value } : {}) }
  if (typeof value === 'number' || typeof value === 'boolean') return { type: typeof value }
  if (Array.isArray(value)) return { type: 'array', count: value.length,
    items: value.slice(0, 12).map(item => schema(item, field, depth + 1, budget)), truncated: value.length > 12 }
  if (!value || typeof value !== 'object') return { type: typeof value }
  const entries = Object.entries(value)
  return { type: 'object', fields: Object.fromEntries(entries.slice(0, 70).map(([key, item]) => [
    /^[a-zA-Z_][a-zA-Z0-9_]{0,70}$/.test(key) ? key : '[key:' + alias(key) + ']', schema(item, key, depth + 1, budget)])), truncated: entries.length > 70 }
}
function endpoint(value) {
  const url = new URL(value)
  const known = new Set(['backend-api', 'backend-anon', 'f', 'conversation', 'conversations', 'prepare', 'resume', 'message',
    'messages', 'stream', 'branch', 'branches', 'gen_title', 'stop', 'update', 'edit', 'init', 'moderations', 'sentinel'])
  return { path: url.pathname.split('/').map(segment => !segment || known.has(segment) ? segment : '{' + alias(segment) + '}').join('/'),
    queryNames: [...new Set(url.searchParams.keys())].filter(key => /^[a-zA-Z_]{1,40}$/.test(key)).slice(0, 20) }
}
function relevantRequest(value) {
  try {
    const url = new URL(value)
    return url.origin === ORIGIN && /^\/backend-(?:api|anon)\//.test(url.pathname) && /conversation|message|branch|resume|prepare/.test(url.pathname)
  } catch { return false }
}
function responseSummary(body, mimeType) {
  const messages = new Map(), references = new Map(), patches = new Map(), graphs = [], shapes = new Map()
  let records = 0, malformed = 0, done = false, visited = 0
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || ++visited > 30000) return
    if (Array.isArray(value)) { value.slice(0, 120).forEach(item => walk(item, depth + 1)); return }
    const message = value.message || (value.author && value.id ? value : null)
    if (message && typeof message.id === 'string') {
      const role = ['user', 'assistant', 'system', 'tool'].includes(message.author?.role) ? message.author.role : 'other'
      messages.set(alias(message.id), { id: alias(message.id), role, contentType: ENUMS.has(message.content?.content_type) ? message.content.content_type : null,
        partCount: Array.isArray(message.content?.parts) ? message.content.parts.length : null,
        textChars: Array.isArray(message.content?.parts) ? message.content.parts.reduce((sum, part) => sum + (typeof part === 'string' ? part.length : 0), 0) : null,
        status: ENUMS.has(message.status) ? message.status : null })
    }
    for (const [key, item] of Object.entries(value)) {
      if (ID_FIELD.test(key) && typeof item === 'string' && references.size < 300) references.set(key + ':' + alias(item), { field: key, ref: alias(item) })
    }
    // Some streams transport JSON patches instead of complete message objects.
    if (typeof value.p === 'string' && /^\/(?:message\/)?(?:id|conversation_id|parent_id|parent_message_id)$/.test(value.p) && typeof value.v === 'string') {
      patches.set(value.p + ':' + alias(value.v), { path: value.p, ref: alias(value.v) })
    }
    if (value.mapping && typeof value.mapping === 'object' && !Array.isArray(value.mapping) && graphs.length < 3) {
      const nodes = Object.entries(value.mapping)
      graphs.push({ conversation: alias(value.conversation_id || value.id), currentNode: alias(value.current_node), count: nodes.length,
        nodes: nodes.slice(0, 240).map(([key, node]) => ({ key: alias(key), id: alias(node?.id), parent: alias(node?.parent),
          children: Array.isArray(node?.children) ? node.children.slice(0, 60).map(alias) : [], message: alias(node?.message?.id),
          role: ['user', 'assistant', 'system', 'tool'].includes(node?.message?.author?.role) ? node.message.author.role : 'other' })), truncated: nodes.length > 240 })
    }
    for (const [key, item] of Object.entries(value)) if (!['content', 'parts', 'metadata', 'mapping'].includes(key)) walk(item, depth + 1)
  }
  const consume = value => {
    records++; walk(value)
    if (shapes.size < 6) {
      const shape = schema(value)
      const signature = JSON.stringify(shape).replace(/"chars":\d+/g, '').replace(/"ref":"[a-f0-9]+"/g, '')
      if (!shapes.has(signature)) shapes.set(signature, shape)
    }
  }
  if (/event-stream/i.test(mimeType) || /^\s*(?:event:|data:)/.test(body)) {
    // SSE can split one JSON document across several data: lines.
    for (const block of body.split(/\r?\n\r?\n/).slice(0, 12000)) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      if (data === '[DONE]') { done = true; continue }
      try { consume(JSON.parse(data)) } catch { malformed++ }
    }
  } else { try { consume(JSON.parse(body)) } catch { malformed++ } }
  return { records, malformed, done, messageIdentities: [...messages.values()].slice(0, 120), references: [...references.values()],
    idPatches: [...patches.values()].slice(0, 120), graphs, sampleSchemas: [...shapes.values()] }
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
          coverage.graphResponses += summary.graphs.length
          if (/event-stream/i.test(record.mimeType)) coverage.streamResponses++
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
  // Exactly one header listener; matches the existing ChatGPT probes' identity treatment.
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
    title: 'ChatGPT 编辑消息探针 — 按说明手动编辑，结束后关闭窗口',
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
        const history = report.snapshot?.editors?.some(editor => editor.inHistory && editor.visible && editor.focused) === true
        coverage.editClick ||= report.action === 'click' && report.kind === 'edit'
        coverage.cancelClick ||= report.action === 'click' && report.kind === 'cancel'
        coverage.historySendClick ||= report.action === 'click' && report.kind === 'send' &&
          report.snapshot?.editors?.some(editor => editor.inHistory && editor.visible) === true
        coverage.historyEnter ||= report.action === 'key' && report.key === 'Enter' && !report.shift && !report.composing && history
        const { route: rawRoute, snapshot, ...event } = report
        log('PAGE-EVENT', { ...event, page: route(rawRoute), inHistoryEditor: history, target: redactIds(snapshot?.target) })
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
    win.setTitle('ChatGPT 编辑消息探针 — 正在保存最后的日志…')
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
          note: '记录的是原网页行为；事件出现不等于重发成功，须结合请求、回复及刷新后的分支图。未观察状态不算已覆盖。' })
        console.log('\n日志已保存：' + logPath + '\n把这个路径发给智能体即可。\n')
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
        if (!win.isDestroyed()) win.destroy()
      }
    })()
  })
  console.log('\n按 tools/diag/chatgpt-edit-probe.md 操作；探针只观察，由你手动编辑和发送。\n日志：' + logPath + '\n')
  // A fresh BrowserWindow may not service Network.enable until navigation creates its
  // renderer. Start navigation first and never make loading or close-handler installation
  // depend on the debugger handshake. Observing the network must remain optional.
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
