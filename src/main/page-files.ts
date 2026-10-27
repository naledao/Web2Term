import type { WebContents } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreparedAttachment } from './file-access'
import type { FileSendOutcome } from '../shared/file-requests'
import type { FileReadingPlatform } from '../shared/types'
import { isQuestionChatHome, selectionQuestionConversation } from '../shared/deepseek-question'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const diagnosticLogPaths = new Map<FileReadingPlatform['id'], string>()

/** Append only upload diagnostics, never the message payload or file bytes. */
function writeDiagnostic(platformId: FileReadingPlatform['id'], token: string, event: string, details: Record<string, unknown>): void {
  try {
    let diagnosticLogPath = diagnosticLogPaths.get(platformId)
    if (!diagnosticLogPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      diagnosticLogPath = join(directory, `${platformId}-file-send-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
      diagnosticLogPaths.set(platformId, diagnosticLogPath)
    }
    appendFileSync(diagnosticLogPath, `${new Date().toISOString()} ${JSON.stringify({ token, event, ...details })}\n`)
  } catch { /* Diagnostics must never interrupt an upload. */ }
}

function diagnosticSnapshot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { available: false }
  const snapshot = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of ['status', 'rootFound', 'rootIsForm', 'images', 'imagesExpected', 'cards', 'namesSeen', 'nameSourceCount', 'missingNameCount', 'uploading', 'error', 'inputFiles', 'composerFound', 'sendFound', 'sendDisabled', 'draftEmpty', 'stopFound', 'draftCleared', 'newTurnSeen', 'turnFilesSeen', 'captionSeen', 'captionPrefixSeen', 'turnTextLength', 'captionLength', 'edited',
    'turnIdPresent', 'turnIdKnown', 'turnVisible', 'hiddenUserTurnCount', 'newTurnCount', 'baselineTurnIdCount', 'turnPosition', 'baselinePosition', 'turnKeyPresent', 'turnKeyKnown', 'baselineKeyCount', 'userTurnCount', 'baselinePositionAvailable', 'menuCount', 'localEntryCount', 'captionEntryCount', 'entryAmbiguous', 'entryClicked']) {
    if (typeof snapshot[key] === 'boolean' || typeof snapshot[key] === 'number' || (key === 'status' && typeof snapshot[key] === 'string')) result[key] = snapshot[key]
  }
  if (['none', 'fallback', 'id', 'other'].includes(String(snapshot.turnKeyShape))) result.turnKeyShape = snapshot.turnKeyShape
  if (['', 'files-not-selected', 'attachment-root-missing', 'attachment-names-missing', 'upload-in-progress', 'send-button-missing', 'send-button-disabled', 'still-generating'].includes(String(snapshot.readyBlockReason))) {
    result.readyBlockReason = snapshot.readyBlockReason
  }
  if (Array.isArray(snapshot.nameEvidence)) result.nameEvidence = snapshot.nameEvidence.slice(0, 5).map((raw) => {
    const name = raw as Record<string, unknown>
    return {
      index: Number.isSafeInteger(name.index) && Number(name.index) >= 0 ? name.index : null,
      nameLength: Number.isSafeInteger(name.nameLength) && Number(name.nameLength) >= 0 ? name.nameLength : null,
      method: ['exact', 'normalized', 'renamed', 'truncated', 'image', 'missing'].includes(String(name.method)) ? name.method : 'missing'
    }
  })
  if (Array.isArray(snapshot.fileInputs)) result.fileInputs = snapshot.fileInputs.slice(0, 12).map((raw) => {
    const input = raw as Record<string, unknown>
    const safe: Record<string, unknown> = { accept: String(input.accept ?? '').slice(0, 500), multiple: !!input.multiple, disabled: !!input.disabled, nearComposer: !!input.nearComposer }
    for (const key of ['index', 'compatible', 'selected', 'connected', 'hiddenAncestor']) {
      if (typeof input[key] === 'boolean' || typeof input[key] === 'number') safe[key] = input[key]
    }
    if (Array.isArray(input.ancestors)) safe.ancestors = input.ancestors.slice(0, 16).map((raw) => {
      const ancestor = raw as Record<string, unknown>
      const row: Record<string, unknown> = {}
      if (typeof ancestor.tag === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(ancestor.tag)) row.tag = ancestor.tag
      for (const key of ['depth', 'visible', 'containsComposer', 'hasMessages', 'isForm', 'fileInputs', 'composers', 'visibleComposers']) {
        if (typeof ancestor[key] === 'boolean' || typeof ancestor[key] === 'number') row[key] = ancestor[key]
      }
      return row
    })
    return safe
  })
  if (Array.isArray(snapshot.composerCandidates)) result.composerCandidates = snapshot.composerCandidates.slice(0, 12).map((raw) => {
    const composer = raw as Record<string, unknown>
    const safe: Record<string, unknown> = {}
    if (composer.tag === 'textarea' || composer.tag === 'div') safe.tag = composer.tag
    for (const key of ['index', 'visible', 'selected', 'focused']) {
      if (typeof composer[key] === 'boolean' || typeof composer[key] === 'number') safe[key] = composer[key]
    }
    return safe
  })
  if (Array.isArray(snapshot.attachmentAncestors)) result.attachmentAncestors = snapshot.attachmentAncestors.slice(0, 16).map((raw) => {
    const ancestor = raw as Record<string, unknown>
    const safe: Record<string, boolean | number> = {}
    for (const key of ['depth', 'hasMessages', 'isForm', 'selectedRoot', 'controls', 'fileInputs', 'visible', 'images', 'textNameMatches', 'labelNameMatches']) {
      if (typeof ancestor[key] === 'boolean' || typeof ancestor[key] === 'number') safe[key] = ancestor[key] as boolean | number
    }
    return safe
  })
  if (Array.isArray(snapshot.draftImages)) result.draftImages = snapshot.draftImages.slice(0, 8).map((raw) => {
    const image = raw as Record<string, unknown>
    const safe: Record<string, unknown> = {}
    for (const key of ['depth', 'naturalWidth', 'naturalHeight', 'width', 'height', 'offsetX', 'offsetY', 'visible', 'complete', 'altLength']) {
      if (typeof image[key] === 'boolean' || typeof image[key] === 'number') safe[key] = image[key]
    }
    // Scheme and hostname only: never a path or query, which can carry an account id.
    if (typeof image.scheme === 'string' && /^[a-z][a-z0-9+.-]{0,20}$/.test(image.scheme)) safe.scheme = image.scheme
    if (typeof image.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(image.host)) safe.host = image.host
    if (['', 'nav', 'aside', 'header', 'footer', 'a', 'button', 'role-button'].includes(String(image.landmark))) safe.landmark = image.landmark
    return safe
  })
  if (Array.isArray(snapshot.userAttachmentAncestors)) result.userAttachmentAncestors = snapshot.userAttachmentAncestors.slice(0, 7).map((raw) => {
    const ancestor = raw as Record<string, unknown>
    const safe: Record<string, boolean | number> = {}
    for (const key of ['depth', 'selectedRoot', 'hasOtherMessages', 'hasAssistant', 'hasComposer', 'images', 'filenameMatches']) {
      if (typeof ancestor[key] === 'boolean' || typeof ancestor[key] === 'number') safe[key] = ancestor[key] as boolean | number
    }
    return safe
  })
  return result
}

/** Upload through the page's own file input, then submit exactly once. */
export async function sendPageFiles(
  contents: WebContents,
  platformId: FileReadingPlatform['id'],
  attachments: PreparedAttachment[],
  token: string,
  isCurrent: () => boolean,
  signal: AbortSignal,
  options: { caption?: string; allowNewConversation?: boolean; userText?: string; computerResult?: { path: string; generation: number } } = {}
): Promise<FileSendOutcome> {
  const debuggerApi = contents.debugger
  let attached = false
  let submitted = false
  let sendClicked = false
  let detached = false
  let uploadError = false
  let chooserIntercepted = false
  let chooser: { backendNodeId: number; mode: string } | null = null
  const ownerUrl = contents.getURL()
  let acceptedConversationId: string | null = null
  const pageContext = (): { matches: boolean; transitioning: boolean; route: string; sameOrigin: boolean; conversationAccepted: boolean } => {
    const rejected = { matches: false, transitioning: false, route: 'other', sameOrigin: false, conversationAccepted: !!acceptedConversationId }
    if (contents.isDestroyed()) return { ...rejected, route: 'destroyed' }
    const url = contents.getURL()
    const initialSend = sendClicked && options.allowNewConversation === true && isQuestionChatHome(platformId, ownerUrl)
    try {
      const before = new URL(ownerUrl), after = new URL(url)
      if (!initialSend) return { ...rejected, matches: url === ownerUrl, route: url === ownerUrl ? 'owner' : 'changed', sameOrigin: after.origin === before.origin }
      if (after.origin !== before.origin) return rejected
      const conversation = selectionQuestionConversation(platformId, url)
      if (conversation) {
        // Query/hash normalization can follow creation of the new conversation.
        // Pin its identity rather than its first absolute URL, and never borrow
        // the acknowledgement from a different conversation.
        const matches = !acceptedConversationId || acceptedConversationId === conversation.id
        if (matches) acceptedConversationId = conversation.id
        return { matches, transitioning: false, route: 'conversation', sameOrigin: true, conversationAccepted: true }
      }
      if (isQuestionChatHome(platformId, url)) return { ...rejected, matches: !acceptedConversationId, route: 'home', sameOrigin: true }
      // A same-origin intermediate route may precede the final conversation.
      // Only read the owned send token while waiting; this route cannot confirm
      // success and does not authorize any upload, text insertion or submission.
      return { ...rejected, transitioning: true, sameOrigin: true }
    } catch { return { ...rejected, route: 'invalid' } }
  }
  const urlMatches = (): boolean => pageContext().matches
  const current = (): boolean => isCurrent() && urlMatches()
  const started = Date.now()
  let stage = 'begin'
  const log = (event: string, details: Record<string, unknown> = {}): void => writeDiagnostic(platformId, token, event, { platformId, stage, elapsedMs: Date.now() - started, ...details })
  const finish = (outcome: FileSendOutcome, reason: string): FileSendOutcome => {
    if (options.computerResult && outcome === 'upload-failed' && !submitted && stage !== 'submit') outcome = 'not-submitted'
    // Automatic screenshots may wait on an idle composer. A changed draft after upload is a
    // blocked delivery, never a reason to start another upload or recapture the desktop.
    if (options.computerResult && (outcome === 'busy' || outcome === 'no-composer') && stage !== 'begin') outcome = 'unknown'
    log('finish', { outcome, reason, submitted })
    if (outcome !== 'ok') console.warn(`[files:${platformId}] ${outcome} at ${stage}: ${reason}; log: ${diagnosticLogPaths.get(platformId) ?? 'unavailable'}`)
    return outcome
  }
  log('start', { attachmentCount: attachments.length, attachments: attachments.map(({ mimeType, sizeBytes, textNameAlias }) => ({ mimeType, sizeBytes, textNameAlias: !!textNameAlias })) })
  const pending = new Set<string>()
  const call = async (method: string, ...args: unknown[]): Promise<unknown> => {
    if (!current() || signal.aborted || contents.isDestroyed()) throw new Error('cancelled')
    return contents.executeJavaScript(`window.__cmdTerminalInterceptor?.${method}(${args.map((arg) => JSON.stringify(arg)).join(',')})`, method === 'openFileChooser')
  }
  const command = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    let timer: NodeJS.Timeout | undefined
    try {
      log('cdp-start', { method })
      const result = await Promise.race([
        debuggerApi.sendCommand(method, params) as Promise<Record<string, unknown>>,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('CDP 操作超时')), 5000) })
      ])
      log('cdp-done', { method })
      return result
    } finally { if (timer) clearTimeout(timer) }
  }
  const onDetach = (): void => { detached = true; log('debugger-detached') }
  const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
    const id = String(params.requestId ?? '')
    if (method === 'Page.fileChooserOpened' && chooserIntercepted && !chooser) {
      if (typeof params.backendNodeId === 'number' && params.backendNodeId > 0) {
        chooser = { backendNodeId: params.backendNodeId, mode: String(params.mode ?? '') }
        log('file-chooser-opened', { multiple: chooser.mode === 'selectMultiple', inputFound: true })
      }
    } else if (method === 'Network.requestWillBeSent') {
      const request = params.request as { method?: string; headers?: Record<string, string> } | undefined
      const type = Object.entries(request?.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
      const resumable = platformId === 'gemini' && Object.entries(request?.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'x-goog-upload-protocol' && value.toLowerCase() === 'resumable')
      const uploadCommand = platformId === 'gemini' && Object.entries(request?.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'x-goog-upload-command' && /(?:^|,)\s*(?:start|upload|finalize)\s*(?:,|$)/i.test(value))
      if (request?.method === 'PUT' || (request?.method === 'POST' && (resumable || uploadCommand || /multipart\/form-data|application\/octet-stream|image\//i.test(type)))) {
        pending.add(id)
        log('upload-request', { requestId: id, method: request.method, pending: pending.size })
      }
    } else if (method === 'Network.responseReceived' && pending.has(id)) {
      const response = params.response as { status?: number } | undefined
      if ((response?.status ?? 200) >= 400) uploadError = true
      log('upload-response', { requestId: id, status: response?.status })
    } else if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
      if (pending.has(id)) {
        if (method === 'Network.loadingFailed') uploadError = true
        log('upload-complete', { requestId: id, failed: method === 'Network.loadingFailed', errorText: params.errorText })
      }
      pending.delete(id)
    }
  }
  try {
    if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
    if (!attachments.length) return finish('upload-failed', 'no-attachments')
    if (attachments.length && debuggerApi.isAttached()) return finish('upload-failed', 'debugger-already-attached')
    const fileInfo = attachments.map(({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes }))
    const begin = options.computerResult
      ? await call('beginComputerFileSend', token, fileInfo, options.computerResult)
      : options.userText !== undefined
      ? await call('beginFocusFileSend', token, fileInfo, options.userText, new URL(ownerUrl).pathname)
      : await call('beginFileSend', token, fileInfo)
    log('begin-result', { result: begin ?? 'missing-handler' })
    if (begin !== 'ok' && begin !== 'resume') {
      try { log('page-diagnostics', diagnosticSnapshot(await call('attachmentDiagnostics', attachments.map(({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes }))))) } catch { log('page-diagnostics-unavailable') }
      return finish(begin === 'busy' || begin === 'no-composer' || begin === 'insert-failed' || begin === 'unsupported-file-type' ? begin : 'upload-failed', typeof begin === 'string' ? begin : 'missing-handler')
    }
    if (attachments.length) {
      stage = 'debugger-attach'
      // Do not detach someone else's debugger or borrow their Network listeners.
      if (debuggerApi.isAttached()) return finish('upload-failed', 'debugger-already-attached')
      debuggerApi.attach('1.3')
      attached = true
      debuggerApi.on('detach', onDetach)
      debuggerApi.on('message', onMessage)
      await command('Network.enable')
    }
    if (attachments.length && begin === 'ok') {
      stage = 'file-input'
      if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
      if (platformId === 'gemini') {
        stage = 'file-chooser'
        await command('Page.enable')
        chooserIntercepted = true
        await command('Page.setInterceptFileChooserDialog', { enabled: true })
        const chooserDeadline = Date.now() + 8000
        let entryActivated = false
        let lastEntryState = ''
        while (!chooser && Date.now() < chooserDeadline) {
          if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
          if (detached) return finish('upload-failed', 'debugger-detached')
          if (!entryActivated) {
            const result = await call('openFileChooser', token)
            const entryState = result === true ? 'activated' : result === 'waiting' ? 'waiting' : 'blocked'
            if (entryState !== lastEntryState) { log('chooser-entry-state', { state: entryState }); lastEntryState = entryState }
            if (result !== true && result !== 'waiting') {
              try { log('chooser-diagnostics', diagnosticSnapshot(await call('fileChooserDiagnostics'))) } catch { log('chooser-diagnostics-unavailable') }
              return finish('upload-failed', 'local-upload-entry-blocked')
            }
            entryActivated = result === true
          }
          if (chooser) break
          await pause(50)
        }
        // The browser reports the transient input directly, even if it has no
        // selector/id and the website closes the menu immediately afterwards.
        const selectedChooser = chooser as { backendNodeId: number; mode: string } | null
        if (!selectedChooser) {
          try { log('chooser-diagnostics', diagnosticSnapshot(await call('fileChooserDiagnostics'))) } catch { log('chooser-diagnostics-unavailable') }
          return finish('upload-failed', entryActivated ? 'file-chooser-timeout' : 'local-upload-entry-missing')
        }
        if (attachments.length > 1 && selectedChooser.mode !== 'selectMultiple') return finish('upload-failed', 'file-chooser-not-multiple')
        if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
        stage = 'file-selection'
        await command('DOM.setFileInputFiles', { backendNodeId: selectedChooser.backendNodeId, files: attachments.map((file) => file.path) })
        await command('Page.setInterceptFileChooserDialog', { enabled: false })
        chooserIntercepted = false
      } else {
        if (await call('refreshFileInput', token) !== true) return finish('upload-failed', 'file-input-refresh-failed')
        const document = await command('DOM.getDocument', { depth: 0 })
        const root = document.root as { nodeId: number }
        const input = await command('DOM.querySelector', { nodeId: root.nodeId, selector: `input[data-codex-file-input="${token}"]` })
        if (!input.nodeId) return finish('upload-failed', 'file-input-node-missing')
        if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
        stage = 'file-selection'
        await command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: attachments.map((file) => file.path) })
      }
      await call('fileSelectionApplied', token)
      log('files-selected', { count: attachments.length })
    }
    stage = 'upload-wait'
    const deadline = Date.now() + (attachments.length ? 120000 : 10000)
    let readySince = 0
    let previousSnapshot = ''
    let lastSnapshotAt = 0
    let lastPageDiagnosticsAt = 0
    while (Date.now() < deadline) {
      if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
      if (detached || uploadError) return finish('upload-failed', detached ? 'debugger-detached' : 'upload-network-error')
      const snapshot = await call('fileSendStatus', token) as { status?: string; namesSeen?: boolean }
      const diagnostics = { ...diagnosticSnapshot(snapshot), pendingRequests: pending.size }
      const signature = JSON.stringify(diagnostics)
      if (signature !== previousSnapshot || Date.now() - lastSnapshotAt >= 10000) {
        log('upload-state', diagnostics)
        previousSnapshot = signature
        lastSnapshotAt = Date.now()
      }
      if (snapshot?.status === 'uploading' && snapshot.namesSeen === false && (!lastPageDiagnosticsAt || Date.now() - lastPageDiagnosticsAt >= 10000)) {
        try { log('page-diagnostics', diagnosticSnapshot(await call('attachmentDiagnostics'))) } catch { log('page-diagnostics-unavailable') }
        lastPageDiagnosticsAt = Date.now()
      }
      if (snapshot?.status === 'busy') return finish('busy', 'draft-changed')
      if (snapshot?.status === 'stale' || snapshot?.status === 'no-composer' || snapshot?.status === 'upload-failed') return finish('upload-failed', snapshot.status)
      if (snapshot?.status === 'ready' && pending.size === 0) {
        readySince ||= Date.now()
        if (Date.now() - readySince >= 1000) break
      } else readySince = 0
      await pause(250)
    }
    if (!readySince || Date.now() >= deadline) return finish('upload-failed', 'upload-ready-timeout')
    if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
    if (options.caption || options.userText !== undefined) {
      stage = 'caption'
      const prepared = options.userText !== undefined
        ? await call('prepareFocusFileSendCaption', token)
        : await call('prepareFileSendCaption', token, options.caption)
      if (prepared !== true) return finish('busy', 'caption-not-prepared')
      const captionDeadline = Date.now() + 5000
      let ready = false
      while (Date.now() < captionDeadline) {
        if (!current() || signal.aborted) return finish('cancelled', 'context-changed')
        const status = await call('fileSendStatus', token) as { status?: string; error?: boolean }
        if (status?.status === 'ready') { ready = true; break }
        if (status?.status !== 'uploading') {
          let details: unknown = null
          try { details = await call('fileSendCaptionDiagnostics', token) } catch (error) { details = { unavailable: (error as Error).message } }
          log('caption-check', { status: status?.status ?? null, snapshotError: status?.error ?? null, details })
          return finish('busy', 'caption-draft-changed')
        }
        await pause(100)
      }
      if (!ready) return finish('upload-failed', 'caption-ready-timeout')
    }
    stage = 'submit'
    // From this point, a context loss is ambiguous; never automatically click again.
    submitted = true
    const clicked = await call('submitFileSend', token)
    log('submit-result', { clicked: clicked === true })
    if (clicked !== true) { submitted = false; return finish('upload-failed', 'submit-not-confirmed') }
    sendClicked = true
    stage = 'confirm'
    const confirmDeadline = Date.now() + 10000
    let previousConfirmation = ''
    let previousNavigation = ''
    let lastConfirmDiagnosticsAt = 0
    while (Date.now() < confirmDeadline) {
      const context = pageContext()
      const navigation = JSON.stringify(context)
      if (navigation !== previousNavigation) { log('confirm-navigation', context); previousNavigation = navigation }
      if ((!context.matches && !context.transitioning) || detached) return finish('unknown', 'page-changed-after-submit')
      // A fast next action can supersede this run; still read the acknowledgement.
      const snapshot = await contents.executeJavaScript(`window.__cmdTerminalInterceptor?.fileSendStatus(${JSON.stringify(token)})`) as { status?: string }
      const diagnostics = diagnosticSnapshot(snapshot)
      const signature = JSON.stringify(diagnostics)
      if (signature !== previousConfirmation) { log('confirm-state', diagnostics); previousConfirmation = signature }
      // Recheck after the page call, which can itself race with SPA navigation.
      const afterRead = pageContext()
      if ((!afterRead.matches && !afterRead.transitioning) || detached) return finish('unknown', 'page-changed-after-submit')
      if (afterRead.matches && snapshot?.status === 'sent') return finish('ok', 'message-confirmed')
      if (!isCurrent() || signal.aborted) return finish('unknown', 'context-changed-after-submit')
      if (afterRead.matches && diagnostics.newTurnSeen === true && diagnostics.turnFilesSeen === false && (!lastConfirmDiagnosticsAt || Date.now() - lastConfirmDiagnosticsAt >= 3000)) {
        try { log('confirmation-diagnostics', diagnosticSnapshot(await call('attachmentDiagnostics'))) } catch { log('confirmation-diagnostics-unavailable') }
        lastConfirmDiagnosticsAt = Date.now()
      }
      await pause(150)
    }
    return finish('unknown', 'message-confirm-timeout')
  } catch (error) {
    log('exception', { message: (error as Error).message?.slice(0, 500) })
    return finish(submitted ? 'unknown' : signal.aborted || !current() ? 'cancelled' : 'upload-failed', 'exception')
  } finally {
    if (!contents.isDestroyed()) {
      try {
        const released = await contents.executeJavaScript(`window.__cmdTerminalInterceptor?.releaseFileSend(${JSON.stringify(token)})`)
        log('release-result', { released: released === true, submitted })
      } catch { log('release-unavailable') }
    }
    if (attached) {
      if (chooserIntercepted && !detached && !contents.isDestroyed()) {
        try { await command('Page.setInterceptFileChooserDialog', { enabled: false }) } catch { /* detach also releases interception */ }
      }
      debuggerApi.removeListener('message', onMessage)
      debuggerApi.removeListener('detach', onDetach)
      try { if (!detached && debuggerApi.isAttached()) debuggerApi.detach() } catch { /* destroyed contents */ }
    }
  }
}
