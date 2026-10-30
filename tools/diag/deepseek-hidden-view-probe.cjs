/** User-run only. Standalone or opt-in observation of the application's existing view. */
const { app, BrowserWindow, WebContentsView, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ORIGIN = 'https://chat.deepseek.com'
const standalone = require.main === module
const start = new URL(standalone ? process.env.PROBE_START_URL || ORIGIN + '/' : ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password || start.search || start.hash) {
  throw new Error('PROBE_START_URL 必须是无查询参数的 https://chat.deepseek.com 同源页面。')
}
if (standalone) app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(directory, (standalone ? 'deepseek-hidden-view-' : 'deepseek-hidden-app-') + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const platformToken = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' :
  process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
const userAgent = 'Mozilla/5.0 (' + platformToken + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
let bytes = 0, logLimited = false
function log(event, data = {}) {
  if (logLimited) return
  let line = new Date().toISOString() + ' ' + JSON.stringify({ event, ...data }) + '\n'
  if (bytes + Buffer.byteLength(line) > 4 * 1024 * 1024) {
    line = new Date().toISOString() + ' {"event":"LOG-LIMIT","maxBytes":4194304}\n'
    logLimited = true
  }
  try { fs.appendFileSync(logPath, line, 'utf8'); bytes += Buffer.byteLength(line) }
  catch { logLimited = true; console.error('隐藏视图诊断日志写入失败，已停止记录。'); if (standalone) app.quit() }
}
const errorKind = error => ['Error', 'TypeError', 'RangeError'].includes(error?.name) ? error.name : 'unavailable'

// No layout reads, frame requests or observer registrations: capture the unperturbed
// application first, before installing the more intrusive rendering instruments.
function readBaselinePageSnapshot() {
  const count = selector => document.querySelectorAll(selector).length
  return { readyState: document.readyState, visibility: document.visibilityState,
    innerWidth, innerHeight, focused: document.hasFocus(),
    counts: { virtualRows: count('[data-virtual-list-item-key]'), assistantContents: count('.ds-assistant-message-main-content'),
      reasoningContents: count('.ds-think-content'), codeBlocks: count('pre'), textareas: count('textarea'),
      editable: count('[contenteditable="true"]'), alerts: count('[role="alert"]'), dialogs: count('[role="dialog"]') } }
}
const baselineSource = '(' + readBaselinePageSnapshot.toString() + ')()'
new vm.Script(baselineSource)

// A function serialized directly, rather than a nested template literal with double escapes.
function installPageObserver() {
  const key = '__web2termHiddenViewProbe'
  if (window[key]) return 'already-installed'
  const stats = { timerTicks: 0, animationFrames: 0, mutationBatches: 0, resizeCallbacks: 0,
    intersectionCallbacks: 0, visibilityChanges: 0, lastFrameAt: null, lastMutationAt: null,
    rootIntersecting: null, composerIntersecting: null, intersectionRootWidth: null, intersectionRootHeight: null }
  let framePending = false, composerTarget = null
  const observers = [], now = () => performance.now()
  const intersection = new IntersectionObserver(entries => {
    stats.intersectionCallbacks++
    for (const entry of entries) {
      if (entry.target === document.documentElement) stats.rootIntersecting = entry.isIntersecting
      if (entry.target === composerTarget) stats.composerIntersecting = entry.isIntersecting
      stats.intersectionRootWidth = entry.rootBounds?.width ?? null
      stats.intersectionRootHeight = entry.rootBounds?.height ?? null
    }
  })
  if (document.documentElement) intersection.observe(document.documentElement)
  observers.push(intersection)
  const resize = new ResizeObserver(() => { stats.resizeCallbacks++ })
  if (document.documentElement) resize.observe(document.documentElement)
  if (document.body) resize.observe(document.body)
  observers.push(resize)
  const mutations = new MutationObserver(() => { stats.mutationBatches++; stats.lastMutationAt = now() })
  if (document.documentElement) mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
  observers.push(mutations)
  const visibility = () => { stats.visibilityChanges++ }
  document.addEventListener('visibilitychange', visibility)
  const tick = () => {
    stats.timerTicks++
    if (!framePending) {
      framePending = true
      requestAnimationFrame(() => { framePending = false; stats.animationFrames++; stats.lastFrameAt = now() })
    }
    const composer = document.querySelector('textarea, [contenteditable="true"]')
    if (composer && composer !== composerTarget) {
      if (composerTarget) intersection.unobserve(composerTarget)
      composerTarget = composer
      intersection.observe(composer)
    }
  }
  const timer = setInterval(tick, 1000)
  tick()
  const size = node => node ? { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
    clientWidth: node.clientWidth, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight } : null
  window[key] = { snapshot() {
    const count = selector => document.querySelectorAll(selector).length
    return { readyState: document.readyState, visibility: document.visibilityState, focused: document.hasFocus(),
      innerWidth, innerHeight, visualWidth: window.visualViewport?.width ?? null, visualHeight: window.visualViewport?.height ?? null,
      document: size(document.documentElement), body: size(document.body), composer: size(composerTarget),
      topLevel: [...(document.body?.children || [])].slice(0, 4).map(size),
      containers: [['main', 'main'], ['virtual', '[class*="virtual"]'], ['scroll', '[class*="scroll"]']].flatMap(([kind, selector]) =>
        [...document.querySelectorAll(selector)].slice(0, 4).map(node => ({ kind, ...size(node) }))),
      counts: { virtualRows: count('[data-virtual-list-item-key]'), assistantContents: count('.ds-assistant-message-main-content'),
        reasoningContents: count('.ds-think-content'), codeBlocks: count('pre'), textareas: count('textarea'),
        editable: count('[contenteditable="true"]'), alerts: count('[role="alert"]'), dialogs: count('[role="dialog"]') },
      ...stats, framePending, lastFrameAgeMs: stats.lastFrameAt === null ? null : Math.round(now() - stats.lastFrameAt),
      lastMutationAgeMs: stats.lastMutationAt === null ? null : Math.round(now() - stats.lastMutationAt) }
  }, dispose() {
    clearInterval(timer)
    observers.forEach(observer => observer.disconnect())
    document.removeEventListener('visibilitychange', visibility)
    delete window[key]
  } }
  return 'installed'
}
const observerSource = '(' + installPageObserver.toString() + ')()'
const snapshotSource = 'window.__web2termHiddenViewProbe?.snapshot() ?? null'
new vm.Script(observerSource)
new vm.Script(snapshotSource)

// Explicit host-side whitelist: even a page replacing our observer cannot log text/URLs.
const number = value => Number.isFinite(value) && value >= 0 && value < 1e12 ? Math.round(value * 100) / 100 : null
const boolean = value => typeof value === 'boolean' ? value : null
const dimensions = value => value && typeof value === 'object' ? Object.fromEntries(
  ['width', 'height', 'clientWidth', 'clientHeight', 'scrollHeight'].map(key => [key, number(value[key])])) : null
function pageMetadata(raw) {
  if (!raw || typeof raw !== 'object') return null
  const result = { visibility: ['visible', 'hidden', 'prerender'].includes(raw.visibility) ? raw.visibility : 'unknown',
    readyState: ['loading', 'interactive', 'complete'].includes(raw.readyState) ? raw.readyState : 'unknown' }
  for (const key of ['innerWidth', 'innerHeight', 'visualWidth', 'visualHeight', 'timerTicks', 'animationFrames', 'mutationBatches',
    'resizeCallbacks', 'intersectionCallbacks', 'visibilityChanges', 'intersectionRootWidth', 'intersectionRootHeight',
    'lastFrameAgeMs', 'lastMutationAgeMs']) result[key] = number(raw[key])
  for (const key of ['focused', 'framePending', 'rootIntersecting', 'composerIntersecting']) result[key] = boolean(raw[key])
  for (const key of ['document', 'body', 'composer']) result[key] = dimensions(raw[key])
  result.topLevel = Array.isArray(raw.topLevel) ? raw.topLevel.slice(0, 4).map(dimensions) : []
  result.containers = Array.isArray(raw.containers) ? raw.containers.slice(0, 12).map(value => ({
    kind: ['main', 'virtual', 'scroll'].includes(value?.kind) ? value.kind : 'unknown', ...dimensions(value) })) : []
  result.counts = Object.fromEntries(['virtualRows', 'assistantContents', 'reasoningContents', 'codeBlocks', 'textareas',
    'editable', 'alerts', 'dialogs'].map(key => [key, number(raw.counts?.[key])]))
  return result
}

// This path never creates a window, changes visibility/bounds/proxy/profile, or installs
// the app interceptor. The application already owns the view; the user opts in via env.
const attachedViews = new WeakMap()
function attachExistingView(existingView, options) {
  const contents = existingView.webContents
  if (attachedViews.has(contents)) return attachedViews.get(contents)
  let activeUntil = 0, stopped = false, busy = false, installed = false, pending = null
  let documentSequence = 0, readSerial = 0, waitingSince = 0
  const viewId = contents.id
  const ownsPage = () => { try { return !contents.isDestroyed() && new URL(contents.getURL()).origin === ORIGIN } catch { return false } }
  const native = () => {
    try {
      const state = options.nativeState()
      let frameVisibility = 'unknown'
      try { const value = contents.mainFrame.visibilityState; if (['visible', 'hidden', 'prerender'].includes(value)) frameVisibility = value } catch {}
      return { viewId, documentSequence, ...state, backgroundThrottling: contents.getBackgroundThrottling(), frameVisibility }
    } catch { return { viewId, documentSequence, unavailable: true } }
  }
  const isActive = () => !stopped && Date.now() <= activeUntil && ownsPage()
  async function collect(reason) {
    if (!isActive()) return
    if (busy) { log('APP-SAMPLE', { reason, native: native(), pagePending: true }); return }
    busy = true
    const serial = ++readSerial, url = contents.getURL(), documentAtRead = documentSequence
    let timeout
    try {
      const instrument = installed || waitingSince !== 0 && Date.now() - waitingSince >= 10000
      const script = installed ? snapshotSource : instrument ? observerSource + ';' + snapshotSource : baselineSource
      const operation = contents.executeJavaScript(script)
      pending = operation
      void operation.finally(() => { if (pending === operation) { pending = null; busy = false } }).catch(() => {})
      const raw = await Promise.race([operation, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timeout')), 2500)
      })])
      if (stopped || contents.isDestroyed() || contents.getURL() !== url || documentSequence !== documentAtRead || serial !== readSerial) return
      installed = instrument && raw != null
      log('APP-SAMPLE', { reason, phase: instrument ? 'layout-observers' : 'baseline', native: native(), page: pageMetadata(raw) })
    } catch (error) { if (!stopped) log('APP-READ-FAILED', { reason, viewId, documentSequence, errorKind: errorKind(error) }) }
    finally { clearTimeout(timeout); if (!pending) busy = false }
  }
  const ready = () => { installed = false; waitingSince = 0; documentSequence++; if (isActive()) void collect('dom-ready') }
  const controller = {
    active(waiting) {
      activeUntil = Date.now() + 15000
      if (waiting === true && waitingSince === 0) waitingSince = Date.now()
      if (waiting === false) waitingSince = 0
    },
    note(reason) {
      if (!isActive()) return
      log('APP-NATIVE', { reason: ['hidden', 'shown', 'zero-slot'].includes(reason) ? reason : 'layout', native: native() })
      void collect('native-change')
    },
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      contents.removeListener('dom-ready', ready)
      contents.removeListener('destroyed', controller.stop)
      attachedViews.delete(contents)
      log('APP-DETACHED', { viewId })
      // A closing/navigating document owns its observers; no extra evaluation on teardown.
    }
  }
  const timer = setInterval(() => { if (isActive()) void collect('periodic') }, 1000)
  timer.unref?.()
  contents.on('dom-ready', ready)
  contents.once('destroyed', controller.stop)
  attachedViews.set(contents, controller)
  log('APP-ATTACHED', { viewId, electron: process.versions.electron, chrome: process.versions.chrome,
    applicationView: true, changesNativeView: false, automaticMessages: false })
  console.log('应用内隐藏视图诊断日志：' + logPath)
  return controller
}
module.exports = { attachExistingView }

let win, view, poll, shown = false, closing = false, allowClose = false, pageRead = null, lastKeepAlive = 0
const route = () => {
  try { const url = new URL(view.webContents.getURL()); return url.origin !== ORIGIN ? 'other-origin' :
    /^\/a\/chat\/s\//.test(url.pathname) ? 'conversation' : url.pathname === '/' ? 'home' : 'other-same-origin' }
  catch { return 'unavailable' }
}
function nativeMetadata() {
  if (!view || view.webContents.isDestroyed()) return { destroyed: true }
  const contents = view.webContents
  let frameVisibility = 'unavailable'
  try { frameVisibility = ['visible', 'hidden', 'prerender'].includes(contents.mainFrame.visibilityState) ? contents.mainFrame.visibilityState : 'unknown' } catch {}
  return { requestedVisible: shown, nativeVisible: view.getVisible(), actualBounds: view.getBounds(),
    windowVisible: win.isVisible(), minimized: win.isMinimized(), windowFocused: win.isFocused(),
    backgroundThrottling: contents.getBackgroundThrottling(), frameVisibility, route: route() }
}
function keepAlive(reason) {
  try { view.webContents.setBackgroundThrottling(false); lastKeepAlive = Date.now(); log('KEEP-ALIVE', { reason, ...nativeMetadata() }) }
  catch (error) { log('KEEP-ALIVE-FAILED', { reason, errorKind: errorKind(error) }) }
}
function layout(reason) {
  if (!view || view.webContents.isDestroyed() || win.isDestroyed()) return
  const [width, height] = win.getContentSize()
  const requestedBounds = { x: 0, y: 132, width: Math.max(1, width), height: Math.max(1, height - 132) }
  view.setBounds(requestedBounds)
  view.setVisible(shown)
  if (!shown) keepAlive('after-layout')
  log('NATIVE-STATE', { reason, requestedBounds, ...nativeMetadata() })
}
async function sample(reason) {
  if (!view || view.webContents.isDestroyed() || win.isDestroyed()) return
  const native = nativeMetadata(), contents = view.webContents
  if (pageRead || route() === 'other-origin') { log('SAMPLE', { reason, native, pagePending: !!pageRead }); return }
  const url = contents.getURL()
  let timeout
  const pending = contents.executeJavaScript(snapshotSource)
  pageRead = pending
  // A timed-out read stays in flight until it settles; never queue a read every tick.
  void pending.finally(() => { if (pageRead === pending) pageRead = null }).catch(() => {})
  try {
    const raw = await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 2500) })])
    if (contents.isDestroyed() || contents.getURL() !== url || closing && reason !== 'closing') return
    log('SAMPLE', { reason, native, page: pageMetadata(raw) })
  } catch (error) { log('PAGE-READ-FAILED', { reason, native, errorKind: errorKind(error) }) }
  finally { clearTimeout(timeout) }
}

const panel = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DeepSeek 隐藏视图诊断</title>' +
  '<style>body{margin:0;background:#f5f7fb;color:#25314a;font:15px/1.7 system-ui}header{height:132px;box-sizing:border-box;padding:12px 24px;background:white;border-bottom:1px solid #dce2ed}h1{margin:0;font-size:19px}p{margin:4px 0}main{padding:38px 24px;color:#526079}</style>' +
  '<header><h1>DeepSeek 隐藏视图诊断 · 初始为隐藏</h1><p>Ctrl+1 显示网页　Ctrl+2 隐藏网页　Ctrl+3 再次保活　Ctrl+Q 结束</p>' +
  '<p>隐藏状态先等待约 15 秒，再显示；随后可发送一次普通消息并立即隐藏。日志自动记录，不连接终端。</p></header>' +
  '<main>当前原网页隐藏。请使用顶部“视图试验”菜单或快捷键操作。<br>隐藏时每 5 秒保活；不会自动发消息。关闭窗口结束并保留日志。</main></html>'

if (standalone) {
console.log('诊断日志：' + logPath)
app.whenReady().then(async () => {
  log('START', { electron: process.versions.electron, chrome: process.versions.chrome,
    initialMode: 'hidden', startKind: start.pathname === '/' ? 'home' : 'conversation-or-page',
    metadataOnly: true, appInterceptor: false, terminal: false, automaticMessages: false })
  const ses = session.fromPartition('persist:deepseek')
  ses.setUserAgent(userAgent)
  // Exactly one header listener, only identity; no request/cookie/body logging.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }, major = process.versions.chrome.split('.')[0]
    for (const name of Object.keys(headers)) if (/^user-agent$|^sec-ch-ua(?:-full-version-list)?$/i.test(name)) delete headers[name]
    headers['User-Agent'] = userAgent
    headers['sec-ch-ua'] = '"Google Chrome";v="' + major + '", "Chromium";v="' + major + '", "Not(A:Brand";v="24"'
    headers['sec-ch-ua-full-version-list'] = '"Google Chrome";v="' + process.versions.chrome + '", "Chromium";v="' + process.versions.chrome + '", "Not(A:Brand";v="24.0.0.0"'
    callback({ requestHeaders: headers })
  })
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  await ses.setProxy(proxy === 'direct' ? { mode: 'direct' } : { mode: 'fixed_servers', proxyRules: proxy })
  log('PROXY', { mode: proxy === 'direct' ? 'direct' : 'probe-proxy' })
  win = new BrowserWindow({ width: 1320, height: 930, minWidth: 760, minHeight: 500, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  view = new WebContentsView({ webPreferences: { partition: 'persist:deepseek', sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false } })
  win.contentView.addChildView(view)
  const contents = view.webContents
  contents.setUserAgent(userAgent)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  contents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== ORIGIN) event.preventDefault() } catch { event.preventDefault() } })
  const change = visible => { shown = visible; layout(visible ? 'user-show' : 'user-hide'); void sample('user-view-change') }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '视图试验', submenu: [
      { label: '显示原网页', accelerator: 'CmdOrCtrl+1', click: () => change(true) },
      { label: '隐藏原网页', accelerator: 'CmdOrCtrl+2', click: () => change(false) },
      { label: '再次调用保活', accelerator: 'CmdOrCtrl+3', click: () => { keepAlive('user-reapply'); void sample('user-reapply') } },
      { type: 'separator' }, { label: '结束诊断', accelerator: 'CmdOrCtrl+Q', click: () => win.close() }
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]))
  contents.on('dom-ready', () => {
    keepAlive('dom-ready')
    if (route() === 'other-origin') return
    void contents.executeJavaScript(observerSource).then(status => {
      log('OBSERVER', { installed: status === 'installed' || status === 'already-installed', ...nativeMetadata() })
      void sample('observer-ready')
    }).catch(error => log('OBSERVER-FAILED', { errorKind: errorKind(error) }))
  })
  contents.on('did-finish-load', () => { keepAlive('did-finish-load'); void sample('did-finish-load') })
  contents.on('did-navigate-in-page', () => { keepAlive('in-page-navigation'); void sample('in-page-navigation') })
  contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (code !== -3) log('LOAD-FAILED', { code, mainFrame: !!mainFrame }) })
  contents.on('render-process-gone', (_event, details) => log('RENDERER-GONE', { exitCode: number(details.exitCode) }))
  win.on('resize', () => layout('window-resize'))
  for (const event of ['minimize', 'restore', 'show', 'hide']) win.on(event, () => { log('WINDOW', { kind: event }); void sample('window-' + event) })
  win.on('close', event => {
    if (allowClose) return
    event.preventDefault()
    if (closing) return
    closing = true
    clearInterval(poll)
    void Promise.race([sample('closing'), new Promise(resolve => setTimeout(resolve, 700))]).finally(() => {
      log('DONE', { logLimited, bytes })
      console.log('诊断结束，日志：' + logPath)
      allowClose = true
      if (!contents.isDestroyed()) contents.close()
      win.close()
    })
  })
  layout('initial-hidden')
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(panel))
  win.show()
  poll = setInterval(() => {
    if (closing || contents.isDestroyed()) return
    if (!shown && Date.now() - lastKeepAlive >= 5000) keepAlive('hidden-five-second-fallback')
    void sample('periodic')
  }, 1000)
  await contents.loadURL(start.href).catch(error => log('PAGE-LOAD-REJECTED', { errorKind: errorKind(error) }))
}).catch(error => { log('FATAL', { errorKind: errorKind(error) }); app.quit() })
app.on('window-all-closed', () => app.quit())
}
