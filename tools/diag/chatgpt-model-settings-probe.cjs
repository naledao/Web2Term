/** User-run, passive discovery of ChatGPT model / thinking-effort menus. Never clicks or sends. */
const { app, BrowserWindow, Menu, dialog, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')

const ORIGIN = 'https://chatgpt.com'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 https://chatgpt.com 同源页面。')
// Mirror the application's profile discovery without importing or starting the app.
const profiles = ['Web2Term', 'gpt-web-to-codex-terminal', 'GPT Web to Codex Terminal'].map(name => path.join(app.getPath('appData'), name))
const userData = process.env.PROBE_USER_DATA || profiles.find(root => fs.existsSync(path.join(root, 'conversations.db'))) || profiles.find(root => fs.existsSync(root)) || profiles[0]
app.setPath('userData', userData)
app.setPath('sessionData', userData)
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(directory, 'chatgpt-model-settings-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
const config = { key: '__chatgptSettingsProbe_' + randomUUID().replace(/-/g, ''), tag: '[chatgpt-settings-' + randomUUID() + '] ' }
let win, timer, capturing = false, closing = false, signature = '', sequence = 0, bytes = 0, clicks = 0
const scheduled = new Set(), models = new Set(), efforts = new Set()

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
  if (bytes > 6 * 1024 * 1024 && !['FINAL', 'FATAL'].includes(event)) return
  fs.appendFileSync(logPath, line, 'utf8'); bytes += Buffer.byteLength(line)
  if (event !== 'SNAPSHOT') console.log(line.trimEnd())
}

/** Self-contained DOM reader. Never read editor values, message bodies, storage or network. */
function inspectModelSettings(config) {
  const CONTROL = 'button, [role="button"], [role="combobox"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"], [role="tab"]'
  const MESSAGE = '[data-turn-key], [data-content-search-turn-key], [data-content-search-unit-key], [data-chatgpt-selection-message-id], [data-markdown-text-style], [data-message-author-role], [class~="group/user-message"]'
  const EDITOR = 'textarea, input, [contenteditable="true"], [role="textbox"]'
  const COMPOSER = 'div[contenteditable="true"][data-composer-markdown], div[contenteditable="true"][role="textbox"], textarea#pending-home-input, #prompt-textarea'
  const POPUP = '[role="menu"], [role="listbox"], [role="radiogroup"], [data-radix-menu-content], [data-radix-popper-content-wrapper], [popover]:popover-open'
  const MODEL = /^GPT[- ]?\d[A-Za-z0-9. ():+/_-]{0,76}(?:\s*(?:低|中|高|标准|扩展|自动))?$/i
  const EFFORT = /^(?:minimal|low|medium|high|xhigh|max|ultra|standard|extended|heavy|light|低|中|高|极高|标准|扩展|轻量|深度|较长|更长|快速)$/i
  const OTHER = /^(?:ChatGPT|Auto|Instant|Thinking|Pro|自动|思考|专业|旧版模型|更多模型|其他模型|Legacy models|More models|Other models|选择\s*ChatGPT\s*模型|Select\s*ChatGPT\s*model|当前模型|模型|Model|思考强度|推理强度|思考时间|Thinking effort|Reasoning effort|Thinking time)$/i
  const collapse = value => String(value || '').replace(/\s+/g, ' ').trim()
  const safeText = value => {
    const text = collapse(value)
    return text.length <= 100 && (MODEL.test(text) || EFFORT.test(text) || OTHER.test(text)) ? text : null
  }
  // Do not aggregate a scope ancestor's draft or transcript into even a length.
  const textOf = node => !node || node.matches(EDITOR) || node.closest(MESSAGE) || node.querySelector(EDITOR + ', ' + MESSAGE)
    ? '' : collapse(node.textContent)
  const visible = node => !!node && node.getClientRects().length > 0 && !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
    !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const excluded = node => !!node.closest(MESSAGE + ', nav, aside')
  let state = window[config.key]
  if (!state) {
    state = { ids: new Map(), lastTrail: [], observer: null, notice: null }
    window[config.key] = state
  }
  const ref = value => {
    if (!value) return null
    if (!state.ids.has(value)) state.ids.set(value, 'ref-' + (state.ids.size + 1))
    return state.ids.get(value)
  }
  const attrs = node => {
    const result = {}
    for (const name of ['role', 'type', 'aria-haspopup', 'aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-disabled',
      'aria-hidden', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'data-state', 'data-highlighted', 'data-orientation', 'data-side', 'data-align',
      'data-selected-reasoning-effort', 'data-model-selected', 'data-model-picker-view', 'data-selected', 'data-locked', 'data-fast-mode',
      'data-explicit-model', 'data-inline-model', 'data-effort-header', 'tabindex', 'disabled']) {
      const value = node.getAttribute(name)
      if (value !== null) result[name] = /^[\w .:-]{0,100}$/.test(value) ? value : { chars: value.length }
    }
    for (const name of ['aria-label', 'aria-valuetext', 'title', 'data-tooltip-content']) {
      const value = node.getAttribute(name)
      if (value !== null) result[name] = safeText(value) || { chars: value.length }
    }
    for (const name of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
      const value = node.getAttribute(name)
      if (value) result[name] = value.split(/\s+/).slice(0, 6).map(id => ({ ref: ref(id), label: safeText(textOf(document.getElementById(id))) }))
    }
    const id = node.getAttribute('id')
    if (id) result.id = /^(prompt-textarea|pending-home-input)$/.test(id) ? id : ref(id)
    const testId = node.getAttribute('data-testid')
    if (testId !== null) result['data-testid'] = /^[a-z][a-z0-9_-]{0,79}$/i.test(testId) ? testId : { chars: testId.length }
    result.dataNames = [...node.attributes].map(attr => attr.name).filter(name => name.startsWith('data-')).slice(0, 30)
    return result
  }
  const describe = node => {
    const css = getComputedStyle(node), text = textOf(node)
    return { tag: node.tagName.toLowerCase(), attrs: attrs(node), classes: typeof node.className === 'string' ? node.className.slice(0, 600) : '',
      label: safeText(text), textChars: text.length, visible: visible(node), disabled: 'disabled' in node ? !!node.disabled : null,
      style: { color: css.color, backgroundColor: css.backgroundColor, fontWeight: css.fontWeight, display: css.display, pointerEvents: css.pointerEvents } }
  }
  const structure = (node, budget, depth = 0) => {
    if (budget.left-- <= 0) return null
    if (node.nodeType === 3) {
      const text = collapse(node.textContent)
      return text ? { text: safeText(text), textChars: text.length } : null
    }
    if (node.nodeType !== 1 || excluded(node) || /^(script|style|noscript|iframe|object|embed|link|meta|img)$/i.test(node.tagName)) return null
    const result = describe(node)
    if (node.matches(EDITOR)) return { ...result, editorOmitted: true }
    if (node.tagName.toLowerCase() === 'path') return { ...result, d: String(node.getAttribute('d') || '').slice(0, 1600) }
    if (node.tagName.toLowerCase() === 'use') return { ...result, iconReferenceOmitted: true }
    if (depth >= 9) return { ...result, depthLimit: true }
    result.children = [...node.childNodes].slice(0, 60).map(child => structure(child, budget, depth + 1)).filter(Boolean)
    return result
  }
  const allControls = [...document.querySelectorAll(CONTROL)].filter(node => visible(node) && !excluded(node))
  const composer = [...document.querySelectorAll(COMPOSER)].find(node => visible(node) && !excluded(node))
  const named = node => safeText(node.getAttribute('aria-label')) || safeText(node.getAttribute('title')) || safeText(textOf(node))
  const interesting = node => !!named(node) || node.hasAttribute('aria-haspopup')
  const triggers = allControls.filter(interesting).slice(0, 32)
  const scopes = []
  for (let node = composer?.parentElement, depth = 0; node && node !== document.body && depth < 7; node = node.parentElement, depth++) {
    scopes.push({ depth, root: describe(node), controls: allControls.filter(control => node.contains(control)).slice(0, 35).map(describe) })
    if (node.tagName.toLowerCase() === 'main') break
  }
  // Portal menus often sit outside the composer subtree; aria-controls adds an
  // independent discovery path for a popup without a conventional role/class.
  const popupSet = new Set([...document.querySelectorAll(POPUP)].filter(node => visible(node) && !excluded(node)))
  for (const trigger of triggers) for (const id of (trigger.getAttribute('aria-controls') || '').split(/\s+/)) {
    const popup = id && document.getElementById(id)
    if (popup && visible(popup) && !excluded(popup)) popupSet.add(popup)
  }
  const popups = [...popupSet].slice(0, 12).map(node => ({ root: describe(node),
    controls: allControls.filter(control => node.contains(control)).slice(0, 50).map(control => structure(control, { left: 90 })),
    tree: structure(node, { left: 220 }) }))
  const choices = [...new Set([...popupSet].flatMap(node => [...node.querySelectorAll(CONTROL + ', span, label')]
    .filter(child => visible(child) && !excluded(child)).map(child => safeText(textOf(child))).filter(Boolean)))].slice(0, 60)
  if (!state.observer) {
    const notify = () => {
      if (state.notice) return
      state.notice = setTimeout(() => { state.notice = null; console.log(config.tag + JSON.stringify({ type: 'changed' })) }, 120)
    }
    state.observer = new MutationObserver(notify)
    state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'data-state'] })
    document.addEventListener('click', event => {
      if (!event.isTrusted) return
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      if (!target || excluded(target)) return
      const control = target.closest(CONTROL)
      if (!control || !interesting(control)) return
      const trail = []
      for (let node = control; node && node !== document.body && trail.length < 5; node = node.parentElement) trail.push(describe(node))
      state.lastTrail = trail
      console.log(config.tag + JSON.stringify({ type: 'control-click', trusted: true, control: structure(control, { left: 100 }), trail }))
      notify()
    }, true)
    for (const type of ['keydown', 'pointerup']) document.addEventListener(type, event => {
      if (!event.isTrusted) return
      const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement
      const slider = target?.closest('[data-reasoning-slider]')
      if (!slider || excluded(slider)) return
      const key = type === 'keydown' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) ? event.key : null
      if (type === 'keydown' && !key) return
      const box = slider.getBoundingClientRect()
      console.log(config.tag + JSON.stringify({ type: 'slider-input', trusted: true, input: type, key,
        fractionX: type === 'pointerup' && box.width > 0 ? Math.round(1000 * (event.clientX - box.left) / box.width) / 1000 : null,
        control: structure(slider, { left: 130 }) }))
      notify()
    }, true)
  }
  return { ready: !!composer, triggers: triggers.map(node => ({ ...describe(node), tree: structure(node, { left: 100 }) })), scopes,
    popups, choices, modelChoices: choices.filter(text => MODEL.test(text)), effortChoices: choices.filter(text => EFFORT.test(text)), lastClickTrail: state.lastTrail }
}
const source = '(' + inspectModelSettings.toString() + ')(' + JSON.stringify(config) + ')'
new vm.Script(source)

async function capture(reason) {
  if (capturing || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try { if (new URL(win.webContents.getURL()).origin !== ORIGIN) return } catch { return }
  capturing = true
  let timeout
  try {
    const data = await Promise.race([win.webContents.executeJavaScript(source),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('snapshot-timeout')), 3000) })])
    for (const value of data.modelChoices || []) models.add(value)
    for (const value of data.effortChoices || []) efforts.add(value)
    win.setTitle('ChatGPT 模型/思考强度探针 — 已采集模型 ' + models.size + ' 项 · 强度 ' + efforts.size + ' 项 · 点击 ' + clicks + ' 次')
    const current = JSON.stringify(data)
    if (current !== signature || reason === 'manual' || reason === 'final') {
      signature = current
      log('SNAPSHOT', { sequence: ++sequence, reason, ...data })
    }
  } catch { log('READ-FAILED', { reason }) }
  finally { clearTimeout(timeout); capturing = false }
}
function schedule(reason, delay) {
  if (closing || scheduled.size >= 6) return
  const id = setTimeout(() => { scheduled.delete(id); if (!closing) void capture(reason) }, delay)
  scheduled.add(id)
}
const instructions = '无需发消息，也不用手动打点。\n' +
  '1. 等页面就绪，展开模型菜单，停留两秒；如有子菜单也展开一次。\n' +
  '2. 手动选择另一个模型，等待两秒，再切回原模型。\n' +
  '3. 展开思考强度菜单，停留两秒；切换另一个强度，等待两秒，再切回来。\n' +
  '4. 如果模型与强度在同一个菜单中，请把相关层级都展开一次。\n' +
  '标题会显示已采集选项数；F8 可额外采集。完成后关闭窗口。\n\n日志：' + logPath

app.whenReady().then(async () => {
  const ses = session.fromPartition(process.env.PROBE_PARTITION || 'persist:chatgpt')
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  await ses.setProxy({ proxyRules: proxy })
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36')
  win = new BrowserWindow({ width: 1400, height: 940, title: 'ChatGPT 模型/思考强度探针 — 手动展开菜单并切换',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  win.on('page-title-updated', event => event.preventDefault())
  const menu = Menu.buildFromTemplate([
    { label: '采集当前状态', accelerator: 'F8', click: () => { void capture('manual') } },
    { label: '操作说明', click: () => { void dialog.showMessageBox(win, { type: 'info', title: '模型与思考强度采集', message: instructions }) } }
  ])
  Menu.setApplicationMenu(menu); win.setMenu(menu); win.setMenuBarVisibility(true)
  win.webContents.on('console-message', (event, _level, legacyMessage) => {
    const message = typeof legacyMessage === 'string' ? legacyMessage : event.message
    if (typeof message !== 'string' || !message.startsWith(config.tag) || message.length > 80000) return
    try {
      const data = JSON.parse(message.slice(config.tag.length))
      if (data.type === 'control-click' && data.trusted === true) {
        clicks++; log('CONTROL-CLICK', data)
        schedule('after-click', 60); schedule('after-click-settled', 450)
      } else if (data.type === 'slider-input' && data.trusted === true) {
        log('SLIDER-INPUT', data); schedule('after-slider', 60); schedule('after-slider-settled', 450)
      } else if (data.type === 'changed') schedule('dom-change', 40)
    } catch { /* No other page console output is recorded. */ }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('did-finish-load', () => { void capture('loaded') })
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame) log('LOAD-FAILED', { code }) })
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true; clearInterval(timer)
    for (const id of scheduled) clearTimeout(id)
    scheduled.clear()
    void (async () => {
      while (capturing) await new Promise(resolve => setTimeout(resolve, 50))
      await capture('final')
    })().finally(() => {
      log('FINAL', { snapshots: sequence, clicks, modelChoices: [...models], effortChoices: [...efforts],
        modelMenuSeen: models.size > 0, effortMenuSeen: efforts.size > 0,
        notes: 'Coverage only. Read native state/selection differences before implementing switching.' })
      console.log('日志已保存：' + logPath)
      win.destroy(); app.quit()
    })
  })
  log('START', { origin: ORIGIN, proxyConfigured: !!proxy, partition: process.env.PROBE_PARTITION ? 'override' : 'persist:chatgpt',
    profile: process.env.PROBE_USER_DATA ? 'override' : path.basename(userData), notes: 'Passive DOM metadata. No messages, editor values, cookies, storage, network capture, automatic clicks or app imports.' })
  console.log(instructions)
  timer = setInterval(() => { if (!closing) void capture('poll') }, 1000)
  await win.loadURL(start.href)
}).catch(() => { log('FATAL', { reason: 'startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
