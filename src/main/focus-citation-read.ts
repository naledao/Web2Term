import type { WebContents } from 'electron'
import { parseFocusCitationSources } from '../shared/focus-citations'
import type { FocusCitationTarget, FocusCitationResult } from '../shared/focus-citations'

/** Open only the page-identified source trigger; read its plain links and clean up. */
export async function readNativeFocusCitation(contents: WebContents, target: FocusCitationTarget, token: string,
  isCurrent: () => boolean, focused: () => boolean): Promise<FocusCitationResult> {
  const empty = (outcome: FocusCitationResult['outcome']): FocusCitationResult => ({ outcome, sources: [] })
  const url = contents.getURL()
  const current = (): boolean => isCurrent() && !contents.isDestroyed() && contents.getURL() === url
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
  try {
    if (!current() || !focused()) return empty('unavailable')
    const prepared = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusCitation(' +
      JSON.stringify({ ...target, token }) + ',' + JSON.stringify(new URL(url).pathname) + ')')
    if (!current()) return empty('cancelled')
    const ready = read(prepared)
    if (ready) return ready
    if (prepared?.outcome === 'busy') return empty('busy')
    if (prepared?.outcome !== 'pending' || !move(prepared)) return empty('unavailable')
    // Hover cards need a pointer entry; click-only popovers get one guarded click.
    let result = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusCitation(' + JSON.stringify(token) + ',900)')
    if (!current()) return empty('cancelled')
    const hovered = read(result)
    if (hovered) return hovered
    const point = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusCitationClick(' + JSON.stringify(token) + ')')
    if (!current()) return empty('cancelled')
    if (!move(point, true)) return empty('unavailable')
    result = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusCitation(' + JSON.stringify(token) + ',2200)')
    return current() ? read(result) ?? empty('unavailable') : empty('cancelled')
  } catch { return empty(current() ? 'unavailable' : 'cancelled') }
  finally {
    if (!contents.isDestroyed() && contents.getURL() === url) {
      await contents.executeJavaScript('window.__cmdTerminalInterceptor?.closeFocusCitation(' + JSON.stringify(token) + ')').catch(() => {})
      if (current() && focused()) contents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 })
    }
  }
}
