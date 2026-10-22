/**
 * User-run DeepSeek chat view capture. The user navigates, types and sends.
 * DOM/layout and user actions are logged automatically; no screenshots or labels.
 * Run instructions: deepseek-chat-view-probe.md. Never run this as an agent.
 */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const vm = require('node:vm')

const ORIGIN = 'https://chat.deepseek.com'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) {
  throw new Error('PROBE_START_URL 必须是 https://chat.deepseek.com 的页面。')
}
app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
const prefix = path.join(directory, 'deepseek-chat-view-' + stamp)
const logPath = prefix + '.log'
const EVENT_TAG = '[deepseek-chat-view-' + randomUUID() + '] '
const OBSERVER_KEY = '__deepseekChatViewProbe_' + randomUUID().replace(/-/g, '')
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data })
  try { fs.appendFileSync(logPath, line + '\n', 'utf8') }
  catch { console.error('诊断日志写入失败：', logPath) }
  if (!['SNAPSHOT', 'STRUCTURE', 'PAGE-EVENT'].includes(event)) console.log(line)
}

function routeForLog(value) {
  try {
    const url = new URL(value)
    const match = /^\/a\/chat\/s\/([^/]+)/.exec(url.pathname)
    return { origin: url.origin, kind: match ? 'conversation' : url.pathname === '/' ? 'home' : 'other', conversationAlias: match ? digest(match[1]) : null }
  } catch { return { kind: 'unavailable' } }
}

/** Self-contained function: no page mutations, storage, credentials or fetches. */
function inspectChatView() {
  const ROW = '[data-virtual-list-item-key]'
  const ANSWER = '.ds-assistant-message-main-content'
  const THINK = '.ds-think-content'
  // Independent copies of the shipped DEEPSEEK_PAGE selectors (platforms.ts).
  // A miss means absent at this moment; it does not by itself mean broken.
  const selectors = {
    composer: ['textarea[placeholder]', 'textarea'],
    sendCandidates: ['.ds-button--primary.ds-button--circle:not(.ds-button--disabled)', '.ds-button--primary.ds-button--filled', 'button[type="submit"]'],
    turns: [ROW], answers: [ANSWER], reasoning: [THINK],
    stop: [] // DeepSeek historically shares send/stop classes. Do not guess one.
  }
  const query = (selector, root = document) => [...root.querySelectorAll(selector)]
  const chars = element => String(element?.value ?? element?.textContent ?? '').length
  const round = number => Math.round(number * 10) / 10
  const bounds = element => {
    const r = element.getBoundingClientRect()
    return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }
  }
  const visible = element => {
    const r = element.getBoundingClientRect()
    const css = getComputedStyle(element)
    return r.width > 0 && r.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'
  }
  // Retain only established short UI labels. Unknown labels may contain messages.
  const uiLabel = value => {
    const text = String(value || '').trim()
    return /^(发送|停止|停止生成|重新生成|复制|编辑|分享|深度思考|联网搜索|搜索|上传附件|添加附件|新对话|开启新对话|展开|收起|已思考(?:（用时 ?[0-9.]+ 秒）)?|思考中[.…]*|Send|Stop|Copy|Edit|Share|Search|Regenerate)$/i.test(text)
      ? text : text ? '[label chars=' + text.length + ']' : ''
  }
  const attrs = element => {
    const result = {}
    for (const attr of element.attributes || []) {
      const name = attr.name
      if (name === 'class') result.class = attr.value.slice(0, 500)
      else if (['role', 'type', 'aria-expanded', 'aria-busy', 'aria-disabled', 'aria-pressed', 'aria-live', 'contenteditable', 'disabled', 'hidden'].includes(name)) result[name] = attr.value.slice(0, 80)
      else if (['aria-label', 'title', 'placeholder', 'alt'].includes(name)) result[name] = uiLabel(attr.value)
      else if (name === 'data-virtual-list-item-key') result[name] = /^\d{1,8}$/.test(attr.value) ? attr.value : '[opaque virtual position]'
      else if (['data-state', 'data-status', 'data-is-streaming', 'data-loading', 'data-role', 'data-message-role'].includes(name)
        && /^(true|false|loading|streaming|idle|pending|complete|completed|stopped|error|open|closed|collapsed|expanded|user|assistant|system)$/.test(attr.value)) result[name] = attr.value
      else if (name.startsWith('data-')) result[name] = '[value chars=' + attr.value.length + ']'
      else if (name === 'id') result.id = '[id chars=' + attr.value.length + ']'
    }
    return result
  }
  const describe = element => {
    if (!element) return null
    const css = getComputedStyle(element)
    return { tag: element.tagName.toLowerCase(), attrs: attrs(element), visible: visible(element), bounds: bounds(element), textChars: chars(element),
      style: { display: css.display, position: css.position, overflowY: css.overflowY, background: css.backgroundColor, color: css.color, fontSize: css.fontSize, lineHeight: css.lineHeight, borderRadius: css.borderRadius } }
  }
  const ancestors = element => {
    const items = []
    for (let node = element, depth = 0; node && depth < 9; node = node.parentElement, depth++) {
      items.push({ ...describe(node), childCount: node.children.length, turnsInside: node.querySelectorAll(ROW).length, answersInside: node.querySelectorAll(ANSWER).length,
        scroll: { top: Math.round(node.scrollTop), height: node.scrollHeight, clientHeight: node.clientHeight } })
      if (node === document.body) break
    }
    return items
  }
  const composer = document.querySelector('textarea[placeholder], textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')
  let composerRoot = composer?.parentElement || null
  for (let depth = 0; composerRoot && depth < 5; depth++) {
    if (composerRoot.querySelectorAll('button, [role="button"], input[type="file"]').length >= 2) break
    if (!composerRoot.parentElement || composerRoot.parentElement.querySelector(ROW)) break
    composerRoot = composerRoot.parentElement
  }
  const controls = root => query('button, [role="button"], input[type="file"]', root).slice(0, 45).map(element => ({ ...describe(element),
    label: uiLabel(element.textContent), fileAccept: element.getAttribute('type') === 'file' ? String(element.getAttribute('accept') || '').slice(0, 180) : null,
    svg: query('svg', element).slice(0, 2).map(svg => ({ viewBox: svg.getAttribute('viewBox'), shapes: [...svg.querySelectorAll('path, rect, circle, polygon')].slice(0, 5).map(shape => ({ tag: shape.tagName, d: shape.getAttribute('d')?.slice(0, 650) || null, width: shape.getAttribute('width'), height: shape.getAttribute('height') })) })) }))
  const rows = query(ROW)
  const sampledRows = [...new Set([...rows.slice(0, 2), ...rows.slice(-10)])]
  const turns = sampledRows.map(element => {
    const answer = element.matches(ANSWER) ? element : element.querySelector(ANSWER)
    const think = element.querySelector(THINK)
    return { row: describe(element), roleEvidence: answer || think ? 'assistant-marker' : 'unclassified',
      virtualPositionIsIdentity: false, answer: describe(answer), reasoning: describe(think),
      codeBlocks: query('pre', element).slice(0, 8).map(pre => ({ ...describe(pre), language: (pre.querySelector('code')?.className || '').match(/language-[a-zA-Z0-9_+-]+/)?.[0] || null })),
      tables: query('table', element).map(table => ({ rows: table.rows.length, columns: table.rows[0]?.cells.length || 0 })),
      images: query('img', element).slice(0, 8).map(img => ({ bounds: bounds(img), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        sourceKind: /^(https?:|blob:|data:)/i.exec(img.getAttribute('src') || '')?.[1].toLowerCase() || 'relative-or-empty' })),
      linkCount: element.querySelectorAll('a').length, controls: controls(element) }
  })
  // Discovery independent of the old selectors, so an empty match still leaves evidence.
  const dataHistogram = {}, semanticClasses = {}
  let scanned = 0
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
  for (let element = walker.currentNode; element && scanned < 24000; element = walker.nextNode(), scanned++) {
    for (const attr of element.attributes || []) if (attr.name.startsWith('data-')) dataHistogram[attr.name] = (dataHistogram[attr.name] || 0) + 1
    for (const cls of element.classList || []) if (/^ds-|message|markdown|think|reason|virtual|upload|attach|composer|stream/i.test(cls)) semanticClasses[cls] = (semanticClasses[cls] || 0) + 1
  }
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  let nodeBudget = 1700
  const structure = (node, depth = 0) => {
    if (--nodeBudget < 0) return ''
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim() ? escape('[text chars=' + node.textContent.length + ']') : ''
    if (node.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|LINK|META|SVG|IMG)$/.test(node.tagName)) return ''
    const tag = node.tagName.toLowerCase()
    const attributes = Object.entries(attrs(node)).map(([name, value]) => ' ' + name + '="' + escape(value) + '"').join('')
    if (depth >= 16) return '<' + tag + attributes + '>[depth limit]</' + tag + '>'
    return '<' + tag + attributes + '>' + [...node.childNodes].map(child => structure(child, depth + 1)).join('') + '</' + tag + '>'
  }
  const roots = [...new Set([rows[0], ...rows.slice(-3), composerRoot, ...query('main, [role="main"]').slice(0, rows.length ? 0 : 1)].filter(Boolean))]
  const markup = roots.map(element => structure(element)).join('\n')
  const selectorMatches = Object.fromEntries(Object.entries(selectors).map(([key, list]) => [key, list.map(selector => ({ selector, count: document.querySelectorAll(selector).length, visible: query(selector).filter(visible).length }))]))
  return {
    route: location.href, readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    theme: { prefersDark: matchMedia('(prefers-color-scheme: dark)').matches, html: describe(document.documentElement), body: describe(document.body) },
    selectorMatches, composer: describe(composer), composerAncestors: ancestors(composer), composerControls: composerRoot ? controls(composerRoot) : [],
    counts: { turns: rows.length, answers: document.querySelectorAll(ANSWER).length, reasoning: document.querySelectorAll(THINK).length, textareas: document.querySelectorAll('textarea').length, scanned, scanTruncated: scanned >= 24000 },
    turns, lastTurnAncestors: ancestors(rows.at(-1) || document.querySelector(ANSWER)),
    fallbackMarkdown: query('[class*="markdown"]').slice(-4).map(describe),
    fallbackControls: composer ? [] : controls(document),
    fileInputs: query('input[type="file"]').slice(0, 8).map(input => ({
      selectedCount: input.files?.length || 0,
      selectedBytes: [...(input.files || [])].reduce((sum, file) => sum + file.size, 0),
      multiple: input.multiple, disabled: input.disabled
    })),
    dataHistogram, semanticClasses, structureTruncated: nodeBudget < 0, markup,
    note: 'Only mounted rows observed. Role evidence is not a complete role classifier. No reliable generating/completed verdict is inferred from send-button classes.'
  }
}

/** Passive observation only. Never cancel events or modify the site's UI. */
function observeChatView(config) {
  if (window[config.key]) return 'already-installed'
  const listeners = []
  let mutationTimer, scrollTimer, mutationCounts = { attributes: 0, childList: 0, characterData: 0 }
  const emit = (event, data = {}) => {
    console.log(config.tag + JSON.stringify({ event, ...data, route: location.href }))
  }
  const on = (target, event, handler) => {
    const options = { capture: true, passive: true }
    target.addEventListener(event, handler, options)
    listeners.push(() => target.removeEventListener(event, handler, options))
  }
  const editable = target => target instanceof Element
    ? target.closest('textarea, [contenteditable="true"]') : null
  const targetShape = target => {
    if (!(target instanceof Element)) return null
    const control = target.closest('button, [role="button"], summary, input[type="file"]') || target
    const label = (control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent || '').trim()
    return { tag: control.tagName.toLowerCase(), class: String(control.getAttribute('class') || '').slice(0, 300),
      role: control.getAttribute('role'), type: control.getAttribute('type'),
      expanded: control.getAttribute('aria-expanded'), pressed: control.getAttribute('aria-pressed'),
      label: /^(发送|停止|停止生成|重新生成|复制|编辑|分享|深度思考|联网搜索|搜索|上传附件|添加附件|新对话|开启新对话|展开|收起|Send|Stop|Copy|Edit|Share|Search|Regenerate)$/i.test(label)
        ? label : label ? '[label chars=' + label.length + ']' : '' }
  }
  on(document, 'input', event => {
    const element = editable(event.target)
    if (element) emit('input', { chars: String(element.value ?? element.textContent ?? '').length, composing: event.isComposing === true })
  })
  on(document, 'keydown', event => {
    if (event.key === 'Enter' && editable(event.target) && !event.repeat) {
      emit('enter', { shift: event.shiftKey, composing: event.isComposing === true })
    }
  })
  on(document, 'click', event => {
    if (!(event.target instanceof Element)) return
    const control = event.target.closest('button, [role="button"], summary, input[type="file"]')
    if (control) emit('control-click', { target: targetShape(control) })
  })
  on(document, 'submit', () => emit('form-submit'))
  on(document, 'change', event => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file') {
      emit('file-selection', { selectedCount: event.target.files?.length || 0,
        selectedBytes: [...(event.target.files || [])].reduce((sum, file) => sum + file.size, 0) })
    }
  })
  on(document, 'toggle', event => {
    if (event.target instanceof HTMLDetailsElement) emit('details-toggle', { open: event.target.open })
  })
  on(document, 'scroll', () => {
    if (!scrollTimer) scrollTimer = setTimeout(() => { scrollTimer = null; emit('scroll') }, 450)
  })
  on(window, 'resize', () => emit('resize'))
  const observer = new MutationObserver(records => {
    for (const record of records) mutationCounts[record.type]++
    if (!mutationTimer) mutationTimer = setTimeout(() => {
      mutationTimer = null
      emit('dom-change', { counts: mutationCounts })
      mutationCounts = { attributes: 0, childList: 0, characterData: 0 }
    }, 400)
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-expanded', 'aria-busy', 'aria-disabled', 'aria-pressed',
      'data-state', 'data-status', 'data-is-streaming', 'data-loading'] })
  window[config.key] = () => {
    observer.disconnect()
    clearTimeout(mutationTimer)
    clearTimeout(scrollTimer)
    for (const dispose of listeners) dispose()
    delete window[config.key]
  }
  return 'installed'
}

const pageSource = '(' + inspectChatView.toString() + ')()'
const observerSource = '(' + observeChatView.toString() + ')(' + JSON.stringify({ tag: EVENT_TAG, key: OBSERVER_KEY }) + ')'
// Parse the actual serialized page code, not only this outer CommonJS file.
new vm.Script(pageSource, { filename: 'deepseek-chat-view-page.js' })
new vm.Script(observerSource, { filename: 'deepseek-chat-view-observer.js' })

let win, timer, captureTimer, activeCapture = null, closing = false
let lastSignature = '', lastStructureSignature = '', previousInfo = null, lastCaptureAt = 0
let sequence = 0, actionCount = 0, structureCount = 0, captureFailures = 0
const pendingReasons = new Set()
const observed = { composer: false, turns: false, answers: false, reasoning: false, fileSelection: false, events: {} }

async function bounded(promise, timeout = 4500) {
  let timeoutId
  try { return await Promise.race([promise, new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('capture-timeout')), timeout) })]) }
  finally { clearTimeout(timeoutId) }
}

function requestCapture(reason) {
  if (closing) return
  pendingReasons.add(reason)
  if (activeCapture || captureTimer) return
  // Coalesce typing/streaming mutations; at most one full DOM read per 900 ms.
  captureTimer = setTimeout(() => {
    captureTimer = null
    const reasons = [...pendingReasons]
    pendingReasons.clear()
    void capture(reasons.join(','))
  }, Math.max(100, 900 - (Date.now() - lastCaptureAt)))
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

function changesSince(previous, current) {
  if (!previous || JSON.stringify(previous.route) !== JSON.stringify(current.route)) return ['page-baseline']
  const changes = []
  const changed = (name, before, after) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(name)
  }
  changed('composer-changed', previous.composer, current.composer)
  changed('mounted-message-count-changed', previous.counts.turns, current.counts.turns)
  changed('answer-content-or-layout-changed', previous.turns.map(turn => turn.answer), current.turns.map(turn => turn.answer))
  changed('reasoning-content-or-visibility-changed', previous.turns.map(turn => turn.reasoning), current.turns.map(turn => turn.reasoning))
  changed('composer-controls-changed', previous.composerControls, current.composerControls)
  changed('file-input-changed', previous.fileInputs, current.fileInputs)
  changed('scroll-or-container-changed', previous.lastTurnAncestors, current.lastTurnAncestors)
  changed('viewport-or-theme-changed', [previous.viewport, previous.theme], [current.viewport, current.theme])
  return changes.length ? changes : ['other-structure-or-metadata-changed']
}

async function captureNow(reason) {
  const wc = win.webContents
  try {
    if (new URL(wc.getURL()).origin !== ORIGIN) {
      return
    }
    const capturedUrl = wc.getURL()
    const raw = await bounded(wc.executeJavaScript(pageSource))
    if (wc.isDestroyed() || capturedUrl !== wc.getURL() || raw.route !== capturedUrl) {
      log('CAPTURE-DISCARDED', { reason, cause: 'navigation-during-capture' })
      return
    }
    const { route, markup, ...info } = raw
    info.route = routeForLog(route)
    const signature = digest(JSON.stringify(info))
    const isFinal = reason === 'final'
    // Ignore text lengths when comparing tree shape, so a streamed sentence does
    // not cause the entire redacted structure to be written on every token.
    const structure = markup.replace(/\[(?:text|label|value|id) chars=\d+\]/g, '[redacted text]')
    const structureSignature = digest(JSON.stringify([info.route, structure]))
    const structureChanged = structureSignature !== lastStructureSignature
    if (!isFinal && signature === lastSignature && !structureChanged) return
    const changes = changesSince(previousInfo, info)
    previousInfo = info
    lastSignature = signature
    const id = ++sequence
    observed.composer ||= Boolean(info.composer)
    observed.turns ||= info.counts.turns > 0
    observed.answers ||= info.counts.answers > 0
    observed.reasoning ||= info.counts.reasoning > 0
    log('SNAPSHOT', { id, reason, changes, ...info })
    if (structureChanged || isFinal) {
      log('STRUCTURE', { id, markup, truncated: info.structureTruncated })
      lastStructureSignature = structureSignature
      structureCount++
    }
  } catch (error) {
    captureFailures++
    log('CAPTURE-FAILED', { reason, category: error?.message === 'capture-timeout' ? 'timeout' : 'page-or-file-unavailable', errorName: error?.name })
  }
}

app.whenReady().then(async () => {
  log('START', { logPath, electron: process.versions.electron, chrome: process.versions.chrome,
    partition: 'persist:deepseek', observationOnly: true, screenshots: false, automaticLogging: true, pageScriptsParsed: true })
  const ses = session.fromPartition('persist:deepseek')
  ses.setUserAgent(USER_AGENT)
  // Exactly one header hook. No response bodies, request headers or cookies logged.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) if (/^user-agent$|^sec-ch-ua(?:-full-version-list)?$/i.test(name)) delete headers[name]
    const major = process.versions.chrome.split('.')[0]
    headers['User-Agent'] = USER_AGENT
    headers['sec-ch-ua'] = '"Google Chrome";v="' + major + '", "Chromium";v="' + major + '", "Not(A:Brand";v="24"'
    headers['sec-ch-ua-full-version-list'] = '"Google Chrome";v="' + process.versions.chrome + '", "Chromium";v="' + process.versions.chrome + '", "Not(A:Brand";v="24.0.0.0"'
    callback({ requestHeaders: headers })
  })
  const proxy = process.env.PROBE_PROXY
  if (proxy) await ses.setProxy(proxy === 'direct' ? { mode: 'direct' } : { mode: 'fixed_servers', proxyRules: proxy })
  log('PROXY', { mode: proxy === 'direct' ? 'direct' : proxy ? 'explicit-probe-proxy' : 'system-default', note: '不会读取或修改应用已保存的代理设置。' })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]))
  win = new BrowserWindow({ width: 1320, height: 930, minWidth: 760, minHeight: 600,
    title: 'DeepSeek 聊天视图 — 日志自动记录中，正常操作后关闭窗口即可',
    webPreferences: { partition: 'persist:deepseek', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } })
  const wc = win.webContents
  wc.setUserAgent(USER_AGENT)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('page-title-updated', event => event.preventDefault())
  const installObserver = () => {
    if (closing || wc.isDestroyed() || new URL(wc.getURL()).origin !== ORIGIN) return
    void bounded(wc.executeJavaScript(observerSource)).then(status => {
      if (status === 'installed') log('OBSERVER-READY', { route: routeForLog(wc.getURL()) })
      requestCapture('observer-ready')
    }).catch(error => log('OBSERVER-FAILED', { errorName: error?.name, fallback: 'periodic-dom-snapshots' }))
  }
  wc.on('console-message', details => {
    if (closing || !details.message.startsWith(EVENT_TAG) || details.message.length > 8000) return
    try {
      const report = JSON.parse(details.message.slice(EVENT_TAG.length))
      if (report.route !== wc.getURL() || new URL(report.route).origin !== ORIGIN) return
      const supported = ['input', 'enter', 'control-click', 'form-submit', 'file-selection', 'details-toggle', 'scroll', 'resize', 'dom-change']
      if (!supported.includes(report.event)) return
      const { route, event, ...metadata } = report
      // The source emits structural metadata and lengths only, never typed text.
      log('PAGE-EVENT', { action: event, route: routeForLog(route), ...metadata })
      actionCount++
      observed.events[event] = (observed.events[event] || 0) + 1
      observed.fileSelection ||= event === 'file-selection' && report.selectedCount > 0
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
  timer = setInterval(() => requestCapture('periodic'), 1200)
  win.on('close', event => {
    if (closing) return
    event.preventDefault()
    closing = true
    clearInterval(timer)
    clearTimeout(captureTimer)
    pendingReasons.clear()
    win.setTitle('DeepSeek 聊天视图 — 正在完成日志…')
    void (async () => {
      try {
        await bounded((async () => {
          if (activeCapture) await activeCapture
          await capture('final', true)
        })(), 5500)
      } catch {
        log('FINAL-INCOMPLETE', { cause: 'close-timeout', note: '已保存此前自动日志。' })
      } finally {
        log('COVERAGE', { snapshots: sequence, structures: structureCount, pageEvents: actionCount, captureFailures, ...observed,
          verdict: '自动记录元素、操作与变化；未观察到的状态不算已覆盖，内容暂时稳定不代表生成已完成。' })
        console.log('\n本轮日志已保存：' + logPath + '\n把这个日志路径发给智能体即可，无需截图或其他文件。\n')
        if (!win.isDestroyed()) win.destroy()
      }
    })()
  })
  console.log('\n日志自动记录中。正常聊天、展开思考或滚动即可；结束后直接关闭窗口。\n无需采集菜单、快捷键或截图。日志：' + logPath + '\n')
  await wc.loadURL(start.href).catch(() => log('PAGE-LOAD-REJECTED', { route: routeForLog(start.href) }))
}).catch(error => { log('FATAL', { errorName: error?.name, category: 'startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
