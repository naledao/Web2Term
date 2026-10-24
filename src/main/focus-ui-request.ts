import type { OnBeforeRequestListenerDetails } from 'electron'
/** Read only an already submitted native request. No endpoint replay or saved payload. */
export function smartUiSubmission(details: Pick<OnBeforeRequestListenerDetails, 'url' | 'method' | 'uploadData'>,
  expected: { origin: string; path: string; conversationId: string; sourceMessageId: string; selectedValue: string }):
  { matched: boolean; messageId: string | null; text: string; reason: string;
    requestStatePresent?: boolean; requestStateMatches?: boolean; requestSnapshotCount?: number } | null {
  const url = new URL(details.url)
  if (details.method !== 'POST' || url.origin !== expected.origin || url.pathname !== expected.path) return null
  const unknown = { matched: false, messageId: null, text: '', reason: 'request-body-unavailable' }
  const chunks = details.uploadData
  if (!chunks?.length || chunks.some(item => !Buffer.isBuffer(item.bytes)) || chunks.reduce((size, item) => size + item.bytes!.length, 0) > 512 * 1024) return unknown
  try {
    const body = JSON.parse(Buffer.concat(chunks.map(item => item.bytes!)).toString('utf8'))
    if (body?.conversation_id !== expected.conversationId || body.parent_message_id !== expected.sourceMessageId) return null
    if (body.action !== 'next' || !Array.isArray(body.messages) || body.messages.length !== 1) return unknown
    const message = body.messages[0]
    if (message?.author?.role !== 'user' || message.content?.content_type !== 'text' || !Array.isArray(message.content.parts) ||
      message.content.parts.length !== 1 || typeof message.content.parts[0] !== 'string' || !message.content.parts[0].trim() || message.content.parts[0].length > 20000 ||
      typeof message.id !== 'string' || !/^[a-zA-Z0-9_:-]{1,160}$/.test(message.id)) return unknown
    const snapshots = Array.isArray(body.genui_state_snapshots) ? body.genui_state_snapshots : []
    const snapshot = snapshots.find((item: { message_id?: string }) => item?.message_id === expected.sourceMessageId)
    const requestStateMatches = !!snapshot?.root && typeof snapshot.root === 'object' && !Array.isArray(snapshot.root) &&
      Object.values(snapshot.root).includes(expected.selectedValue)
    // A state discrepancy is diagnostic, not grounds to discard a message ChatGPT
    // already sent. Ownership comes from origin/conversation/parent, then trusted
    // target input and the actual new native user id are checked on the page.
    return { matched: true, messageId: message.id, text: message.content.parts[0], requestStatePresent: !!snapshot,
      requestStateMatches, requestSnapshotCount: snapshots.length,
      reason: requestStateMatches ? 'request-matched' : snapshot ? 'request-state-mismatch' : 'request-state-absent' }
  } catch { return unknown }
}
