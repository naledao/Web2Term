import { createElement, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, ReactNode } from 'react'
import type { FocusLayoutData, FocusLayoutNode } from '@shared/focus-layout'
import './FocusLayout.css'

const tones: Record<string, string> = { $text: 'var(--fc-text)', $muted: 'var(--fl-muted)', $bg: 'var(--fc-bg)',
  $soft: 'var(--fc-soft)', $border: 'var(--fc-border)', $accent: 'var(--fc-accent)' }
function draw(node: string | FocusLayoutNode, key: number): ReactNode {
  if (typeof node === 'string') return node
  const style = Object.fromEntries(Object.entries(node.style ?? {}).map(([name, value]) => [name, tones[value] ?? value])) as CSSProperties
  const height = node.style?.height ?? ''
  const divider = node.tag === 'hr' || (['div', 'span'].includes(node.tag) &&
    !(node.children ?? []).some(child => typeof child !== 'string' || child.trim().length > 0) &&
    /^\d+(?:\.\d+)?px$/.test(height) && parseFloat(height) > 0 && parseFloat(height) <= 2 &&
    !!node.style?.backgroundColor && node.style.backgroundColor !== 'transparent')
  // Native Divider keeps spacing in padding and paints only the one-pixel content box.
  // Restore that paint boundary for saved trees too, without coloring the surrounding space.
  if (divider) Object.assign(style, { boxSizing: 'content-box', backgroundClip: 'content-box',
    height: '1px', minHeight: '1px', maxHeight: '1px', borderWidth: 0,
    flexGrow: 0, flexShrink: 0, flexBasis: 'auto', backgroundColor: tones.$border })
  return createElement(node.tag, { ...node.attrs, style, key,
    ...(node.tag === 'svg' ? { 'aria-hidden': true, focusable: false } : {}) },
  ...((node.tag === 'hr' || node.tag === 'br') ? [] : (node.children ?? []).map(draw)))
}

/** Rebuild a validated presentation tree; native HTML and code never enter this renderer. */
export default function FocusLayout({ data }: { data: FocusLayoutData }): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const read = (): void => setOverflow(element.scrollWidth > element.clientWidth + 1)
    const observer = new ResizeObserver(read)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    read()
    return () => observer.disconnect()
  }, [data])
  return <section className={data.kind === 'list' ? 'focus-layout focus-layout--list' : 'focus-layout'} aria-label={data.label || '智能界面布局'}>
    <div className="focus-layout__viewport" ref={viewport} tabIndex={overflow ? 0 : undefined}
      role={overflow ? 'region' : undefined} aria-label={overflow ? '可左右滚动的界面布局' : undefined}>
      <div className="focus-layout__canvas" style={{ minWidth: data.kind === 'list' ? 0 : Math.min(data.width, 560) }}>{draw(data.root, 0)}</div>
    </div>
    {overflow ? <p className="focus-layout__hint">左右滚动查看完整布局</p> : null}
  </section>
}
