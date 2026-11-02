import type { DownloadItem, WebContents } from 'electron'
import { mkdtemp, readFile, rmdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FOCUS_FILE_PREVIEW_BYTES, validFocusFileLinkTarget } from '../shared/focus-file-links'
import type { FocusFileLinkTarget, FocusFilePreviewResult, FocusFilePreviewStage } from '../shared/focus-file-links'
import type { FocusEditDiagnostic } from '../shared/focus-chat'
import { clickNativeFocusFileControl, openNativeFocusFileLink } from './focus-file-link'

export interface CapturedFocusFile { fileName: string; bytes: Buffer }
export type CapturedFocusFileResult = Omit<FocusFilePreviewResult, 'preview'> & { file?: CapturedFocusFile }
export interface FocusFileCaptureDiagnostic extends FocusEditDiagnostic { fileStage: FocusFilePreviewStage }
export interface FocusFileCaptureOptions { focused(): boolean; diagnose?(details: FocusFileCaptureDiagnostic): void }
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const safeName = (value: string): string => value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 240)

/** Obtain the original bytes through the user's native file action, without guessing signed API URLs. */
export async function captureNativeFocusFile(contents: WebContents, target: FocusFileLinkTarget,
  isCurrent: () => boolean, timeoutMs = 20000, input?: FocusFileCaptureOptions): Promise<CapturedFocusFileResult> {
  if (!validFocusFileLinkTarget(target)) return { outcome: 'invalid' }
  if (!isCurrent() || contents.isDestroyed()) return { outcome: 'cancelled' }
  const url = contents.getURL(), path = new URL(url).pathname
  const current = (): boolean => isCurrent() && !contents.isDestroyed() && contents.getURL() === url
  let fileStage: FocusFilePreviewStage = 'prepare'
  const report = (details: FocusEditDiagnostic = {}): void => input?.diagnose?.({ ...details, fileStage })
  const advance = (stage: FocusFilePreviewStage): void => { fileStage = stage; report() }
  const nativeInput = { focused: input?.focused ?? (() => contents.isFocused()), diagnose: report }
  const call = (method: string, args: unknown[], gesture = false): Promise<any> => contents.executeJavaScript(
    'window.__cmdTerminalInterceptor?.' + method + '(' + args.map(value => JSON.stringify(value)).join(',') + ')', gesture)
  const directory = await mkdtemp(join(tmpdir(), 'web2term-file-preview-'))
  const destination = join(directory, 'content')
  const ses = contents.session
  let enabled = false, item: DownloadItem | null = null, tooLarge = false, expectedName = ''
  let viewer: { fileName: string; signature: string } | null = null
  let settled = false, timer: ReturnType<typeof setTimeout> | undefined, watcher: ReturnType<typeof setInterval> | undefined
  let finish: (result: CapturedFocusFileResult) => void = () => {}
  const downloaded = new Promise<CapturedFocusFileResult>(resolve => {
    finish = result => { if (!settled) { settled = true; resolve({ ...result, fileStage }) } }
  })
  const progress = (): void => {
    if (item && (item.getReceivedBytes() > MAX_FOCUS_FILE_PREVIEW_BYTES || !current())) {
      tooLarge = item.getReceivedBytes() > MAX_FOCUS_FILE_PREVIEW_BYTES
      item.cancel()
    }
  }
  const onDownload = (_event: Electron.Event, incoming: DownloadItem, initiator?: WebContents): void => {
    if (!enabled || item || initiator !== contents) return
    const fileName = safeName(incoming.getFilename())
    let allowed = false
    try {
      const source = new URL(incoming.getURL()), page = new URL(url)
      allowed = (['https:', 'http:', 'blob:'].includes(source.protocol) && source.origin === page.origin)
        || source.protocol === 'https:' && /(?:^|\.)oaiusercontent\.com$/.test(source.hostname)
    } catch { /* An unrecognized download is not captured. */ }
    if (!allowed || !fileName) return
    item = incoming
    report({ reason: 'file-download-received' })
    if (expectedName && fileName !== safeName(expectedName)) {
      incoming.cancel(); finish({ outcome: 'unavailable', reason: 'file-unavailable' }); return
    }
    if (!current() || incoming.getTotalBytes() > MAX_FOCUS_FILE_PREVIEW_BYTES) {
      tooLarge = incoming.getTotalBytes() > MAX_FOCUS_FILE_PREVIEW_BYTES
      incoming.cancel(); finish({ outcome: current() ? 'unavailable' : 'cancelled', reason: tooLarge ? 'too-large' : 'file-unavailable' }); return
    }
    try {
      incoming.setSavePath(destination)
      incoming.on('updated', progress)
      incoming.once('done', (_doneEvent, state) => {
        incoming.removeListener('updated', progress)
        report({ reason: state === 'completed' ? 'file-download-completed' : 'file-download-failed' })
        finish(state === 'completed' && current() ? { outcome: 'ok', file: { fileName, bytes: Buffer.alloc(0) } } :
          { outcome: current() ? 'unavailable' : 'cancelled', reason: tooLarge ? 'too-large' : 'file-unavailable' })
      })
    } catch { incoming.cancel(); finish({ outcome: 'unavailable', reason: 'file-unavailable' }) }
  }
  try {
    ses.on('will-download', onDownload)
    report()
    timer = setTimeout(() => { report({ reason: 'file-preview-timeout' }); finish({ outcome: 'unavailable', reason: 'timeout' }); item?.cancel() }, timeoutMs)
    watcher = setInterval(() => { if (!current()) { finish({ outcome: 'cancelled' }); item?.cancel() } }, 100)
    // Close a previous native file first, so a stale tab cannot supply another file's bytes.
    if (!current()) return { outcome: 'cancelled' }
    const prepared = await call('prepareFocusFileViewer', [target, path], true)
    if (prepared !== 'ok') return { outcome: prepared === 'busy' ? 'busy' : 'unavailable', fileStage }
    const closeDeadline = Date.now() + Math.min(timeoutMs, 2000)
    while (current() && !settled) {
      const previous = await call('readFocusFileViewer', [path])
      if (previous?.outcome === 'pending') break
      if (Date.now() >= closeDeadline || previous?.outcome !== 'ok') return { outcome: 'unavailable' }
      await pause(80)
    }
    if (!current()) return { outcome: 'cancelled' }
    if (settled) return await downloaded
    enabled = true
    advance('open')
    const opened = await openNativeFocusFileLink(contents, target, current, nativeInput)
    if (opened !== 'ok') return { outcome: opened, fileStage }
    advance('viewer')
    while (current() && !settled && !item) {
      const ready = await call('readFocusFileViewer', [path])
      if (ready?.outcome === 'ok' && typeof ready.fileName === 'string' && /^[a-f0-9]{8}$/.test(ready.signature)) {
        expectedName = ready.fileName; viewer = { fileName: ready.fileName, signature: ready.signature }
        if (!current()) return { outcome: 'cancelled' }
        advance('download')
        const triggered = await clickNativeFocusFileControl(contents, { kind: 'download', target: viewer }, current, nativeInput)
        if (triggered !== 'ok' && !item) return { outcome: triggered, fileStage }
        break
      }
      if (ready?.outcome !== 'pending') return { outcome: 'unavailable', fileStage }
      await pause(80)
    }
    if (!current()) return { outcome: 'cancelled' }
    const result = await downloaded
    if (result.outcome !== 'ok' || !result.file || !current()) return current() ? result : { outcome: 'cancelled' }
    advance('read')
    const info = await stat(destination)
    if (info.size > MAX_FOCUS_FILE_PREVIEW_BYTES) return { outcome: 'unavailable', reason: 'too-large' }
    const bytes = await readFile(destination)
    return current() ? { outcome: 'ok', file: { fileName: result.file.fileName, bytes } } : { outcome: 'cancelled' }
  } catch { return { outcome: current() ? 'unavailable' : 'cancelled', reason: 'file-unavailable', fileStage } }
  finally {
    clearTimeout(timer); clearInterval(watcher); enabled = false
    ses.removeListener('will-download', onDownload)
    const incoming = item as DownloadItem | null
    if (incoming) { incoming.removeListener('updated', progress); if (!settled) incoming.cancel() }
    if (viewer && current()) await call('closeFocusFileViewer', [viewer, path], true).catch(() => {})
    // Both paths were created by this invocation. No recursive filesystem deletion.
    await unlink(destination).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
}
