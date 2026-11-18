/** User-run, passive discovery of Claude model & thinking/effort controls on claude.ai. Never clicks or sends. */
const { app, BrowserWindow, Menu, dialog, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')

const ORIGIN = 'https://claude.ai'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/new')
if (start.origin !== ORIGIN || start.username || start.password) {
  throw new Error('PROBE_START_URL 必须是 https://claude.ai 同源页面。')
}

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

// Match the application's existing profile order without importing or starting the app.
const profiles = ['Web2Term', 'gpt-web-to-codex-terminal', 'GPT Web to Codex Terminal']
  .map(name => path.join(app.getPath('appData'), name))
const userData = process.env.PROBE_USER_DATA ||
  profiles.find(root => fs.existsSync(path.join(root, 'conversations.db'))) ||
  profiles.find(root => fs.existsSync(root)) ||
  profiles[0]
app.setPath('userData', userData)
app.setPath('sessionData', userData)

const directory = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(
  directory,
  'claude-model-settings-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log'
)

const config = {
  key: '__claudeSettingsProbe_' + randomUUID().replace(/-/g, ''),
  tag: '[claude-settings-' + randomUUID() + '] '
}
let win, timer, capturing = false, closing = false, signature = '', sequence = 0, bytes = 0, clicks = 0
const scheduled = new Set(), models = new Set(), efforts = new Set()

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
  if (bytes > 6 * 1024 * 1024 && !['FINAL', 'FATAL'].includes(event)) return
  fs.appendFileSync(logPath, line, 'utf8')
  bytes += Buffer.byteLength(line)
  if (event !== 'SNAPSHOT') console.log(line.trimEnd())
}

const chromeVersion = String(process.versions.chrome)
const majorVersion = chromeVersion.split('.')[0]
const CHROME_BRANDS = `"Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not(A:Brand";v="24"`
const CHROME_FULL_VERSION_LIST = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not(A:Brand";v="24.0.0.0"`

function chromeLikeUserAgent() {
  const platformToken = process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])
const FIREFOX_VERSION = '140.0'
function googleAuthUserAgent() {
  const platformToken = process.platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10.15'
      : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platformToken}; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`
}

let notedIdentity = false
function installChromeIdentity(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    let touched = false
    let googleAuth = false
    let host = ''
    try {
      host = new URL(details.url).hostname.toLowerCase()
      googleAuth = GOOGLE_AUTH_HOSTS.has(host)
    } catch { /* ignore */ }

    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (googleAuth) {
        if (lower.startsWith('sec-ch-ua')) {
          delete headers[name]
          touched = true
        } else if (lower === 'user-agent') {
          headers[name] = googleAuthUserAgent()
          touched = true
        }
        continue
      }
      if (lower === 'sec-ch-ua') {
        headers[name] = CHROME_BRANDS
        touched = true
      } else if (lower === 'sec-ch-ua-full-version-list') {
        headers[name] = CHROME_FULL_VERSION_LIST
        touched = true
      } else if (lower === 'sec-ch-ua-full-version') {
        headers[name] = `"${chromeVersion}"`
        touched = true
      } else if (lower === 'user-agent') {
        headers[name] = chromeLikeUserAgent()
        touched = true
      }
    }

    if (!notedIdentity && touched && /(^|\.)(claude\.ai|anthropic\.com)$/.test(host)) {
      notedIdentity = true
      const beforeKey = Object.keys(details.requestHeaders || {}).find(k => k.toLowerCase() === 'sec-ch-ua')
      log('IDENTITY-PATCH', {
        host,
        secChUaBefore: beforeKey ? details.requestHeaders[beforeKey] : '(absent)',
        secChUaAfter: CHROME_BRANDS
      })
    }
    callback({ requestHeaders: headers })
  })
}

/** Self-contained DOM reader executed in isolated world 1001. Never reads editor values, message bodies, storage or network. */
function inspectClaudeModelSettings(config) {
  if (location.origin !== 'https://claude.ai') return null
  const CONTROL = [
    'button',
    '[role="button"]',
    '[role="combobox"]',
    '[role="switch"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="slider"]',
    '[role="tab"]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    '[aria-haspopup]',
    '[data-testid*="model"]',
    '[data-testid*="think"]',
    '[data-testid*="effort"]'
  ].join(', ')
  const EXCLUDED = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    '[class*="font-claude-response"]',
    '[data-testid="transcript-row"]',
    '[class~="group/message-row"]',
    'nav',
    'aside',
    '[role="navigation"]'
  ].join(', ')
  const EDITOR = 'textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"], [role="textbox"]'
  const COMPOSER = 'div[contenteditable="true"][data-testid="chat-input"], div.ProseMirror[contenteditable="true"], div[contenteditable="true"]'
  const POPUP = '[role="menu"], [role="listbox"], [role="radiogroup"], [role="dialog"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [data-floating-ui-portal], [popover]:popover-open'
  const MODEL = /^(?:Claude(?:\s+\d+(?:\.\d+)*)?\s+)?(?:Opus|Sonnet|Haiku)(?:\s+\d+(?:\.\d+)*)?(?:\s+[A-Za-z0-9.()/_·-]{1,24}){0,4}$/i
  const EFFORT = /^(?:Extended(?:\s+thinking)?|Thinking(?:\s+(?:mode|effort|budget|longer))?|Think(?:\s+longer)?|Effort|Reasoning\s+effort|Low|Medium|High|Max|Extreme|Auto|Standard|On|Off|Enabled|Disabled|Fast(?:\s+mode)?|Slow|扩展思考|延长思考|深度思考|思考(?:模式|强度|预算)?|推理(?:强度|深度)|低|中|高|极高|最高|最大|自动|标准|开启|关闭|已开启|已关闭|快速)$/i
  const OTHER = /^(?:Claude|Model|Models|Select\s+(?:a\s+)?model|Switch\s+model|Choose\s+model|More\s+models|Legacy\s+models|Other\s+models|All\s+models|1M(?:\s+context)?|200K(?:\s+context)?|Beta|New|Pro|Current|Selected|Upgrade|Learn\s+more|Use\s+style|Style|Styles|Normal|Concise|Explanatory|Formal|模型|选择模型|切换模型|当前模型|更多模型|其他模型|旧版模型|全部模型|已选中|当前|升级|风格|使用风格|常规|简洁|详细|正式|新)$/i

  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const safeText = value => {
    const text = collapse(value)
    if (!text || text.length > 100) return null
    return MODEL.test(text) || EFFORT.test(text) || OTHER.test(text) ? text : null
  }
  const textOf = node => !node || node.matches(EDITOR) || node.closest(EXCLUDED) || node.querySelector(EDITOR + ', ' + EXCLUDED)
    ? '' : collapse(node.textContent)
  const visible = node => !!node && node.getClientRects().length > 0 &&
    !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
    !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const excluded = node => !!node.closest(EXCLUDED)

  let state = globalThis[config.key]
  if (!state) {
    state = { ids: new Map(), lastTrail: [], observer: null, notice: null }
    globalThis[config.key] = state
  }
  const ref = value => {
    if (!value) return null
    if (!state.ids.has(value) && state.ids.size < 400) state.ids.set(value, 'ref-' + (state.ids.size + 1))
    return state.ids.get(value) ?? 'ref-limit'
  }
  const attrs = node => {
    const result = {}
    for (const name of [
      'role', 'type', 'aria-haspopup', 'aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected',
      'aria-disabled', 'aria-hidden', 'aria-current', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow',
      'data-state', 'data-selected', 'data-highlighted', 'data-disabled', 'data-locked', 'data-orientation',
      'data-side', 'data-align', 'tabindex', 'disabled'
    ]) {
      const value = node.getAttribute(name)
      if (value !== null) result[name] = /^[\w .:-]{0,100}$/.test(value) ? value : { chars: value.length }
    }
    if (node.tagName === 'INPUT' && (node.type === 'checkbox' || node.type === 'radio')) {
      result.checked = !!node.checked
    }
    for (const name of ['aria-label', 'aria-valuetext', 'title', 'data-tooltip-content']) {
      const value = node.getAttribute(name)
      if (value !== null) result[name] = safeText(value) || { chars: value.length }
    }
    for (const name of ['aria-controls', 'aria-owns', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']) {
      const value = node.getAttribute(name)
      if (value) {
        result[name] = value.split(/\s+/).filter(Boolean).slice(0, 6).map(id => ({
          ref: ref(id),
          label: safeText(textOf(document.getElementById(id)))
        }))
      }
    }
    const id = node.getAttribute('id')
    if (id) result.id = ref(id)
    for (const attrName of ['data-testid', 'data-test-id']) {
      const testId = node.getAttribute(attrName)
      if (testId !== null) result[attrName] = /^[a-z][a-z0-9_.:-]{0,79}$/i.test(testId) ? testId : { chars: testId.length }
    }
    result.dataNames = [...node.attributes].map(attr => attr.name).filter(name => name.startsWith('data-')).slice(0, 30)
    return result
  }
  const describe = node => {
    const css = getComputedStyle(node)
    const text = textOf(node)
    return {
      tag: node.tagName.toLowerCase(),
      attrs: attrs(node),
      classes: typeof node.className === 'string' ? node.className.slice(0, 500) : '',
      label: safeText(text),
      textChars: text.length,
      visible: visible(node),
      disabled: 'disabled' in node ? !!node.disabled : null,
      style: {
        color: css.color,
        backgroundColor: css.backgroundColor,
        fontWeight: css.fontWeight,
        display: css.display,
        pointerEvents: css.pointerEvents
      }
    }
  }
  const structure = (node, budget, depth = 0) => {
    if (budget.left-- <= 0) return null
    if (node.nodeType === 3) {
      const text = collapse(node.nodeValue)
      return text ? { text: safeText(text), textChars: text.length } : null
    }
    if (node.nodeType !== 1 || excluded(node) || /^(script|style|noscript|iframe|object|embed|link|meta|img)$/i.test(node.tagName)) {
      return null
    }
    const result = describe(node)
    if (node.matches(EDITOR)) return { ...result, editorOmitted: true }
    if (node.tagName.toLowerCase() === 'path') {
      return { ...result, d: String(node.getAttribute('d') || '').slice(0, 800) }
    }
    if (node.tagName.toLowerCase() === 'use') return { ...result, iconReferenceOmitted: true }
    if (depth >= 10) return { ...result, depthLimit: true }
    result.children = [...node.childNodes].slice(0, 60).map(child => structure(child, budget, depth + 1)).filter(Boolean)
    return result
  }
  const ancestors = (node, limit) => {
    const chain = []
    for (let parent = node?.parentElement; parent && parent !== document.body && chain.length < limit; parent = parent.parentElement) {
      chain.push(describe(parent))
    }
    return chain
  }

  const allControls = [...document.querySelectorAll(CONTROL)].filter(node => visible(node) && !excluded(node))
  const composer = [...document.querySelectorAll(COMPOSER)].find(node => visible(node) && !excluded(node))
  const named = node => safeText(node.getAttribute('aria-label')) || safeText(node.getAttribute('title')) || safeText(textOf(node))
  const interesting = node => !!named(node) || node.hasAttribute('aria-haspopup') || node.hasAttribute('data-testid') ||
    node.getAttribute('role') === 'switch' || (node.tagName === 'INPUT' && node.type === 'checkbox')

  const scopes = []
  for (let node = composer?.parentElement, depth = 0; node && node !== document.body && depth < 7; node = node.parentElement, depth++) {
    scopes.push({
      depth,
      root: describe(node),
      controls: allControls.filter(control => node.contains(control)).slice(0, 35).map(describe)
    })
    if (node.tagName.toLowerCase() === 'main') break
  }

  const composerScopeRoot = (() => {
    let cur = composer?.parentElement
    for (let depth = 0; cur && cur.parentElement && cur.parentElement !== document.body && depth < 6; depth++) {
      const parent = cur.parentElement
      if (parent.tagName.toLowerCase() === 'main' || parent.querySelector(EXCLUDED)) break
      cur = parent
    }
    return cur || null
  })()
  const triggers = (composerScopeRoot
    ? allControls.filter(control => composerScopeRoot.contains(control))
    : allControls.filter(interesting)
  ).slice(0, 32)

  const popupSet = new Set([...document.querySelectorAll(POPUP)].filter(node => visible(node) && !excluded(node) && !node.querySelector(EDITOR)))
  const addLinked = node => {
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (node.getAttribute(attr) || '').split(/\s+/)) {
        const linked = id && document.getElementById(id)
        if (linked && visible(linked) && !excluded(linked) && !linked.matches(EDITOR) && !linked.querySelector(EDITOR)) {
          popupSet.add(linked)
        }
      }
    }
  }
  for (const trigger of allControls.filter(interesting).slice(0, 40)) addLinked(trigger)
  for (const popup of [...popupSet].slice(0, 16)) {
    for (const nested of [...popup.querySelectorAll('[aria-controls], [aria-owns]')].filter(visible).slice(0, 30)) {
      addLinked(nested)
    }
  }
  // Catch custom floating popovers mounted directly under body even without role/radix attributes.
  for (const child of document.body?.children || []) {
    if (!visible(child) || excluded(child) || child.matches(EDITOR) || child.querySelector(EDITOR + ', ' + EXCLUDED)) continue
    if (popupSet.has(child) || [...popupSet].some(popup => child.contains(popup) || popup.contains(child))) continue
    const css = getComputedStyle(child)
    if ((css.position === 'fixed' || css.position === 'absolute') && child.querySelectorAll(CONTROL).length >= 2) {
      popupSet.add(child)
    }
  }

  // Keep outermost popup roots when a wrapper contains a nested popup element already captured.
  const popupRoots = [...popupSet].filter(node => ![...popupSet].some(other => other !== node && other.contains(node)))
  const popups = popupRoots.slice(0, 12).map(node => ({
    ancestors: ancestors(node, 3),
    root: describe(node),
    controls: allControls.filter(control => node.contains(control)).slice(0, 50).map(control => structure(control, { left: 100 })),
    tree: structure(node, { left: 260 })
  }))

  const choiceNodes = [
    ...triggers,
    ...popupRoots.flatMap(node => [...node.querySelectorAll(CONTROL + ', span, label, div')])
  ]
  const choices = [...new Set(
    choiceNodes
      .filter(child => visible(child) && !excluded(child))
      .map(child => safeText(textOf(child)) || safeText(child.getAttribute('aria-label')))
      .filter(Boolean)
  )].slice(0, 60)

  if (!state.observer) {
    const notify = () => {
      if (state.notice) return
      state.notice = setTimeout(() => {
        state.notice = null
        console.log(config.tag + JSON.stringify({ type: 'changed' }))
      }, 120)
    }
    state.observer = new MutationObserver(notify)
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-disabled', 'data-state', 'data-selected', 'checked', 'disabled']
    })
    document.addEventListener('click', event => {
      if (!event.isTrusted) return
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      if (!target || excluded(target)) return
      const control = target.closest(CONTROL)
      if (!control) return
      const trail = ancestors(control, 5)
      state.lastTrail = trail
      console.log(config.tag + JSON.stringify({
        type: 'control-click',
        trusted: true,
        control: structure(control, { left: 110 }),
        trail
      }))
      notify()
    }, true)
    for (const eventType of ['change', 'input']) {
      document.addEventListener(eventType, event => {
        if (!event.isTrusted) return
        const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
        if (!target || excluded(target) || target.matches(EDITOR)) return
        const control = target.closest('input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], [role="slider"]')
        if (!control) return
        console.log(config.tag + JSON.stringify({
          type: 'control-change',
          trusted: true,
          eventType,
          control: structure(control, { left: 110 })
        }))
        notify()
      }, true)
    }
  }

  const route = /^\/chat\/[^/?#]+/i.test(location.pathname)
    ? 'conversation'
    : /^\/(?:new|)\/?$/i.test(location.pathname)
      ? 'home'
      : /^\/login/i.test(location.pathname)
        ? 'login'
        : 'other'

  return {
    route,
    viewport: { width: innerWidth, height: innerHeight },
    ready: !!composer,
    triggers: triggers.map(node => ({ ancestors: ancestors(node, 3), tree: structure(node, { left: 110 }) })),
    scopes,
    popups,
    choices,
    modelChoices: choices.filter(text => MODEL.test(text)),
    effortChoices: choices.filter(text => EFFORT.test(text)),
    lastClickTrail: state.lastTrail
  }
}

const source = '(' + inspectClaudeModelSettings.toString() + ')(' + JSON.stringify(config) + ')'
new vm.Script(source)

async function capture(reason) {
  if (capturing || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    if (new URL(win.webContents.getURL()).origin !== ORIGIN) return
  } catch { return }
  capturing = true
  let timeout
  try {
    const data = await Promise.race([
      win.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: source }]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('snapshot-timeout')), 3000) })
    ])
    if (!data || win.isDestroyed()) return
    for (const value of data.modelChoices || []) models.add(value)
    for (const value of data.effortChoices || []) efforts.add(value)
    win.setTitle(
      'Claude 模型/思考探针 — 已采集模型 ' + models.size + ' 项 · 思考/强度 ' + efforts.size + ' 项 · 点击 ' + clicks + ' 次'
    )
    const current = JSON.stringify(data)
    if (current !== signature || reason === 'manual' || reason === 'final') {
      signature = current
      log('SNAPSHOT', { sequence: ++sequence, reason, ...data })
    }
  } catch {
    log('READ-FAILED', { reason })
  } finally {
    clearTimeout(timeout)
    capturing = false
  }
}

function schedule(reason, delay) {
  if (closing || scheduled.size >= 6) return
  const id = setTimeout(() => {
    scheduled.delete(id)
    if (!closing) void capture(reason)
  }, delay)
  scheduled.add(id)
}

const instructions = '无需发送消息，也不用手动打点。\n' +
  '1. 等页面和输入框加载就绪。\n' +
  '2. 展开原生模型菜单，停留 2 秒；如果有「More models / 更多模型」或子菜单，也悬停/点开停留 2 秒。\n' +
  '3. 手动切换另一个模型，等待 2 秒，再切回原模型。\n' +
  '4. 如果有「Extended thinking / 扩展思考 / 思考强度 / Effort」开关或菜单，切换/展开一次，停留 2 秒后再恢复。\n' +
  '标题会显示已采集的模型与思考选项数；按 F8 可额外手动采集一次当前状态。\n' +
  '完成后直接关闭窗口，把终端打印的日志路径发给智能体。\n\n日志：' + logPath

app.whenReady().then(async () => {
  const partition = process.env.PROBE_PARTITION || 'persist:claude'
  const proxy = process.env.PROBE_PROXY ?? 'http://127.0.0.1:7897'
  const ses = session.fromPartition(partition)
  await ses.setProxy(proxy ? { proxyRules: proxy } : { mode: 'direct' })
  ses.setUserAgent(chromeLikeUserAgent())
  installChromeIdentity(ses)

  win = new BrowserWindow({
    width: 1380,
    height: 940,
    title: 'Claude 模型/思考探针 — 请展开模型菜单与思考开关',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true }
  })
  win.on('page-title-updated', event => event.preventDefault())
  const menu = Menu.buildFromTemplate([
    { label: '采集当前状态', accelerator: 'F8', click: () => { void capture('manual') } },
    { label: '操作说明', click: () => { void dialog.showMessageBox(win, { type: 'info', title: 'Claude 模型与思考设置采集', message: instructions }) } }
  ])
  Menu.setApplicationMenu(menu)
  win.setMenu(menu)
  win.setMenuBarVisibility(true)

  win.webContents.on('console-message', (event, _level, legacyMessage) => {
    const message = typeof legacyMessage === 'string' ? legacyMessage : event.message
    if (typeof message !== 'string' || !message.startsWith(config.tag) || message.length > 80000) return
    try {
      const data = JSON.parse(message.slice(config.tag.length))
      if (data.type === 'control-click' && data.trusted === true) {
        clicks++
        log('CONTROL-CLICK', data)
        schedule('after-click', 60)
        schedule('after-click-settled', 450)
      } else if (data.type === 'control-change' && data.trusted === true) {
        log('CONTROL-CHANGE', data)
        schedule('after-change', 60)
        schedule('after-change-settled', 450)
      } else if (data.type === 'changed') {
        schedule('dom-change', 40)
      }
    } catch { /* No other page console output is recorded. */ }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('did-finish-load', () => { void capture('loaded') })
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame) log('LOAD-FAILED', { code })
  })
  win.on('close', event => {
    if (closing) return
    event.preventDefault()
    closing = true
    clearInterval(timer)
    for (const id of scheduled) clearTimeout(id)
    scheduled.clear()
    void (async () => {
      while (capturing) await new Promise(resolve => setTimeout(resolve, 50))
      await capture('final')
    })().finally(() => {
      log('FINAL', {
        snapshots: sequence,
        clicks,
        modelChoices: [...models],
        effortChoices: [...efforts],
        modelMenuSeen: models.size > 0,
        effortMenuSeen: efforts.size > 0,
        notes: 'Coverage only. Read native state/selection differences before implementing switching.'
      })
      console.log('日志已保存：' + logPath)
      win.destroy()
      app.quit()
    })
  })

  log('START', {
    origin: ORIGIN,
    proxyConfigured: !!proxy,
    partition: partition === 'persist:claude' ? partition : 'override',
    profile: process.env.PROBE_USER_DATA ? 'override' : path.basename(userData),
    electron: process.versions.electron,
    chrome: chromeVersion,
    notes: 'Passive DOM metadata in isolated world. No messages, editor values, cookies, storage, network capture, automatic clicks or app imports.'
  })
  console.log(instructions)
  timer = setInterval(() => {
    if (!closing) void capture('poll')
  }, 600)
  await win.loadURL(start.href)
}).catch(() => {
  log('FATAL', { reason: 'startup-failed' })
  console.log('日志已保存：' + logPath)
  app.quit()
})

app.on('window-all-closed', () => app.quit())
