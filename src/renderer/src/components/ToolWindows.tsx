import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import type { AppTheme } from '@shared/types'
import { TOOL_LABELS, toolWindowReducer } from '../tool-window-state'
import type { ToolKind, ToolWindowEntry } from '../tool-window-state'
import { ToolSurfaceContext } from './ToolSurfaceContext'
import GitDialog from './GitDialog'
import MysqlDialog from './MysqlDialog'
import RedisDialog from './RedisDialog'
import NacosDialog from './NacosDialog'
import MysqlIcon from './MysqlIcon'
import RedisIcon from './RedisIcon'
import NacosIcon from './NacosIcon'
import './ToolWindows.css'

interface ToolWindowsValue {
  windows: ToolWindowEntry[]
  open: (sessionId: string, kind: ToolKind, cwd?: string) => void
  minimize: (id: string) => void
  restore: (id: string) => void
  close: (id: string) => void
}
const ToolWindowsContext = createContext<ToolWindowsValue | null>(null)

export function ToolWindowsProvider({ sessionIds, children }: { sessionIds: string[]; children: ReactNode }) {
  const [windows, dispatch] = useReducer(toolWindowReducer, [])
  const sessionKey = JSON.stringify(sessionIds)
  useEffect(() => { dispatch({ type: 'retain', sessionIds: JSON.parse(sessionKey) as string[] }) }, [sessionKey])
  const open = useCallback((sessionId: string, kind: ToolKind, cwd?: string) => dispatch({ type: 'open', sessionId, kind, cwd }), [])
  const minimize = useCallback((id: string) => {
    dispatch({ type: 'minimize', id })
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-tool-restore="${CSS.escape(id)}"]`)?.focus())
  }, [])
  const restore = useCallback((id: string) => dispatch({ type: 'restore', id }), [])
  const close = useCallback((id: string) => {
    dispatch({ type: 'close', id })
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-tool-open="${CSS.escape(id.slice(id.lastIndexOf(':') + 1))}"]`)?.focus())
  }, [])
  const value = useMemo(() => ({ windows, open, minimize, restore, close }), [windows, open, minimize, restore, close])
  return <ToolWindowsContext.Provider value={value}>{children}</ToolWindowsContext.Provider>
}

export function useToolWindows() {
  const value = useContext(ToolWindowsContext)
  if (!value) throw new Error('工具窗口必须位于会话工作区内。')
  return value
}

export function ToolIcon({ kind }: { kind: ToolKind }) {
  if (kind === 'mysql') return <MysqlIcon size={15} />
  if (kind === 'redis') return <RedisIcon size={15} />
  if (kind === 'nacos') return <NacosIcon size={15} />
  return <svg viewBox="0 0 24 24" width="15" height="15" fill="#f05032" aria-hidden="true"><path d="m23.5 10.9-10.4-10.4a1.7 1.7 0 0 0-2.3 0L8.6 2.7l2.8 2.8a2 2 0 0 1 2.5 2.5l2.7 2.7a2 2 0 1 1-1.1 1.1L13 9.3v6.5a2 2 0 1 1-1.6 0V9.1a2 2 0 0 1-1.1-2.5L7.5 3.8l-7 7a1.7 1.7 0 0 0 0 2.3l10.4 10.4a1.7 1.7 0 0 0 2.3 0l10.3-10.3a1.7 1.7 0 0 0 0-2.3Z" /></svg>
}

function toolTitle(item: ToolWindowEntry): string {
  return item.kind === 'git' && item.cwd ? `${TOOL_LABELS.git} · ${item.cwd}` : TOOL_LABELS[item.kind]
}

export function ToolWindowDock({ sessionId }: { sessionId: string }) {
  const { windows, restore, close } = useToolWindows()
  const minimized = windows.filter((item) => item.sessionId === sessionId && item.minimized)
  if (!minimized.length) return null
  return <div className="tool-dock" role="group" aria-label="已最小化的工具窗口">
    {minimized.map((item) => <div className="tool-dock__tab" key={item.id}>
      <button type="button" className="tool-dock__restore" data-tool-restore={item.id} title={`恢复 ${toolTitle(item)}`} aria-label={`恢复 ${toolTitle(item)}`} onClick={() => restore(item.id)}>
        <ToolIcon kind={item.kind} /><span>{TOOL_LABELS[item.kind]}</span>
      </button>
      <button type="button" className="tool-dock__close" title={`关闭 ${toolTitle(item)}`} aria-label={`关闭 ${toolTitle(item)}`} onClick={() => close(item.id)}>×</button>
    </div>)}
  </div>
}

/** Lives outside App's session key: switching App must not destroy its tool trees. */
export function ToolWindowsHost({ sessionId, theme, blocked }: { sessionId: string | null; theme: AppTheme; blocked: boolean }) {
  const { windows } = useToolWindows()
  const container = useRef<HTMLDivElement>(null)
  return <div ref={container} className="tool-windows-host">
    {windows.map((entry) => <ToolWindow key={entry.id} entry={entry} active={entry.sessionId === sessionId} visible={entry.sessionId === sessionId && !entry.minimized && !blocked} theme={theme} container={container} />)}
  </div>
}

function ToolWindow({ entry, active, visible, theme, container }: {
  entry: ToolWindowEntry; active: boolean; visible: boolean; theme: AppTheme; container: RefObject<HTMLDivElement | null>
}) {
  const { minimize, close } = useToolWindows()
  const onClose = useCallback(() => close(entry.id), [close, entry.id])
  const onMinimize = useCallback(() => minimize(entry.id), [minimize, entry.id])
  const surface = useMemo(() => ({ sessionId: entry.sessionId, visible, active, minimize: onMinimize }), [entry.sessionId, visible, active, onMinimize])
  return <ToolSurfaceContext.Provider value={surface}>
    <Dialog.Root open={visible} disablePointerDismissal onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal container={container} keepMounted>
        <Dialog.Popup className="tool-window__surface" aria-label={TOOL_LABELS[entry.kind]} finalFocus={false}>
          {entry.kind === 'git' ? <GitDialog open cwd={entry.cwd} theme={theme} onClose={onClose} /> : null}
          {entry.kind === 'mysql' ? <MysqlDialog open theme={theme} onClose={onClose} /> : null}
          {entry.kind === 'redis' ? <RedisDialog open theme={theme} onClose={onClose} /> : null}
          {entry.kind === 'nacos' ? <NacosDialog open theme={theme} onClose={onClose} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </ToolSurfaceContext.Provider>
}
