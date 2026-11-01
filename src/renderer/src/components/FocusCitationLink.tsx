import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ComponentProps, JSX, RefObject } from 'react'
import type { FocusOwner } from '@shared/focus-chat'
import { cleanFocusCitationCopy, parseFocusCitationHref, parseFocusCitationSources } from '@shared/focus-citations'
import type { FocusCitation, FocusCitationSource } from '@shared/focus-citations'
import AppPopover from './AppPopover'
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
  const trigger = useRef<HTMLButtonElement>(null)
  const epoch = useRef(0)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [sources, setSources] = useState<FocusCitationSource[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!context?.visible) { epoch.current++; setOpen(false); setPending(false) }
    return () => { epoch.current++ }
  }, [context?.visible])
  const load = async (): Promise<void> => {
    if (!context || !context.visible || pending) return
    const id = ++epoch.current
    setPending(true); setError('')
    try {
      const result = await window.api.readFocusCitation({ ...context.owner, sourceMessageId: data.sourceMessageId,
        index: data.index, signature: data.signature })
      if (id !== epoch.current) return
      const links = result.outcome === 'ok' ? parseFocusCitationSources(result.sources) : null
      if (links) setSources(links)
      else setError(result.outcome === 'busy' ? '网页正在处理其他操作，请稍后重试。' : '这组来源尚未载入，请重试或在原始视图中查看。')
    } catch { if (id === epoch.current) setError('读取来源失败，请重试或在原始视图中查看。') }
    finally { if (id === epoch.current) setPending(false) }
  }
  const close = (): void => { epoch.current++; setPending(false); setOpen(false) }
  return <span className="focus-citation">
    <button ref={trigger} type="button" className="focus-citation__trigger" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => { if (open) close(); else { setOpen(true); if (!sources.length) void load() } }}>
      <SourceIcon /><span>{data.label}</span>
    </button>
    <AppPopover open={open} onClose={close} anchor={trigger.current} containerRef={context?.containerRef}
      className="focus-citation-popover" aria-label="引用来源" style={{ width: 360 }}>
      <div className="focus-citation__heading"><strong>引用来源{sources.length ? ` · ${sources.length}` : ''}</strong>
        <button type="button" onClick={close} aria-label="关闭来源列表"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
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
    </AppPopover>
  </span>
}

/** Reserved citation links become local source lists; ordinary Markdown links remain links. */
export default function FocusCitationLink({ href, title, children }: ComponentProps<'a'>): JSX.Element {
  const context = useContext(FocusCitationContext)
  const data = parseFocusCitationHref(href)
  return data ? <CitationControl key={(context?.ownerKey ?? '') + ':' + data.sourceMessageId + ':' + data.index + ':' + data.signature} data={data} context={context} /> :
    <a href={href} title={title} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>
}
