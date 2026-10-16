import { createContext, useContext, useMemo } from 'react'
import type { AppApi } from '@shared/types'
import { createToolSessionApi } from '../tool-session-api'

export const ToolSurfaceContext = createContext<{
  sessionId: string
  visible: boolean
  active: boolean
  minimize: () => void
} | null>(null)

export function useToolSurface() {
  const context = useContext(ToolSurfaceContext)
  return { visible: context?.visible ?? true, active: context?.active ?? true }
}

/** All async work stays bound to its original session, even after the user switches. */
export function useToolApi(): AppApi {
  const sessionId = useContext(ToolSurfaceContext)?.sessionId
  return useMemo(() => sessionId ? createToolSessionApi(window.api, sessionId) : window.api, [sessionId])
}

export function ToolMinimizeButton() {
  const context = useContext(ToolSurfaceContext)
  if (!context) return null
  return <button type="button" className="tool-window__minimize" title="最小化到会话底栏" aria-label="最小化到会话底栏" onClick={context.minimize}>
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M3 11.5h10" /></svg>
  </button>
}
