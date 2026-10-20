import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepSeekContextSnapshot, deepSeekMessageRange, deepSeekShareUrl, DeepSeekQuestionError } from '../shared/deepseek-question'
import type { DeepSeekContextSnapshot, DeepSeekSelection } from '../shared/deepseek-question'

const ORIGIN = 'https://chat.deepseek.com'
const credentials = new Map<number, Record<string, string>>()
let credentialGeneration = 0
let currentAuthorization = ''
let logPath = ''

export function writeQuestionLog(event: string, details: Record<string, unknown> = {}): string {
  try {
    if (!logPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `deepseek-question-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`, 'utf8')
  } catch { /* Logging never blocks the user's question. */ }
  return logPath
}

/** Called by the EXISTING identity handler: no second webRequest registration. */
export function observeDeepSeekHeaders(details: Electron.OnBeforeSendHeadersListenerDetails): void {
  let url: URL
  try { url = new URL(details.url) } catch { return }
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/') || !details.webContentsId || details.webContentsId < 0) return
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(details.requestHeaders)) {
    if (/^(authorization|x-client-bundle-id|x-client-locale|x-client-platform|x-client-timezone-offset|x-client-version|x-device-id|x-device-model)$/i.test(key) && typeof value === 'string') {
      headers[key.toLowerCase()] = value
    }
  }
  if (/\/(logout|login)(\/|$)/i.test(url.pathname)) {
    credentials.clear(); currentAuthorization = ''; credentialGeneration++
    return
  }
  if (!headers.authorization) return
  if (currentAuthorization && currentAuthorization !== headers.authorization) {
    credentials.clear(); credentialGeneration++
  }
  currentAuthorization = headers.authorization
  credentials.set(details.webContentsId, { ...credentials.get(details.webContentsId), ...headers })
}

export function releaseDeepSeekHeaders(contentsId: number): void { credentials.delete(contentsId) }

export function questionPageCall<T>(contents: Electron.WebContents, source: string, timeoutMs = 4000): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    contents.executeJavaScript(source) as Promise<T>,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(
      new DeepSeekQuestionError('page-timeout', '页面暂时没有响应，请稍后重试。')
    ), timeoutMs) })
  ]).finally(() => clearTimeout(timer))
}

async function responseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok) throw new DeepSeekQuestionError('http-status', `DeepSeek 请求失败（HTTP ${response.status}），请确认登录及网络后重试。`)
  if (!/json/i.test(response.headers.get('content-type') ?? '')) throw new DeepSeekQuestionError('not-json', 'DeepSeek 返回了非预期页面，请确认登录及网络后重试。')
  const reader = response.body?.getReader()
  if (!reader) throw new DeepSeekQuestionError('empty-response', 'DeepSeek 返回了空响应，请重试。')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) { await reader.cancel(); throw new DeepSeekQuestionError('response-size', '会话历史过大，暂时无法创建分享链接。') }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { reader.releaseLock() }
}

export async function createDeepSeekSelectionShare(
  contents: Electron.WebContents,
  conversationId: string,
  selection: DeepSeekSelection,
  signal: AbortSignal,
  isCurrent: () => boolean,
  onContext?: (snapshot: DeepSeekContextSnapshot) => Promise<void>
): Promise<string> {
  const auth = credentials.get(contents.id)
  if (!auth?.authorization) throw new DeepSeekQuestionError('no-credentials', '尚未读取到 DeepSeek 登录状态，请刷新原会话后重试。')
  const generation = credentialGeneration
  const check = (): void => {
    if (signal.aborted || !isCurrent() || generation !== credentialGeneration) throw new DeepSeekQuestionError('cancelled', '本次提问已取消。')
  }
  const headers = { ...auth, accept: 'application/json', Origin: ORIGIN, Referer: ORIGIN + selection.sourcePath, 'User-Agent': contents.getUserAgent() }
  check()
  // A fresh main-process GET has no page-side known-message/cache hints and no
  // conditional headers. The SPA's incremental history can legitimately be [].
  const historyUrl = new URL('/api/v0/chat/history_messages', ORIGIN)
  historyUrl.searchParams.set('chat_session_id', conversationId)
  writeQuestionLog('HISTORY-START')
  const history = await contents.session.fetch(historyUrl.href, {
    method: 'GET', headers: { ...headers, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    credentials: 'include', redirect: 'error', signal
  })
  const json = await responseJson(history, 8 * 1024 * 1024)
  check()
  const messageIds = deepSeekMessageRange(json, conversationId, selection)
  writeQuestionLog('SHARE-START', { messageCount: messageIds.length, targetMessageId: messageIds[0] })
  const response = await contents.session.fetch(ORIGIN + '/api/v0/share/create', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ chat_session_id: conversationId, message_ids: messageIds }),
    credentials: 'include', redirect: 'error', signal
  })
  const result = await responseJson(response, 65536)
  check()
  const url = deepSeekShareUrl(result)
  writeQuestionLog('SHARE-LINK', { url, messageCount: messageIds.length })
  if (onContext) {
    await onContext(deepSeekContextSnapshot(json, messageIds, url, selection))
    check()
  }
  return url
}
