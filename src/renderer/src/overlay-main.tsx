import { StrictMode, useEffect, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ComputerUseOverlay from './components/ComputerUseOverlay'
import type { ComputerOverlaySnapshot } from '@shared/computer-overlay'
import './assets/computer-overlay-window.css'

/** Measure the same fonts, column proportions and padding used by the visible overlay. */
function measureOverlaySize(panel: HTMLElement): { width: number; height: number } {
  const root = panel.parentElement!
  const padding = getComputedStyle(root)
  const horizontalPadding = parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight)
  const verticalPadding = parseFloat(padding.paddingTop) + parseFloat(padding.paddingBottom)
  const measure = panel.cloneNode(true) as HTMLElement
  measure.setAttribute('aria-hidden', 'true')
  Object.assign(measure.style, {
    position: 'fixed', left: '-100000px', top: '0', width: 'max-content',
    visibility: 'hidden', pointerEvents: 'none'
  })
  measure.querySelectorAll<HTMLElement>('.computer-use-overlay__goal-text, .computer-use-overlay__action-text')
    .forEach(text => { text.style.whiteSpace = 'nowrap' })
  document.body.appendChild(measure)
  try {
    return {
      width: Math.ceil(measure.getBoundingClientRect().width + horizontalPadding),
      // Use the visible, wrapped content after the main process limits width to the screen.
      height: Math.ceil(panel.getBoundingClientRect().height + verticalPadding)
    }
  } finally {
    measure.remove()
  }
}

function OverlayApp() {
  const [snapshot, setSnapshot] = useState<ComputerOverlaySnapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true, pushed = false
    const off = window.computerOverlay.onChanged(next => {
      pushed = true
      if (alive) { setSnapshot(next); setError('') }
    })
    void window.computerOverlay.getSnapshot().then(next => {
      if (alive && !pushed) setSnapshot(next)
    }).catch(() => { if (alive && !pushed) setError('暂时无法读取任务进度，等待下一次更新。') })
    return () => { alive = false; off() }
  }, [])
  useLayoutEffect(() => {
    const panel = document.querySelector<HTMLElement>('.computer-use-overlay')
    if (!panel) return
    let alive = true
    let frame = 0
    let previousSize = ''
    const fit = (): void => {
      const size = measureOverlaySize(panel)
      const encoded = JSON.stringify(size)
      if (encoded !== previousSize) {
        previousSize = encoded
        window.computerOverlay.fitContent(size)
      }
    }
    const scheduleFit = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(panel)
    window.addEventListener('resize', scheduleFit)
    void document.fonts.ready.then(() => { if (alive) scheduleFit() })
    fit()
    return () => {
      alive = false
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleFit)
    }
  }, [snapshot, error])
  return <ComputerUseOverlay snapshot={snapshot} error={error} />
}

const container = document.getElementById('root')
if (!container) throw new Error('Computer Use overlay bootstrap failed: missing root element.')

createRoot(container).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>
)
