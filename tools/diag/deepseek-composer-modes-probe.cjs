/** User-run only. Reads the two composer switches; never clicks, types or sends. */
const { app, BrowserWindow, Menu, dialog, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')

const ORIGIN = 'https://chat.deepseek.com'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 https://chat.deepseek.com 同源页面。')
app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logPath = path.join(directory, 'deepseek-composer-modes-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log')
let win, timer, capturing = false, closing = false, signature = '', sequence = 0, bytes = 0
const marks = new Set()
const foundModes = new Set(), clicks = { thinking: 0, search: 0 }
const config = { key: '__deepseekModeProbe_' + randomUUID().replace(/-/g, ''), tag: '[deepseek-mode-' + randomUUID() + '] ' }
function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n'
  if (bytes > 4 * 1024 * 1024 && !['FINAL', 'FATAL'].includes(event)) return
  fs.appendFileSync(logPath, line, 'utf8'); bytes += Buffer.byteLength(line)
  if (event !== 'SNAPSHOT') console.log(line.trimEnd())
}

function inspectModes(config) {
  const labels = {
    thinking: /^(?:深度思考(?:\s*\(R1\))?|DeepThink(?:\s*\(R1\))?)$/i,
    search: /^(?:智能搜索|联网搜索|搜索|Search|Web search)$/i
  }
  const visible = node => !!node && node.getClientRects().length > 0 && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)
  const textOf = node => String(node.textContent || '').replace(/\s+/g, ' ').trim()
  const idOf = node => {
    const text = textOf(node)
    return text.length <= 80 ? Object.keys(labels).find(key => labels[key].test(text)) || null : null
  }
  const CONTROL = 'button, [role="button"], .ds-button, [aria-pressed], [aria-checked]'
  const composer = [...document.querySelectorAll('textarea[placeholder], textarea')].find(visible)
  const attrs = node => Object.fromEntries(['role', 'type', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-disabled',
    'data-state', 'data-selected', 'data-checked', 'disabled', 'tabindex'].flatMap(key => {
    const value = node.getAttribute(key)
    return value === null ? [] : [[key, value.slice(0, 100)]]
  }))
  const styles = node => {
    const css = getComputedStyle(node)
    return Object.fromEntries(['color', 'backgroundColor', 'borderTopColor', 'borderTopWidth', 'opacity', 'cursor', 'display',
      'pointerEvents', 'fontWeight', 'boxShadow'].map(key => [key, css[key]]))
  }
  const describe = node => {
    const text = textOf(node), id = idOf(node)
    return { id, label: id ? text : null, textChars: text.length, tag: node.tagName.toLowerCase(),
      classes: typeof node.className === 'string' ? node.className.slice(0, 600) : '', attrs: attrs(node), style: styles(node),
      ...(id ? { children: [...node.children].slice(0, 8).map(child => ({ tag: child.tagName.toLowerCase(),
        classes: typeof child.className === 'string' ? child.className.slice(0, 400) : '', attrs: attrs(child), style: styles(child) })) } : {}) }
  }
  let root = null, partial = null
  const scopes = []
  for (let node = composer?.parentElement, depth = 0; node && node !== document.body && depth < 10; node = node.parentElement, depth++) {
    const controls = [...node.querySelectorAll(CONTROL)].filter(visible)
    const modeIds = [...new Set(controls.map(idOf).filter(Boolean))]
    scopes.push({ depth, tag: node.tagName.toLowerCase(), classes: typeof node.className === 'string' ? node.className.slice(0, 400) : '',
      controlCount: controls.length, modeIds })
    if (!partial && modeIds.length) partial = node
    if (modeIds.length === 2) { root = node; break }
  }
  root = root || partial
  const semantic = [...document.querySelectorAll(CONTROL)].filter(visible)
  // Independent discovery still works if the new site moves switches out of the
  // textarea subtree or stops using a semantic button element.
  const missing = Object.keys(labels).some(id => !semantic.some(node => idOf(node) === id))
  const leaves = missing ? [...document.querySelectorAll('span, p, div')].slice(0, 8000).filter(node => visible(node) && idOf(node) &&
    ![...node.children].some(child => idOf(child) === idOf(node))) : []
  const named = Object.keys(labels).flatMap(id => {
    const controls = semantic.filter(node => idOf(node) === id)
    return (controls.length ? controls : leaves.filter(node => idOf(node) === id)).slice(0, 6)
  })
  const namedControls = named.map(node => ({ ...describe(node), inComposerScope: !!root?.contains(node),
    discovery: node.matches(CONTROL) ? 'control' : 'label-leaf',
    ancestors: (() => {
      const items = []
      for (let parent = node.parentElement, depth = 0; parent && parent !== document.body && depth < 4; parent = parent.parentElement, depth++) items.push(describe(parent))
      return items
    })() }))
  if (!window[config.key]) {
    window[config.key] = true
    document.addEventListener('click', event => {
      if (!event.isTrusted) return
      const trail = event.composedPath().filter(node => node?.nodeType === 1)
      const target = trail.find(node => idOf(node))
      if (!target) return
      console.log(config.tag + JSON.stringify({ type: 'mode-click', id: idOf(target), trusted: true,
        target: describe(target), trail: trail.slice(0, 6).map(describe) }))
    }, true)
  }
  const controls = root ? [...root.querySelectorAll(CONTROL)].filter(visible).sort((a, b) => Number(!!idOf(b)) - Number(!!idOf(a))).slice(0, 40).map(describe) : []
  return { ready: !!composer, toolbar: !!root, scopes, controls, namedControls }
}
const source = '(' + inspectModes.toString() + ')(' + JSON.stringify(config) + ')'
new vm.Script(source)

async function capture(reason, phase = null) {
  if (capturing || !win || win.isDestroyed() || win.webContents.isDestroyed()) return
  if (new URL(win.webContents.getURL() || ORIGIN).origin !== ORIGIN) return
  capturing = true
  let timeout
  try {
    const data = await Promise.race([win.webContents.executeJavaScript(source),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('snapshot-timeout')), 3000) })])
    for (const node of data.namedControls || []) if (node.id) foundModes.add(node.id)
    win.setTitle('DeepSeek 开关探针 — 找到：思考' + (foundModes.has('thinking') ? '✓' : '×') + ' 搜索' +
      (foundModes.has('search') ? '✓' : '×') + ' · 点击次数 ' + clicks.thinking + '/' + clicks.search)
    if (phase) { marks.add(phase); log('MARK', { phase }) }
    const current = JSON.stringify(data)
    if (current !== signature || phase) {
      signature = current
      log('SNAPSHOT', { sequence: ++sequence, reason, phase, ...data })
    }
  } catch { log('READ-FAILED', { reason }) }
  finally { clearTimeout(timeout); capturing = false }
}

const instructions = '无需发消息，也不用菜单打点。\n' +
  '先手动把两个开关都关闭。\n' +
  '依次点击：深度思考 → 智能搜索 → 深度思考 → 智能搜索。每次间隔约一秒。\n' +
  '探针自动记录手动点击和状态变化；标题会显示是否找到两个开关及点击次数。\n' +
  '有需要可额外用“状态打点”菜单标记四种组合。结束后关闭窗口。\n\n日志：' + logPath
app.whenReady().then(async () => {
  const ses = session.fromPartition(process.env.PROBE_PARTITION || 'persist:deepseek')
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  await ses.setProxy({ proxyRules: proxy })
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36')
  win = new BrowserWindow({ width: 1320, height: 920, title: 'DeepSeek 开关探针 — 手动切换并打点，完成后关闭',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true } })
  win.on('page-title-updated', event => event.preventDefault())
  const phases = [['两个均关闭', 'both-off'], ['仅深度思考开启', 'thinking-only'], ['两个均开启', 'both-on'], ['仅智能搜索开启', 'search-only']]
  const menu = Menu.buildFromTemplate([
    { label: '状态打点', submenu: phases.map(([label, phase]) => ({ label, click: () => { void capture('manual', phase) } })) },
    { label: '采集当前状态', accelerator: 'F8', click: () => { void capture('manual', 'current') } },
    { label: '操作说明', click: () => { void dialog.showMessageBox(win, { type: 'info', title: '开关采集步骤', message: instructions }) } }
  ])
  Menu.setApplicationMenu(menu); win.setMenu(menu); win.setMenuBarVisibility(true)
  win.webContents.on('console-message', (event, _level, legacyMessage) => {
    const message = typeof legacyMessage === 'string' ? legacyMessage : event.message
    if (typeof message !== 'string' || !message.startsWith(config.tag) || message.length > 48000) return
    try {
      const data = JSON.parse(message.slice(config.tag.length))
      if (data.type !== 'mode-click' || !['thinking', 'search'].includes(data.id) || data.trusted !== true) return
      clicks[data.id]++
      log('MODE-CLICK', data)
      setTimeout(() => { if (!closing) void capture('after-click') }, 150)
      setTimeout(() => { if (!closing) void capture('after-click-settled') }, 500)
    } catch { /* Other page console output is never recorded. */ }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('did-finish-load', () => { void capture('loaded') })
  win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame) log('LOAD-FAILED', { code }) })
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true; clearInterval(timer)
    void (async () => {
      // Let an in-flight read finish before taking the final snapshot.
      while (capturing) await new Promise(resolve => setTimeout(resolve, 50))
      await capture('final')
    })().finally(() => {
      log('FINAL', { snapshots: sequence, foundModes: [...foundModes], clicks, marks: [...marks],
        complete: foundModes.size === 2 && (Object.values(clicks).every(count => count >= 2) || phases.every(([, phase]) => marks.has(phase))) })
      console.log('日志已保存：' + logPath)
      win.destroy(); app.quit()
    })
  })
  log('START', { origin: ORIGIN, proxyConfigured: !!proxy, notes: 'No messages, input values, cookies, storage, network bodies or automatic clicks.' })
  console.log(instructions)
  timer = setInterval(() => { if (!closing) void capture('poll') }, 800)
  await win.loadURL(start.href)
}).catch(() => { log('FATAL', { reason: 'startup-failed' }); app.quit() })
app.on('window-all-closed', () => app.quit())
