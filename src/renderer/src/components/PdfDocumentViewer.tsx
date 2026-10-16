import { useEffect, useMemo, useRef } from 'react'
import { PDFViewer, ZoomMode } from '@embedpdf/react-pdf-viewer'
import type { PDFViewerConfig, PDFViewerRef } from '@embedpdf/react-pdf-viewer'
import type { AppTheme } from '@shared/types'
import { PDF_ASSET_ORIGIN } from '@shared/pdf-assets'

interface Props {
  data: ArrayBuffer
  name: string
  theme: AppTheme
  onError: (message: string) => void
}

export default function PdfDocumentViewer({ data, name, theme, onError }: Props) {
  const viewer = useRef<PDFViewerRef>(null)
  const ready = useRef(false)
  const config = useMemo<PDFViewerConfig>(() => ({
    worker: true,
    wasmUrl: `${PDF_ASSET_ORIGIN}/pdfium.wasm`,
    fonts: { ui: { family: 'system-ui, sans-serif', stylesheetUrl: null }, signature: null },
    fontFallback: {
      fonts: {
        0: `${PDF_ASSET_ORIGIN}/latin.ttf`,
        134: `${PDF_ASSET_ORIGIN}/chinese.otf`,
        136: `${PDF_ASSET_ORIGIN}/traditional.otf`
      },
      defaultFont: `${PDF_ASSET_ORIGIN}/latin.ttf`
    },
    documentManager: { initialDocuments: [{ buffer: data, name, documentId: 'remote-pdf' }], maxDocuments: 1 },
    theme: { preference: theme === 'dark' ? 'dark' : 'light' },
    i18n: { defaultLocale: 'zh-CN', fallbackLocale: 'en' },
    zoom: { defaultZoomLevel: ZoomMode.FitWidth },
    tabBar: 'never',
    permissions: { overrides: { modifyContents: false, modifyAnnotations: false, fillForms: false, assembleDocument: false } },
    disabledCategories: [
      'annotation', 'form', 'redaction', 'insert', 'history', 'capture', 'panel-comment',
      'document-open', 'document-close', 'document-protect', 'document-export', 'document-print', 'document-fullscreen'
    ]
  // The drop-in viewer reads config at mount; the parent remounts it for another PDF.
  }), [data, name])

  useEffect(() => { viewer.current?.container?.setTheme(theme === 'dark' ? 'dark' : 'light') }, [theme])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!ready.current) onError('PDF 查看器初始化超时，请重试或下载后查看。')
    }, 30000)
    return () => window.clearTimeout(timer)
  }, [onError])

  return <PDFViewer ref={viewer} config={config} style={{ height: '100%', width: '100%' }} onReady={() => { ready.current = true }} />
}
