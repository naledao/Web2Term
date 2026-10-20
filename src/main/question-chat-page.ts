import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekQuestionError } from '../shared/deepseek-question'

let logPath = ''
export function writeQuestionLog(event: string, details: Record<string, unknown> = {}): string {
  try {
    if (!logPath) {
      const directory = join(tmpdir(), 'gpt-login-diag')
      mkdirSync(directory, { recursive: true })
      logPath = join(directory, `deepseek-question-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`, 'utf8')
  } catch { /* Logging never blocks the user's question. */ }
  return logPath
}

export function questionPageCall<T>(contents: Electron.WebContents, source: string, timeoutMs = 4000): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    contents.executeJavaScript(source) as Promise<T>,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(
      new DeepSeekQuestionError('page-timeout', '页面暂时没有响应，请稍后重试。')
    ), timeoutMs) })
  ]).finally(() => clearTimeout(timer))
}
