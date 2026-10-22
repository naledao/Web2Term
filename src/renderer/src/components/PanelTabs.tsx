import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, RefObject } from 'react'
import { Popover } from '@base-ui/react/popover'
import './TerminalActionsMenu.css'
import './PanelTabs.css'

export interface PanelTabItem<Id extends string> {
  id: Id
  title: string
  closable?: boolean
  closeDisabled?: boolean
  closeTitle?: string
}

interface PanelTabsProps<Id extends string> {
  items: PanelTabItem<Id>[]
  active: Id
  containerRef: RefObject<HTMLElement | null>
  visible: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: Id) => void
  onClose: (id: Id) => void
}

function TabIcon({ name }: { name: 'previous' | 'next' | 'list' | 'check' | 'close' }): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={{ previous: 'm14 6-6 6 6 6', next: 'm10 6 6 6-6 6', list: 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01', check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M6 18 18 6' }[name]} />
  </svg>
}

/** Single-row navigation with edge paging and a complete, directly selectable list. */
export default function PanelTabs<Id extends string>({ items, active, containerRef, visible, open, onOpenChange, onSelect, onClose }: PanelTabsProps<Id>): JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef(new Map<Id, HTMLButtonElement>())
  const closeFocusRef = useRef<{ id: Id; index: number; inList: boolean } | null>(null)
  const selectedFromListRef = useRef<Id | null>(null)
  const previousLayoutRef = useRef<{ active: Id; ids: Id[] }>({ active, ids: [] })
  const [edges, setEdges] = useState({ left: false, right: false, overflow: false })
  // Terminal status updates must not pull a manually scrolled strip back to its selection.
  const layoutKey = JSON.stringify(items.map(item => [item.id, item.title, item.closable]))
  const shown = open && visible

  const updateEdges = useCallback((): void => {
    const strip = stripRef.current
    if (!strip) return
    const next = {
      left: strip.scrollLeft > 1,
      right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
      overflow: strip.scrollWidth > strip.clientWidth + 1
    }
    setEdges(previous => previous.left === next.left && previous.right === next.right && previous.overflow === next.overflow ? previous : next)
  }, [])

  const reveal = useCallback((element: HTMLElement | null): void => {
    const strip = stripRef.current
    if (!strip || !element || strip.clientWidth === 0) return
    const tab = element.closest<HTMLElement>('[data-panel-tab]') ?? element
    const bounds = strip.getBoundingClientRect()
    const tabBounds = tab.getBoundingClientRect()
    const padding = 10
    let left = strip.scrollLeft
    if (tabBounds.width > bounds.width - padding * 2 || tabBounds.left < bounds.left + padding) left += tabBounds.left - bounds.left - padding
    else if (tabBounds.right > bounds.right - padding) left += tabBounds.right - bounds.right + padding
    strip.scrollLeft = Math.max(0, Math.min(left, strip.scrollWidth - strip.clientWidth))
    updateEdges()
  }, [updateEdges])

  useEffect(() => {
    if (open && !visible) onOpenChange(false)
  }, [open, visible, onOpenChange])

  useLayoutEffect(() => {
    const previous = previousLayoutRef.current
    const ids = items.map(item => item.id)
    const removedInactive = previous.active === active && previous.ids.some(id => id !== active && !ids.includes(id))
    previousLayoutRef.current = { active, ids }
    if (!removedInactive) reveal(labelsRef.current.get(active) ?? null)
    updateEdges()
  }, [active, layoutKey, reveal, updateEdges])

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const observer = new ResizeObserver(() => {
      reveal(strip.querySelector<HTMLButtonElement>('[aria-pressed="true"]'))
      updateEdges()
    })
    observer.observe(strip)
    return () => observer.disconnect()
  }, [reveal, updateEdges])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const onWheel = (event: WheelEvent): void => {
      // Keep native horizontal input (including diagonal trackpad gestures) and zoom intact.
      if (event.ctrlKey || event.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth + 1) return
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1
      const delta = Math.max(-strip.clientWidth * .8, Math.min(strip.clientWidth * .8, event.deltaY * unit))
      const left = Math.max(0, Math.min(strip.scrollLeft + delta, strip.scrollWidth - strip.clientWidth))
      if (!event.cancelable || Math.abs(left - strip.scrollLeft) < .5) return
      event.preventDefault()
      strip.scrollLeft = left
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])

  useLayoutEffect(() => {
    const request = closeFocusRef.current
    if (!request || items.some(item => item.id === request.id)) return
    closeFocusRef.current = null
    const next = items[Math.min(request.index, items.length - 1)]
    if (!next) return
    const target = request.inList && shown
      ? Array.from(popupRef.current?.querySelectorAll<HTMLButtonElement>('[data-tab-choice]') ?? []).find(button => button.dataset.tabChoice === next.id)
      : labelsRef.current.get(next.id)
    target?.focus({ preventScroll: true })
  }, [items, shown])

  useEffect(() => {
    if (!shown) return
    const frame = requestAnimationFrame(() => {
      const buttons = popupRef.current?.querySelectorAll<HTMLButtonElement>('[data-tab-choice]')
      const target = Array.from(buttons ?? []).find(button => button.dataset.tabChoice === active) ?? buttons?.[0]
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
    // Only initial opening should move focus, not a list item being closed.
  }, [shown])

  const page = (direction: -1 | 1): void => {
    const strip = stripRef.current
    if (!strip) return
    const bounds = strip.getBoundingClientRect()
    const tabs = Array.from(strip.children) as HTMLElement[]
    let left: number
    if (direction === 1) {
      const next = tabs.find(tab => tab.getBoundingClientRect().right > bounds.right - 4)
      left = next ? strip.scrollLeft + next.getBoundingClientRect().left - bounds.left - 10 : strip.scrollWidth
      if (left <= strip.scrollLeft + 4) left = strip.scrollLeft + strip.clientWidth * .75
    } else {
      const firstVisible = tabs.findIndex(tab => tab.getBoundingClientRect().right > bounds.left + 4)
      const previous = tabs[Math.max(0, firstVisible - 1)]
      left = previous ? strip.scrollLeft + previous.getBoundingClientRect().right - bounds.right + 10 : 0
      if (left >= strip.scrollLeft - 4) left = strip.scrollLeft - strip.clientWidth * .75
    }
    strip.scrollTo({
      left: Math.max(0, Math.min(left, strip.scrollWidth - strip.clientWidth)),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    })
  }

  const navigate = (event: KeyboardEvent<HTMLElement>, inList = false): void => {
    const selector = inList ? '[data-tab-choice]' : '[data-tab-label]'
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(selector))
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    let next: HTMLButtonElement | undefined
    if (event.key === (inList ? 'ArrowDown' : 'ArrowRight')) next = buttons[(index + 1) % buttons.length]
    if (event.key === (inList ? 'ArrowUp' : 'ArrowLeft')) next = buttons[(index - 1 + buttons.length) % buttons.length]
    if (event.key === 'Home') next = buttons[0]
    if (event.key === 'End') next = buttons[buttons.length - 1]
    if (!next) return
    event.preventDefault()
    next.focus({ preventScroll: true })
    if (inList) next.scrollIntoView({ block: 'nearest' })
  }

  const close = (item: PanelTabItem<Id>, index: number, inList: boolean): void => {
    closeFocusRef.current = { id: item.id, index, inList }
    onClose(item.id)
  }

  return <div className="panel-tabs" data-overflow={edges.overflow}>
    <div className="panel-tabs__rail">
      <button type="button" className="panel-tabs__page" hidden={!edges.overflow} disabled={!edges.left}
        aria-label="向左翻页" title="向左翻页" onClick={() => page(-1)}><TabIcon name="previous" /></button>
      <div className="panel-tabs__viewport" data-left={edges.left} data-right={edges.right}>
        <div ref={stripRef} className="panel-tabs__strip" role="group" aria-label="右侧栏内容"
          onScroll={updateEdges} onKeyDown={navigate}>
          {items.map((item, index) => <span key={item.id} className="panel-tabs__tab" data-panel-tab={item.id} data-active={active === item.id}>
            <button type="button" className="panel-tabs__label" data-tab-label="" aria-pressed={active === item.id} title={item.title}
              ref={element => { if (element) labelsRef.current.set(item.id, element); else labelsRef.current.delete(item.id) }}
              onFocus={event => reveal(event.currentTarget)} onClick={() => { reveal(labelsRef.current.get(item.id) ?? null); onSelect(item.id) }}>{item.title}</button>
            {item.closable ? <button type="button" className="panel-tabs__close" disabled={item.closeDisabled}
              aria-label={`关闭${item.title}页签`} title={item.closeTitle ?? `关闭${item.title}`}
              onFocus={event => reveal(event.currentTarget)} onClick={() => close(item, index, false)}><TabIcon name="close" /></button> : null}
          </span>)}
        </div>
      </div>
      <button type="button" className="panel-tabs__page" hidden={!edges.overflow} disabled={!edges.right}
        aria-label="向右翻页" title="向右翻页" onClick={() => page(1)}><TabIcon name="next" /></button>
    </div>
    <Popover.Root open={shown} onOpenChange={next => { selectedFromListRef.current = null; onOpenChange(next) }}>
      <Popover.Trigger className="panel-tabs__list-trigger" aria-label={`全部页签，共 ${items.length} 个`} title={`全部页签（${items.length}）`}>
        <TabIcon name="list" />
      </Popover.Trigger>
      <Popover.Portal container={containerRef} className="terminal-actions__portal">
        <Popover.Positioner positionMethod="fixed" side="bottom" align="end" sideOffset={8} collisionPadding={8}
          collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
          collisionBoundary={containerRef.current ?? undefined} className="terminal-actions__positioner">
          <Popover.Popup ref={popupRef} className="terminal-actions__popup panel-tabs__popup" initialFocus={false}
            finalFocus={() => visible ? (selectedFromListRef.current ? labelsRef.current.get(selectedFromListRef.current) ?? true : true) : false}
            onKeyDown={event => navigate(event, true)}>
            <Popover.Title className="terminal-actions__heading panel-tabs__list-title">全部页签 <span>{items.length}</span></Popover.Title>
            {items.map((item, index) => <div key={item.id} className="panel-tabs__choice-row" data-active={active === item.id}>
              <button type="button" className="panel-tabs__choice" data-tab-choice={item.id} aria-pressed={active === item.id} title={item.title}
                onClick={() => { selectedFromListRef.current = item.id; onSelect(item.id); onOpenChange(false) }}>
                <span className="panel-tabs__check"><TabIcon name="check" /></span><span className="panel-tabs__choice-title">{item.title}</span>
              </button>
              {item.closable ? <button type="button" className="panel-tabs__close" disabled={item.closeDisabled}
                aria-label={`关闭${item.title}页签`} title={item.closeTitle ?? `关闭${item.title}`}
                onClick={() => close(item, index, true)}><TabIcon name="close" /></button> : null}
            </div>)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>
}
