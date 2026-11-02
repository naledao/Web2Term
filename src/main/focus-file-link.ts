import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { FocusFileLinkTarget } from '../shared/focus-file-links'
import { validFocusFileLinkTarget } from '../shared/focus-file-links'
import type { FocusSendOutcome, FocusEditDiagnostic } from '../shared/focus-chat'

export interface FocusFileInputOptions {
  focused(): boolean
  diagnose?(details: FocusEditDiagnostic): void
}
type FileControl = { kind: 'source'; target: FocusFileLinkTarget } |
  { kind: 'download'; target: { fileName: string; signature: string } }

/** One native input step in the owned web contents, acknowledged by the exact live control. */
export async function clickNativeFocusFileControl(contents: WebContents, control: FileControl,
  isCurrent: () => boolean, input: FocusFileInputOptions): Promise<FocusSendOutcome> {
  if (!isCurrent() || contents.isDestroyed()) return 'cancelled'
  const url = contents.getURL(), token = randomUUID()
  const current = (): boolean => isCurrent() && !contents.isDestroyed() && contents.getURL() === url
  const call = (method: string, args: unknown[]): Promise<any> => contents.executeJavaScript(
    'window.__cmdTerminalInterceptor?.' + method + '(' + args.map(value => JSON.stringify(value)).join(',') + ')')
  const diagnose = (reason: string, extra: Partial<FocusEditDiagnostic> = {}): void => input.diagnose?.({ stage: 'open', reason, ...extra })
  try {
    if (!input.focused()) { diagnose('native-click-window-unfocused'); return 'unavailable' }
    const point = await call('prepareFocusFileControl', [{ ...control, token }, new URL(url).pathname])
    if (!current()) return 'cancelled'
    if (point?.outcome !== 'ok') {
      diagnose(point?.reason === 'native-click-unreachable' ? point.reason : 'native-click-target-changed')
      return point?.outcome === 'busy' ? 'busy' : 'unavailable'
    }
    const zoom = contents.getZoomFactor()
    if (!input.focused()) { diagnose('native-click-window-unfocused'); return 'unavailable' }
    if (![point.x, point.y, zoom].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      || zoom <= 0 || point.x * zoom > 100000 || point.y * zoom > 100000) return 'unavailable'
    const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
    contents.sendInputEvent({ type: 'mouseMove', ...position })
    contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 })
    diagnose('native-click-dispatched')
    const deadline = Date.now() + 750
    while (current() && Date.now() < deadline) {
      const ack = await call('finishFocusFileControl', [token, false])
      if (!current()) return 'cancelled'
      if (ack?.outcome === 'ok') { diagnose('native-click-dispatched', { nativeClickReceived: true, clickTrusted: true, clickPrevented: ack.prevented === true }); return 'ok' }
      if (ack?.outcome !== 'pending') { diagnose('native-click-target-changed'); return 'unavailable' }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    diagnose('native-click-not-received', { nativeClickReceived: false })
    return current() ? 'unavailable' : 'cancelled'
  } catch { diagnose('native-click-dispatch-failed'); return current() ? 'unknown' : 'cancelled' }
  finally { if (!contents.isDestroyed()) await call('finishFocusFileControl', [token, true]).catch(() => {}) }
}

/** Dispatch the user's file action inside the authenticated page; never open a sandbox path in the OS. */
export async function openNativeFocusFileLink(contents: WebContents, target: FocusFileLinkTarget,
  isCurrent: () => boolean, input?: FocusFileInputOptions): Promise<FocusSendOutcome> {
  if (!validFocusFileLinkTarget(target)) return 'invalid'
  if (!isCurrent() || contents.isDestroyed()) return 'cancelled'
  if (target.href === undefined) return clickNativeFocusFileControl(contents, { kind: 'source', target }, isCurrent,
    input ?? { focused: () => contents.isFocused() })
  const url = contents.getURL()
  try {
    const outcome = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.openFocusFileLink(' +
      JSON.stringify(target) + ',' + JSON.stringify(new URL(url).pathname) + ')', true)
    if (!isCurrent() || contents.isDestroyed() || contents.getURL() !== url) return 'cancelled'
    return ['ok', 'busy', 'unavailable', 'invalid', 'unknown', 'cancelled'].includes(outcome) ? outcome : 'unavailable'
  } catch { return isCurrent() && !contents.isDestroyed() && contents.getURL() === url ? 'unknown' : 'cancelled' }
}
