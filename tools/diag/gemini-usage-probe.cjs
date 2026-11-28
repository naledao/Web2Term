/** User-run from the repository root after exiting Web2Term (including the tray).
 *  .\node_modules\electron\dist\electron.exe .\tools\diag\gemini-usage-probe.cjs
 *  Wait for the usage cards, press F8, then close this window. No chat is needed.
 */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const origin = 'https://gemini.google.com'
const usagePath = /^\/(?:u\/\d{1,3}\/)?usage\/?$/
const partition = process.env.PROBE_PARTITION || 'persist:gemini'
const authCookies = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'])
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
const logFile = path.join(directory, `gemini-usage-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
fs.mkdirSync(directory, { recursive: true })

let logBytes = 0
function log(event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n'
  const size = Buffer.byteLength(line)
  const limit = 2 * 1024 * 1024
  if (logBytes + size > (event === 'FINAL' ? limit : limit - 1024)) return false
  fs.appendFileSync(logFile, line, 'utf8')
  logBytes += size
  return true
}

function route(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.origin === origin) {
      if (usagePath.test(url.pathname)) return 'usage'
      return /^\/(?:u\/\d{1,3}\/)?app(?:\/|$)/.test(url.pathname) ? 'gemini-app' : 'gemini-other'
    }
    if (url.origin === 'https://accounts.google.com') return 'google-sign-in'
  } catch { /* Navigation may not have committed a URL yet. */ }
  return 'other'
}

// Runs in an isolated world on the usage route only. Keep recognizable quota
// labels and numbers with their owning DOM nodes so their meanings can be checked.
function inspectUsage(expectedOrigin, pathPattern) {
  if (location.origin !== expectedOrigin || !new RegExp(pathPattern).test(location.pathname)) return null
  const excluded = 'nav, aside, [role="banner"], [role="navigation"], [role="menu"], [role="dialog"], ' +
    'user-query, model-response, message-content, textarea, input, [contenteditable], button, ' +
    'script, style, iframe, svg, [hidden], [inert], [aria-hidden="true"]'
  const semanticMeter = 'progress, meter, [role="progressbar"], [role="meter"], [aria-valuenow], mat-progress-bar'
  const labels = /额度|用量|限额|配额|上限|使用量|使用限制|已使用|已用|剩[余餘]|重[置設]|刷新|恢[复復]|下次[更刷]|每[周週日天月]|小[时時]|\b(?:usage|quotas?|limits?|used|remaining|resets?|refresh(?:ed|es)?|weekly|daily|monthly|rolling|hours?|renews?|unlimited|Google AI|Gemini)\b/i
  const measurement = /(?:\d{1,3}(?:[.,]\d{1,3})?\s*[%％]|^\d{1,5}(?:\s*\/\s*\d{1,5})?$|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b|\d{1,2}月\s*\d{1,2}日)/i
  const identity = /@|(?:https?|mailto|tel):|\bwww\.|\d{7,}|[a-z0-9_+=-]{28,}/i
  const token = /^[a-z][a-z0-9_-]{0,79}$/i
  const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim()
  const quotaText = value => {
    const text = compact(value)
    return text && text.length <= 220 && !identity.test(text) && (labels.test(text) || measurement.test(text)) ? text : null
  }
  const visible = node => !!node && !node.closest(excluded) && node.getClientRects().length > 0 &&
    !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const staticToken = value => token.test(value ?? '') && !identity.test(value) ? value : undefined

  function address(node, root) {
    const ancestry = []
    for (let parent = node; parent && ancestry.length < 7; parent = parent.parentElement) {
      const { localName: tag, classList } = parent
      ancestry.unshift({ tag,
        index: parent.parentElement ? Array.prototype.indexOf.call(parent.parentElement.children, parent) + 1 : 1,
        role: staticToken(parent.getAttribute('role')),
        testId: staticToken(parent.getAttribute('data-test-id')) ?? staticToken(parent.getAttribute('data-testid')),
        classes: [...classList].filter(staticToken).slice(0, 6) })
      if (parent === root) break
    }
    return ancestry
  }

  function numericAttribute(node, name) {
    const value = node.getAttribute(name)
    return /^-?\d{1,6}(?:\.\d{1,4})?$/.test(value ?? '') ? Number(value) : undefined
  }

  const signIn = [...document.querySelectorAll('a[href^="https://accounts.google.com/"]')]
    .some(link => link.getClientRects().length > 0)
  const authForm = !!document.querySelector('input[type="password"], input[type="email"], input[autocomplete="username"]')
  const main = [...document.querySelectorAll('main, [role="main"], usage-page, usage-limits-page')].find(visible)
  const root = main ?? document.body
  if (!root || authForm) return { ready: document.readyState, signIn, authForm, texts: [], meters: [] }

  const texts = [], meters = [], seen = new Set()
  function addText(node, source, raw) {
    const text = quotaText(raw)
    if (!text || texts.length >= 90 || !visible(node)) return
    const owner = address(node, root)
    const key = JSON.stringify([owner, source, text])
    if (seen.has(key)) return
    seen.add(key)
    texts.push({ source, text, owner })
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let scanned = 0
  for (let text = walker.nextNode(); text && scanned < 3500 && texts.length < 90; text = walker.nextNode()) {
    scanned++
    addText(text.parentElement, 'text', text.nodeValue)
  }
  for (const node of [...root.querySelectorAll('[aria-label], [aria-valuetext], [title], time[datetime]')].slice(0, 300)) {
    for (const name of ['aria-label', 'aria-valuetext', 'title']) addText(node, name, node.getAttribute(name))
    const datetime = node.getAttribute('datetime')
    if (texts.length < 90 && visible(node) && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(datetime ?? '')) {
      texts.push({ source: 'datetime', text: datetime, owner: address(node, root) })
    }
  }

  for (const node of [...root.querySelectorAll(`${semanticMeter}, [style*="%"]`)].slice(0, 250)) {
    if (!visible(node)) continue
    const width = node.style?.width ?? ''
    const inlineWidth = /^\d{1,3}(?:\.\d{1,4})?%$/.test(width) ? width : undefined
    const semantic = node.matches(semanticMeter)
    if (!semantic && !(inlineWidth && node.closest('[class*="progress"], [class*="usage"], [class*="quota"], [class*="meter"]'))) continue
    meters.push({ semantic, inlineWidth, owner: address(node, root),
      now: numericAttribute(node, 'aria-valuenow') ?? numericAttribute(node, 'value'),
      min: numericAttribute(node, 'aria-valuemin') ?? numericAttribute(node, 'min'),
      max: numericAttribute(node, 'aria-valuemax') ?? numericAttribute(node, 'max'),
      label: quotaText(node.getAttribute('aria-label')), valueText: quotaText(node.getAttribute('aria-valuetext')) })
    if (meters.length === 30) break
  }
  const language = document.documentElement.lang
  return { ready: document.readyState, signIn, authForm, language: /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(language) ? language : undefined,
    scope: main ? 'main' : 'body', texts, meters, bounded: scanned === 3500 || texts.length === 90 || meters.length === 30 }
}

const source = `(${inspectUsage.toString()})(${JSON.stringify(origin)}, ${JSON.stringify(usagePath.source)})`

async function run() {
  if (!/^persist:gemini(?:-[a-z0-9_-]{1,96})?$/i.test(partition)) throw new Error('invalid-partition')
  const profiles = ['Web2Term', 'gpt-web-to-codex-terminal', 'GPT Web to Codex Terminal']
    .map(name => path.join(app.getPath('appData'), name))
  const profile = process.env.PROBE_USER_DATA || profiles.find(root => fs.existsSync(path.join(root, 'conversations.db'))) || profiles.find(root => fs.existsSync(root))
  if (!profile) throw new Error('no-existing-gemini-partition')
  const partitionDir = path.join(profile, 'Partitions', partition.slice('persist:'.length))
  if (!fs.existsSync(partitionDir)) throw new Error('no-existing-gemini-partition')
  // Check the file handle without reading the database. On Windows another
  // Chromium process may deny access even if the storage directory exists.
  try {
    const fd = fs.openSync(path.join(partitionDir, 'Network', 'Cookies'), 'r')
    fs.closeSync(fd)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('session-store-unavailable')
  }
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  if (!app.requestSingleInstanceLock()) throw new Error('profile-in-use')

  await app.whenReady()
  const browserSession = session.fromPartition(partition)
  log('START', { partition: partition === 'persist:gemini' ? 'default' : 'override', electron: process.versions.electron })
  try {
    const cookies = await browserSession.cookies.get({ url: origin + '/usage' })
    log('SESSION-COOKIES', { count: cookies.length, auth: cookies.filter(cookie => authCookies.has(cookie.name))
      .map(cookie => ({ name: cookie.name, length: cookie.value.length })) })
  } catch { log('SESSION-COOKIES-UNAVAILABLE') }
  await browserSession.setProxy({ mode: 'fixed_servers', proxyRules: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' :
    process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
  browserSession.setUserAgent(`Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`)
  browserSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
  const win = new BrowserWindow({ width: 1260, height: 900, title: 'Gemini 额度探针',
    webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const contents = win.webContents
  const contentsId = contents.id
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('page-title-updated', event => event.preventDefault())

  let snapshots = 0, requests = 0, reading = false, readFailed = false, lastSignature = '', poll, stopAt = 0
  async function capture(reason) {
    if (reading || contents.isDestroyed() || route(contents.getURL()) !== 'usage') return
    const currentUrl = contents.getURL()
    reading = true
    let timer
    try {
      const snapshot = await Promise.race([contents.executeJavaScriptInIsolatedWorld(1001, [{ code: source }]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('read-timeout')), 2500) })])
      if (!snapshot || contents.isDestroyed() || contents.getURL() !== currentUrl) return
      readFailed = false
      const signature = JSON.stringify(snapshot)
      if (signature === lastSignature && reason !== 'F8') return
      if (!log('SNAPSHOT', { reason, sequence: snapshots + 1, ...snapshot })) return
      snapshots++
      lastSignature = signature
      win.setTitle(`Gemini 额度探针 · 快照 ${snapshots} · F8 重新采集`)
      if (reason === 'F8') console.log(`已写入快照 ${snapshots}`)
    } catch {
      if (!readFailed && !contents.isDestroyed()) log('READ-FAILED', { reason })
      readFailed = true
    } finally { clearTimeout(timer); reading = false }
  }

  // One observer, scoped to this window. Keep only statuses and bounded RPC names.
  browserSession.webRequest.onCompleted({ urls: [origin + '/*'] }, details => {
    if (requests >= 50 || details.webContentsId !== contentsId) return
    const url = new URL(details.url)
    const documentRequest = details.resourceType === 'mainFrame' && usagePath.test(url.pathname)
    const rpc = details.resourceType === 'xhr' && /^(?:\/_\/[a-z][a-z0-9]{0,60})?\/data\/batchexecute\/?$/i.test(url.pathname)
    if (!documentRequest && !(rpc && !contents.isDestroyed() && route(contents.getURL()) === 'usage')) return
    const rpcNames = rpc ? (url.searchParams.get('rpcids') ?? '').split(',').filter(id => /^[a-z0-9]{1,12}$/i.test(id)).slice(0, 12) : undefined
    if (log('REQUEST', { kind: documentRequest ? 'usage-document' : 'batchexecute', status: details.statusCode, rpcNames })) requests++
  })

  function onNavigation() {
    if (contents.isDestroyed()) return
    const kind = route(contents.getURL())
    log('PAGE', { route: kind })
    stopAt = kind === 'usage' ? Date.now() + 25_000 : 0
    lastSignature = ''
    if (kind === 'usage') void capture('navigation')
  }
  contents.on('dom-ready', onNavigation)
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) onNavigation() })
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) log('LOAD-FAILED', { code, route: route(url) })
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '诊断', submenu: [
    { label: '采集当前额度页面', accelerator: 'F8', click: () => { void capture('F8') } }
  ] }]))
  poll = setInterval(() => { if (Date.now() < stopAt) void capture('poll') }, 900)
  win.on('closed', () => {
    clearInterval(poll)
    browserSession.webRequest.onCompleted(null)
    log('FINAL', { snapshots, requests })
    console.log('日志已保存 ' + logFile)
  })
  console.log('日志 ' + logFile)
  console.log('等 Gemini 额度卡片显示后按 F8，然后关闭窗口。如果显示登录页或错误页，直接关闭即可。')
  await win.loadURL(origin + '/usage').catch(() => { /* Main-frame failure is logged by the listener. */ })
}

app.on('window-all-closed', () => app.quit())
void run().catch(error => {
  const messages = {
    'invalid-partition': 'PROBE_PARTITION 必须指定现有的 Gemini 分区。',
    'no-existing-gemini-partition': '未找到已存在的 Gemini 会话。可用 PROBE_USER_DATA 和 PROBE_PARTITION 指定现有目录和分区。',
    'session-store-unavailable': '无法读取 Gemini 会话存储。请从托盘退出 Web2Term，并关闭其他 Gemini 探针后重试。',
    'profile-in-use': 'Web2Term 会话目录正在使用。请从托盘退出 Web2Term，并关闭其他 Gemini 探针后重试。',
    'startup-failed': '额度探针启动失败。'
  }
  const reason = Object.hasOwn(messages, error?.message) ? error.message : 'startup-failed'
  log('FATAL', { reason })
  console.error(messages[reason])
  console.log('日志 ' + logFile)
  app.exit(1)
})
