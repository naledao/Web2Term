import type { WebContents, Session, OnBeforeRequestListenerDetails } from 'electron'
import type { FocusEditDiagnostic } from '../shared/focus-chat'

export interface FocusEditSubmission extends FocusEditDiagnostic {
  messageId: string | null
}
interface ExpectedEdit {
  origin: string
  submissionPath: string
  conversationId: string
  text: string
  originalText: string
  prefix: string
}
type ObserveRequest = (details: OnBeforeRequestListenerDetails) => void
const observers = new WeakMap<Session, Map<number, ObserveRequest>>()
const MAX_BODY = 512 * 1024
const normalize = (text: string): string => text.replace(/[\u0000\u0001\u2063]/g, '').replace(/\s+/g, ' ').trim()

/** The measured text-only native request. Compare in memory; return metadata only. */
export function summarizeFocusEditRequest(details: Pick<OnBeforeRequestListenerDetails, 'method' | 'url' | 'uploadData'>,
  expected: ExpectedEdit): FocusEditSubmission | null {
  const url = new URL(details.url)
  if (details.method !== 'POST' || url.origin !== expected.origin || url.pathname !== expected.submissionPath) return null
  const unavailable = (reason: string): FocusEditSubmission => ({ messageId: null, requestBodyReadable: false, reason })
  const chunks = details.uploadData
  // Never read file paths or resolve blobs to diagnose a pure-text edit.
  if (!chunks?.length || chunks.some(item => !Buffer.isBuffer(item.bytes)) ||
    chunks.reduce((size, item) => size + item.bytes!.length, 0) > MAX_BODY) return unavailable('request-body-unavailable')
  let body
  try { body = JSON.parse(Buffer.concat(chunks.map(item => item.bytes!)).toString('utf8')) }
  catch { return unavailable('request-body-unavailable') }
  if (body?.conversation_id !== expected.conversationId) return null
  if (body.action !== 'next' || !Array.isArray(body.messages) || body.messages.length !== 1) return unavailable('request-schema-unavailable')
  const message = body.messages[0]
  if (message?.author?.role !== 'user' || message.content?.content_type !== 'text' ||
    !Array.isArray(message.content.parts) || message.content.parts.length !== 1 || typeof message.content.parts[0] !== 'string' ||
    typeof message.id !== 'string' || !/^[a-zA-Z0-9_:-]{1,160}$/.test(message.id)) return unavailable('request-schema-unavailable')
  const actual = message.content.parts[0]
  const at = Math.max(actual.lastIndexOf('\u2063\u2063'), actual.lastIndexOf('\u0000\u0001'))
  const human = at < 0 ? null : normalize(actual.slice(at + 2))
  // An editor can remove the invisible separator or legacy control characters.
  // In that case require the entire payload to match, rather than a suffix of old text.
  const matches = (text: string): boolean => human !== null ? human === normalize(text) :
    normalize(actual) === normalize(text) || (!!expected.prefix && normalize(actual) === normalize(expected.prefix + text))
  const requestTextMatches = matches(expected.text)
  const requestOriginalMatches = matches(expected.originalText)
  return {
    messageId: message.id, requestBodyReadable: true, requestTextMatches, requestOriginalMatches,
    ...(human !== null ? { requestUserLength: human.length } : {}),
    reason: requestTextMatches ? 'request-matched' : requestOriginalMatches ? 'request-original' : 'request-mismatch'
  }
}

/** One passive listener per partition; only the active editing view's request is read. */
export function observeFocusEditRequest(contents: WebContents, expected: ExpectedEdit,
  receive: (submission: FocusEditSubmission) => void): () => void {
  let count = 0
  return observeFocusPageRequest(contents, expected.origin, details => {
    const page = new URL(contents.getURL())
    if (page.origin !== expected.origin || !page.pathname.endsWith('/' + expected.conversationId)) return
    const summary = summarizeFocusEditRequest(details, expected)
    if (summary) receive({ ...summary, requestCount: ++count })
  })
}

/** Shared slot for a user-initiated edit or smart-component action, never two listeners. */
export function observeFocusPageRequest(contents: WebContents, origin: string, receive: ObserveRequest): () => void {
  const ses = contents.session
  let active = observers.get(ses)
  if (!active) {
    active = new Map()
    observers.set(ses, active)
    const dispatch = active
    ses.webRequest.onBeforeRequest({ urls: [origin + '/backend-api/*'] }, (details, callback) => {
      // Observation does not block, cancel or rewrite the request.
      callback({})
      try { if (details.webContentsId !== undefined) dispatch.get(details.webContentsId)?.(details) } catch { /* metadata only */ }
    })
  }
  const observe: ObserveRequest = details => {
    if (contents.isDestroyed()) return
    const main = contents.mainFrame, frame = details.frame
    // Electron may expose another wrapper for the same frame. Compare its public
    // identity while still excluding iframe requests from the native send proof.
    if (frame && frame !== main && !(Number.isSafeInteger(frame.processId) && Number.isSafeInteger(frame.routingId) &&
      frame.processId === main.processId && frame.routingId === main.routingId)) return
    if (new URL(contents.getURL()).origin !== origin) return
    receive(details)
  }
  active.set(contents.id, observe)
  return () => { if (active.get(contents.id) === observe) active.delete(contents.id) }
}
