import type { WebContents } from 'electron'

/** A single page-armed input step. Recheck ownership after the asynchronous point read. */
export async function dispatchFocusModelClick(contents: WebContents, token: string, step: number,
  current: () => boolean, focused: () => boolean): Promise<void> {
  const finish = async (dispatched: boolean): Promise<void> => {
    if (current()) await contents.executeJavaScript('window.__cmdTerminalInterceptor?.finishFocusModelClick(' +
      JSON.stringify(token) + ',' + step + ',' + dispatched + ')').catch(() => {})
  }
  try {
    if (!current()) return
    if (!focused()) return await finish(false)
    const point = await contents.executeJavaScript('window.__cmdTerminalInterceptor?.prepareFocusModelClick(' + JSON.stringify(token) + ',' + step + ')')
    if (!current()) return
    const zoom = contents.getZoomFactor()
    if (!focused() || !point || ![point.x, point.y, zoom].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
      zoom <= 0 || point.x * zoom > 100000 || point.y * zoom > 100000) return await finish(false)
    const position = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
    contents.sendInputEvent({ type: 'mouseMove', ...position })
    contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 })
    await finish(true)
  } catch { await finish(false) }
}
