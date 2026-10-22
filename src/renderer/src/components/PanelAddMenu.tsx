import { useEffect } from 'react'
import type { JSX, RefObject } from 'react'
import { Popover } from '@base-ui/react/popover'
import './TerminalActionsMenu.css'
import './PanelAddMenu.css'

export type PanelAddItem = 'terminal' | 'background' | 'question'

/** The + beside the right panel's tabs: opens a menu of tabs that can be added. */
export default function PanelAddMenu({ containerRef, visible, open, questionChatAvailable, onOpenChange, onAdd }: {
  containerRef: RefObject<HTMLElement | null>
  visible: boolean
  open: boolean
  questionChatAvailable: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (item: PanelAddItem) => void
}): JSX.Element {
  const shown = open && visible

  useEffect(() => {
    if (open && !visible) onOpenChange(false)
  }, [open, visible, onOpenChange])

  return <Popover.Root open={shown} onOpenChange={onOpenChange}>
    <Popover.Trigger className="panel-add__trigger" title="新增页签" aria-label="新增页签">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </Popover.Trigger>
    <Popover.Portal container={containerRef} className="terminal-actions__portal">
      <Popover.Positioner positionMethod="fixed" side="bottom" align="start" sideOffset={8} collisionPadding={8}
        collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
        collisionBoundary={containerRef.current ?? undefined} className="terminal-actions__positioner">
        <Popover.Popup className="terminal-actions__popup panel-add__popup">
          <Popover.Title className="terminal-actions__heading">新增页签</Popover.Title>
          <button type="button" className="terminal-actions__item" onClick={() => {
            onOpenChange(false)
            onAdd('terminal')
          }}>
            <span className="terminal-actions__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="3" /><path d="M7 9l3 3-3 3M13 15h4" /></svg>
            </span>
            <span className="terminal-actions__label">终端</span>
          </button>
          <button type="button" className="terminal-actions__item" onClick={() => {
            onOpenChange(false)
            onAdd('background')
          }}>
            <span className="terminal-actions__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 9h4M7 13h3M15 10v6m-2-2 2 2 2-2" /></svg>
            </span>
            <span className="terminal-actions__label">后台任务</span>
          </button>
          <button type="button" className="terminal-actions__item" disabled={!questionChatAvailable}
            title={questionChatAvailable ? '新建侧边聊天' : '当前平台不支持侧边聊天'} onClick={() => {
            onOpenChange(false)
              onAdd('question')
            }}>
            <span className="terminal-actions__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h16v12H9l-5 4V4z" /><path d="M8 8h8M8 12h5" /></svg>
            </span>
            <span className="terminal-actions__label">侧边聊天</span>
          </button>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
