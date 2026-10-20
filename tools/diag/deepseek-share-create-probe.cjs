/**
 * User-run discovery + explicit replay of DeepSeek's actual share-create request.
 * Manual baseline: F6, share a reply, create its link. The measured creation
 * response supplies the share ID directly; clipboard correlation is optional.
 * Background check: close the native share dialog, select answer text, enter a
 * question, press Enter (or F9). Only the captured, correlated POST is replayed.
 * No guessed API path, automatic login, DOM click, new chat or model submission.
 */
const { app, BrowserWindow, Menu, clipboard, session } = require('electron')
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const vm = require('node:vm')

const ORIGIN = 'https://chat.deepseek.com'
const start = new URL(process.env.PROBE_START_URL || ORIGIN + '/')
if (start.origin !== ORIGIN || start.username || start.password) throw new Error('PROBE_START_URL 必须是 DeepSeek 页面。')
const PARTITION = 'persist:deepseek'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
const MAX_BODY = 512 * 1024
const tag = '[deepseek-share-create-' + randomUUID() + '] '
app.setPath('userData', process.env.PROBE_USER_DATA || join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = join(app.getPath('temp'), 'gpt-login-diag')
mkdirSync(directory, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
const logPath = join(directory, `deepseek-share-create-${stamp}.log`)
const instructionsPath = join(directory, `deepseek-share-create-${stamp}.txt`)
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
const errorShape = error => ({ name: error?.name || 'Error', code: typeof error?.code === 'string' && /^[A-Z_0-9:-]+$/i.test(error.code) ? error.code : undefined })
let win
let wc
let pageSession
let baseline = null
let learned = null
let replaying = false
let closing = false
let replayAbort = null
let nextRequest = 1
let nativeEnterAt = 0
let capturedResponses = 0
let createdLinkSeen = false
let copiedLinkSeen = false
let successfulReplay = false
const requests = new Map()
const completed = []
const tasks = new Set()

function log(event, details = {}) {
  const line = new Date().toISOString() + ' ' + event + ' ' + JSON.stringify(details)
  try { appendFileSync(logPath, line + '\n', 'utf8') } catch { console.error('诊断日志写入失败。') }
  console.log(line)
}
function status(text) {
  if (win && !win.isDestroyed()) win.setTitle('DeepSeek 创建分享诊断 · ' + text)
  console.log(text)
}
function observeTask(promise) {
  tasks.add(promise)
  void promise.catch(error => log('OBSERVATION-FAILED', errorShape(error))).finally(() => tasks.delete(promise))
}
function bounded(promise, milliseconds = 3500) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { const error = new Error('timeout'); error.name = 'TimeoutError'; reject(error) }, milliseconds)
  })]).finally(() => clearTimeout(timer))
}
function shareUrl(raw) {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw.trim())
    return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && /^\/share\/[\w-]+\/?$/.test(url.pathname)
      ? url.origin + url.pathname.replace(/\/$/, '') : null
  } catch { return null }
}
function clipboardShareUrl(raw) {
  const text = String(raw || '').replace(/[\u200B-\u200D\uFEFF]/g, '')
  const candidates = text.match(/https:\/\/chat\.deepseek\.com\/share\/[a-zA-Z0-9_-]+\/?(?:[?#][^\s<>"'）)]*)?/g) || []
  const urls = candidates.flatMap(candidate => {
    try {
      const url = new URL(candidate)
      const normalized = shareUrl(url.origin + url.pathname)
      return normalized ? [normalized] : []
    } catch { return [] }
  })
  const unique = [...new Set(urls)]
  return unique.length === 1 ? unique[0] : null
}
function pageIdentity(raw) {
  try {
    const url = new URL(raw)
    const match = /^\/a\/chat\/s\/([^/]+)\/?$/.exec(url.pathname)
    return { conversation: url.origin === ORIGIN && !!match, alias: match ? digest(match[1]) : null }
  } catch { return { conversation: false, alias: null } }
}
function endpoint(raw) {
  try {
    const url = new URL(raw)
    return { origin: url.origin, path: url.pathname.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, ':id').replace(/[\w-]{25,}/g, ':id'),
      queryKeys: [...url.searchParams.keys()].filter(key => /^[a-zA-Z_][\w-]{0,60}$/.test(key)).slice(0, 12) }
  } catch { return { origin: 'invalid' } }
}
function shareRelated(raw) {
  try { const url = new URL(raw); return url.origin === ORIGIN && /share|snapshot/i.test(url.pathname) } catch { return false }
}
function safeCreateCandidate(record) {
  const path = new URL(record.url).pathname
  // A POST with the copied link in its response is the evidence; some API routes
  // are nouns without a "create" verb. Destructive/update routes stay excluded.
  return record.method === 'POST' && shareRelated(record.url) &&
    !/delete|remove|revoke|cancel|disable|update|report|unpublish/i.test(path) && record.jsonRequest &&
    record.status >= 200 && record.status < 300 && !!record.response
}
function schema(value, key = '', depth = 0) {
  if (depth > 6) return { type: 'depth-limit' }
  if (/token|authorization|password|secret|cookie|credential|signature|proof/i.test(key)) return { type: 'redacted' }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : { type: 'number' }
  if (typeof value === 'string') {
    const publicLink = shareUrl(value)
    if (publicLink) return { type: 'share-url', alias: digest(publicLink) }
    return { type: 'string', length: value.length, alias: /(?:^|_)(?:id|ids|uuid)$/.test(key) ? digest(value) : undefined }
  }
  if (Array.isArray(value)) return { type: 'array', length: value.length, items: value.slice(0, 40).map(item => schema(item, key, depth + 1)), truncated: value.length > 40 }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 70).map(([name, item]) => [name, schema(item, name, depth + 1)]))
  return { type: typeof value }
}
function leafMatches(value, copiedUrl, path = '$', output = [], depth = 0) {
  if (depth > 8 || output.length > 20) return output
  if (typeof value === 'string') {
    const slug = new URL(copiedUrl).pathname.split('/').at(-1)
    if (shareUrl(value) === copiedUrl) output.push({ path, format: 'full-url' })
    else if (value === '/share/' + slug) output.push({ path, format: 'relative-url' })
    else if (value === slug) output.push({ path, format: 'share-id' })
  } else if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => leafMatches(item, copiedUrl, path + '[' + index + ']', output, depth + 1))
  } else if (value && typeof value === 'object') {
    Object.entries(value).slice(0, 100).forEach(([key, item]) => {
      if (!/token|password|secret|cookie|credential/i.test(key)) leafMatches(item, copiedUrl, path + '.' + key, output, depth + 1)
    })
  }
  return output
}
function valueAt(value, fieldPath) {
  if (fieldPath === '$') return value
  const keys = fieldPath.slice(2).replace(/\[(\d+)\]/g, '.$1').split('.')
  return keys.reduce((current, key) => current && typeof current === 'object' ? current[key] : undefined, value)
}

// Observation only. Describes the user's actual share controls rather than
// guessing a selector to click. Message text and composer contents are omitted.
function readUi() {
  const visible = node => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' }
  const describe = node => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute('role'),
    className: String(node.className?.baseVal ?? node.className ?? '').slice(0, 180),
    dataAttributeNames: [...node.attributes].map(attribute => attribute.name).filter(name => name.startsWith('data-')).slice(0, 15) })
  const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visible).flatMap(node => {
    const text = (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || '').trim()
    if (text.length > 65 || !/分享|创建链接|复制链接|copy link|create link|share/i.test(text)) return []
    return [{ ...describe(node), label: text, disabled: node.getAttribute('aria-disabled') === 'true' || node.hasAttribute('disabled') }]
  }).slice(0, 20)
  const dialogs = [...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')].filter(visible).map(describe).slice(0, 12)
  const links = [...document.querySelectorAll('input, textarea, a[href]')].filter(visible).map(node => String(node.value || node.getAttribute('href') || '')).filter(value => /^https:\/\/chat\.deepseek\.com\/share\/[\w-]+\/?$/.test(value)).slice(0, 8)
  return { controls, dialogs, links, answerNodes: document.querySelectorAll('.ds-assistant-message-main-content').length,
    virtualRows: document.querySelectorAll('[data-virtual-list-item-key]').length }
}
async function snapshot(label) {
  if (!wc || wc.isDestroyed() || new URL(wc.getURL() || 'about:blank').origin !== ORIGIN) return
  try {
    const info = await bounded(wc.executeJavaScript(`(${readUi.toString()})()`))
    log('UI', { label, page: pageIdentity(wc.getURL()), ...info })
  } catch (error) { log('UI-FAILED', { label, ...errorShape(error) }) }
}

function installProbeEnter(logTag) {
  if (window.__deepseekShareCreateProbe) return
  window.__deepseekShareCreateProbe = true
  let composing = false
  window.addEventListener('compositionstart', () => { composing = true }, true)
  window.addEventListener('compositionend', () => { composing = false }, true)
  window.addEventListener('keydown', event => {
    const host = document.getElementById('cmd-terminal-selection-question')
    if (!host || !event.composedPath().includes(host) || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.isComposing || composing || event.keyCode === 229 || !event.isTrusted) return
    const draft = window.__cmdTerminalSelectionQuestion?.getDraft()
    if (!draft?.question.trim()) return
    event.preventDefault()
    event.stopImmediatePropagation()
    console.log(logTag + JSON.stringify({ event: 'enter-share-replay', questionLength: draft.question.trim().length, selectedLength: draft.selectedText.length }))
  }, true)
}
const uiSource = readFileSync(join(__dirname, '../../src/main/injected/selection-question.js'), 'utf8')
const uiCss = readFileSync(join(__dirname, '../../src/main/injected/selection-question.css'), 'utf8')
const installSource = `(${installProbeEnter.toString()})(${JSON.stringify(tag)});\n${uiSource}\n;window.__cmdTerminalSelectionQuestion.configure(${JSON.stringify({ theme: 'light', answerSelectors: ['.ds-assistant-message-main-content'], css: uiCss })});true`
new vm.Script(installSource) // Parse only; no page script is executed by this check.

async function startBaseline(kind) {
  if (replaying || tasks.size || requests.size) { status('正在完成采集，请稍后再开始下一组'); return }
  const identity = pageIdentity(wc.getURL())
  if (!identity.conversation) { status('请先打开要测试的原会话，再按 F6'); return }
  learned = null
  completed.length = 0
  baseline = { kind, sourcePath: new URL(wc.getURL()).pathname, alias: identity.alias }
  log('BASELINE-START', { kind, sourceConversationAlias: identity.alias })
  status('现在手动点击该回答的分享按钮并创建链接；成功后自动取链接，不需要复制或按 F7')
  await snapshot('before-manual-share')
}

function learnFromCreationResponse(record) {
  // Measured from the user's 2026-10-20 log, requests 1–3:
  // POST /api/v0/share/create, { chat_session_id, message_ids }, then
  // { code: 0, data: { biz_code: 0, biz_data: { share_id } } }.
  if (!baseline || closing || record.sourcePath !== baseline.sourcePath || record.sourcePath !== new URL(wc.getURL()).pathname) return
  const url = new URL(record.url)
  const json = record.response
  const request = record.jsonRequest
  if (url.origin !== ORIGIN || url.pathname !== '/api/v0/share/create' || !safeCreateCandidate(record) ||
    json?.code !== 0 || json.data?.biz_code !== 0 || !Array.isArray(request?.message_ids) ||
    typeof request.chat_session_id !== 'string' || digest(request.chat_session_id) !== baseline.alias) return
  const id = json.data.biz_data?.share_id
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) return
  const createdUrl = shareUrl(ORIGIN + '/share/' + id)
  if (!createdUrl) return
  learned = { ...record, matches: [{ path: '$.data.biz_data.share_id', format: 'share-id' }],
    copiedUrl: createdUrl, linkSource: 'creation-response' }
  createdLinkSeen = true
  log('CREATED-LINK', { request: record.alias, url: createdUrl, source: 'response.data.biz_data.share_id',
    clipboardRequired: false, messageCount: request.message_ids.length })
  log('TEMPLATE-LEARNED', { request: record.alias, endpoint: endpoint(record.url), method: record.method,
    sourceConversationAlias: baseline.alias, responseLinkFields: learned.matches, source: 'creation-response' })
  status('链接已直接从创建接口取得。关闭分享弹窗，在同一回答的询问 AI 中输入问题并按 Enter；也可按 F9')
}

function observeNetwork() {
  wc.debugger.attach('1.3')
  wc.debugger.on('detach', () => log('NETWORK-DETACHED'))
  wc.debugger.on('message', (_event, method, params) => {
    if (closing) return
    if (method === 'Network.requestWillBeSent') {
      if (!baseline || replaying || !shareRelated(params.request.url) || !['XHR', 'Fetch'].includes(params.type)) return
      const request = params.request
      if (requests.size >= 40) { log('CAPTURE-LIMIT'); return }
      const record = { alias: nextRequest++, url: request.url, method: request.method,
        headers: request.headers, body: request.postData, status: null, response: null,
        sourcePath: new URL(wc.getURL()).pathname, baselineKind: baseline.kind }
      try { record.jsonRequest = typeof record.body === 'string' ? JSON.parse(record.body) : null } catch { record.jsonRequest = null }
      requests.set(params.requestId, record)
      log('SHARE-REQUEST', { request: record.alias, kind: record.baselineKind, endpoint: endpoint(record.url), method: record.method,
        bodyAvailable: typeof record.body === 'string', requestSchema: schema(record.jsonRequest),
        headerNames: Object.keys(record.headers).filter(name => /^[\w-]+$/.test(name)) })
    } else if (method === 'Network.responseReceived' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId)
      record.status = params.response.status
      record.mimeType = params.response.mimeType
      log('SHARE-RESPONSE', { request: record.alias, status: record.status, mimeType: record.mimeType })
    } else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId)
      requests.delete(params.requestId)
      if (!/json/i.test(record.mimeType || '') || params.encodedDataLength > MAX_BODY) {
        log('BODY-SKIPPED', { request: record.alias, reason: 'not-small-json' }); return
      }
      observeTask((async () => {
        try {
          const result = await bounded(wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId }))
          const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
          if (Buffer.byteLength(body) > MAX_BODY || closing) return
          record.response = JSON.parse(body)
          if (completed.length < 40) completed.push(record)
          capturedResponses++
          log('SHARE-RESPONSE-SCHEMA', { request: record.alias, responseSchema: schema(record.response),
            eligibleForReplay: safeCreateCandidate(record) })
          learnFromCreationResponse(record)
        } catch (error) { log('BODY-UNAVAILABLE', { request: record.alias, ...errorShape(error) }) }
      })())
    } else if (method === 'Network.loadingFailed' && requests.has(params.requestId)) {
      const record = requests.get(params.requestId)
      requests.delete(params.requestId)
      log('SHARE-REQUEST-FAILED', { request: record.alias, canceled: !!params.canceled })
    }
  })
  void wc.debugger.sendCommand('Network.enable', { maxPostDataSize: 65536, maxResourceBufferSize: MAX_BODY, maxTotalBufferSize: 4 * MAX_BODY })
    .catch(error => log('NETWORK-ENABLE-FAILED', errorShape(error)))
}

async function correlateClipboard() {
  if (!baseline || replaying) { status('请先按 F6 开始一组手动分享采集'); return }
  await Promise.race([Promise.allSettled([...tasks]), new Promise(resolve => setTimeout(resolve, 1200))])
  const text = clipboard.readText()
  const url = clipboardShareUrl(text)
  if (!url) {
    log('CLIPBOARD-NOT-A-SHARE-LINK', { textLength: text.length, containsShareAddress: text.includes('chat.deepseek.com/share/'),
      formats: clipboard.availableFormats().slice(0, 12), creationResponseLinkAvailable: !!learned })
    status(learned ? '剪贴板格式未识别，但已从创建接口取得链接；关闭分享弹窗后可直接按 Enter 或 F9' : '暂未识别剪贴板格式；请创建一次分享链接，探针会直接从接口返回取得链接')
    return
  }
  copiedLinkSeen = true
  log('COPIED-LINK', { url })
  const candidates = completed.filter(record => record.sourcePath === baseline.sourcePath && safeCreateCandidate(record))
    .map(record => ({ record, matches: leafMatches(record.response, url) })).filter(candidate => candidate.matches.length)
  const endpoints = new Set(candidates.map(candidate => candidate.record.url))
  if (!candidates.length || endpoints.size !== 1) {
    log('TEMPLATE-NOT-LEARNED', { reason: candidates.length ? 'ambiguous-endpoints' : 'no-create-response-matching-copied-link',
      observedResponses: completed.length, matchingCandidates: candidates.length })
    status('链接已记录；还缺少可对应的创建请求，请先把日志发给智能体')
    await snapshot('clipboard-without-template')
    return
  }
  const selected = candidates.at(-1)
  learned = { ...selected.record, matches: selected.matches, copiedUrl: url }
  log('TEMPLATE-LEARNED', { request: learned.alias, endpoint: endpoint(learned.url), method: learned.method,
    sourceConversationAlias: baseline.alias, responseLinkFields: learned.matches })
  status('请求已关联：关闭分享弹窗，在询问 AI 中输入问题并按 Enter；或按 F9')
  await snapshot('after-copy')
}

async function readSmallJson(response) {
  if (!/json/i.test(response.headers.get('content-type') || '')) throw new TypeError('non-json')
  const reader = response.body?.getReader()
  if (!reader) throw new TypeError('empty-body')
  const chunks = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > MAX_BODY) { await reader.cancel(); throw new RangeError('body-limit') }
      chunks.push(Buffer.from(part.value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { reader.releaseLock() }
}

async function replay(trigger) {
  if (replaying || closing) return
  if (!learned) { status('尚未采集创建请求：请按 F6，手动创建一次链接；成功后会自动从接口取得'); return }
  if (new URL(wc.getURL()).origin !== ORIGIN || new URL(wc.getURL()).pathname !== learned.sourcePath) {
    log('REPLAY-BLOCKED', { reason: 'source-conversation-changed' }); status('当前会话已改变，请在该会话重新采集'); return
  }
  const template = learned
  replaying = true
  const before = await bounded(wc.executeJavaScript(`(${readUi.toString()})()`)).catch(() => null)
  if (closing || wc.isDestroyed() || new URL(wc.getURL()).pathname !== template.sourcePath) { replaying = false; return }
  if (!before || before.dialogs.length) { replaying = false; status('请先关闭 DeepSeek 分享弹窗，再测试后台创建'); return }
  replayAbort = new AbortController()
  const timeout = setTimeout(() => replayAbort?.abort(), 15000)
  // Keep application/auth headers ONLY in memory. Chromium supplies session
  // cookies. Transport headers and raw cookie values are never copied or logged.
  const headers = Object.fromEntries(Object.entries(template.headers).filter(([name]) => /^(accept|content-type|authorization|x-[\w-]+)$/i.test(name)))
  headers.Origin = ORIGIN
  headers.Referer = ORIGIN + template.sourcePath
  log('BACKGROUND-START', { trigger, request: template.alias, endpoint: endpoint(template.url), dialogsBefore: before.dialogs.length,
    applicationHeaderNames: Object.keys(headers), sameCapturedMessageRange: true })
  status('正在后台请求分享链接，不打开网站分享弹窗…')
  try {
    const response = await pageSession.fetch(template.url, { method: template.method, headers, body: template.body,
      credentials: 'include', redirect: 'error', signal: replayAbort.signal })
    const json = await readSmallJson(response)
    if (closing) return
    log('BACKGROUND-RESPONSE', { status: response.status, responseSchema: schema(json) })
    const links = template.matches.flatMap(match => {
      const value = valueAt(json, match.path)
      if (typeof value !== 'string') return []
      const url = shareUrl(match.format === 'share-id' ? ORIGIN + '/share/' + value : match.format === 'relative-url' ? ORIGIN + value : value)
      return url ? [url] : []
    })
    const unique = [...new Set(links)]
    if (!response.ok || unique.length !== 1) { status('后台请求未返回唯一有效链接，请查看日志；不会自动重试'); return }
    clipboard.writeText(unique[0])
    successfulReplay = true
    const after = await bounded(wc.executeJavaScript(`(${readUi.toString()})()`)).catch(() => null)
    log('BACKGROUND-LINK', { url: unique[0], copied: true, sameAsManualLink: unique[0] === template.copiedUrl,
      dialogsAfter: after?.dialogs.length, observation: 'Request returned a link; the script never clicked or opened a share dialog.' })
    status('后台获取成功，链接已复制。请核对链接中的消息范围，然后关闭探针')
  } catch (error) {
    log('BACKGROUND-FAILED', errorShape(error))
    status('后台获取失败，过程已记录；不会自动重试')
  } finally {
    clearTimeout(timeout)
    replayAbort = null
    replaying = false
  }
}

const instructions = [
  'DeepSeek 创建分享链接诊断：手动采集一次，再用 Enter 验证后台获取。',
  `日志：${logPath}`, '',
  '1. 先关闭正常应用，再运行此探针。它复用 persist:deepseek 登录，初始打开 DeepSeek 首页。',
  '2. 打开要测试的原会话，按 F6（最新回答），或 Shift+F6（较早回答）。',
  '3. 手动点击对应回答的分享按钮，按网站流程创建链接；等待终端出现 CREATED-LINK 和 TEMPLATE-LEARNED。',
  '   不需要点复制，也不需要 F7。链接直接由创建接口返回的 share_id 得到。F7 仅供可选核对剪贴板。',
  '   如果只打开一个旧链接且没有创建请求，可重新执行一次网站的创建操作；不自动撤销旧分享。',
  '4. 终端出现 TEMPLATE-LEARNED 后，手动关闭网站分享弹窗。',
  '5. 在刚才分享的同一回答中选中文字，浮出询问 AI 后输入一个问题，按 Enter。',
  '   探针只重放刚才采集的那一次分享创建请求；不点击分享按钮、不弹出网站分享窗口。F9 也可触发同样操作。',
  '6. 成功后链接自动进入剪贴板。核对链接对应的消息范围，再关闭探针，把 .log 路径发给智能体。',
  '   可在菜单中标记“无弹窗且范围正确”或“出现弹窗/范围不符/失败”。',
  '这一步不创建新聊天、不把问题发给模型；重放范围就是刚才人工分享请求的范围，尚未自动按选区裁剪。',
  '请求中的认证头只在内存中保留供这一次显式操作使用，不落盘；日志仅含字段结构、消息编号、状态、链接和控件信息。',
  '不记录 Cookie、Token、原会话正文和输入的问题；不自动创建初始公开分享，不自动登录，不重复重试。'
].join('\n')
writeFileSync(instructionsPath, instructions, { flag: 'wx', encoding: 'utf8' })

app.whenReady().then(async () => {
  pageSession = session.fromPartition(PARTITION)
  pageSession.setUserAgent(USER_AGENT)
  await pageSession.setProxy({ mode: 'fixed_servers', proxyRules: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '分享诊断', submenu: [
      { label: '开始采集：最新回答', accelerator: 'F6', click: () => { void startBaseline('latest') } },
      { label: '开始采集：较早回答（比较历史范围）', accelerator: 'Shift+F6', click: () => { void startBaseline('earlier') } },
      { label: '可选：核对剪贴板分享链接（不影响后台获取）', accelerator: 'F7', click: () => { void correlateClipboard() } },
      { label: '后台获取并复制链接（不打开分享弹窗）', accelerator: 'F9', click: () => { void replay('user-f9') } },
      { type: 'separator' },
      { label: '记录当前分享控件结构', accelerator: 'F8', click: () => { void snapshot('user-f8') } },
      { label: '我核对过：无弹窗，且链接消息范围正确', click: () => log('USER-CHECK', { result: 'no-dialog-and-correct-range' }) },
      { label: '我核对过：弹窗、消息范围或请求存在问题', click: () => log('USER-CHECK', { result: 'dialog-or-range-or-request-problem' }) },
      { label: '打印日志路径与操作步骤', click: () => console.log(instructions) },
      { role: 'close', label: '关闭探针' }
    ] },
    { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }
  ]))
  win = new BrowserWindow({ width: 1300, height: 950, title: 'DeepSeek 创建分享诊断',
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: false } })
  wc = win.webContents
  wc.setUserAgent(USER_AGENT)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('page-title-updated', event => event.preventDefault())
  wc.on('before-input-event', (_event, input) => { if (input.type === 'keyDown' && input.key === 'Enter' && !input.isAutoRepeat) nativeEnterAt = Date.now() })
  wc.on('console-message', details => {
    if (!details.message.startsWith(tag) || Date.now() - nativeEnterAt > 1000) return
    try {
      const report = JSON.parse(details.message.slice(tag.length))
      if (report.event !== 'enter-share-replay' || !Number.isInteger(report.questionLength) || report.questionLength < 1 || !Number.isInteger(report.selectedLength)) return
      nativeEnterAt = 0
      log('QUESTION-ENTER', { questionLength: report.questionLength, selectedLength: report.selectedLength })
      void replay('question-enter')
    } catch { log('INVALID-ENTER-REPORT') }
  })
  wc.on('did-finish-load', () => {
    if (new URL(wc.getURL()).origin === ORIGIN) void wc.executeJavaScript(installSource).catch(error => log('SELECTION-UI-FAILED', errorShape(error)))
  })
  wc.on('did-navigate-in-page', (_event, url, isMain) => {
    if (!isMain) return
    log('NAVIGATE', { page: pageIdentity(url) })
    if (baseline && new URL(url).pathname !== baseline.sourcePath) { learned = null; baseline = null; completed.length = 0; requests.clear(); replayAbort?.abort() }
  })
  wc.on('did-navigate', () => {
    if (!baseline) return
    learned = null
    baseline = null
    completed.length = 0
    requests.clear()
    replayAbort?.abort()
    log('CAPTURE-RESET', { reason: 'full-navigation-or-reload' })
  })
  wc.on('did-fail-load', (_event, code, _description, _url, isMain) => { if (isMain && code !== -3) log('LOAD-FAILED', { code }) })
  observeNetwork()
  win.on('close', event => {
    if (closing) return
    event.preventDefault()
    replayAbort?.abort()
    const finalSnapshot = snapshot('closing')
    closing = true
    void Promise.race([Promise.allSettled([finalSnapshot, ...tasks]), new Promise(resolve => setTimeout(resolve, 1500))]).finally(() => {
      log('COVERAGE', { capturedResponses, createdLinkSeen, copiedLinkSeen, templateLearned: !!learned, successfulReplay,
        note: 'A returned URL is evidence about replay, not automatic selected-message cutoff or model context access.' })
      learned = null
      baseline = null
      completed.length = 0
      requests.clear()
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      win.destroy()
    })
  })
  log('START', { logPath, instructionsPath, electron: process.versions.electron, partition: PARTITION, autoLogin: false, autoClick: false,
    replayPolicy: 'measured successful share/create response, or a create POST correlated with an optionally copied link; source conversation must stay unchanged' })
  console.log(instructions)
  await wc.loadURL(start.href).catch(error => log('LOAD-REJECTED', errorShape(error)))
}).catch(error => { log('FATAL', errorShape(error)); app.quit() })
app.on('window-all-closed', () => app.quit())
