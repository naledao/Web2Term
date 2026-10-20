import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { questionContextMarkdown } from '../shared/deepseek-context-markdown'
import type { QuestionContextSnapshot } from '../shared/deepseek-context-markdown'
import { DeepSeekQuestionError } from '../shared/deepseek-question'

export async function saveQuestionContextMarkdown(snapshot: QuestionContextSnapshot, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const document = questionContextMarkdown(snapshot)
  if (Buffer.byteLength(document) > 20 * 1024 * 1024) throw new DeepSeekQuestionError('context-size', '本地对话超过 20 MiB 附件上限，无法发送完整上下文。')
  const directory = join(app.getPath('userData'), 'exports', 'deepseek', `context-${randomUUID()}`)
  const path = join(directory, 'deepseek-context.md')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(path, document, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal })
    return path
  } catch {
    signal.throwIfAborted()
    throw new DeepSeekQuestionError('context-write', '保存本地对话 Markdown 失败，请检查本地存储后重试。')
  }
}
