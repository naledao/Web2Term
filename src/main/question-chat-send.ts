import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import interceptorSource from './injected/send-interceptor.js?raw'
import { prepareFiles } from './file-access'
import { sendPageFiles } from './page-files'
import { questionPageCall } from './question-chat-page'
import { isQuestionChatHome, supportsSelectionQuestion } from '../shared/deepseek-question'
import type { ChatPlatform } from '../shared/platforms'
import type { FileSendOutcome } from '../shared/file-requests'

/** Upload the generated snapshot and question as ONE message. No URL-only fallback. */
export async function sendQuestionChatAttachment(
  contents: Electron.WebContents, platform: ChatPlatform, contextPath: string, prompt: string,
  signal: AbortSignal, isCurrent: () => boolean
): Promise<FileSendOutcome> {
  if (!contextPath || !supportsSelectionQuestion(platform.id) || !isCurrent() || signal.aborted) return 'cancelled'
  const platformId = platform.id
  const ownerUrl = contents.getURL()
  if (!isQuestionChatHome(platformId, ownerUrl)) return 'cancelled'
  const config = { enabled: false, promptInjectionEnabled: false, prefix: '', armBaseline: true, page: platform.page }
  // Reuse the measured file-input bridge, with terminal behavior disabled. This
  // WebContents has no console report handler that could execute commands.
  await questionPageCall(contents, `${interceptorSource}\n;window.__cmdTerminalInterceptor.configure(${JSON.stringify(config)});true`)
  const prepared = await prepareFiles({ type: 'read_files', files: [{ path: contextPath }], description: '追问的本地对话 Markdown 上下文',
    context: { scope: 'local', hostId: '', cwd: dirname(contextPath) } }, signal, undefined, platformId)
  try {
    if (!isCurrent() || signal.aborted || contents.isDestroyed() || contents.getURL() !== ownerUrl) return 'cancelled'
    if (prepared.failed || prepared.attachments.length !== 1 || prepared.attachments[0].mimeType !== 'text/markdown') return 'upload-failed'
    return await sendPageFiles(contents, platformId, prepared.attachments, randomUUID(), isCurrent, signal,
      { caption: prompt, allowNewConversation: true })
  } finally { await prepared.cleanup() }
}
