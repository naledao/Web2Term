/** User-run, passive citation discovery. The agent must never launch this file. */
const { app, BrowserWindow, Menu, dialog, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHmac, randomUUID } = require('node:crypto')

const ORIGIN = 'https://chatgpt.com'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/c/6ae8240f-5e2c-83e8-bc84-6a6bcabec58a')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 https://chatgpt.com 同源页面。')
const sourceMessageId = process.env.PROBE_SOURCE_MESSAGE_ID || ''
if (sourceMessageId && !/^[a-zA-Z0-9_:-]{1,160}$/.test(sourceMessageId)) throw new Error('PROBE_SOURCE_MESSAGE_ID 格式无效。')
const profiles = ['Web2Term', 'gpt-web-to-codex-terminal', 'GPT Web to Codex Terminal'].map(name => path.join(app.getPath('appData'), name))
const userData = process.env.PROBE_USER_DATA || profiles.find(root => fs.existsSync(path.join(root, 'conversations.db')))
  || profiles.find(root => fs.existsSync(root)) || profiles[0]
app.setPath('userData', userData)
app.setPath('sessionData', userData)
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(directory, 'chatgpt-citation-preview-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const salt = randomUUID()
const config = {
  key: '__citationPreviewProbe_' + randomUUID().replace(/-/g, ''), tag: '[citation-preview-' + randomUUID() + '] ', sourceMessageId,
  // Deliberately duplicated from CHATGPT_PAGE.focus.citations; do not import app code.
  triggerSelector: 'a[href], [data-citation-group], [data-citation-index], [data-testid*="citation"], [role="button"][data-state], button[aria-haspopup]',
  popupSelector: '[role="tooltip"], [role="dialog"], [data-radix-popper-content-wrapper], [data-state="open"][id]'
}
const alias = value => createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16)
const windows = new Set(), signatures = new Map(), scheduled = new Set()
const coverage = { candidatesSeen: false, hoverSeen: false, clickSeen: false, popupSeen: false,
  popupAfterHoverSeen: false, popupAfterClickSeen: false, popupLinksSeen: false, sourceNavigationSeen: false }
let win, timer, pendingRead = null, closing = false, armedUntil = 0, snapshots = 0, interactions = 0, bytes = 0, capped = false
function log(event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n'
  if (bytes + Buffer.byteLength(line) > 8 * 1024 * 1024 && !['FINAL', 'FATAL'].includes(event)) { capped = true; return }
  fs.appendFileSync(logPath, line, 'utf8'); bytes += Buffer.byteLength(line)
  if (!['SNAPSHOT', 'DOM-CHANGED'].includes(event)) console.log(line.trimEnd())
}
function urlMetadata(raw) {
  try {
    const url = new URL(raw), known = new Set(['c', 'docs', 'api', 'models', 'pricing', 'search', 'index.html', 'favicon.ico'])
    return { protocol: url.protocol, ref: alias(url.href), hostRef: alias(url.hostname),
      family: url.hostname === 'chatgpt.com' ? 'chatgpt' : /(?:^|\.)deepseek\.com$/.test(url.hostname) ? 'deepseek' : 'other',
      pathShape: url.pathname.split('/').map(part => !part || known.has(part) ? part : ':segment').join('/'),
      queryCount: [...url.searchParams.keys()].length, hasFragment: !!url.hash }
  } catch { return { invalid: true } }
}

/** No conversation/body text, editor values, cookies, private framework objects or raw URLs leave this reader. */
function inspectCitationPreview(config) {
  const MESSAGE = '[data-chatgpt-selection-message-id], [data-dil-message-id], [data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]'
  const EDITOR = 'input, textarea, [contenteditable="true"], [role="textbox"], pre, code'
  const HINTS = config.popupSelector + ', [popover], [data-testid*="source"], [data-testid*="preview"], [data-citation-group], [data-citation-index]'
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const visible = node => !!node?.isConnected && node.getClientRects().length > 0 && !node.closest('[hidden], [inert], [aria-hidden="true"]')
    && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  let state = window[config.key]
  if (!state) state = window[config.key] = { refs: new Map(), active: null, listening: false, observer: null, candidates: [], roots: [] }
  const ref = value => {
    if (!state.refs.has(value) && state.refs.size >= 10000) return 'ref-limit'
    if (!state.refs.has(value)) state.refs.set(value, 'ref-' + (state.refs.size + 1))
    return state.refs.get(value)
  }
  const textMeta = value => {
    const text = collapse(value)
    return { chars: text.length, ref: ref(text), hasMoreCount: /\+\s*[1-9]\d?\s*$/.test(text),
      category: /deepseek/i.test(text) ? 'deepseek' : /pricing|价格|定价/i.test(text) ? 'pricing' :
        /source|来源|引用/i.test(text) ? 'source' : /close|关闭/i.test(text) ? 'close' : 'other' }
  }
  const urlMeta = raw => {
    if (!raw) return { present: raw !== null, chars: 0 }
    try {
      const url = new URL(raw, location.href), known = new Set(['c', 'docs', 'api', 'models', 'pricing', 'search', 'index.html', 'favicon.ico'])
      return { present: true, ref: ref(url.href), chars: raw.length, protocol: url.protocol, sameOrigin: url.origin === location.origin,
        hostRef: ref(url.hostname), family: url.hostname === 'chatgpt.com' ? 'chatgpt' : /(?:^|\.)deepseek\.com$/.test(url.hostname) ? 'deepseek' : 'other',
        pathShape: url.protocol === 'data:' ? ':data' : url.pathname.split('/').map(part => !part || known.has(part) ? part : ':segment').join('/'),
        queryCount: [...url.searchParams.keys()].length, hasFragment: !!url.hash }
    } catch { return { present: true, chars: raw.length, invalid: true } }
  }
  const shortText = node => node?.matches(EDITOR) || node?.querySelector(EDITOR) ? '' : String(node?.textContent || '').slice(0, 2001)
  const scopeOf = node => node?.closest(MESSAGE)
  const sourceMeta = node => {
    const result = {}
    for (let current = node, level = 0; current && current !== document.body && level < 10; current = current.parentElement, level++) {
      for (const key of ['data-chatgpt-selection-message-id', 'data-dil-message-id', 'data-message-id', 'data-content-search-unit-key']) {
        const value = current.getAttribute(key)
        if (value && !result[key]) result[key] = ref(value)
      }
    }
    return result
  }
  const describe = (node, label = false) => {
    const css = getComputedStyle(node), rect = node.getBoundingClientRect(), attrs = {}
    for (const { name, value } of [...node.attributes].slice(0, 45)) {
      if (/^(?:role|type|tabindex|target|rel|disabled|aria-disabled|aria-hidden|aria-haspopup|aria-expanded|aria-modal|aria-selected|data-state|data-side|data-align)$/.test(name)) {
        attrs[name] = /^[a-z0-9 _-]{0,70}$/i.test(value) ? value : textMeta(value)
      } else if (['href', 'src'].includes(name)) attrs[name] = urlMeta(value)
      else if (['aria-controls', 'aria-describedby', 'aria-labelledby', 'aria-details'].includes(name)) attrs[name] = value.split(/\s+/).filter(Boolean).slice(0, 8).map(id => ref(id))
      else if (name === 'data-testid' && /^[a-z][a-z_-]{0,79}$/i.test(value)) attrs[name] = value
      else if (name === 'data-d-component' && /^[a-z]{1,50}$/i.test(value)) attrs[name] = value
      else if (/^(?:data-|aria-)|^(?:id|title|alt)$/.test(name)) attrs[name] = textMeta(value)
    }
    const labelText = label ? shortText(node) : ''
    return { tag: node.tagName.toLowerCase(), ref: ref(node), attrs, visible: visible(node), nativeOnClick: typeof node.onclick === 'function',
      ...(label ? { label: textMeta(labelText), ariaLabel: textMeta(node.getAttribute('aria-label') || '') } : {}),
      classes: [...node.classList].filter(value => /^(?:cursor-pointer|inline-flex|flex|sr-only|truncate|overflow-hidden|rounded-full|relative|group)$/.test(value)),
      bounds: { width: Math.round(rect.width), height: Math.round(rect.height) },
      style: { display: css.display, cursor: css.cursor, pointerEvents: css.pointerEvents, position: css.position,
        zIndex: /^\d{1,8}$/.test(css.zIndex) ? css.zIndex : 'auto', overflowX: css.overflowX, overflowY: css.overflowY,
        borderRadius: css.borderRadius, fontSize: css.fontSize, lineHeight: css.lineHeight, whiteSpace: css.whiteSpace, textOverflow: css.textOverflow } }
  }
  const tree = (node, budget, depth = 0) => {
    if (budget.left-- <= 0 || node.nodeType !== 1 || /^(script|style|noscript)$/i.test(node.tagName)) return null
    const result = describe(node, false)
    if (node.matches(EDITOR)) return { ...result, contentsOmitted: true }
    if (/^(?:iframe|object|embed|canvas|img)$/i.test(node.tagName)) return { ...result, carrier: true }
    if (depth < 10) result.children = [...node.children].slice(0, 24).map(child => tree(child, budget, depth + 1)).filter(Boolean)
    else result.depthLimited = node.children.length > 0
    return result
  }
  const httpLinks = root => [...(root.matches('a[href]') ? [root] : []), ...root.querySelectorAll('a[href]')].slice(0, 45).flatMap(link => {
    const raw = link.getAttribute('href') || ''
    try {
      const url = new URL(raw, location.href)
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return []
      return [{ ...describe(link, true), external: url.origin !== location.origin, title: textMeta(link.getAttribute('title') || '') }]
    } catch { return [] }
  })
  // Mirror the app's source admission separately from the broader discovery inventory.
  const adapterSourceCount = root => {
    const seen = new Set()
    for (const link of [...(root.matches('a[href]') ? [root] : []), ...root.querySelectorAll('a[href]')]) {
      const raw = link.getAttribute('href') || ''
      if (!raw || raw.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(raw)) continue
      try {
        const url = new URL(raw, location.href)
        if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || seen.has(url.href)) continue
        if (!collapse(link.getAttribute('title') || link.innerText || link.textContent)) continue
        seen.add(url.href)
        if (seen.size > 40) return 0
      } catch { /* Discovery inventory still records the rejected link's shape. */ }
    }
    return seen.size
  }
  const candidateReasons = node => {
    if (!visible(node) || node.closest(EDITOR) || !scopeOf(node)) return []
    if (node.closest('[data-message-author-role="user"], [data-content-search-unit-key$=":user"]')) return []
    const rect = node.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8 || rect.width > 480 || rect.height > 96) return []
    const text = collapse(shortText(node)), css = getComputedStyle(node)
    if (text.length > 240) return []
    const reasons = []
    if (node.hasAttribute('data-citation-group') || node.hasAttribute('data-citation-index') || /citation|source/i.test(node.getAttribute('data-testid') || '')) reasons.push('explicit-marker')
    if (/deepseek|api docs/i.test(text)) reasons.push('target-site-label')
    if (css.cursor === 'pointer' && (text || node.querySelector('img, svg'))) reasons.push('compact-pointer')
    if (node.matches('a[href]') && httpLinks(node).some(link => link.external)) reasons.push('external-link')
    if (node.tagName === 'IMG' && /deepseek|api docs|source|来源|引用/i.test(node.getAttribute('alt') || '')) reasons.push('image-label')
    return reasons
  }
  const roots = [...document.querySelectorAll(MESSAGE)].filter(node => !config.sourceMessageId ||
    [node, ...node.querySelectorAll('[data-chatgpt-selection-message-id], [data-dil-message-id], [data-message-id]')]
      .some(item => ['data-chatgpt-selection-message-id', 'data-dil-message-id', 'data-message-id'].some(key => item.getAttribute(key) === config.sourceMessageId)))
    .slice(-14)
  const discovered = new Set()
  let scanned = 0
  for (const root of roots) {
    for (const node of root.querySelectorAll('a, button, span, div, img, [role="link"], [role="button"]')) {
      if (++scanned > 7000) break
      if (candidateReasons(node).length) discovered.add(node)
    }
    if (scanned > 7000) break
  }
  const candidates = [...discovered].filter(node => ![...discovered].some(parent => parent !== node && parent.contains(node))).slice(0, 40)
  state.candidates = candidates
  const trailOf = node => {
    const trail = []
    for (let current = node, n = 0; current && current !== document.body && n < 9; current = current.parentElement, n++) trail.push(describe(current))
    return trail
  }
  const adapterOf = node => {
    const links = httpLinks(node), label = collapse(shortText(node)), admitted = adapterSourceCount(node)
    const explicit = node.hasAttribute('data-citation-group') || node.hasAttribute('data-citation-index') || /citation/i.test(node.getAttribute('data-testid') || '')
    const flags = /\+\s*[1-9]\d?\s*$/.test(label) || ['data-state', 'aria-describedby', 'aria-controls', 'aria-haspopup'].some(name => node.hasAttribute(name))
    return { selectorMatch: node.matches(config.triggerSelector), explicit, httpLinkCount: links.length, admittedSourceCount: admitted,
      currentHeuristicAccepts: node.matches(config.triggerSelector) && !!label && label.length <= 500 && (explicit || admitted > 0 && flags),
      nestedTriggerCount: node.querySelectorAll(config.triggerSelector).length,
      nativeImageCount: node.querySelectorAll('img').length, nativeSvgCount: node.querySelectorAll('svg').length }
  }
  const findCandidate = target => {
    const cached = state.candidates.find(node => node === target || node.contains(target))
    if (cached) return cached
    let chosen = null
    for (let node = target, n = 0; node && node !== document.body && n < 8; node = node.parentElement, n++) {
      if (candidateReasons(node).length) chosen = node
    }
    return chosen
  }
  const arm = (target, kind) => {
    if (state.active?.target !== target) {
      // Include body so a brand-new portal appended directly to body is discoverable.
      const before = [document.body, ...document.querySelectorAll('body *')].filter(Boolean).slice(0, 16000)
      state.active = { target, kind, before: new WeakSet(before), visibleBefore: new WeakSet(before.filter(visible)) }
    } else state.active.kind = kind
  }
  if (config.manual) {
    const hovered = [...document.querySelectorAll(':hover')].reverse().find(node => {
      if (!scopeOf(node) || node.closest(EDITOR) || !visible(node)) return false
      const box = node.getBoundingClientRect()
      return box.width >= 8 && box.width <= 480 && box.height >= 8 && box.height <= 96
    })
    if (hovered && (!state.active || !state.active.target.isConnected || !state.active.target.contains(hovered))) arm(findCandidate(hovered) || hovered, 'manual')
  }
  const active = state.active
  const relatedIds = active ? [...new Set(trailOf(active.target).flatMap(node =>
    ['aria-describedby', 'aria-controls', 'aria-details'].flatMap(key => node.attrs[key] || [])))] : []
  const linked = active ? [...document.querySelectorAll('[id]')].filter(node => relatedIds.includes(ref(node.id)) && visible(node)) : []
  const hints = active ? [...document.querySelectorAll(HINTS)].slice(0, 180).filter(node => visible(node) &&
    !node.contains(active.target) && !active.target.contains(node) && (!active.visibleBefore.has(node) || config.manual) &&
    node.getBoundingClientRect().width >= 80 && node.getBoundingClientRect().height >= 28) : []
  const fresh = active ? [...document.querySelectorAll('body *')].slice(0, 16000).filter(node =>
    !active.before.has(node) && active.before.has(node.parentElement) && visible(node) && !node.matches(EDITOR) &&
    !node.closest(EDITOR) && !node.contains(active.target) && !active.target.contains(node) &&
    node.getBoundingClientRect().width >= 80 && node.getBoundingClientRect().height >= 28) : []
  const popupCandidates = [...new Set([...linked, ...hints, ...fresh])]
  const popups = popupCandidates.filter(node => !popupCandidates.some(parent => parent !== node && parent.contains(node))).slice(0, 8)
  state.roots = popups
  const emit = details => console.log(config.tag + JSON.stringify(details))
  if (!state.listening) {
    state.listening = true
    for (const type of ['pointerover', 'pointerout', 'focusin', 'click']) document.addEventListener(type, event => {
      if (!event.isTrusted) return
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      if (!target || target.closest(EDITOR)) return
      const popup = state.roots.find(root => root.contains(target))
      if (popup) {
        if (type === 'pointerover' && popup.contains(event.relatedTarget)) return
        if (type === 'pointerout') return
        emit({ type: type === 'click' ? 'popup-click' : 'popup-enter', trusted: true, control: describe(target, true),
          root: describe(popup), trail: trailOf(target), links: httpLinks(popup), tree: tree(popup, { left: 220 }) })
        return
      }
      const control = findCandidate(target)
      if (!control) return
      if (['pointerover', 'pointerout'].includes(type) && control.contains(event.relatedTarget)) return
      const kind = type === 'click' ? 'click' : type === 'pointerout' ? 'leave' : type === 'focusin' ? 'focus' : 'hover'
      if (kind !== 'leave') arm(control, kind)
      emit({ type: 'source-' + kind, trusted: true, control: describe(control, true), source: sourceMeta(control),
        reasons: candidateReasons(control), adapter: adapterOf(control), trail: trailOf(control), tree: tree(control, { left: 160 }) })
      if (kind === 'click') queueMicrotask(() => emit({ type: 'click-finished', prevented: event.defaultPrevented === true }))
    }, true)
    if (document.body) {
      let queued = false
      state.observer = new MutationObserver(() => {
        if (!state.active || queued) return
        queued = true
        setTimeout(() => { queued = false; emit({ type: 'changed' }) }, 100)
      })
      state.observer.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['aria-expanded', 'aria-describedby', 'aria-controls', 'hidden', 'data-state', 'style'] })
    }
  }
  return { readyState: document.readyState, sourceRootCount: roots.length, scanned, scanLimited: scanned > 7000,
    candidates: candidates.map(node => ({ control: describe(node, true), reasons: candidateReasons(node), source: sourceMeta(node),
      adapter: adapterOf(node), trail: trailOf(node), links: httpLinks(node), tree: tree(node, { left: 160 }) })),
    active: active ? { ref: ref(active.target), kind: active.kind, connected: active.target.isConnected } : null,
    popups: popups.map(node => ({ root: describe(node), linkedByAria: linked.some(link => node === link || node.contains(link)),
      currentPopupSelectorMatch: node.matches(config.popupSelector), links: httpLinks(node), tree: tree(node, { left: 240 }),
      carriers: [...node.querySelectorAll('img, svg, iframe, canvas')].slice(0, 12).map(item => describe(item)) })) }
}
const source = '(' + inspectCitationPreview.toString() + ')(' + JSON.stringify(config) + ')'
new vm.Script(source)

async function capture(reason) {
  if (pendingRead) return pendingRead
  pendingRead = (async () => {
    for (const window of windows) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      const wc = window.webContents, before = wc.getURL()
      try { if (new URL(before).origin !== ORIGIN) continue } catch { continue }
      let timeout
      try {
        const reader = '(' + inspectCitationPreview.toString() + ')(' + JSON.stringify({ ...config, manual: reason === 'manual' }) + ')'
        const data = await Promise.race([wc.executeJavaScript(reader),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('read-timeout')), 2500) })])
        if (wc.isDestroyed() || wc.getURL() !== before) continue
        coverage.candidatesSeen ||= data.candidates.length > 0
        coverage.popupSeen ||= data.popups.length > 0
        coverage.popupAfterHoverSeen ||= data.active?.kind === 'hover' && data.popups.length > 0
        coverage.popupAfterClickSeen ||= data.active?.kind === 'click' && data.popups.length > 0
        coverage.popupLinksSeen ||= data.popups.some(popup => popup.links.length > 0)
        const signature = JSON.stringify(data)
        if (signature !== signatures.get(wc.id) || ['manual', 'final'].includes(reason)) {
          signatures.set(wc.id, signature)
          log('SNAPSHOT', { sequence: ++snapshots, reason, mainWindow: window === win, url: urlMetadata(before), ...data })
        }
      } catch { log('READ-FAILED', { reason, mainWindow: window === win }) }
      finally { clearTimeout(timeout) }
    }
    if (win && !win.isDestroyed()) win.setTitle('ChatGPT 引用来源探针 — 入口 ' + (coverage.candidatesSeen ? '已采集' : '未采集')
      + ' · 弹层 ' + (coverage.popupSeen ? '已采集' : '未采集') + ' · 链接 ' + (coverage.popupLinksSeen ? '已采集' : '未采集'))
  })().finally(() => { pendingRead = null })
  return pendingRead
}
function schedule(reason, delay) {
  if (closing || scheduled.size >= 8) return
  const handle = setTimeout(() => { scheduled.delete(handle); if (!closing) void capture(reason) }, delay)
  scheduled.add(handle)
}
function attachWindow(window, ses) {
  windows.add(window)
  const wc = window.webContents
  window.on('page-title-updated', event => event.preventDefault())
  wc.on('console-message', (event, _level, legacyMessage) => {
    const message = typeof legacyMessage === 'string' ? legacyMessage : event.message
    if (typeof message !== 'string' || !message.startsWith(config.tag) || message.length > 200000) return
    try {
      const data = JSON.parse(message.slice(config.tag.length))
      if (/^(?:source-(?:hover|click|leave|focus)|popup-(?:enter|click))$/.test(data.type) && data.trusted === true) {
        interactions++; armedUntil = Date.now() + 10000
        coverage.hoverSeen ||= data.type === 'source-hover'; coverage.clickSeen ||= data.type === 'source-click'
        log('USER-INTERACTION', { sequence: interactions, ...data })
        schedule('after-interaction', 60); schedule('after-interaction-settled', 450); schedule('after-interaction-loaded', 1300)
      } else if (data.type === 'changed') schedule('dom-change', 30)
      else if (data.type === 'click-finished') log('CLICK-FINISHED', { prevented: data.prevented === true })
    } catch { /* Ignore unrelated page console output. */ }
  })
  wc.on('did-finish-load', () => { schedule('loaded', 30) })
  wc.on('did-navigate', (_event, url) => {
    if (Date.now() < armedUntil) { coverage.sourceNavigationSeen = true; log('NAVIGATION', { mainWindow: window === win, url: urlMetadata(url) }) }
  })
  wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame) log('LOAD-FAILED', { code }) })
  wc.setWindowOpenHandler(({ url }) => {
    let allowed = false
    try { allowed = Date.now() < armedUntil && ['https:', 'http:'].includes(new URL(url).protocol) } catch {}
    log('NEW-WINDOW-REQUEST', { allowed, url: urlMetadata(url) })
    return allowed ? { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 900,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } } } : { action: 'deny' }
  })
  wc.on('did-create-window', child => { coverage.sourceNavigationSeen = true; attachWindow(child, ses) })
  window.on('closed', () => windows.delete(window))
}
const instructions = '1. 找到截图里的 DeepSeek API 来源标签，鼠标悬停两秒。\n' +
  '2. 卡片出现后，保持悬停按 F8，再把鼠标移入卡片并停留两秒。\n' +
  '3. 鼠标移到空白处，等卡片消失，再手动点击同一标签一次。\n' +
  '4. 如点击后仍有来源卡片或列表，保持打开按 F8。可手动打开其中一个来源链接。\n' +
  '5. 关闭探针主窗口，把日志路径发回来。无需发送消息。\n\n日志：' + logPath
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:chatgpt')
  await ses.setProxy({ proxyRules: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36')
  win = new BrowserWindow({ width: 1500, height: 980, title: 'ChatGPT 引用来源只读探针',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  attachWindow(win, ses)
  const menu = Menu.buildFromTemplate([
    { label: '采集当前入口与来源卡片', accelerator: 'F8', click: () => { void capture('manual') } },
    { label: '操作说明', click: () => { void dialog.showMessageBox(win, { type: 'info', title: '引用来源探针', message: instructions }) } }
  ])
  Menu.setApplicationMenu(menu); win.setMenu(menu)
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true; clearInterval(timer)
    for (const handle of scheduled) clearTimeout(handle)
    scheduled.clear()
    void (async () => { if (pendingRead) await pendingRead; await capture('final') })().finally(() => {
      log('FINAL', { snapshots, interactions, coverage, capped,
        note: 'Coverage only; missing hover/popup fields mean not captured. No automatic input, app pipeline, cookies, network listeners or request replay.' })
      console.log('日志已保存：' + logPath)
      for (const window of windows) if (!window.isDestroyed()) window.destroy()
      app.quit()
    })
  })
  log('START', { version: 1, profile: process.env.PROBE_USER_DATA ? 'override' : path.basename(userData),
    sourceFilter: !!sourceMessageId, url: urlMetadata(start.href),
    note: 'Passive user-driven citation controls, ancestry, popup/carrier structure and redacted source links; no prompts/body text, raw URLs, storage or app modules.' })
  console.log(instructions)
  timer = setInterval(() => { if (!closing) void capture('poll') }, 1000)
  await win.loadURL(start.href)
}).catch(() => { log('FATAL', { reason: 'startup-failed' }); console.log('日志已保存：' + logPath); app.quit() })
app.on('window-all-closed', () => app.quit())
