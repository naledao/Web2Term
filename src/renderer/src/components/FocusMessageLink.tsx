import { useContext, useEffect, useRef, useState } from 'react'
import type { ComponentProps, JSX } from 'react'
import { parseFocusFileHref, parseFocusNativeFileHref, validFocusFileLinkTarget } from '@shared/focus-file-links'
import type { FocusNativeFileLink } from '@shared/focus-file-links'
import { FocusFilePreviewContext } from './FocusFilePreview'
import FocusCitationLink, { FocusCitationContext } from './FocusCitationLink'
import './FocusMessageLink.css'

function FileLink({ href, title, children, style, nativeTarget }: ComponentProps<'a'> & { nativeTarget?: FocusNativeFileLink }): JSX.Element {
  const context = useContext(FocusCitationContext)
  const preview = useContext(FocusFilePreviewContext)
  const epoch = useRef(0)
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    epoch.current++; inFlight.current = false; setPending(false); setError('')
    return () => { epoch.current++ }
  }, [context?.ownerKey, context?.visible, href])
  const open = async (element: HTMLButtonElement): Promise<void> => {
    if (!context?.visible || inFlight.current) return
    const sourceMessageId = element.closest('[data-question-answer]')?.getAttribute('data-question-answer') ?? ''
    const target = nativeTarget ?? { href: href ?? '', sourceMessageId,
      label: (element.textContent ?? '').replace(/\s+/g, ' ').trim() }
    if (!preview || !validFocusFileLinkTarget(target) || target.sourceMessageId !== sourceMessageId) { setError('原始回复尚未载入，请稍后重试。'); return }
    const id = ++epoch.current
    inFlight.current = true; setPending(true); setError('')
    try {
      const outcome = await preview.open(target)
      if (id !== epoch.current) return
      if (outcome !== 'ok') setError(outcome === 'busy' ? '网页正在处理其他操作，请稍后重试。' :
        outcome === 'unknown' ? '打开请求的结果暂不明确，请先检查下载或在原始视图中查看。' : '文件链接暂不可用，请在原始视图中打开。')
    } catch { if (id === epoch.current) setError('打开文件失败，请在原始视图中查看。') }
    finally { if (id === epoch.current) { inFlight.current = false; setPending(false) } }
  }
  return <span className="focus-file-link" style={style}><button type="button" className="focus-file-link__trigger"
    title={title || nativeTarget?.label || href} disabled={pending || !context?.visible} aria-busy={pending}
    onClick={event => void open(event.currentTarget)}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false"><path d="M10 2v10m-4-4 4 4 4-4M3 12v4h14v-4" /></svg>
    <span>{children}</span></button>{error ? <span className="focus-file-link__error" role="alert">{error}
      {context ? <button type="button" onClick={context.onOriginal}>查看原始链接</button> : null}</span> : null}</span>
}

export default function FocusMessageLink(props: ComponentProps<'a'>): JSX.Element {
  const nativeTarget = parseFocusNativeFileHref(props.href)
  if (nativeTarget) return <FileLink {...props} nativeTarget={nativeTarget}>{nativeTarget.label}</FileLink>
  const href = parseFocusFileHref(props.href)
  return href ? <FileLink {...props} href={href} /> : <FocusCitationLink {...props} />
}
