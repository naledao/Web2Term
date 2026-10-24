import type { WebContents } from 'electron'
import type { FocusEditDiagnostic } from '../shared/focus-chat'

/** One native click for an already armed card action; no synthetic fallback or retry. */
export async function dispatchFocusUiClick(contents: WebContents, token: string, current: () => boolean,
  focused: () => boolean, diagnose: (details: FocusEditDiagnostic) => void): Promise<void> {
  const fail = async (reason: string): Promise<void> => {
    diagnose({ stage: 'submit', reason })
    if (current()) await contents.executeJavaScript('window.__cmdTerminalInterceptor?.failSmartUiClick(' +
      JSON.stringify(token) + ',' + JSON.stringify(reason) + ')').catch(() => {})
  }
  try {
    if (!current()) return
    if (!focused()) return await fail('native-click-window-unfocused')
    const point = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareSmartUiClick(' + JSON.stringify(token) + ')')
    if (!current()) return
    if (!point?.ok) {
      diagnose({ stage: 'submit', reason: point?.reason === 'native-click-unreachable' ? point.reason : 'native-click-target-changed' })
      return
    }
    if (!focused()) return await fail('native-click-window-unfocused')
    const zoom = contents.getZoomFactor()
    if (![point.x, point.y, zoom].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
      zoom <= 0 || point.x * zoom > 100000 || point.y * zoom > 100000) return await fail('native-click-dispatch-failed')
    const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
    contents.sendInputEvent({ type: 'mouseMove', ...position })
    contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 })
    diagnose({ stage: 'submit', reason: 'native-click-dispatched' })
  } catch { await fail('native-click-dispatch-failed') }
}
