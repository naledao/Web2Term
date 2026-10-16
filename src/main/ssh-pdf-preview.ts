import { posix } from 'node:path'
import { isPdfPath, MAX_PDF_PREVIEW_BYTES } from '../shared/pdf-preview'
import type { SshPdfPreviewData, SshPdfPreviewRequest, SshState } from '../shared/types'

interface PdfSource {
  getState(): Pick<SshState, 'status' | 'attached' | 'hostId'>
  readFileForModel(path: string, hostId: string, maxBytes: number, signal: AbortSignal): Promise<Buffer>
}

/** One preview per session; closing, replacing or disconnecting cancels its SFTP read. */
export class SshPdfPreviewReader {
  private readonly source: PdfSource
  private pending: { requestId: string; controller: AbortController } | null = null

  constructor(source: PdfSource) { this.source = source }

  async read(request: SshPdfPreviewRequest): Promise<SshPdfPreviewData> {
    if (!request || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.requestId) ||
      typeof request.hostId !== 'string' || typeof request.path !== 'string' ||
      !posix.isAbsolute(request.path) || request.path.includes('\0') || !isPdfPath(request.path)) {
      throw new Error('请选择有效的远程 PDF 文件。')
    }
    this.verifyHost(request.hostId)
    this.cancel()
    const controller = new AbortController()
    this.pending = { requestId: request.requestId, controller }
    try {
      const bytes = await this.source.readFileForModel(request.path, request.hostId, MAX_PDF_PREVIEW_BYTES, controller.signal)
      controller.signal.throwIfAborted()
      this.verifyHost(request.hostId)
      if (bytes.length > MAX_PDF_PREVIEW_BYTES) throw new Error('PDF 超过 32 MB，请下载后查看。')
      if (bytes.subarray(0, 1024).indexOf('%PDF-') < 0) throw new Error('文件不是有效的 PDF，无法预览。')
      // Use a standard ArrayBuffer, never expose a Node Buffer across the bridge.
      const data = new Uint8Array(bytes.length)
      data.set(bytes)
      return { hostId: request.hostId, path: request.path, data: data.buffer }
    } catch (error) {
      if (error instanceof Error && /文件超过本次读取大小上限|文件读取超过大小上限/.test(error.message)) {
        throw new Error('PDF 超过 32 MB，请下载后查看。')
      }
      throw error
    } finally {
      if (this.pending?.controller === controller) this.pending = null
    }
  }

  cancel(requestId?: string): void {
    if (!this.pending || (requestId !== undefined && this.pending.requestId !== requestId)) return
    const pending = this.pending
    this.pending = null
    pending.controller.abort(new Error('PDF 预览已取消。'))
  }

  private verifyHost(hostId: string): void {
    const state = this.source.getState()
    if (!state.attached || state.status !== 'connected' || !hostId || state.hostId !== hostId) {
      throw new Error('原 SSH 主机已断开或切换，请重新打开 PDF。')
    }
  }
}
