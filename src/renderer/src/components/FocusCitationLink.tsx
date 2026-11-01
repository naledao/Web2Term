import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ComponentProps, JSX, RefObject } from 'react'
import { Popover } from '@base-ui/react/popover'
import type { FocusOwner } from '@shared/focus-chat'
import { cleanFocusCitationCopy, parseFocusCitationHref, parseFocusCitationSources } from '@shared/focus-citations'
import type { FocusCitation, FocusCitationSource } from '@shared/focus-citations'
import './AppPopover.css'
import './FocusCitationLink.css'

interface CitationContext {
  owner: FocusOwner
  ownerKey: string
  visible: boolean
  containerRef: RefObject<HTMLElement | null>
  onOriginal(): void
}
export const FocusCitationContext = createContext<CitationContext | null>(null)
export { cleanFocusCitationCopy }

function SourceIcon(): JSX.Element {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
    <circle cx="10" cy="10" r="7.5" /><path d="M2.5 10h15M10 2.5c4 4 4 11 0 15-4-4-4-11 0-15Z" />
  </svg>
}
function CitationControl({ data, context }: { data: FocusCitation; context: CitationContext | null }): JSX.Element {
  const epoch = useRef(0)
  const loading = useRef<number | null>(null)
  const cachedSources = useRef<FocusCitationSource[]>([])
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [sources, setSources] = useState<FocusCitationSource[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!context?.visible) { epoch.current++; loading.current = null; setOpen(false); setPending(false) }
    return () => { epoch.current++; loading.current = null }
  }, [context?.visible])
  const load = async (): Promise<void> => {
    if (!context || !context.visible || loading.current !== null || cachedSources.current.length) return
    const id = ++epoch.current
    loading.current = id
    setPending(true); setError('')
    try {
      const result = await window.api.readFocusCitation({ ...context.owner, sourceMessageId: data.sourceMessageId,
        index: data.index, signature: data.signature })
      if (id !== epoch.current) return
      const links = result.outcome === 'ok' ? parseFocusCitationSources(result.sources) : null
      if (links) { cachedSources.current = links; setSources(links) }
      else setError(result.outcome === 'busy' ? '网页正在处理其他操作，请稍后重试。' : '这组来源尚未载入，请重试或在原始视图中查看。')
    } catch { if (id === epoch.current) setError('读取来源失败，请重试或在原始视图中查看。') }
    finally { if (loading.current === id) { loading.current = null; if (id === epoch.current) setPending(false) } }
  }
  // Closing a hover card keeps its in-flight read: the next hover can reuse the
  // result instead of racing another native read. Owner changes still revoke it.
  const close = (): void => { setOpen(false) }
  return <span className="focus-citation"><Popover.Root open={open && context?.visible !== false} modal={false}
    onOpenChange={next => { setOpen(next); if (next) void load() }}>
    <Popover.Trigger type="button" className="focus-citation__trigger" openOnHover delay={200} closeDelay={300}>
      <SourceIcon /><span>{data.label}</span>
    </Popover.Trigger>
    <Popover.Portal container={context?.containerRef}
      className={'app-popover-portal' + (context?.containerRef ? ' app-popover-portal--bounded' : '')}>
      <Popover.Positioner positionMethod="fixed" side="bottom" align="start" sideOffset={8} collisionPadding={12}
        collisionBoundary={context?.containerRef.current ?? undefined}
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }} className="app-popover-positioner">
    <Popover.Popup className="app-popover focus-citation-popover" aria-label="引用来源" style={{ width: 360 }}
      finalFocus={() => context?.visible === true}>
      <div className="focus-citation__heading"><strong>引用来源{sources.length ? ` · ${sources.length}` : ''}</strong>
        <Popover.Close type="button" aria-label="关闭来源列表"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></Popover.Close>
      </div>
      {pending ? <p className="focus-citation__status" role="status">正在读取来源…</p> : null}
      {sources.length ? <ul className="focus-citation__sources">{sources.map(source => <li key={source.url}>
        <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>
          <span className="focus-citation__site"><SourceIcon />{source.site}</span><strong>{source.title}</strong>
        </a>
      </li>)}</ul> : null}
      {error || !context ? <div className="focus-citation__error"><p role="alert">{error || '请在原始视图中查看这组来源。'}</p>
        {context ? <div><button type="button" disabled={pending} onClick={() => void load()}>重试</button>
          <button type="button" onClick={() => { close(); context.onOriginal() }}>查看原始来源</button></div> : null}
      </div> : null}
    </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root></span>
}

/** Reserved citation links become local source lists; ordinary Markdown links remain links. */
export default function FocusCitationLink({ href, title, children }: ComponentProps<'a'>): JSX.Element {
  const context = useContext(FocusCitationContext)
  const data = parseFocusCitationHref(href)
  return data ? <CitationControl key={(context?.ownerKey ?? '') + ':' + data.sourceMessageId + ':' + data.index + ':' + data.signature} data={data} context={context} /> :
    <a href={href} title={title} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>
}
