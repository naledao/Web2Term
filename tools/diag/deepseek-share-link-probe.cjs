/**
 * User-run observation of: a NEW DeepSeek chat receives a share URL + a question.
 * No fork/continue action, app interceptor, automatic typing, clicking or sending.
 * Run: .\node_modules\electron\dist\electron.exe .\tools\diag\deepseek-share-link-probe.cjs
 * See deepseek-share-link-probe.md for the user steps and evidence limits.
 */
const { app, BrowserWindow, Menu, clipboard, session } = require('electron')
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const vm = require('node:vm')

const HOME = 'https://chat.deepseek.com/'
const PARTITION = 'persist:deepseek'
const share = new URL(process.env.PROBE_SHARE_URL || 'https://chat.deepseek.com/share/fqjeqcqyedq5fflpmh')
if (share.origin !== new URL(HOME).origin || !/^\/share\/[a-zA-Z0-9_-]+\/?$/.test(share.pathname) || share.search || share.hash) {
  throw new Error('PROBE_SHARE_URL 必须是 https://chat.deepseek.com/share/<id>，不能包含查询参数。')
}
const SHARE_URL = share.href
app.setPath('userData', process.env.PROBE_USER_DATA || join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = join(app.getPath('temp'), 'gpt-login-diag')
mkdirSync(directory, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
const logPath = join(directory, `deepseek-share-link-${stamp}.log`)
const instructionsPath = join(directory, `deepseek-share-link-${stamp}.txt`)
const marker = 'DS_SHARE_LINK_PROBE_' + stamp
const windows = new Map()
const references = new Map()
const cases = new Map()
const digest = text => createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
const normalize = text => String(text || '').replace(/\s+/g, '')
const errorShape = error => ({ name: error?.name || 'Error', code: typeof error?.code === 'string' && /^[A-Z0-9_:-]+$/i.test(error.code) ? error.code : undefined })
let nextWindow = 1

function log(event, details = {}) {
  const line = new Date().toISOString() + ' ' + event + ' ' + JSON.stringify(details)
  try { appendFileSync(logPath, line + '\n', 'utf8') } catch { console.error('诊断日志写入失败，请检查临时目录。') }
  console.log(line)
}

function locationShape(raw) {
  try {
    const url = new URL(raw)
    const chat = /^\/a\/chat\/s\/([^/]+)/.exec(url.pathname)
    return { origin: url.origin, kind: /^\/share\//.test(url.pathname) ? 'share' : chat ? 'conversation' : url.pathname === '/' ? 'home' : 'other',
      conversationAlias: chat ? digest(chat[1]) : undefined,
      path: url.pathname.replace(/(\/share\/|\/s\/)[^/]+/g, '$1:id').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, ':id').replace(/[a-zA-Z0-9_-]{24,}/g, ':id'),
      queryKeys: [...url.searchParams.keys()].filter(key => /^[a-zA-Z_][\w-]{0,50}$/.test(key)).slice(0, 12) }
  } catch { return { kind: 'invalid' } }
}

function promptFor(mode) {
  return [
    `${marker}:${mode}`,
    '请先实际读取以下 DeepSeek 分享链接中的对话，再回答问题：',
    SHARE_URL,
    '',
    '如果无法读取，请明确回答“无法读取分享链接”，不要声称已经读过，也不要凭常识猜测。',
    '如果能读取，请只依据分享对话，用 JSON 回答以下字段：',
    'read_status：能否读取；apk_filename：对话中最新 APK 的完整文件名；',
    'version_code、version_name：该 APK 对应的两个版本号；',
    'compose_reason：项目最终没有采用 Compose 的原因；',
    'early_user_quote：较早一条用户消息中的连续 15～30 个字；',
    'last_assistant_quote：最后一条助手回答正文中的连续 15～30 个字。',
    '未找到的字段写“无法确认”。两段摘录必须是原文，不要概括或改写。'
  ].join('\n')
}

// This function is parsed as JavaScript in this file, then serialized. No nested
// template-string escapes, DOM writes, event suppression or application imports.
function readPage(testMarker) {
  const visible = node => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const composers = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible)
  // Independent copy of the measured DeepSeek answer/turn selectors. The fallback
  // is explicitly identified in the log; reasoning blocks are always excluded.
  const primary = [...document.querySelectorAll('.ds-assistant-message-main-content')].filter(visible)
  const fallback = [...document.querySelectorAll('.ds-markdown')].filter(node => visible(node) && !node.closest('.ds-think-content'))
  const answers = primary.length ? primary : fallback
  const rows = [...document.querySelectorAll('[data-virtual-list-item-key]')].filter(visible)
  const text = node => String(node.innerText || '').slice(0, 100000)
  const markerRows = rows.filter(node => text(node).includes(testMarker))
  const finalMarkerRow = markerRows.at(-1)
  // If virtualization evicts the marked question, do not guess which answer
  // belongs to it. The user can scroll it back into view and capture again.
  const followingAnswers = finalMarkerRow ? answers.filter(node => {
    const row = node.closest('[data-virtual-list-item-key]') || node
    return row !== finalMarkerRow && !!(finalMarkerRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)
  }) : []
  const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visible).flatMap(node => {
    const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '').trim()
    if (label.length > 45 || !/搜索|联网|深度思考|search|think/i.test(label)) return []
    return [{ label, tag: node.tagName.toLowerCase(), className: String(node.className).slice(0, 180),
      pressed: node.getAttribute('aria-pressed'), checked: node.getAttribute('aria-checked'), disabled: node.getAttribute('aria-disabled') }]
  }).slice(0, 12)
  const pageText = String(document.body?.innerText || '')
  return {
    path: location.pathname,
    composer: composers.map(node => ({ tag: node.tagName.toLowerCase(), draftLength: String(node.value ?? node.innerText ?? '').length })),
    answerSelector: primary.length ? '.ds-assistant-message-main-content' : '.ds-markdown (fallback; roles unconfirmed)',
    answerCount: answers.length, rowCount: rows.length, markerRowCount: markerRows.length,
    controls, loading: !!document.querySelector('[aria-busy="true"], [role="progressbar"]'),
    loginOrChallengeVisible: /验证您是真人|verify you are human|checking your browser|扫码登录|手机号登录/i.test(pageText),
    referenceText: location.pathname.startsWith('/share/') ? pageText.slice(0, 400000) : '',
    // Only a fresh test window's reply after its marked question is eligible.
    diagnosticAnswer: followingAnswers.length ? text(followingAnswers.at(-1)).slice(0, 12000) : ''
  }
}
const captureSource = `(${readPage.toString()})(${JSON.stringify(marker)})`
new vm.Script(captureSource) // Parse only, including the actual serialized page code.

function redactAnswer(raw) {
  return String(raw).replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, '[redacted-key]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[redacted]')
}

function quoteChecks(answer) {
  const result = { referenceSamples: references.size, quoteEvidence: [] }
  let parsed
  try { parsed = JSON.parse(answer.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')) } catch { return result }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result
  for (const key of ['early_user_quote', 'last_assistant_quote']) {
    const quote = typeof parsed[key] === 'string' ? normalize(parsed[key]) : ''
    if (quote.length < 15 || quote.length > 100) continue
    result.quoteEvidence.push({ field: key, length: quote.length, sha256: digest(quote),
      matchesObservedShareText: [...references.values()].some(sample => sample.includes(quote)) })
  }
  return result
}

async function inspect(record, reason, saveAnswer = false) {
  if (record.closing || record.window.isDestroyed()) return
  if (record.busy) {
    if (saveAnswer) console.log('正在采集页面，请稍后再按 F8；本次未发送任何消息。')
    return
  }
  const wc = record.window.webContents
  if (wc.isDestroyed() || !wc.getURL().startsWith(new URL(HOME).origin + '/')) return
  record.busy = true
  try {
    const caseMarker = record.kind === 'reference' ? marker : marker + ':' + record.kind
    const captured = await wc.executeJavaScript(`(${readPage.toString()})(${JSON.stringify(caseMarker)})`)
    if (record.closed) return
    const { referenceText, diagnosticAnswer, path: _path, ...metadata } = captured
    if (record.kind === 'reference' && referenceText && /^\/share\//.test(captured.path)) {
      const key = digest(referenceText)
      if (!references.has(key) && references.size < 120) {
        references.set(key, normalize(referenceText))
        log('SHARE-REFERENCE', { window: record.alias, characters: referenceText.length, sha256: key,
          samples: references.size, completeHistoryProven: false })
      }
    }
    const value = JSON.stringify(metadata)
    if (reason !== 'tick' || value !== record.lastMetadata) {
      log('PAGE', { window: record.alias, case: record.kind, reason, location: locationShape(wc.getURL()), ...metadata })
      record.lastMetadata = value
    }
    // Polling intentionally does not store streamed fragments. F8 is the user's
    // statement that the answer has ended; its completion is not inferred from a
    // timeout or a guessed DeepSeek stop-button selector.
    if (saveAnswer && record.kind !== 'reference') {
      if (!diagnosticAnswer || captured.markerRowCount !== 1) {
        log('ANSWER-NOT-CAPTURED', { case: record.kind, markedRequestSeen: record.markedRequestSeen,
          markerRowCount: captured.markerRowCount, answerPresent: !!diagnosticAnswer,
          reason: 'Need exactly one marked question and its following reply in view; wait for the reply, then press F8.' })
      } else {
        const answer = redactAnswer(diagnosticAnswer)
        const evidence = quoteChecks(diagnosticAnswer)
        const value = { case: record.kind, characters: diagnosticAnswer.length, sha256: digest(diagnosticAnswer),
          markedRequestSeen: record.markedRequestSeen,
          userMarkedFinished: true, selector: captured.answerSelector, evidence, answer }
        cases.set(record.kind, { answer, rawQuoteEvidence: evidence })
        log('TEST-ANSWER', value)
        console.log('已记录本轮回答。请继续下一组，或关闭全部探针窗口结束。')
      }
    }
  } catch (error) { log('CAPTURE-FAILED', { case: record.kind, reason, ...errorShape(error) }) }
  finally { record.busy = false }
}

function requestFlags(request) {
  const body = request.postData
  const flags = { postDataAvailable: typeof body === 'string', bytes: typeof body === 'string' ? Buffer.byteLength(body) : undefined,
    containsShareUrl: typeof body === 'string' ? body.includes(SHARE_URL) || body.includes(SHARE_URL.replaceAll('/', '\\/')) : undefined,
    containsTestMarker: typeof body === 'string' ? body.includes(marker) : undefined, modeFlags: {} }
  if (typeof body !== 'string' || body.length > 262144) return flags
  try {
    const parsed = JSON.parse(body)
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 5) return
      for (const [key, entry] of Object.entries(value).slice(0, 80)) {
        if (/^(search_enabled|thinking_enabled|enable_search|enable_thinking|is_search|is_thinking)$/i.test(key) && typeof entry === 'boolean') flags.modeFlags[key] = entry
        if (typeof entry === 'object') walk(entry, depth + 1)
      }
    }
    walk(parsed, 0)
  } catch { /* Non-JSON bodies are never logged. */ }
  return flags
}

async function observeNetwork(record) {
  const wc = record.window.webContents
  const pending = new Map()
  try {
    wc.debugger.attach('1.3')
    wc.debugger.on('detach', () => log('NETWORK-DETACHED', { window: record.alias }))
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.requestWillBeSent') {
        const request = params.request
        const endpoint = locationShape(request.url)
        if (endpoint.origin !== new URL(HOME).origin || !['XHR', 'Fetch', 'Document'].includes(params.type)) return
        // Headers, cookie values, raw request bodies and response bodies are not
        // persisted. The marked test request is recognized only in memory.
        const flags = requestFlags(request)
        if (flags.containsTestMarker && request.method === 'POST') record.markedRequestSeen = true
        const metadata = { window: record.alias, case: record.kind, method: request.method,
          endpoint, resourceType: params.type, ...flags }
        if (pending.size >= 300) pending.delete(pending.keys().next().value)
        pending.set(params.requestId, metadata)
        log('NETWORK-REQUEST', metadata)
      } else if (method === 'Network.responseReceived' && pending.has(params.requestId)) {
        const request = pending.get(params.requestId)
        log('NETWORK-RESPONSE', { ...request, status: params.response.status, mimeType: params.response.mimeType })
      } else if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
        log('NETWORK-FINISHED', { window: record.alias, case: record.kind, bytes: params.encodedDataLength })
        pending.delete(params.requestId)
      } else if (method === 'Network.loadingFailed' && pending.has(params.requestId)) {
        const request = pending.get(params.requestId)
        log('NETWORK-FAILED', { ...request, canceled: !!params.canceled,
          error: /^net::ERR_[A-Z0-9_]+$/.test(params.errorText) ? params.errorText : 'network-error' })
        pending.delete(params.requestId)
      }
    })
    // Do not await before the first navigation: Electron documents that a CDP
    // command can wait for navigation. loadURL below releases that wait.
    void wc.debugger.sendCommand('Network.enable', { maxPostDataSize: 262144 }).catch(error => log('NETWORK-ENABLE-FAILED', errorShape(error)))
  } catch (error) { log('NETWORK-UNAVAILABLE', { window: record.alias, ...errorShape(error) }) }
}

function focusedRecord() {
  const focused = BrowserWindow.getFocusedWindow()
  return focused ? windows.get(focused.id) : undefined
}

function openWindow(kind) {
  // Each mode has one dedicated window, so the ordinary reply cannot become the
  // search case's conversation history. Existing test windows are simply focused.
  const existing = [...windows.values()].find(record => record.kind === kind && !record.closing)
  if (existing) { existing.window.focus(); return existing }
  const labels = { reference: '分享页原文（只读采集）', plain: '普通模式：请手动关闭智能搜索', search: '搜索模式：请手动开启智能搜索' }
  const window = new BrowserWindow({ width: 1250, height: 930, title: 'DeepSeek 链接测试 · ' + labels[kind],
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false, backgroundThrottling: false } })
  const record = { window, kind, alias: nextWindow++, markedRequestSeen: false, closing: false, closed: false, busy: false, lastMetadata: '' }
  windows.set(window.id, record)
  const wc = window.webContents
  wc.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36')
  wc.setWindowOpenHandler(() => { log('POPUP-BLOCKED', { window: record.alias }); return { action: 'deny' } })
  wc.on('page-title-updated', event => { event.preventDefault(); window.setTitle('DeepSeek 链接测试 · ' + labels[kind]) })
  wc.on('did-navigate', (_event, url) => log('NAVIGATE', { window: record.alias, location: locationShape(url) }))
  wc.on('did-navigate-in-page', (_event, url, isMain) => { if (isMain) log('IN-PAGE', { window: record.alias, location: locationShape(url) }) })
  wc.on('did-fail-load', (_event, code, _description, _url, isMain) => { if (isMain && code !== -3) log('LOAD-FAILED', { window: record.alias, code }) })
  wc.on('did-finish-load', () => { void inspect(record, 'load') })
  void observeNetwork(record)
  const timer = setInterval(() => { void inspect(record, 'tick') }, 2000)
  window.on('close', event => {
    if (record.closing) return
    event.preventDefault()
    clearInterval(timer)
    // Finish observation while the webContents is still alive. F8, rather than
    // closing a window, is what authorizes logging the completed test response.
    const activeCapture = inspect(record, 'closing')
    record.closing = true
    void Promise.race([activeCapture, new Promise(resolve => setTimeout(resolve, 1800))]).finally(() => {
      record.closed = true
      log('WINDOW-CLOSED', { window: record.alias, case: kind, markedRequestSeen: record.markedRequestSeen })
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      windows.delete(window.id)
      if (!window.isDestroyed()) window.destroy()
    })
  })
  const url = kind === 'reference' ? SHARE_URL : HOME
  log('WINDOW-OPEN', { window: record.alias, case: kind, location: locationShape(url) })
  void wc.loadURL(url).catch(error => log('LOAD-REJECTED', { case: kind, ...errorShape(error) }))
  return record
}

const instructions = [
  'DeepSeek 分享链接 + 用户提示词诊断（用户操作，探针只观察）',
  `日志：${logPath}`, `分享链接：${SHARE_URL}`, '',
  '请先关闭正常应用，避免同一持久化分区被两个进程同时使用。',
  '启动后先显示分享页。手动从头到尾滚动，页面顶部和底部各停 3 秒；原文只在内存里用于核对摘录，不保存全文。',
  '菜单“诊断”→“普通模式测试并复制提示词”：在全新的空白会话里手动关闭智能搜索，粘贴提示词，停 3 秒，再按 Enter。',
  '等模型回答完全结束，确保本轮问题和回答在当前页面中，按 F8 记录回答。若日志提示未采集，向上滚到问题可见再按 F8。',
  '菜单“诊断”→“智能搜索测试并复制提示词”：打开另一全新会话，手动开启智能搜索，再粘贴同样的问题，停 3 秒后发送。回答结束按 F8。',
  '两组的深度思考开关请保持相同。不要点分享页里的“继续对话”，不要把分享原文复制到新会话。',
  '每组只发送一次；遇到登录/安全验证由你处理，失败时保留界面并结束，不自动重试登录。',
  '最后关闭所有探针窗口，将 .log 文件交给智能体。只有“已读取”声明、HTTP 200 或文字相似都不能单独证明读取成功。',
  '日志保存专用测试回答（最多 12000 字符/次）、DOM 数量、网络状态及搜索布尔开关；不记录 Cookie、请求头/正文、原对话全文。',
  '菜单中的“我核对了原文”是人工检查结果，只标记你自己已核对的那一组。', '',
  '---- 普通模式提示词 ----', promptFor('plain'), '', '---- 智能搜索提示词 ----', promptFor('search')
].join('\n')
writeFileSync(instructionsPath, instructions, { flag: 'wx', encoding: 'utf8' })

app.whenReady().then(async () => {
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  await session.fromPartition(PARTITION).setProxy({ mode: 'fixed_servers', proxyRules: proxy })
  // No webRequest handlers are registered: one CDP observer per window suffices,
  // without replacing a partition-wide listener or changing HTTP requests.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '诊断', submenu: [
      { label: '打开分享原文（只读采集）', click: () => openWindow('reference') },
      ...['plain', 'search'].map(kind => ({ label: kind === 'plain' ? '普通模式测试并复制提示词' : '智能搜索测试并复制提示词',
        click: () => { const record = openWindow(kind); clipboard.writeText(promptFor(kind)); log('PROMPT-COPIED', { case: record.kind }) } })),
      { type: 'separator' },
      { label: '记录当前页面；测试回答结束后按此项', accelerator: 'F8', click: () => { const record = focusedRecord(); if (record) void inspect(record, 'user-f8', true) } },
      { label: '我核对了原文：本组细节和两段摘录全部正确', click: () => { const record = focusedRecord(); if (record && record.kind !== 'reference') log('USER-REFERENCE-CHECK', { case: record.kind, result: 'all-requested-facts-and-quotes-match' }) } },
      { label: '我核对了原文：本组无法读取或存在错误', click: () => { const record = focusedRecord(); if (record && record.kind !== 'reference') log('USER-REFERENCE-CHECK', { case: record.kind, result: 'unreadable-or-mismatch' }) } },
      { type: 'separator' },
      { label: '打印日志路径和操作步骤', click: () => console.log(instructions) },
      { role: 'close', label: '关闭当前窗口' }
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]))
  log('START', { logPath, instructionsPath, electron: process.versions.electron, chrome: process.versions.chrome,
    partition: PARTITION, proxyConfigured: true, shareAlias: digest(SHARE_URL), autoSend: false,
    question: 'Can a new DeepSeek conversation read a share URL supplied only as text?' })
  console.log(instructions)
  openWindow('reference')
}).catch(error => { log('FATAL', errorShape(error)); app.quit() })

app.on('window-all-closed', () => {
  log('COVERAGE', { observedShareSamples: references.size, capturedCases: [...cases.keys()],
    note: 'User-run diagnostic only. No automatic success verdict; check both quotes and concrete facts against the source. Missing evidence is inconclusive.' })
  references.clear()
  cases.clear()
  app.quit()
})
