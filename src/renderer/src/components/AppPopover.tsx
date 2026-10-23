import { useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, Ref } from 'react'
import { Popover } from '@base-ui/react/popover'
import './AppPopover.css'

type PopupProps = ComponentProps<typeof Popover.Popup>
interface Props extends Omit<PopupProps, 'open' | 'role' | 'aria-modal' | 'onClose'> {
  open?: boolean
  onClose(): void
  busy?: boolean
  dismissOnOutside?: boolean
  dismissOnEscape?: boolean
  keepMounted?: boolean
  anchor?: HTMLElement | null
  ref?: Ref<HTMLDivElement>
}

function captureAnchor(explicit?: HTMLElement | null) {
  const focused = explicit ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null)
  const box = focused?.getBoundingClientRect()
  // A menu item can disappear in the same commit that opens its popover.
  const rect = box && box.width + box.height > 0 ? box : new DOMRect(window.innerWidth - 24, window.innerHeight - 24, 0, 0)
  return { trigger: focused, virtual: { contextElement: focused ?? undefined, getBoundingClientRect: () => {
    const current = focused?.isConnected ? focused.getBoundingClientRect() : null
    return current && current.width + current.height > 0 ? current : rect
  } },
    side: rect.top > window.innerHeight / 2 ? 'top' as const : 'bottom' as const }
}

/** Shared, non-modal surface for application forms, previews and confirmations. */
export default function AppPopover({ open = true, keepMounted = false, ...props }: Props) {
  if (!open && !keepMounted) return null
  return <PopoverSurface {...props} open={open} keepMounted={keepMounted} />
}

function PopoverSurface({ open, onClose, busy = false, dismissOnOutside = true, dismissOnEscape = true,
  keepMounted, anchor, className = '', initialFocus, finalFocus, children, ref, ...props }: Props & { open: boolean }) {
  const marker = useRef<HTMLSpanElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const origin = useRef(captureAnchor(anchor))
  const restoreFocus = useRef(true)
  const previousOpen = useRef(open)
  if (open && !previousOpen.current) { origin.current = captureAnchor(anchor); restoreFocus.current = true }
  previousOpen.current = open
  useLayoutEffect(() => { setContainer(marker.current?.parentElement ?? null) }, [])
  return <>
    <span hidden ref={marker} />
    <Popover.Root open={open} modal={false} onOpenChange={(next, details) => {
      if (next) return
      const outside = details.reason === 'outside-press' || details.reason === 'focus-out'
      if (busy || (!dismissOnOutside && outside) || (!dismissOnEscape && details.reason === 'escape-key')) {
        details.cancel()
        return
      }
      restoreFocus.current = !outside
      onClose()
    }}>
      {container ? <Popover.Portal container={container} keepMounted={keepMounted} className="app-popover-portal">
        <Popover.Positioner anchor={origin.current.virtual} positionMethod="fixed" side={origin.current.side} align="end"
          sideOffset={8} collisionPadding={12} collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'end' }}
          className="app-popover-positioner">
          <Popover.Popup {...props} ref={ref} className={`app-popover ${className}`} aria-modal={false}
            initialFocus={initialFocus} finalFocus={finalFocus ?? (() => restoreFocus.current && origin.current.trigger?.isConnected ? origin.current.trigger : false)}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal> : null}
    </Popover.Root>
  </>
}
