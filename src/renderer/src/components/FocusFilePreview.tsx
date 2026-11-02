import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { focusOwnerKey } from '@shared/focus-chat'
import type { FocusOwner, FocusSendOutcome } from '@shared/focus-chat'
import type { FocusFileLinkTarget, FocusFilePreview } from '@shared/focus-file-links'
import './FocusFilePreview.css'

export const FocusFilePreviewContext = createContext<{ open(target: FocusFileLinkTarget): Promise<FocusSendOutcome> } | null>(null)
// The document is untrusted file content. Its scripts run only inside an opaque sandbox.
export function focusFilePreviewDocument(html: string): string {
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' +
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; " +
    "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\">" +
    html.replace(/^\s*<!doctype[^>]*>/i, '')
}
interface PreviewState { token: string; file: FocusFilePreview | null; error: string }

export default function FocusFilePreviewProvider({ owner, visible, children }: {
  owner: FocusOwner; visible: boolean; children: ReactNode
}): JSX.Element {
  const ownerKey = focusOwnerKey(owner)
  const active = useRef<{ token: string; owner: FocusOwner } | null>(null)
  const launch = useRef<HTMLElement | null>(null)
  const savingRef = useRef(false)
  const [state, setState] = useState<PreviewState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState('')
  const release = useCallback((): void => {
    const current = active.current
    active.current = null; savingRef.current = false
    if (current) void window.api.releaseFocusFilePreview({ ...current.owner, token: current.token }).catch(() => {})
  }, [])
  const close = useCallback((): void => {
    release(); setState(null); setSaving(false); setSaveStatus('')
    if (launch.current?.isConnected) launch.current.focus()
  }, [release])
  useEffect(() => { if (!visible) close(); return release }, [visible, ownerKey, close, release])
  const open = useCallback(async (target: FocusFileLinkTarget): Promise<FocusSendOutcome> => {
    if (!visible) return 'cancelled'
    if (active.current) return 'busy'
    const token = crypto.randomUUID()
    launch.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    active.current = { token, owner }
    setState({ token, file: null, error: '' }); setSaveStatus('')
    try {
      const result = await window.api.previewFocusFile({ ...target, ...owner, token })
      if (active.current?.token !== token) return 'cancelled'
      if (result.outcome === 'ok' && result.preview?.token === token) {
        setState({ token, file: result.preview, error: '' }); return 'ok'
      }
      setState({ token, file: null, error: result.reason === 'too-large' ? '文件超过 10 MB，暂时无法预览。' :
        result.outcome === 'busy' ? '网页正在处理其他操作，请关闭预览后重试。' :
          result.fileStage === 'open' ? '原网页文件入口未响应，请保持应用在前台，关闭预览后重试。' :
            result.reason === 'timeout' && result.fileStage === 'viewer' ? '等待原网页打开文件预览超时，请关闭预览后重试。' :
              result.reason === 'timeout' && result.fileStage === 'download' ? '原网页已打开预览，但未返回下载文件，请关闭预览后重试。' :
                '文件暂时无法打开，请关闭预览后重试。' })
      return result.outcome === 'ok' ? 'unavailable' : result.outcome
    } catch {
      if (active.current?.token === token) setState({ token, file: null, error: '读取文件失败，请关闭预览后重试。' })
      return 'unavailable'
    }
  }, [ownerKey, visible])
  const save = async (): Promise<void> => {
    const current = active.current
    if (!current || !state?.file || savingRef.current) return
    savingRef.current = true; setSaving(true); setSaveStatus('')
    try {
      const result = await window.api.saveFocusFilePreview({ ...current.owner, token: current.token })
      if (active.current?.token === current.token) setSaveStatus(result === 'ok' ? '已保存' : result === 'cancelled' ? '' : '保存失败，请重试。')
    } catch { if (active.current?.token === current.token) setSaveStatus('保存失败，请重试。') }
    finally { if (active.current?.token === current.token) { savingRef.current = false; setSaving(false) } }
  }
  const value = useMemo(() => ({ open }), [open])
  const source = useMemo(() => state?.file?.kind === 'html' ? focusFilePreviewDocument(state.file.text) : '', [state?.file])
  return <FocusFilePreviewContext.Provider value={value}>{children}{visible && state ?
    <section className="focus-file-preview" aria-label="文件预览" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
      <header className="focus-file-preview__header"><div><strong>{state.file?.fileName || '文件预览'}</strong>
        {state.file ? <small>{Math.max(1, Math.ceil(state.file.sizeBytes / 1024))} KB</small> : null}</div>
        <span className="focus-file-preview__save-status" role="status">{saveStatus}</span>
        <button type="button" disabled={!state.file || saving} onClick={() => void save()} className="focus-file-preview__download">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M3 12v4h14v-4" /></svg>{saving ? '保存中…' : '下载'}</button>
        <button type="button" onClick={close} aria-label="关闭文件预览" title="关闭文件预览" className="focus-file-preview__close">×</button>
      </header>
      {state.error ? <div className="focus-file-preview__message" role="alert">{state.error}</div> : !state.file ?
        <div className="focus-file-preview__message" role="status">正在打开文件预览…</div> : state.file.kind === 'html' ?
          <iframe title={state.file.fileName} srcDoc={source} sandbox="allow-scripts" referrerPolicy="no-referrer" className="focus-file-preview__frame" /> :
          state.file.kind === 'text' ? <pre className="focus-file-preview__text">{state.file.text}</pre> :
            <div className="focus-file-preview__message">当前格式暂不支持预览，可使用右上角按钮下载文件。</div>}
    </section> : null}</FocusFilePreviewContext.Provider>
}
