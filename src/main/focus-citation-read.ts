import type { WebContents } from 'electron'
import { parseFocusCitationSources, validFocusCitationSourceTarget } from '../shared/focus-citations'
import type { FocusCitationTarget, FocusCitationResult, FocusCitationSourceTarget } from '../shared/focus-citations'
import type { FocusEditDiagnostic } from '../shared/focus-chat'

export interface FocusCitationSourceAction {
  source: FocusCitationSourceTarget
  captureUrl(receive: (url: string) => void): () => void
  openExternal(url: string): Promise<void>
  diagnose?(details: FocusEditDiagnostic): void
  timeoutMs?: number
}

/** Open only the page-identified trigger; read safe link/card metadata and clean up. */
export async function readNativeFocusCitation(contents: WebContents, target: FocusCitationTarget, token: string,
  isCurrent: () => boolean, focused: () => boolean, sourceAction?: FocusCitationSourceAction): Promise<FocusCitationResult> {
  const empty = (outcome: FocusCitationResult['outcome']): FocusCitationResult => ({ outcome, sources: [] })
  const url = contents.getURL()
  const current = (): boolean => isCurrent() && !contents.isDestroyed() && contents.getURL() === url
  if (sourceAction && !validFocusCitationSourceTarget(sourceAction.source)) return empty('unavailable')
  const read = (raw: unknown): FocusCitationResult | null => {
    const value = raw as Partial<FocusCitationResult> | null
    if (!value || value.outcome !== 'ok') return null
    const sources = parseFocusCitationSources(value.sources)
    return sources ? { outcome: 'ok', sources } : null
  }
  const move = (point: { x?: unknown; y?: unknown } | null, click = false): boolean => {
    if (!point || !current() || !focused()) return false
    const x = point.x, y = point.y, zoom = contents.getZoomFactor()
    if (typeof x !== 'number' || typeof y !== 'number' || ![x, y, zoom].every(Number.isFinite) ||
      x < 0 || y < 0 || zoom <= 0 || x * zoom > 100000 || y * zoom > 100000) return false
    const position = { x: Math.round(x * zoom), y: Math.round(y * zoom) }
    contents.sendInputEvent({ type: 'mouseMove', ...position })
    if (click) {
      contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 })
    }
    return true
  }
  const complete = async (result: FocusCitationResult): Promise<FocusCitationResult> => {
    if (!sourceAction) return result
    const action = sourceAction, source = action.source
    const diagnose = (reason: string, extra: Partial<FocusEditDiagnostic> = {}): void => action.diagnose?.({ stage: 'open', reason, ...extra })
    if (!current()) return empty('cancelled')
    if (result.sources.filter(item => item.kind === 'preview' && item.native?.index === source.index && item.native.signature === source.signature).length !== 1) {
      diagnose('native-click-target-changed'); return empty('unavailable')
    }
    const point = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusCitationSourceClick(' +
      JSON.stringify(token) + ',' + JSON.stringify(source) + ')')
    if (!current()) return empty('cancelled')
    if (!point || !focused()) { diagnose(!point ? 'native-click-target-changed' : 'native-click-window-unfocused'); return empty('unavailable') }
    let stopCapture = (): void => {}, timer: ReturnType<typeof setTimeout> | undefined, armed = false, received = false
    let deliver: (url: string | null) => void = () => {}
    const destination = new Promise<string | null>(resolve => { deliver = resolve })
    const receive = (raw: string): void => {
      if (!armed || received || !current()) return
      received = true
      clearTimeout(timer)
      try {
        const destination = new URL(raw)
        if (!['https:', 'http:'].includes(destination.protocol) || !destination.hostname || destination.username || destination.password || raw.length > 8192) throw new Error('invalid-source-url')
        diagnose('source-navigation-received'); deliver(destination.href)
      } catch { diagnose('invalid-source-url'); deliver(null) }
    }
    const navigation = (event: Electron.Event, destination?: string): void => {
      if (!armed) return
      // A source click opens in the browser, preserving the authenticated conversation.
      event.preventDefault()
      receive(destination ?? (event as Electron.Event & { url?: string }).url ?? '')
    }
    try {
      stopCapture = action.captureUrl(receive)
      contents.on('will-navigate', navigation)
      timer = setTimeout(() => { diagnose('source-navigation-timeout'); deliver(null) }, action.timeoutMs ?? 2500)
      armed = true
      if (!move(point, true)) return empty(current() ? 'unavailable' : 'cancelled')
      diagnose('native-click-dispatched')
      let acknowledged = false
      const deadline = Date.now() + 750
      while (current() && Date.now() < deadline) {
        const ack = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusCitationSourceClick(' + JSON.stringify(token) + ')')
        if (ack?.outcome === 'ok') { acknowledged = true; break }
        if (ack?.outcome !== 'pending') break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      diagnose(acknowledged ? 'native-click-dispatched' : 'native-click-not-received', { nativeClickReceived: acknowledged, clickTrusted: acknowledged })
      if (!current()) return empty('cancelled')
      if (!acknowledged) return empty('unavailable')
      const destinationUrl = await destination
      if (!current()) return empty('cancelled')
      if (!destinationUrl) return empty('unavailable')
      await action.openExternal(destinationUrl)
      diagnose('source-navigation-opened')
      return empty('ok')
    } catch { diagnose('source-navigation-failed'); return empty(current() ? 'unavailable' : 'cancelled') }
    finally { armed = false; clearTimeout(timer); contents.removeListener('will-navigate', navigation); stopCapture() }
  }
  try {
    if (!current() || !focused()) return empty('unavailable')
    const prepared = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusCitation(' +
      JSON.stringify({ ...target, token }) + ',' + JSON.stringify(new URL(url).pathname) + ')')
    if (!current()) return empty('cancelled')
    const ready = read(prepared)
    if (ready) return await complete(ready)
    if (prepared?.outcome === 'busy') return empty('busy')
    if (prepared?.outcome !== 'pending' || !move(prepared)) return empty('unavailable')
    // Hover cards need a pointer entry; click-only popovers get one guarded click.
    let result = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusCitation(' + JSON.stringify(token) + ',900)')
    if (!current()) return empty('cancelled')
    const hovered = read(result)
    if (hovered) return await complete(hovered)
    const point = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusCitationClick(' + JSON.stringify(token) + ')')
    if (!current()) return empty('cancelled')
    if (!move(point, true)) return empty('unavailable')
    result = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusCitation(' + JSON.stringify(token) + ',2200)')
    const clicked = read(result)
    return current() ? clicked ? await complete(clicked) : empty('unavailable') : empty('cancelled')
  } catch { return empty(current() ? 'unavailable' : 'cancelled') }
  finally {
    if (!contents.isDestroyed() && contents.getURL() === url) {
      await contents.executeJavaScript('window.__cmdTerminalInterceptor?.closeFocusCitation(' + JSON.stringify(token) + ')').catch(() => {})
      if (current() && focused()) contents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 })
    }
  }
}
