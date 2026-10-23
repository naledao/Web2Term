import AppPopover from './AppPopover'
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppTheme, SshPdfPreviewData } from '@shared/types'
import './PdfPreviewDialog.css'

const PdfDocumentViewer = lazy(() => import('./PdfDocumentViewer'))

export interface PdfPreviewTarget {
  hostId: string
  path: string
  name: string
}

interface Props {
  target: PdfPreviewTarget
  theme: AppTheme
  onClose: () => void
}

class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override render() {
    return this.state.failed ? <p className="pdf-preview__message" role="alert">PDF 查看器加载失败，请关闭后重新打开，或下载文件查看。</p> : this.props.children
  }
}

export default function PdfPreviewDialog({ target, theme, onClose }: Props) {
  const [pdf, setPdf] = useState<SshPdfPreviewData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const closeButton = useRef<HTMLButtonElement>(null)
  const failViewer = useCallback((message: string) => setError(message), [])

  useEffect(() => {
    let cancelled = false
    const requestId = crypto.randomUUID()
    setLoading(true)
    setPdf(null)
    setError('')
    void window.api.previewSshPdf({ requestId, hostId: target.hostId, path: target.path }).then((result) => {
      if (cancelled) return
      if (result.hostId !== target.hostId || result.path !== target.path) throw new Error('SSH 文件来源已变化，请重新打开。')
      setPdf(result)
    }).catch((failure: unknown) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : '读取 PDF 失败，请重试。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      void window.api.cancelSshPdfPreview(requestId).catch(() => {})
    }
  }, [target.hostId, target.path, attempt])

  const download = async (): Promise<void> => {
    setDownloading(true)
    setDownloadError('')
    try { await window.api.downloadSshFile(target.path, target.hostId) }
    catch (failure) { setDownloadError(failure instanceof Error ? failure.message : '下载失败，请重试。') }
    finally { setDownloading(false) }
  }

  return (
    <AppPopover className={`pdf-preview${theme === 'dark' ? ' pdf-preview--dark' : ''}`} aria-label={`PDF 预览：${target.name}`} onClose={onClose} initialFocus={closeButton}>
      <div className="pdf-preview__box">
        <header className="pdf-preview__head">
          <span className="pdf-preview__badge">PDF</span>
          <div className="pdf-preview__heading">
            <strong title={target.name}>{target.name}</strong>
            <span title={target.path}>{target.path}</span>
          </div>
          <button type="button" className="pdf-preview__button" onClick={() => void download()} disabled={downloading}>{downloading ? '正在下载…' : '下载'}</button>
          <button ref={closeButton} type="button" className="pdf-preview__close" aria-label="关闭 PDF 预览" onClick={onClose}>×</button>
        </header>
        {downloadError ? <p className="pdf-preview__error" role="alert">{downloadError}</p> : null}
        <div className="pdf-preview__body">
          {loading ? <p className="pdf-preview__message" role="status">正在读取远程 PDF…</p> : error ? (
            <div className="pdf-preview__message" role="alert">
              <p>{error}</p>
              <button type="button" className="pdf-preview__button" onClick={() => setAttempt((value) => value + 1)}>重试</button>
            </div>
          ) : pdf ? (
            <ViewerBoundary key={attempt}>
              <Suspense fallback={<p className="pdf-preview__message" role="status">正在加载 PDF 查看器…</p>}>
                <PdfDocumentViewer data={pdf.data} name={target.name} theme={theme} onError={failViewer} />
              </Suspense>
            </ViewerBoundary>
          ) : null}
        </div>
      </div>
    </AppPopover>
  )
}
