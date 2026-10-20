/**
 * User-run direct selection -> Ask AI -> Enter -> share URL test.
 * No manual share creation, F6/F7, replay template, guessed message IDs, automatic
 * clicks, model sends or new conversation. Actual history is observed in memory.
 */
const { app, BrowserWindow, Menu, clipboard, session } = require('electron')
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const vm = require('node:vm')

const ORIGIN = 'https://chat.deepseek.com'
const PARTITION = 'persist:deepseek'
const MAX_BODY = 4 * 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 DeepSeek 页面。')
app.setPath('userData', process.env.PROBE_USER_DATA || join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = join(app.getPath('temp'), 'gpt-login-diag')
mkdirSync(directory, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
const logPath = join(directory, `deepseek-selection-share-${stamp}.log`)
const instructionsPath = join(directory, `deepseek-selection-share-${stamp}.txt`)
const tag = '[deepseek-selection-share-' + randomUUID() + '] '
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
const normalize = value => String(value || '').normalize('NFKC').replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '')
const errorShape = error => ({ name: error?.name || 'Error', code: typeof error?.code === 'string' && /^[A-Z0-9_:-]+$/i.test(error.code) ? error.code : undefined })
const histories = new Map()
const requests = new Map()
const tasks = new Set()
let win
let wc
let pageSession
let auth = null
let busy = false
let closing = false
let activeAbort = null
let nativeEnterAt = 0
let jobGeneration = 0
let authGeneration = 0
let attempts = 0
let successes = 0
let nextRequest = 1
let uiTimer
let lastUiMetadata = ''

function log(event, details = {}) {
  const line = new Date().toISOString() + ' ' + event + ' ' + JSON.stringify(details)
  try { appendFileSync(logPath, line + '\n', 'utf8') } catch { console.error('诊断日志写入失败。') }
  console.log(line)
}
function status(text) {
  if (win && !win.isDestroyed()) win.setTitle('DeepSeek 选区分享测试 · ' + text)
  console.log(text)
}
function identity(raw) {
  try {
    const url = new URL(raw)
    const match = /^\/a\/chat\/s\/([^/]+)\/?$/.exec(url.pathname)
    return url.origin === ORIGIN && match ? { id: decodeURIComponent(match[1]), path: url.pathname } : null
  } catch { return null }
}
function pathForLog(raw) {
  try { return new URL(raw).pathname.replace(/(\/s\/|\/share\/)[^/]+/g, '$1:id').replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, ':id') } catch { return 'invalid' }
}
function bounded(promise, milliseconds = 4000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { const error = new Error('timeout'); error.name = 'TimeoutError'; reject(error) }, milliseconds)
  })]).finally(() => clearTimeout(timer))
}
function observe(promise) {
  tasks.add(promise)
  void promise.catch(error => log('OBSERVATION-FAILED', errorShape(error))).finally(() => tasks.delete(promise))
}
function shape(value, key = '', depth = 0) {
  if (/token|authorization|cookie|password|secret|proof|signature/i.test(key)) return { type: 'redacted' }
  if (depth > 6) return { type: 'depth-limit' }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return { type: 'string', length: value.length }
  if (Array.isArray(value)) return { type: 'array', length: value.length, samples: value.slice(0, 2).map(item => shape(item, key, depth + 1)) }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 45).map(([name, item]) => [name, shape(item, name, depth + 1)]))
  return { type: typeof value }
}

function messageOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const role = String(value.role || value.message_role || '').toLowerCase()
  if (!['user', 'assistant'].includes(role)) return null
  const ids = ['message_id', 'messageId', 'id'].map(key => value[key]).filter(id => Number.isSafeInteger(id) && id >= 0)
  if (!ids.length || new Set(ids).size !== 1) return null
  const parentKeys = ['parent_id', 'parent_message_id', 'parentId'].filter(key => Object.hasOwn(value, key))
  const parents = parentKeys.map(key => value[key])
  if (parents.some(parent => parent !== null && (!Number.isSafeInteger(parent) || parent < -1)) || new Set(parents).size > 1) return null
  const texts = []
  for (const key of ['content', 'text']) if (typeof value[key] === 'string' && value[key].trim()) texts.push(value[key])
  for (const key of ['fragments', 'content', 'parts']) {
    if (!Array.isArray(value[key])) continue
    const parts = value[key].filter(part => part && typeof part === 'object' && !/think|reason/i.test(String(part.type || '')))
      .map(part => typeof part.content === 'string' ? part.content : typeof part.text === 'string' ? part.text : '').filter(Boolean)
    if (parts.length) texts.push(parts.join('\n'))
  }
  return { id: ids[0], role, parentKnown: parentKeys.length > 0, parent: parents[0],
    texts: [...new Set(texts)].map(normalize).filter(Boolean) }
}

function collectionsOf(json) {
  const result = []
  let visited = 0
  const walk = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 12 || ++visited > 15000) return
    if (Array.isArray(value)) {
      const messages = value.map(messageOf)
      if (messages.length && messages.every(Boolean) && new Set(messages.map(message => message.id)).size === messages.length) {
        result.push({ path, messages })
        return
      }
      value.slice(0, 1000).forEach((item, index) => walk(item, path + '[' + index + ']', depth + 1))
      return
    }
    Object.entries(value).slice(0, 100).forEach(([key, item]) => {
      if (!/token|authorization|cookie|password|secret/i.test(key)) walk(item, path + '.' + key, depth + 1)
    })
  }
  walk(json, '$', 0)
  return result
}

function matchesAnswer(message, snapshot) {
  if (message.role !== 'assistant') return false
  const answer = normalize(snapshot.answerText)
  const selected = normalize(snapshot.selectedText)
  if (!answer || !selected || !answer.includes(selected)) return false
  return message.texts.some(text => {
    if (!text.includes(selected)) return false
    if (answer.length < 64) return text === answer
    // Check the reply's beginning AND end. A repeated selected word alone never
    // establishes identity. Rendered Markdown may omit punctuation and link URLs.
    return text.includes(answer.slice(0, 48)) && text.includes(answer.slice(-48))
  })
}

function messageRange(collection, target) {
  const messages = collection.messages
  const byId = new Map(messages.map(message => [message.id, message]))
  if (messages.every(message => message.parentKnown)) {
    const ids = []
    const seen = new Set()
    let current = target
    while (current) {
      if (seen.has(current.id)) throw new TypeError('cyclic-message-parents')
      seen.add(current.id)
      ids.push(current.id)
      if (current.parent === null || current.parent === -1) return { ids, mode: 'server-parent-chain' }
      if (!byId.has(current.parent)) throw new TypeError('incomplete-message-parent-chain')
      current = byId.get(current.parent)
    }
    throw new TypeError('missing-message-parent')
  }
  const ascending = messages.every((message, index) => !index || messages[index - 1].id < message.id)
  const descending = messages.every((message, index) => !index || messages[index - 1].id > message.id)
  if (!ascending && !descending) throw new TypeError('ambiguous-server-message-order')
  const ordered = ascending ? messages : [...messages].reverse()
  return { ids: ordered.slice(0, ordered.findIndex(message => message.id === target.id) + 1).map(message => message.id).reverse(), mode: 'server-array-prefix-needs-range-check' }
}

function resolveSelection(snapshot) {
  const matches = (histories.get(snapshot.conversationId) || []).flatMap(collection => collection.messages
    .filter(message => matchesAnswer(message, snapshot)).map(target => ({ collection, target })))
  if (!matches.length) return { error: 'selected-answer-not-found-in-observed-history' }
  const targets = new Set(matches.map(match => match.target.id))
  if (targets.size !== 1) return { error: 'selected-answer-matches-multiple-message-ids', count: targets.size }
  const ranges = []
  for (const match of matches) {
    try { ranges.push({ ...messageRange(match.collection, match.target), target: match.target.id, path: match.collection.path }) }
    catch (error) { log('RANGE-UNAVAILABLE', { error: error.message, target: match.target.id }) }
  }
  const unique = new Map(ranges.map(range => [JSON.stringify(range.ids), range]))
  if (unique.size !== 1) return { error: unique.size ? 'observed-history-ranges-disagree' : 'message-range-unavailable' }
  return unique.values().next().value
}

// Runs before the actual selection UI. Capture the actual selected reply node,
// not an assumed virtual row index. Raw text only crosses into Node memory when
// the user presses Enter, and is never written to the diagnostic log.
function installSelectionBridge(logTag) {
  if (window.__deepseekSelectionShareProbe) return
  let selected = null
  let composing = false
  const remember = () => {
    const host = document.getElementById('cmd-terminal-selection-question')
    if (host && document.activeElement === host) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
    const range = selection.getRangeAt(0)
    const element = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    const answer = element(range.startContainer)?.closest('.ds-assistant-message-main-content')
    if (!answer || answer !== element(range.endContainer)?.closest('.ds-assistant-message-main-content')) return
    selected = { answer, text: selection.toString().trim(), path: location.pathname }
  }
  const snapshot = () => {
    const draft = window.__cmdTerminalSelectionQuestion?.getDraft()
    if (!draft || !selected || !selected.answer.isConnected || selected.path !== location.pathname || draft.sourcePath !== selected.path || draft.selectedText !== selected.text) return null
    const match = /^\/a\/chat\/s\/([^/]+)\/?$/.exec(location.pathname)
    if (!match) return null
    return { conversationId: decodeURIComponent(match[1]), sourcePath: selected.path, selectedText: selected.text,
      questionLength: draft.question.trim().length, answerText: selected.answer.innerText || '',
      virtualRowKey: selected.answer.closest('[data-virtual-list-item-key]')?.getAttribute('data-virtual-list-item-key') || '' }
  }
  window.__deepseekSelectionShareProbe = { snapshot }
  document.addEventListener('selectionchange', remember)
  document.addEventListener('pointerup', () => setTimeout(remember, 0), true)
  window.addEventListener('compositionstart', () => { composing = true }, true)
  window.addEventListener('compositionend', () => { composing = false }, true)
  window.addEventListener('keydown', event => {
    const host = document.getElementById('cmd-terminal-selection-question')
    if (!host || !event.composedPath().includes(host) || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.isComposing || composing || event.keyCode === 229 || !event.isTrusted) return
    if (!window.__cmdTerminalSelectionQuestion?.getDraft()) return
    event.preventDefault()
    event.stopImmediatePropagation()
    console.log(logTag + JSON.stringify({ event: 'selection-enter' }))
  }, true)
}
const uiSource = readFileSync(join(__dirname, '../../src/main/injected/selection-question.js'), 'utf8')
const uiCss = readFileSync(join(__dirname, '../../src/main/injected/selection-question.css'), 'utf8')
const pageSource = `(${installSelectionBridge.toString()})(${JSON.stringify(tag)});\n${uiSource}\n;window.__cmdTerminalSelectionQuestion.configure(${JSON.stringify({ theme: 'light', answerSelectors: ['.ds-assistant-message-main-content'], css: uiCss })});true`
new vm.Script(pageSource) // Parse only, including the actual raw UI script.

function uiMetadata() {
  const visible = node => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden' }
  const shareControls = [...document.querySelectorAll('button, [role="button"]')].filter(visible).flatMap(node => {
    const text = (node.getAttribute('aria-label') || node.innerText || '').trim()
    return text.length < 60 && /创建链接|复制链接|create link|copy link/i.test(text) ? [text] : []
  })
  return { dialogs: [...document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]')].filter(visible).length,
    shareControls, answers: document.querySelectorAll('.ds-assistant-message-main-content').length,
    virtualRows: document.querySelectorAll('[data-virtual-list-item-key]').length }
}

function requestConversation(request, source) {
  const query = new URL(request.url).searchParams.get('chat_session_id')
  if (query) return query
  try {
    const body = JSON.parse(request.postData || 'null')
    if (typeof body?.chat_session_id === 'string') return body.chat_session_id
  } catch { /* No raw request body is logged. */ }
  return identity(source)?.id || null
}

function observeNetwork() {
  wc.debugger.attach('1.3')
  wc.debugger.on('detach', () => log('NETWORK-DETACHED'))
  wc.debugger.on('message', (_event, method, params) => {
    if (closing) return
    if (method === 'Network.requestWillBeSent') {
      const request = params.request
      const url = new URL(request.url)
      if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/') || !['XHR', 'Fetch'].includes(params.type)) return
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => /^(accept|content-type|authorization|x-[\w-]+)$/i.test(name)).map(([name, value]) => [name.toLowerCase(), value]))
      if (typeof headers.authorization === 'string' && headers.authorization) {
        if (auth && auth.authorization !== headers.authorization) {
          histories.clear()
          authGeneration++
          jobGeneration++
          activeAbort?.abort()
          log('AUTH-HEADERS-CHANGED')
        }
        auth = headers
      }
      if (!/chat|session|conversation|message/i.test(url.pathname) || /share|auth|token|login|logout|pow|feedback/i.test(url.pathname)) return
      const conversationId = requestConversation(request, wc.getURL())
      if (!conversationId || requests.size >= 60) return
      // SPA history loads can start before the URL changes. Navigation cancels a
      // pending share operation, but must not discard that history response.
      const record = { alias: nextRequest++, conversationId, path: pathForLog(request.url), authGeneration, mime: '' }
      requests.set(params.requestId, record)
      log('HISTORY-REQUEST', { request: record.alias, path: record.path, conversationAlias: digest(conversationId) })
    } else if (method === 'Network.responseReceived' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId)
      record.mime = params.response.mimeType
      record.status = params.response.status
    } else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId)
      requests.delete(params.requestId)
      if (!/json/i.test(record.mime) || record.status !== 200 || params.encodedDataLength > MAX_BODY) return
      observe((async () => {
        const result = await bounded(wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }))
        if (closing || record.authGeneration !== authGeneration) return
        const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
        if (Buffer.byteLength(body) > MAX_BODY) { log('HISTORY-TOO-LARGE', { request: record.alias }); return }
        const json = JSON.parse(body)
        const collections = collectionsOf(json)
        if (collections.length) {
          if (!histories.has(record.conversationId) && histories.size >= 12) histories.delete(histories.keys().next().value)
          histories.set(record.conversationId, collections)
          log('HISTORY-READY', { request: record.alias, conversationAlias: digest(record.conversationId),
            collections: collections.map(collection => ({ path: collection.path, count: collection.messages.length,
              messages: collection.messages.slice(0, 120).map(message => ({ id: message.id, role: message.role,
                parentKnown: message.parentKnown, parent: message.parent,
                textLengths: message.texts.map(text => text.length), textAliases: message.texts.map(digest) })) })) })
          if (!busy && identity(wc.getURL())?.id === record.conversationId) status('消息已采集：选中回答 → 询问 AI → Enter 获取链接')
        } else {
          log('HISTORY-SCHEMA', { request: record.alias, path: record.path, schema: shape(json), recognizedMessageLists: 0 })
        }
      })())
    } else if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
      log('HISTORY-FAILED', { request: requests.get(params.requestId).alias })
      requests.delete(params.requestId)
    }
  })
  return wc.debugger.sendCommand('Network.enable', { maxPostDataSize: 65536, maxResourceBufferSize: MAX_BODY, maxTotalBufferSize: MAX_BODY * 3 })
}

async function readJson(response) {
  if (!/json/i.test(response.headers.get('content-type') || '')) throw new TypeError('non-json-response')
  const reader = response.body?.getReader()
  if (!reader) throw new TypeError('empty-response')
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) { await reader.cancel(); throw new RangeError('response-too-large') }
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { reader.releaseLock() }
}

async function createFromSelection() {
  if (closing || busy) return
  busy = true
  attempts++
  const generation = jobGeneration
  let timeout
  try {
    const snapshot = await bounded(wc.executeJavaScript('window.__deepseekSelectionShareProbe?.snapshot() || null'))
    const current = identity(wc.getURL())
    if (!snapshot || !current || snapshot.conversationId !== current.id || snapshot.sourcePath !== current.path) {
      log('SELECTION-BLOCKED', { reason: 'selection-source-not-current' }); status('没有读到当前选区，请重新选择回答中的文字'); return
    }
    log('QUESTION-ENTER', { conversationAlias: digest(current.id), questionLength: snapshot.questionLength,
      selectedLength: snapshot.selectedText.length, answerLength: snapshot.answerText.length,
      virtualRowKey: /^\d+$/.test(snapshot.virtualRowKey) ? Number(snapshot.virtualRowKey) : 'opaque-not-used-as-message-id' })
    if (tasks.size) await Promise.race([Promise.allSettled([...tasks]), new Promise(resolve => setTimeout(resolve, 1500))])
    if (closing || generation !== jobGeneration || identity(wc.getURL())?.id !== current.id) return
    const range = resolveSelection(snapshot)
    if (range.error) {
      log('SELECTION-BLOCKED', { reason: range.error, matchingIds: range.count, historyAvailable: histories.has(current.id) })
      status('暂未唯一识别所选回答；原因已记录，请把日志交给智能体（不会打开分享弹窗）'); return
    }
    if (!auth) { log('SELECTION-BLOCKED', { reason: 'authenticated-api-headers-unavailable' }); status('尚未观察到登录请求信息，请重新打开该会话'); return }
    const before = await bounded(wc.executeJavaScript(`(${uiMetadata.toString()})()`))
    if (before.shareControls.length) { log('SELECTION-BLOCKED', { reason: 'manual-share-panel-already-open' }); status('请关闭手动分享面板后重新按 Enter'); return }
    if (closing || generation !== jobGeneration || identity(wc.getURL())?.id !== current.id) return
    const headers = { ...auth, 'content-type': 'application/json', accept: 'application/json', Origin: ORIGIN, Referer: ORIGIN + current.path }
    const controller = new AbortController()
    activeAbort = controller
    timeout = setTimeout(() => controller.abort(), 15000)
    log('CREATE-START', { targetMessageId: range.target, messageIds: range.ids, rangeMode: range.mode,
      historyPath: range.path, conversationAlias: digest(current.id), dialogsBefore: before.dialogs,
      headerNames: Object.keys(headers), manualShareRequired: false })
    status('正在后台创建分享链接…')
    const response = await pageSession.fetch(ORIGIN + '/api/v0/share/create', { method: 'POST', headers,
      body: JSON.stringify({ chat_session_id: current.id, message_ids: range.ids }), credentials: 'include',
      redirect: 'error', signal: controller.signal })
    const json = await readJson(response)
    if (closing || generation !== jobGeneration || identity(wc.getURL())?.id !== current.id) return
    log('CREATE-RESPONSE', { status: response.status, schema: shape(json) })
    const id = json?.data?.biz_data?.share_id
    if (!response.ok || json?.code !== 0 || json.data?.biz_code !== 0 || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      status('创建接口未返回成功链接，错误已记录；不会自动重试'); return
    }
    const url = ORIGIN + '/share/' + id
    clipboard.writeText(url)
    successes++
    const after = await bounded(wc.executeJavaScript(`(${uiMetadata.toString()})()`)).catch(() => null)
    log('SHARE-LINK', { url, copied: true, targetMessageId: range.target, messageCount: range.ids.length,
      dialogsAfter: after?.dialogs, manualShareRequired: false, scriptClicks: 0 })
    status('分享链接已获取并复制：' + url)
  } catch (error) { log('CREATE-FAILED', errorShape(error)); status('获取失败，过程已记录；不会自动打开弹窗或重试') }
  finally { clearTimeout(timeout); activeAbort = null; busy = false }
}

const instructions = [
  'DeepSeek 选区 → 询问 AI → Enter → 获取链接（直接流程测试）',
  `日志：${logPath}`, '',
  '1. 先关闭正常应用及旧探针，再运行本探针。打开需要测试的已有 DeepSeek 会话。',
  '2. 页面加载后等待约 3 秒，在一条回答里选中文字，点击浮出的“询问 AI”输入框。',
  '3. 可以输入问题，按 Enter 获取链接；空问题也允许用于本次链接测试。Shift+Enter 换行，输入法选字回车不触发。',
  '4. 成功后窗口标题和终端会显示链接，链接自动复制到剪贴板。核对来源回答和分享范围。',
  '5. 关闭探针，把 .log 路径交给智能体。', '',
  '不需要 F6/F7/F9，不需要手动点分享、创建或复制。脚本不点击页面控件，不创建新会话，不发送模型消息。',
  '真实消息编号来自本轮页面的历史响应，选区用回答正文唯一匹配。虚拟列表行号只记日志，不当作消息编号。',
  '无法识别消息结构、所选回答重复、历史缺失或登录信息缺失时，只记录原因，不猜编号，不退回弹窗。',
  '历史正文和认证请求头只在内存中使用，不写日志；日志包含消息编号/关系、正文长度和摘要、状态和最终分享链接。',
  '分享接口、请求字段和成功返回字段来自此前用户运行的实测日志。消息历史结构与范围仍需本轮确认。'
].join('\n')
writeFileSync(instructionsPath, instructions, { flag: 'wx', encoding: 'utf8' })

app.whenReady().then(async () => {
  log('START', { logPath, instructionsPath, electron: process.versions.electron, manualShareRequired: false, scriptClicks: 0, usesReplayTemplate: false })
  console.log(instructions)
  pageSession = session.fromPartition(PARTITION)
  pageSession.setUserAgent(USER_AGENT)
  await pageSession.setProxy({ mode: 'fixed_servers', proxyRules: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  log('PROXY-READY')
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '测试', submenu: [
      { label: '打印操作步骤和日志路径', click: () => console.log(instructions) },
      { label: '重新加载页面', role: 'reload' },
      { label: '我核对过：无分享弹窗，且链接范围正确', click: () => log('USER-CHECK', { result: 'no-share-dialog-and-correct-range' }) },
      { label: '我核对过：出现弹窗或链接范围不正确', click: () => log('USER-CHECK', { result: 'dialog-or-incorrect-range' }) },
      { role: 'close', label: '关闭探针' }
    ] },
    { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]))
  win = new BrowserWindow({ width: 1300, height: 950, title: 'DeepSeek 选区分享测试',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      backgroundThrottling: false, spellcheck: false } })
  wc = win.webContents
  log('WINDOW-CREATED')
  wc.setUserAgent(USER_AGENT)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('page-title-updated', event => event.preventDefault())
  wc.on('before-input-event', (_event, input) => { if (input.type === 'keyDown' && input.key === 'Enter' && !input.isAutoRepeat) nativeEnterAt = Date.now() })
  wc.on('console-message', details => {
    if (!details.message.startsWith(tag) || Date.now() - nativeEnterAt > 1000) return
    try {
      const report = JSON.parse(details.message.slice(tag.length))
      if (report.event !== 'selection-enter') return
      nativeEnterAt = 0
      void createFromSelection()
    } catch { log('INVALID-ENTER-REPORT') }
  })
  const installUi = () => {
    if (new URL(wc.getURL()).origin === ORIGIN) void wc.executeJavaScript(pageSource).catch(error => log('UI-INSTALL-FAILED', errorShape(error)))
  }
  wc.on('dom-ready', installUi)
  wc.on('did-finish-load', () => {
    log('PAGE-LOADED', { path: pathForLog(wc.getURL()), deepseekPage: new URL(wc.getURL()).origin === ORIGIN })
    installUi()
  })
  wc.on('did-navigate-in-page', (_event, url, isMain) => {
    if (!isMain) return
    jobGeneration++
    activeAbort?.abort()
    log('NAVIGATE', { conversationAlias: identity(url) ? digest(identity(url).id) : null })
  })
  wc.on('did-start-navigation', (_event, _url, isInPlace, isMain) => {
    if (isMain && !isInPlace) { jobGeneration++; activeAbort?.abort(); log('PAGE-NAVIGATION-START') }
  })
  wc.on('did-fail-load', (_event, code, _description, _url, isMain) => {
    if (isMain && code !== -3) { log('LOAD-FAILED', { code }); status('页面加载失败，错误码 ' + code + '；请查看终端日志') }
  })
  wc.on('render-process-gone', (_event, details) => {
    log('RENDER-PROCESS-GONE', { reason: details.reason, exitCode: details.exitCode })
    status('页面进程已退出；请查看终端日志')
  })
  uiTimer = setInterval(() => {
    if (closing || !identity(wc.getURL())) return
    observe(bounded(wc.executeJavaScript(`(${uiMetadata.toString()})()`)).then(info => {
      const value = JSON.stringify(info)
      if (value !== lastUiMetadata) { log('UI', info); lastUiMetadata = value }
    }))
  }, 2500)
  win.on('close', event => {
    if (closing) return
    event.preventDefault()
    closing = true
    clearInterval(uiTimer)
    activeAbort?.abort()
    void Promise.race([Promise.allSettled([...tasks]), new Promise(resolve => setTimeout(resolve, 1200))]).finally(() => {
      log('COVERAGE', { attempts, successes, histories: histories.size, authenticatedHeadersObserved: !!auth,
        note: 'Direct selection flow; share content and range require user verification. No manual-share replay template.' })
      auth = null
      histories.clear()
      requests.clear()
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      win.destroy()
    })
  })
  // Network.enable can wait for an initial renderer. Waiting for it before the
  // first loadURL leaves the new BrowserWindow on about:blank indefinitely.
  // Attach synchronously to capture the first requests; let enable and the page
  // load progress together, as in the previous user-tested share probe.
  try {
    log('NETWORK-ENABLE-START')
    void observeNetwork().then(() => {
      if (!closing) log('NETWORK-READY')
    }).catch(error => {
      if (!closing) { log('NETWORK-ENABLE-FAILED', errorShape(error)); status('历史采集初始化失败，请把日志交给智能体') }
    })
  } catch (error) {
    log('NETWORK-ATTACH-FAILED', errorShape(error))
    status('历史采集连接失败，请把日志交给智能体')
  }
  log('PAGE-LOAD-START', { path: pathForLog(start.href) })
  await wc.loadURL(start.href).catch(error => log('LOAD-REJECTED', errorShape(error)))
}).catch(error => { log('FATAL', errorShape(error)); app.quit() })
app.on('window-all-closed', () => app.quit())
