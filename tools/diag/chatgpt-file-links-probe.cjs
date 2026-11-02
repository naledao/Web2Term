/** User-run passive discovery of native file links. Never clicks, sends or starts the app pipeline. */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')

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
const logPath = path.join(directory, 'chatgpt-file-links-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const config = { key: '__fileLinkProbe_' + randomUUID().replace(/-/g, ''), tag: '[file-links-' + randomUUID() + '] ', sourceMessageId }
let win, timer, capturing = false, closing = false, signature = '', snapshots = 0, clicks = 0, downloads = 0, bytes = 0

function log(event, data = {}) {
  if (bytes > 2 * 1024 * 1024 && event !== 'FINAL') return
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
  fs.appendFileSync(logPath, line, 'utf8'); bytes += Buffer.byteLength(line)
  if (event !== 'SNAPSHOT') console.log(line.trimEnd())
}

/** URL shapes only: no file names, dynamic IDs, query values, credentials or fragments. */
function urlMetadata(raw) {
  if (typeof raw !== 'string' || !raw) return { present: raw !== null && raw !== undefined, chars: 0 }
  try {
    const url = new URL(raw, ORIGIN)
    const known = new Set(['c', 'backend-api', 'files', 'file', 'download', 'content', 'mnt', 'data', 'attachment', 'attachments'])
    return { present: true, chars: raw.length, protocol: url.protocol, sameOrigin: url.origin === ORIGIN,
      pathShape: url.pathname.split('/').map(value => !value || known.has(value) ? value : ':segment').join('/'),
      queryKeys: [...new Set(url.searchParams.keys())].slice(0, 12).map(key => /^[a-z_]{1,40}$/i.test(key) ? key : ':key'),
      hasFragment: !!url.hash }
  } catch { return { present: true, chars: raw.length, invalid: true } }
}

/** Self-contained reader. Only the selected reply's actionable controls and trusted user clicks are observed. */
function inspectFileLinks(config) {
  const MESSAGE = '[data-chatgpt-selection-message-id], [data-dil-message-id], [data-message-id]'
  const CONTROL = 'a, button, [role="link"], [role="button"], [tabindex], [class*="cursor-pointer"]'
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const category = value => /下载|download/i.test(value) ? 'download' : /预览|preview/i.test(value) ? 'preview' : 'other'
  const visible = node => !!node && node.getClientRects().length > 0 && !node.closest('[hidden], [aria-hidden="true"], [inert]')
    && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const sourceId = node => ['data-chatgpt-selection-message-id', 'data-dil-message-id', 'data-message-id']
    .map(name => node.getAttribute(name)).find(Boolean)
  let state = window[config.key]
  if (!state) state = window[config.key] = { refs: new Map(), listening: false }
  const ref = value => {
    if (!state.refs.has(value) && state.refs.size >= 5000) return 'ref-limit'
    if (!state.refs.has(value)) state.refs.set(value, 'ref-' + (state.refs.size + 1))
    return state.refs.get(value)
  }
  const urlInfo = raw => {
    if (raw === null || raw === '') return { present: raw !== null, chars: 0 }
    try {
      const url = new URL(raw, location.href)
      const known = new Set(['c', 'backend-api', 'files', 'file', 'download', 'content', 'mnt', 'data', 'attachment', 'attachments'])
      return { present: true, chars: raw.length, protocol: url.protocol, sameOrigin: url.origin === location.origin,
        pathShape: url.pathname.split('/').map(value => !value || known.has(value) ? value : ':segment').join('/'),
        queryKeys: [...new Set(url.searchParams.keys())].slice(0, 12).map(key => /^[a-z_]{1,40}$/i.test(key) ? key : ':key'),
        hasFragment: !!url.hash }
    } catch { return { present: true, chars: raw.length, invalid: true } }
  }
  const valueInfo = value => ({ chars: value.length, ref: ref(value),
    shape: /^sandbox:/i.test(value) ? 'sandbox-url' : /^https?:/i.test(value) ? 'web-url' :
      /^\/mnt\//.test(value) ? 'sandbox-path' : /\.(html?|pdf|docx?|xlsx?|zip|csv|png|jpe?g)$/i.test(value) ? 'file-name' : 'other' })
  const describe = (node, withText = false) => {
    const css = getComputedStyle(node), attrs = {}
    for (const attr of node.attributes) {
      if (/^(role|type|target|rel|tabindex|disabled|aria-disabled|aria-hidden|aria-haspopup|aria-expanded)$/.test(attr.name)) {
        attrs[attr.name] = /^[a-z0-9 _-]{0,80}$/i.test(attr.value) ? attr.value : valueInfo(attr.value)
      } else if (attr.name === 'href') attrs.href = urlInfo(attr.value)
      else if (attr.name === 'download') attrs.download = valueInfo(attr.value)
      else if (/^(data-|aria-)|^(id|title|onclick)$/.test(attr.name)) {
        attrs[attr.name] = attr.name === 'data-testid' && /^[a-z][a-z-]{0,60}$/.test(attr.value) ? attr.value : valueInfo(attr.value)
      }
    }
    const text = withText ? collapse(node.textContent) : ''
    return { tag: node.tagName.toLowerCase(), ref: ref(node), attrs,
      classes: [...node.classList].filter(value => /^(?:cursor-pointer|underline|no-underline|inline|inline-flex|flex|decoration-dotted|whitespace-nowrap)$/.test(value)),
      visible: visible(node), nativeOnClick: typeof node.onclick === 'function',
      ...(withText ? { text: { chars: text.length, category: category(text), ref: ref(text) } } : {}),
      style: { cursor: css.cursor, pointerEvents: css.pointerEvents, display: css.display, textDecoration: css.textDecorationLine } }
  }
  const tree = (node, budget, depth = 0) => {
    if (--budget.left < 0) return null
    if (node.nodeType === 3) { const text = collapse(node.nodeValue); return { type: 'text', chars: text.length, category: category(text), ref: ref(text) } }
    if (node.nodeType !== 1 || /^(script|style|iframe|object|embed|img|input|textarea)$/i.test(node.tagName)) return null
    const result = describe(node, true)
    if (depth < 5) result.children = [...node.childNodes].slice(0, 20).map(child => tree(child, budget, depth + 1)).filter(Boolean)
    return result
  }
  const roots = [...document.querySelectorAll(MESSAGE)].filter(node => sourceId(node) === config.sourceMessageId)
  const controls = [...new Set(roots.flatMap(root => [...root.querySelectorAll(CONTROL)]))].filter(node =>
    visible(node) && !node.closest('pre, code, [contenteditable="true"]') && category(collapse(node.textContent)) !== 'other')
  if (!state.listening) {
    state.listening = true
    document.addEventListener('click', event => {
      if (!event.isTrusted) return
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      let reply = target
      while (reply && sourceId(reply) !== config.sourceMessageId) reply = reply.parentElement
      if (!reply || target.closest('pre, code, input, textarea, [contenteditable="true"]')) return
      let control = target.closest(CONTROL)
      if (!control || !reply.contains(control)) control = target
      const text = collapse(control.textContent)
      if (category(text) === 'other' || text.length > 1000) return
      const trail = []
      for (let node = control; node && trail.length < 6; node = node.parentElement) {
        trail.push(describe(node)); if (node === reply) break
      }
      console.log(config.tag + JSON.stringify({ type: 'file-click', trusted: true, control: tree(control, { left: 100 }), trail }))
      setTimeout(() => console.log(config.tag + JSON.stringify({ type: 'file-click-finished', prevented: event.defaultPrevented })), 0)
    }, { capture: true, passive: true })
  }
  return { targetReplyFound: roots.length > 0, rootCount: roots.length, roots: roots.slice(0, 3).map(node => describe(node)),
    candidateCount: controls.length, controls: controls.slice(0, 12).map(node => tree(node, { left: 100 })) }
}
const source = '(' + inspectFileLinks.toString() + ')(' + JSON.stringify(config) + ')'
new vm.Script(source)

async function capture(reason) {
  if (capturing || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try { if (new URL(win.webContents.getURL()).origin !== ORIGIN) return } catch { return }
  capturing = true
  let timeout
  try {
    const snapshot = await Promise.race([win.webContents.executeJavaScript(source),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 3000) })])
    const next = JSON.stringify(snapshot)
    if (next !== signature || reason === 'manual' || reason === 'final') {
      signature = next; log('SNAPSHOT', { sequence: ++snapshots, reason, ...snapshot })
    }
    win.setTitle('ChatGPT 文件链接探针 — 入口 ' + snapshot.candidateCount + ' · 手动点击 ' + clicks + ' · 下载 ' + downloads)
  } catch { log('READ-FAILED', { reason }) }
  finally { clearTimeout(timeout); capturing = false }
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:chatgpt')
  await ses.setProxy({ proxyRules: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36')
  win = new BrowserWindow({ width: 1450, height: 960, title: 'ChatGPT 文件链接只读探针',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  win.on('page-title-updated', event => event.preventDefault())
  const menu = Menu.buildFromTemplate([{ label: '采集当前入口', accelerator: 'F8', click: () => { void capture('manual') } }])
  Menu.setApplicationMenu(menu); win.setMenu(menu)
  win.webContents.on('console-message', (event, _level, legacyMessage) => {
    const message = typeof legacyMessage === 'string' ? legacyMessage : event.message
    if (typeof message !== 'string' || !message.startsWith(config.tag) || message.length > 60000) return
    try {
      const data = JSON.parse(message.slice(config.tag.length))
      if (data.type === 'file-click' && data.trusted === true) { clicks++; log('FILE-CLICK', data) }
      else if (data.type === 'file-click-finished') log('FILE-CLICK-FINISHED', { prevented: data.prevented === true })
    } catch { /* Other page console output is not recorded. */ }
  })
  win.webContents.setWindowOpenHandler(({ url }) => { log('NEW-WINDOW-REQUEST', { url: urlMetadata(url) }); return { action: 'deny' } })
  ses.on('will-download', (_event, item, contents) => {
    if (contents !== win.webContents) return
    downloads++
    const extension = path.extname(item.getFilename())
    log('DOWNLOAD', { url: urlMetadata(item.getURL()), mime: item.getMimeType().slice(0, 100), totalBytes: item.getTotalBytes(),
      extension: /^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : ':extension' })
    item.once('done', (_event, state) => log('DOWNLOAD-DONE', { state: ['completed', 'cancelled', 'interrupted'].includes(state) ? state : 'unknown' }))
  })
  win.webContents.on('did-finish-load', () => { void capture('loaded') })
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame) log('LOAD-FAILED', { code }) })
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true; clearInterval(timer)
    void (async () => {
      while (capturing) await new Promise(resolve => setTimeout(resolve, 50))
      await capture('final')
    })().finally(() => {
      log('FINAL', { snapshots, clicks, downloads, note: 'Coverage only; no automatic input, message text, cookies, storage, React private objects or request bodies.' })
      console.log('日志已保存：' + logPath); win.destroy(); app.quit()
    })
  })
  log('START', { origin: ORIGIN, targetMessageConfigured: true, profile: process.env.PROBE_USER_DATA ? 'override' : path.basename(userData),
    note: 'Close the normal app first. User-operated page only; application injection pipeline is not loaded.' })
  console.log('等页面载入，滚动到“下载 HTML 页面”，按 F8，手动点击一次。等待数秒后关闭窗口。\n日志：' + logPath)
  timer = setInterval(() => { if (!closing) void capture('poll') }, 1500)
  await win.loadURL(start.href)
}).catch(() => { log('FATAL', { reason: 'startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
