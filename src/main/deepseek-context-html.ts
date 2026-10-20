import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deepSeekContextHtml } from '../shared/deepseek-context-html'
import { DeepSeekQuestionError } from '../shared/deepseek-question'
import type { DeepSeekContextSnapshot } from '../shared/deepseek-question'

export async function saveDeepSeekContextHtml(snapshot: DeepSeekContextSnapshot): Promise<string> {
  const document = deepSeekContextHtml(snapshot)
  if (Buffer.byteLength(document) > 20 * 1024 * 1024) throw new DeepSeekQuestionError('html-size', '生成的 HTML 超过 20 MiB 附件上限，无法发送完整上下文。')
  const shareId = new URL(snapshot.shareUrl).pathname.split('/').at(-1) ?? ''
  if (!/^[\w-]{1,128}$/.test(shareId)) throw new DeepSeekQuestionError('html-source', '本地 HTML 的来源链接无效。')
  const directory = join(app.getPath('userData'), 'exports', 'deepseek', `${shareId}-${randomUUID()}`)
  const path = join(directory, 'deepseek-context.html')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(path, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return path
  } catch {
    throw new DeepSeekQuestionError('html-write', '分享链接已生成，但保存本地 HTML 失败，请检查本地存储后重试。')
  }
}
