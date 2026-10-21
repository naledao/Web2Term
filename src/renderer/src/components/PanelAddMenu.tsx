import { useEffect, useState } from 'react'
import type { JSX, RefObject } from 'react'
import { Popover } from '@base-ui/react/popover'
import './TerminalActionsMenu.css'
import './PanelAddMenu.css'

export type PanelAddItem = 'terminal'

/** The + beside the right panel's tabs: opens a menu of tabs that can be added. */
export default function PanelAddMenu({ containerRef, visible, onOpenChange, onAdd }: {
  containerRef: RefObject<HTMLElement | null>
  visible: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (item: PanelAddItem) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const shown = open && visible

  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  useEffect(() => {
    onOpenChange(shown)
  }, [shown, onOpenChange])

  return <Popover.Root open={shown} onOpenChange={setOpen}>
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
            setOpen(false)
            onAdd('terminal')
          }}>
            <span className="terminal-actions__icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="3" /><path d="M7 9l3 3-3 3M13 15h4" /></svg>
            </span>
            <span className="terminal-actions__label">终端</span>
          </button>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
