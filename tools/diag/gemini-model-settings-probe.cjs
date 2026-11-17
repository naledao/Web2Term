/** User-run Gemini model menu discovery. Open and select options by hand; sending a message is unnecessary. */
const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ORIGIN = 'https://gemini.google.com'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/app?hl=zh-CN')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 Gemini 同源页面。')

// Match the application's existing profile order without loading its main process.
const profiles = ['Web2Term', 'gpt-web-to-codex-terminal', 'GPT Web to Codex Terminal'].map(name => path.join(app.getPath('appData'), name))
const profile = process.env.PROBE_USER_DATA || profiles.find(root => fs.existsSync(path.join(root, 'conversations.db'))) || profiles.find(root => fs.existsSync(root))
if (!profile || !fs.existsSync(profile)) throw new Error('未找到 Web2Term 登录目录。可用 PROBE_USER_DATA 指定现有目录。')
app.setPath('userData', profile)
app.setPath('sessionData', profile)

const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
const logFile = path.join(directory, `gemini-model-settings-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
fs.mkdirSync(directory, { recursive: true })
let bytes = 0, sequence = 0
function log(event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n'
  if (event === 'SNAPSHOT' && bytes >= 6 * 1024 * 1024) return
  fs.appendFileSync(logFile, line, 'utf8')
  bytes += Buffer.byteLength(line)
}

/** Self-contained DOM reader. Only approved labels and bounded structure leave the page. */
function inspectGeminiModelMenu() {
  if (location.origin !== 'https://gemini.google.com') return null
  const EDITOR = 'textarea, input, [contenteditable], [role="textbox"]'
  const EXCLUDED = 'user-query, model-response, message-content, thinking-overlay, nav, aside, [role="navigation"]'
  const CONTROL = 'button, [role="button"], [role="combobox"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"], [aria-haspopup]'
  const POPUP = '[role="menu"], [role="listbox"], [role="radiogroup"], .mat-mdc-menu-panel, .mat-menu-panel, [popover]:popover-open'
  // Current adapter selectors are copied here so a snapshot pinpoints which gate misses.
  const PICKER_ID = ':is([data-test-id="bard-mode-menu-button"], [data-testid="bard-mode-menu-button"])'
  const TRIGGER = ':is(button, [role="button"])' + PICKER_ID + ', ' + PICKER_ID + ' button[aria-haspopup]'
  const OPTION = 'button:is([data-test-id^="bard-mode-option-"], [data-testid^="bard-mode-option-"])'
  const LABEL = /^(?:快速解答|日常帮助|深度研究|代码与分析|高难任务|思考等级|思考强度|选择模型|切换模型|当前模型|低|中|高|深度适中|超级详尽|自动|新|升级|快速|思考|专业版|quick answer(?:s)?|everyday help|deep research|code and analysis|complex tasks|thinking level|thinking effort|select (?:a )?model|switch model|fast(?: and efficient)?|low|medium|high|balanced|auto|new|upgrade|check(?:_small)?|done|lock(?:_outline|_filled)?|arrow_(?:drop_(?:down|up)|right)|expand_(?:more|less)|chevron_(?:right|left)|keyboard_arrow_(?:up|down|right|left))$/i
  const MODEL = /^(?:(?:Gemini\s+)?(?:\d{1,2}(?:\.\d{1,2})?\s+)?(?:Flash(?:[- ]Lite)?|Hydrogen|Pro|Argon|Carbon|Ultra)|Gemini)(?:\s+(?:低|中|高|Low|Medium|High))?$/i
  const token = /^[a-z_][a-z0-9_-]{0,79}$/i
  const safeText = raw => {
    const text = raw.trim().replace(/\s+/g, ' ')
    if (!text) return null
    return LABEL.test(text) || MODEL.test(text) ? text : { chars: text.length }
  }
  const excluded = node => !!node.closest(EXCLUDED)
  const visible = node => !!node && !excluded(node) && node.getClientRects().length > 0 &&
    !node.closest('[hidden], [inert], [aria-hidden="true"]') && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const refs = globalThis.geminiModelProbeRefs ??= new Map()
  const ref = id => {
    if (!refs.has(id) && refs.size < 400) refs.set(id, 'ref-' + (refs.size + 1))
    return refs.get(id) ?? 'ref-limit'
  }
  const idValues = (node, name) => (node.getAttribute(name) ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5)

  function describe(node) {
    const attrs = {}
    if (node.id) attrs.id = ref(node.id)
    for (const name of ['aria-controls', 'aria-owns', 'aria-labelledby', 'aria-describedby', 'aria-activedescendant']) {
      const ids = idValues(node, name)
      if (ids.length) attrs[name] = ids.map(ref)
    }
    for (const name of ['role', 'type', 'aria-haspopup', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed',
      'aria-disabled', 'aria-hidden', 'aria-current', 'data-state', 'data-selected', 'data-locked', 'data-highlighted',
      'data-test-id', 'data-testid', 'fonticon', 'svgicon', 'data-icon', 'tabindex', 'disabled', 'contenteditable']) {
      const value = node.getAttribute(name)
      if (value !== null) attrs[name] = token.test(value) || /^-?\d{0,2}$/.test(value) ? value : { chars: value.length }
    }
    for (const name of ['aria-label', 'title', 'aria-roledescription']) {
      const value = node.getAttribute(name)
      if (value) attrs[name] = safeText(value)
    }
    const tag = node.localName
    // SVG paths can distinguish a checkmark from a lock when there is no icon name.
    const shape = tag === 'path' ? node.getAttribute('d') ?? '' : ''
    return { tag, attrs, classes: [...node.classList].filter(name => token.test(name)).slice(0, 14),
      dataNames: node.getAttributeNames().filter(name => name.startsWith('data-')).slice(0, 18),
      visible: visible(node), disabled: node.matches(':disabled'),
      ...(shape && shape.length <= 420 && /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/.test(shape) ? { shape } : {}) }
  }

  function tree(node, budget, depth = 0) {
    if (budget.left-- <= 0) return null
    if (node.nodeType === Node.TEXT_NODE) {
      const text = safeText(node.nodeValue)
      return text ? { text } : null
    }
    if (node.nodeType !== Node.ELEMENT_NODE || excluded(node) || node.matches(EDITOR + ', script, style, iframe, img, link, object, embed')) return null
    const result = describe(node)
    if (node.matches(OPTION)) result.matchesCurrentOption = true
    if (depth < 11) {
      const children = [...node.childNodes].slice(0, 65).map(child => tree(child, budget, depth + 1)).filter(Boolean)
      if (children.length) result.children = children
    }
    return result
  }
  function ancestors(node, limit) {
    const chain = []
    for (let parent = node.parentElement; parent && parent !== document.body && chain.length < limit; parent = parent.parentElement) {
      chain.push(describe(parent))
    }
    return chain
  }

  const composer = ['div.ql-editor[contenteditable="true"]', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]']
    .map(selector => [...document.querySelectorAll(selector)].find(visible)).find(Boolean)
  const scope = composer?.closest('input-area, fieldset.input-area-fieldset')
  // A tagged wrapper, a semantic toolbar control, and an ARIA-linked portal are independent evidence.
  const scopedControls = scope ? [...scope.querySelectorAll(CONTROL + ', ' + PICKER_ID)].filter(visible).slice(0, 24) : []
  const triggers = [...new Set([...document.querySelectorAll(PICKER_ID), ...scopedControls])].filter(visible).slice(0, 24)
  const popups = new Set([...document.querySelectorAll(POPUP)].filter(visible))
  function addLinkedPopup(trigger) {
    for (const name of ['aria-controls', 'aria-owns']) for (const id of idValues(trigger, name)) {
      const panel = document.getElementById(id)
      if (visible(panel) && !panel.matches(EDITOR) && !panel.querySelector(EDITOR + ', ' + EXCLUDED)) popups.add(panel)
    }
  }
  for (const trigger of triggers) addLinkedPopup(trigger)
  for (const popup of [...popups].slice(0, 12)) {
    for (const toggle of [...popup.querySelectorAll('[aria-controls], [aria-owns]')].filter(visible).slice(0, 25)) addLinkedPopup(toggle)
  }
  for (const pane of document.querySelectorAll('.cdk-overlay-pane')) {
    if (visible(pane) && ![...popups].some(popup => pane.contains(popup))) popups.add(pane)
  }
  const nativeTriggers = [...document.querySelectorAll(TRIGGER)].filter(node => visible(node) && scope?.contains(node))
  const route = /^\/app\/[0-9a-f]{16}\/?$/i.test(location.pathname) ? 'conversation' : /^\/app\/?$/.test(location.pathname) ? 'home' : 'other'
  const expanded = nativeTriggers[0]?.getAttribute('aria-expanded')
  return { route, viewport: { width: innerWidth, height: innerHeight },
    composer: composer ? { ...describe(composer), ancestors: ancestors(composer, 9) } : null,
    currentAdapter: { scopedTriggerCount: nativeTriggers.length, triggerExpanded: ['true', 'false'].includes(expanded) ? expanded === 'true' : null,
      optionCount: document.querySelectorAll(OPTION).length },
    triggers: triggers.map(node => ({ ancestors: ancestors(node, 3), tree: tree(node, { left: 65 }) })),
    popups: [...popups].slice(0, 12).map(node => {
      const options = [...node.querySelectorAll(OPTION)]
      return { ancestors: ancestors(node, 3), currentOptionCount: options.length, visibleCurrentOptionCount: options.filter(visible).length,
        visibleControlCount: [...node.querySelectorAll(CONTROL)].filter(visible).length, tree: tree(node, { left: 320 }) }
    }) }
}

const source = '(' + inspectGeminiModelMenu.toString() + ')()'
new vm.Script(source)

let win, poll, pending = false, signature = '', sawPopup = false, readFailed = false
async function capture(reason) {
  if (pending || !win || win.isDestroyed()) return
  const contents = win.webContents
  try { if (new URL(contents.getURL()).origin !== ORIGIN) return } catch { return }
  pending = true
  let timeout
  try {
    const snapshot = await Promise.race([contents.executeJavaScriptInIsolatedWorld(1001, [{ code: source }]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('snapshot-timeout')), 2500) })])
    if (!snapshot || win.isDestroyed()) return
    readFailed = false
    const next = JSON.stringify(snapshot)
    if (next === signature && reason !== 'F8') return
    signature = next
    sawPopup ||= snapshot.popups.length > 0
    log('SNAPSHOT', { sequence: ++sequence, reason, ...snapshot })
    win.setTitle(`Gemini 模型探针 · 快照 ${sequence} · 当前弹层 ${snapshot.popups.length}`)
  } catch {
    if (!readFailed && !win.isDestroyed()) log('READ-FAILED', { reason })
    readFailed = true
  } finally { clearTimeout(timeout); pending = false }
}

app.whenReady().then(async () => {
  const partition = process.env.PROBE_PARTITION || 'persist:gemini'
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  const ses = session.fromPartition(partition)
  await ses.setProxy({ proxyRules: proxy })
  const osToken = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' :
    process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
  ses.setUserAgent(`Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`)
  win = new BrowserWindow({ width: 1320, height: 940, title: 'Gemini 模型探针',
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  win.on('page-title-updated', event => event.preventDefault())
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '诊断', submenu: [
    { label: '采集当前状态', accelerator: 'F8', click: () => { void capture('F8') } }
  ] }]))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('did-finish-load', () => { void capture('loaded') })
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame) log('LOAD-FAILED', { code }) })
  win.on('closed', () => {
    clearInterval(poll)
    log('FINAL', { snapshots: sequence, sawPopup })
    console.log('日志已保存 ' + logFile)
  })
  log('START', { partition: partition === 'persist:gemini' ? partition : 'override', electron: process.versions.electron, chrome: process.versions.chrome })
  console.log('日志 ' + logFile)
  console.log('等输入区加载后，展开模型菜单并停留 2 秒，再展开「思考等级」并停留 2 秒。可按 F8 采集。')
  console.log('选一个未锁定的模型，等 2 秒后再切回原模型。无需发送消息。完成后关闭窗口。')
  poll = setInterval(() => { void capture('poll') }, 500)
  await win.loadURL(start.href)
}).catch(() => {
  log('FATAL', { reason: 'startup-or-navigation-failed' })
  console.log('日志 ' + logFile)
  app.quit()
})
app.on('window-all-closed', () => app.quit())
