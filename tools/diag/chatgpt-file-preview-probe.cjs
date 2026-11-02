/** User-run passive discovery: native link -> file preview -> toolbar download. Never run by an agent. */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHmac, randomUUID } = require('node:crypto')

const ORIGIN = 'https://chatgpt.com'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/c/6ae80c3b-32d4-83e8-ab7c-0ff8bf6af258')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 https://chatgpt.com 同源页面。')
const sourceMessageId = process.env.PROBE_SOURCE_MESSAGE_ID || '733e7f5d-f073-418a-8743-ce8b93ccba23'
if (!/^[a-zA-Z0-9_:-]{1,160}$/.test(sourceMessageId)) throw new Error('PROBE_SOURCE_MESSAGE_ID 格式无效。')
const profiles = ['Web2Term', 'gpt-web-to-codex-terminal', 'GPT Web to Codex Terminal'].map(name => path.join(app.getPath('appData'), name))
const userData = process.env.PROBE_USER_DATA || profiles.find(root => fs.existsSync(path.join(root, 'conversations.db')))
  || profiles.find(root => fs.existsSync(root)) || profiles[0]
app.setPath('userData', userData)
app.setPath('sessionData', userData)
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(directory, 'chatgpt-file-preview-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const salt = randomUUID()
const config = { key: '__filePreviewProbe_' + randomUUID().replace(/-/g, ''), tag: '[file-preview-' + randomUUID() + '] ', sourceMessageId }
const windows = new Set(), signatures = new Map(), scheduled = new Set()
const coverage = { sourceLinkSeen: false, sourceClick: false, previewContainerSeen: false, previewFrameSeen: false,
  downloadControlSeen: false, previewControlClick: false, downloadEvent: false, downloadCompleted: false, auxiliaryWindowSeen: false }
let win, timer, closing = false, capturing = null, armedUntil = 0, snapshotCount = 0, clickCount = 0, downloadCount = 0, networkCount = 0, bytes = 0
const alias = value => createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16)

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
  if (bytes + Buffer.byteLength(line) > 6 * 1024 * 1024 && !['FINAL', 'FATAL'].includes(event)) return
  fs.appendFileSync(logPath, line, 'utf8'); bytes += Buffer.byteLength(line)
  if (event !== 'SNAPSHOT' && event !== 'FILE-RESPONSE') console.log(line.trimEnd())
}
function urlMetadata(raw) {
  if (typeof raw !== 'string' || !raw) return { present: false }
  try {
    const url = new URL(raw, ORIGIN)
    const known = new Set(['c', 'backend-api', 'files', 'file', 'download', 'content', 'mnt', 'data', 'attachment', 'attachments', 'preview', 'sandbox'])
    return { protocol: url.protocol, urlRef: alias(url.href), pathRef: alias(url.pathname), chars: raw.length,
      hostFamily: url.hostname === 'chatgpt.com' ? 'chatgpt' : /(?:^|\.)oaiusercontent\.com$/.test(url.hostname) ? 'oaiusercontent' : 'other',
      hostRef: alias(url.hostname), pathShape: url.pathname.split('/').map(value => !value || known.has(value) ? value : ':segment').join('/'),
      queryKeys: [...new Set(url.searchParams.keys())].slice(0, 12).map(key => /^[a-z_]{1,40}$/i.test(key) ? key : ':key'), hasFragment: !!url.hash }
  } catch { return { present: true, chars: raw.length, invalid: true } }
}
async function bounded(promise, ms = 2200) {
  let timeout
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), ms) })]) }
  finally { clearTimeout(timeout) }
}

/** Self-contained page/frame reader: structural metadata only; no source HTML, file bytes or private React objects. */
function inspectFilePreview(config) {
  const MESSAGE = '[data-chatgpt-selection-message-id], [data-dil-message-id], [data-message-author-role]'
  const EDITOR = 'input, textarea, [contenteditable="true"], [role="textbox"]'
  const CONTROL = 'a, button, [role="link"], [role="button"], [role="tab"], [role="menuitem"], [tabindex], [class*="cursor-pointer"]'
  const HINTS = 'dialog, [role="dialog"], [aria-modal="true"], aside, [role="complementary"], iframe, object, embed, [data-state="open"], [data-testid*="preview"], [data-testid*="file"], [data-testid*="artifact"]'
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const action = value => /下载|download|另存为|save as/i.test(value) ? 'download' : /预览|preview/i.test(value) ? 'preview' :
    /关闭|close|dismiss/i.test(value) ? 'close' : /代码|源码|source|code/i.test(value) ? 'code' : /复制|copy/i.test(value) ? 'copy' :
      /更多|more|menu/i.test(value) ? 'more' : /返回|back/i.test(value) ? 'back' : /全屏|full.?screen/i.test(value) ? 'fullscreen' : 'other'
  const visible = node => !!node && node.getClientRects().length > 0 && !node.closest('[hidden], [aria-hidden="true"], [inert]')
    && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const sourceId = node => ['data-chatgpt-selection-message-id', 'data-dil-message-id', 'data-message-id'].map(name => node.getAttribute(name)).find(Boolean)
  const inTranscript = node => !!node.closest(MESSAGE + ', ' + EDITOR)
  let state = window[config.key]
  if (!state) state = window[config.key] = { refs: new Map(), listening: false, active: false, before: null, roots: [] }
  state.active ||= config.flowArmed
  const ref = value => {
    if (!state.refs.has(value) && state.refs.size >= 8000) return 'ref-limit'
    if (!state.refs.has(value)) state.refs.set(value, 'ref-' + (state.refs.size + 1))
    return state.refs.get(value)
  }
  const valueInfo = value => ({ chars: value.length, ref: ref(value), action: action(value),
    shape: /^sandbox:/i.test(value) ? 'sandbox-url' : /^blob:/i.test(value) ? 'blob-url' : /^data:/i.test(value) ? 'data-url' :
      /^https?:/i.test(value) ? 'web-url' : /\.(html?|pdf|docx?|xlsx?|zip|csv)$/i.test(value) ? 'file-name' : 'other' })
  const urlInfo = raw => {
    if (raw === null || !raw) return { present: raw !== null, chars: 0 }
    try {
      const url = new URL(raw, location.href), known = new Set(['c', 'backend-api', 'files', 'file', 'download', 'content', 'mnt', 'data', 'attachment', 'attachments', 'preview', 'sandbox'])
      return { present: true, chars: raw.length, ref: ref(url.href), protocol: url.protocol, sameOrigin: url.origin === location.origin,
        pathShape: url.pathname.split('/').map(value => !value || known.has(value) ? value : ':segment').join('/'),
        queryKeys: [...new Set(url.searchParams.keys())].slice(0, 12).map(key => /^[a-z_]{1,40}$/i.test(key) ? key : ':key'), hasFragment: !!url.hash }
    } catch { return { present: true, chars: raw.length, invalid: true } }
  }
  const bounds = node => { const r = node.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) } }
  const placement = (node, root) => {
    const r = node.getBoundingClientRect(), box = root.getBoundingClientRect()
    if (!box.width || !box.height) return null
    const round = value => Math.round(value * 1000) / 1000
    return { x: round((r.left - box.left) / box.width), y: round((r.top - box.top) / box.height),
      width: round(r.width / box.width), height: round(r.height / box.height),
      nearTopRight: r.left + r.width / 2 > box.left + box.width * .65 && r.top < box.top + box.height * .25 }
  }
  const describe = (node, withLabel = false) => {
    const css = getComputedStyle(node), attrs = {}
    for (const attr of [...node.attributes].slice(0, 40)) {
      if (/^(role|type|target|rel|tabindex|disabled|aria-disabled|aria-hidden|aria-haspopup|aria-expanded|aria-modal|data-state|loading|referrerpolicy)$/.test(attr.name)) {
        attrs[attr.name] = /^[a-z0-9 _-]{0,80}$/i.test(attr.value) ? attr.value : valueInfo(attr.value)
      } else if (/^(href|src|data)$/.test(attr.name)) attrs[attr.name] = urlInfo(attr.value)
      else if (attr.name === 'srcdoc') attrs.srcdoc = { present: true, chars: attr.value.length }
      else if (attr.name === 'sandbox') attrs.sandbox = attr.value.split(/\s+/).filter(value => /^allow-[a-z-]{1,40}$/.test(value))
      else if (attr.name === 'data-d-component' && /^[a-z]{1,40}$/i.test(attr.value)) attrs[attr.name] = attr.value
      else if (attr.name === 'data-testid' && /^[a-z][a-z-]{0,70}$/.test(attr.value)) attrs[attr.name] = attr.value
      else if (attr.name === 'd' && node.closest(CONTROL) && attr.value.length <= 1800 && /^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]+$/.test(attr.value)) attrs.d = attr.value
      else if (attr.name === 'viewBox' && node.closest(CONTROL) && /^[-\d.,\s]{1,100}$/.test(attr.value)) attrs.viewBox = attr.value
      else if (/^(data-|aria-)|^(id|title|download|allow|onclick)$/.test(attr.name)) attrs[attr.name] = valueInfo(attr.value)
    }
    // Container/body text is never aggregated. Labels are read only for bounded controls.
    const label = withLabel ? collapse(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent).slice(0, 2000) : ''
    return { tag: node.tagName.toLowerCase(), ref: ref(node), attrs, visible: visible(node), bounds: bounds(node),
      classes: [...node.classList].filter(value => /^(?:cursor-pointer|inline-flex|flex|sr-only|lucide-download|lucide-x|icon-download|icon-close)$/.test(value)),
      nativeOnClick: typeof node.onclick === 'function', ...(withLabel ? { label: valueInfo(label) } : {}),
      style: { cursor: css.cursor, pointerEvents: css.pointerEvents, display: css.display, position: css.position,
        zIndex: /^\d{1,8}$/.test(css.zIndex) ? css.zIndex : 'auto', overflow: css.overflow } }
  }
  const tree = (node, budget, depth = 0) => {
    if (--budget.left < 0 || node.nodeType !== 1 || /^(script|style|noscript|iframe|object|embed|img)$/i.test(node.tagName)) return null
    const result = describe(node, node.matches(CONTROL) && !node.matches(EDITOR))
    if (node.matches(EDITOR) || /^(pre|code)$/i.test(node.tagName)) return { ...result, contentsOmitted: true }
    if (depth < 6) result.children = [...node.children].slice(0, 24).map(child => tree(child, budget, depth + 1)).filter(Boolean)
    return result
  }
  const controlsOf = (root, all = false) => [...root.querySelectorAll(CONTROL)].filter(node => visible(node)
    && !node.matches(EDITOR) && !node.closest('pre, code') && (all || !inTranscript(node))).slice(0, 45)
    .map(node => ({ ...describe(node, true), placement: placement(node, root), tree: tree(node, { left: 45 }) }))
  const sourceRoots = config.frameMode ? [] : [...document.querySelectorAll('[data-chatgpt-selection-message-id], [data-dil-message-id], [data-message-id]')]
    .filter(node => sourceId(node) === config.sourceMessageId)
  const sourceControls = [...new Set(sourceRoots.flatMap(root => [...root.querySelectorAll(CONTROL)]))].filter(node =>
    visible(node) && !node.closest('pre, code, ' + EDITOR) && /download|preview/.test(action(collapse(node.textContent)))).slice(0, 10)
  const hints = state.active ? [...document.querySelectorAll(HINTS)].slice(0, 180).filter(node => visible(node)
    && (!inTranscript(node) || state.before && sourceRoots.some(root => root !== node && root.contains(node)))
    && (!state.before || state.before.get(node) !== true)) : []
  // Discover newly inserted portal/split-pane roots without assuming a preview selector.
  const inserted = state.active && state.before ? [...document.querySelectorAll('body *')].slice(0, 18000).filter(node =>
    !state.before.has(node) && state.before.has(node.parentElement) && visible(node)
    && (!inTranscript(node) || sourceRoots.some(root => root !== node && root.contains(node)))
    && node.getBoundingClientRect().width >= 160 && node.getBoundingClientRect().height >= 80) : []
  let candidates = [...new Set([...hints, ...inserted])].filter(node => !/^(html|body)$/i.test(node.tagName))
  candidates = candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node))).slice(0, 6)
  if (state.active && (config.frameMode || config.navigated) && !candidates.length && document.body) candidates = [document.body]
  state.roots = candidates
  const previews = candidates.map(root => ({ root: describe(root), structure: tree(root, { left: 180 }), controls: controlsOf(root, true),
    carriers: [...root.querySelectorAll('iframe, object, embed, pre, code, canvas')].slice(0, 16).map(node => describe(node)) }))
  const iframes = state.active ? [...document.querySelectorAll('iframe')].slice(0, 16).filter(node => visible(node)
    && (!inTranscript(node) || state.before && state.before.get(node) !== true)).map(node => {
    let documentInfo = { accessible: false }
    try { const doc = node.contentDocument; if (doc) documentInfo = { accessible: true, readyState: doc.readyState, contentType: doc.contentType,
      bodyPresent: !!doc.body, frameCount: doc.querySelectorAll('iframe').length, codeContainers: doc.querySelectorAll('pre, code').length } } catch {}
    return { node: describe(node), document: documentInfo }
  }) : []
  if (!state.listening) {
    state.listening = true
    document.addEventListener('click', event => {
      if (!event.isTrusted) return
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      if (!target || target.closest(EDITOR + ', pre, code')) return
      let sourceRoot = target
      while (sourceRoot && sourceId(sourceRoot) !== config.sourceMessageId) sourceRoot = sourceRoot.parentElement
      const control = target.closest(CONTROL) || target
      const sourceClick = !!sourceRoot && /download|preview/.test(action(collapse(control.textContent)))
      const inPreview = state.roots.some(root => root.contains(control))
      const previewClick = !sourceClick && state.active && (inPreview || !inTranscript(control) && (config.frameMode || config.navigated
        || action(control.getAttribute('aria-label') || control.getAttribute('title') || '') !== 'other'))
      if (!sourceClick && !previewClick) return
      if (sourceClick) {
        state.active = true
        state.before = new Map([...document.querySelectorAll('body *')].slice(0, 18000).map(node => [node, visible(node)]))
      }
      const trail = []
      for (let node = control; node && trail.length < 7; node = node.parentElement) { trail.push(describe(node)); if (node === sourceRoot) break }
      const kind = sourceClick ? 'source-click' : 'preview-click'
      console.log(config.tag + JSON.stringify({ type: kind, trusted: true, control: describe(control, true),
        tree: tree(control, { left: 100 }), trail, placement: state.roots.find(root => root.contains(control))
          ? placement(control, state.roots.find(root => root.contains(control))) : null }))
      setTimeout(() => console.log(config.tag + JSON.stringify({ type: 'click-finished', kind, prevented: event.defaultPrevented })), 0)
    }, { capture: true, passive: true })
  }
  return { readyState: document.readyState, contentType: document.contentType, frameMode: config.frameMode, flowActive: state.active,
    targetReplyFound: sourceRoots.length > 0, sourceControls: sourceControls.map(node => ({ ...describe(node, true), tree: tree(node, { left: 100 }) })), previews, iframes }
}
new vm.Script('(' + inspectFilePreview.toString() + ')(' + JSON.stringify(config) + ')')

function scheduleCapture(reason, delay = 100) {
  if (closing || scheduled.size >= 6) return
  const id = setTimeout(() => { scheduled.delete(id); if (!closing) void captureAll(reason) }, delay)
  scheduled.add(id)
}
function framesFor(window) {
  const wc = window.webContents
  return wc.mainFrame.framesInSubtree.slice(0, 10).filter(frame => {
    try {
      const url = new URL(frame.url)
      if (frame === wc.mainFrame) return url.origin === ORIGIN || Date.now() < armedUntil && ['http:', 'https:', 'blob:', 'about:'].includes(url.protocol)
      return Date.now() < armedUntil && (url.origin === ORIGIN || /(?:^|\.)oaiusercontent\.com$/.test(url.hostname)
        || ['blob:', 'about:'].includes(url.protocol))
    } catch { return false }
  })
}
async function captureAll(reason) {
  if (capturing) return capturing
  capturing = (async () => {
    const reads = []
    for (const window of windows) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue
      for (const frame of framesFor(window)) reads.push((async () => {
        const frameRef = alias(frame.processId + ':' + frame.routingId), beforeUrl = frame.url
        try {
          const settings = { ...config, frameMode: frame !== win.webContents.mainFrame, flowArmed: Date.now() < armedUntil,
            navigated: window !== win || beforeUrl.split(/[?#]/)[0] !== start.href.split(/[?#]/)[0] }
          const raw = await bounded(frame.executeJavaScript('(' + inspectFilePreview.toString() + ')(' + JSON.stringify(settings) + ')'))
          if (frame.url !== beforeUrl) return
          coverage.sourceLinkSeen ||= raw.sourceControls.length > 0
          coverage.previewContainerSeen ||= raw.previews.some(item => item.root.visible && item.root.bounds.width >= 80 && item.root.bounds.height >= 50)
          coverage.previewFrameSeen ||= raw.iframes.length > 0 || settings.frameMode && raw.flowActive
          coverage.downloadControlSeen ||= raw.previews.some(item => item.controls.some(control => control.label.action === 'download'))
          const next = JSON.stringify({ urlRef: alias(beforeUrl), snapshot: raw })
          if (next !== signatures.get(frameRef) || reason === 'manual' || reason === 'final') {
            signatures.set(frameRef, next)
            log('SNAPSHOT', { sequence: ++snapshotCount, reason, frame: frameRef, mainWindow: window === win,
              url: urlMetadata(beforeUrl), ...raw })
          }
        } catch { log('FRAME-READ-FAILED', { frame: frameRef, reason }) }
      })())
    }
    await Promise.allSettled(reads)
    if (win && !win.isDestroyed()) win.setTitle('ChatGPT 文件预览探针 — 预览 ' + (coverage.previewContainerSeen ? '已采集' : '未采集')
      + ' · 下载按钮 ' + (coverage.downloadControlSeen ? '已采集' : '未采集') + ' · 下载 ' + downloadCount)
  })().finally(() => { capturing = null })
  return capturing
}

function attachWindow(window, ses) {
  windows.add(window)
  const wc = window.webContents
  window.on('page-title-updated', event => event.preventDefault())
  wc.on('console-message', (event, _level, legacyMessage) => {
    const message = typeof legacyMessage === 'string' ? legacyMessage : event.message
    if (typeof message !== 'string' || !message.startsWith(config.tag) || message.length > 100000) return
    try {
      const data = JSON.parse(message.slice(config.tag.length))
      if (['source-click', 'preview-click'].includes(data.type) && data.trusted === true) {
        armedUntil = Date.now() + 180000; clickCount++
        if (data.type === 'source-click') coverage.sourceClick = true
        else coverage.previewControlClick = true
        log(data.type === 'source-click' ? 'SOURCE-CLICK' : 'PREVIEW-CLICK', data)
        scheduleCapture('after-click', 80); scheduleCapture('after-click-settled', 600); scheduleCapture('after-click-loaded', 1800)
      } else if (data.type === 'click-finished') log('CLICK-FINISHED', { kind: data.kind === 'source-click' ? 'source' : 'preview', prevented: data.prevented === true })
    } catch { /* Other console output is never copied into the log. */ }
  })
  wc.setWindowOpenHandler(({ url }) => {
    let allow = false
    try { allow = Date.now() < armedUntil && ['http:', 'https:', 'blob:'].includes(new URL(url).protocol) } catch {}
    log('NEW-WINDOW-REQUEST', { allowed: allow, url: urlMetadata(url) })
    return allow ? { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 900,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } } } : { action: 'deny' }
  })
  wc.on('did-create-window', child => { coverage.auxiliaryWindowSeen = true; attachWindow(child, ses); scheduleCapture('child-window', 300) })
  wc.on('did-finish-load', () => { scheduleCapture('loaded', 50) })
  wc.on('did-frame-finish-load', () => { if (Date.now() < armedUntil) scheduleCapture('frame-loaded', 100) })
  wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame) log('LOAD-FAILED', { code }) })
  window.on('closed', () => windows.delete(window))
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:chatgpt')
  await ses.setProxy({ proxyRules: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36')
  win = new BrowserWindow({ width: 1550, height: 980, title: 'ChatGPT 文件预览只读探针',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  attachWindow(win, ses)
  const menu = Menu.buildFromTemplate([{ label: '采集当前预览与下载按钮', accelerator: 'F8', click: () => {
    armedUntil = Date.now() + 180000; void captureAll('manual')
  } }])
  Menu.setApplicationMenu(menu); win.setMenu(menu)
  // One listener per session event. Observe only user-triggered preview traffic, never bodies/credentials or replayed requests.
  ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, details => {
    if (Date.now() >= armedUntil || networkCount >= 120 || !['GET', 'HEAD'].includes(details.method)
      || !['mainFrame', 'subFrame', 'xhr', 'other'].includes(details.resourceType)
      || ![...windows].some(window => !window.isDestroyed() && window.webContents.id === details.webContentsId)) return
    const headers = details.responseHeaders || {}
    const header = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]?.[0] || ''
    const mime = header('content-type').split(';')[0]
    log('FILE-RESPONSE', { sequence: ++networkCount, resourceType: details.resourceType, status: details.statusCode,
      mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) ? mime : 'unknown',
      attachment: /^attachment(?:;|$)/i.test(header('content-disposition')), url: urlMetadata(details.url) })
  })
  ses.on('will-download', (_event, item, contents) => {
    if (contents ? ![...windows].some(window => !window.isDestroyed() && window.webContents === contents) : Date.now() >= armedUntil) return
    downloadCount++; coverage.downloadEvent = true
    const extension = path.extname(item.getFilename()), mime = item.getMimeType()
    log('DOWNLOAD', { sequence: downloadCount, initiator: contents ? 'known-window' : 'session-only', url: urlMetadata(item.getURL()),
      mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime) ? mime : 'unknown', totalBytes: item.getTotalBytes(),
      extension: /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : ':extension' })
    item.once('done', (_event, state) => {
      coverage.downloadCompleted ||= state === 'completed'
      log('DOWNLOAD-DONE', { state: ['completed', 'cancelled', 'interrupted'].includes(state) ? state : 'unknown' })
    })
  })
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true; clearInterval(timer)
    for (const id of scheduled) clearTimeout(id)
    scheduled.clear()
    void (async () => { if (capturing) await capturing; await captureAll('final') })().finally(() => {
      ses.webRequest.onCompleted(null)
      log('FINAL', { snapshotCount, clickCount, downloadCount, networkCount, coverage,
        note: 'Coverage only. User-operated native preview/download; no automatic input, file source/body capture or application pipeline.' })
      console.log('日志已保存：' + logPath)
      for (const window of windows) if (!window.isDestroyed()) window.destroy()
      app.quit()
    })
  })
  log('START', { origin: ORIGIN, version: 2, profile: process.env.PROBE_USER_DATA ? 'override' : path.basename(userData),
    note: 'Native link, preview containers, iframe metadata, toolbar controls and user-triggered download response metadata only.' })
  console.log('1. 手动点击“下载 HTML 页面”打开原生预览。\n2. 预览完整出现后按 F8。\n3. 手动点击预览右上角的下载按钮，保存或取消均可。\n4. 关闭预览后再关闭探针主窗口。\n日志：' + logPath)
  timer = setInterval(() => { if (!closing) void captureAll('poll') }, 1200)
  await win.loadURL(start.href)
}).catch(() => { log('FATAL', { reason: 'startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
