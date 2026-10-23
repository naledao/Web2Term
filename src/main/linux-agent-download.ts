import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { updaterSession } from './updater'
import type { LinuxAgentDownloadState } from '../shared/types'

export const LINUX_AGENT_FILE_NAME = 'web2term-linux-amd64'
const LINUX_AGENT_URL = `https://github.com/naledao/Web2Term/releases/latest/download/${LINUX_AGENT_FILE_NAME}`

/**
 * Downloads the web2term Linux tool from the latest GitHub Release.
 *
 * Through the updater's session so the 应用更新 proxy applies: it is the same
 * destination as an update. The published `.sha256` is checked before the file
 * is put in place, so a truncated or tampered download never lands under the
 * chosen name.
 */
export class LinuxAgentDownloader {
  private state: LinuxAgentDownloadState = { phase: 'idle', percent: 0, message: '', path: '' }

  constructor(private readonly onChanged: (state: LinuxAgentDownloadState) => void) {}

  getState(): LinuxAgentDownloadState {
    return { ...this.state }
  }

  get busy(): boolean {
    return this.state.phase === 'downloading'
  }

  async download(target: string): Promise<void> {
    if (this.busy) return
    const partial = `${target}.part`
    this.update({ phase: 'downloading', percent: 0, message: '正在读取校验值…', path: target })
    try {
      const fetcher = updaterSession()
      const checksumResponse = await fetcher.fetch(`${LINUX_AGENT_URL}.sha256`)
      if (!checksumResponse.ok) throw new Error(`读取校验值失败（HTTP ${checksumResponse.status}），最新版本可能还在发布中，请稍后重试。`)
      const expected = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('校验文件格式不正确，请稍后重试。')

      const response = await fetcher.fetch(LINUX_AGENT_URL)
      if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}），最新版本可能还在发布中，请稍后重试。`)
      const total = Number(response.headers.get('content-length')) || 0
      const hash = createHash('sha256')
      const output = createWriteStream(partial)
      // Listened for, not left unhandled: an unwritable folder must fail this download, not the app.
      let writeError: Error | null = null
      output.on('error', (error) => { writeError = error })
      let received = 0
      try {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (writeError) throw new Error(`无法写入文件：${(writeError as Error).message}`)
          hash.update(value)
          received += value.length
          if (!output.write(value)) {
            await new Promise((resolve) => {
              output.once('drain', resolve)
              output.once('error', resolve)
            })
          }
          // One push per whole percent, not one per network chunk.
          const percent = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0
          if (percent !== this.state.percent || this.state.message !== '') this.update({ ...this.state, percent, message: '' })
        }
      } finally {
        output.end()
        await finished(output).catch(() => {})
      }
      if (writeError) throw new Error(`无法写入文件：${(writeError as Error).message}`)
      if (hash.digest('hex') !== expected) throw new Error('下载的文件校验不一致，已丢弃，请重试。')
      await rename(partial, target)
      this.update({ phase: 'done', percent: 100, message: '', path: target })
    } catch (error) {
      await unlink(partial).catch(() => {})
      this.update({ phase: 'error', percent: 0, message: (error as Error).message || '下载失败，请重试。', path: target })
    }
  }

  private update(next: LinuxAgentDownloadState): void {
    this.state = next
    this.onChanged(this.getState())
  }
}
