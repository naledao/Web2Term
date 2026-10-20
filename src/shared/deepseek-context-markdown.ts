import { DeepSeekQuestionError, deepSeekConversation } from './deepseek-question'
import type { DeepSeekSelection } from './deepseek-question'
import type { ConversationMessage } from './types'

export interface SavedQuestionContext {
  conversationId: string
  title: string
  /** In the exact reading order returned by listConversationMessages(). */
  messages: ConversationMessage[]
}
export type SavedQuestionContextReader = (conversationId: string) => SavedQuestionContext | null | Promise<SavedQuestionContext | null>
export interface QuestionContextSnapshot {
  title: string
  messages: Pick<ConversationMessage, 'id' | 'role' | 'content'>[]
}

const normalize = (value: string): string => value.normalize('NFKC')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, '')
  .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '')

/** Use only the application's clean saved transcript, never provider/share APIs. */
export function savedQuestionSnapshot(context: SavedQuestionContext | null, conversationId: string, selection: DeepSeekSelection): QuestionContextSnapshot {
  if (!context || context.conversationId !== conversationId || deepSeekConversation('https://chat.deepseek.com' + selection.sourcePath)?.id !== conversationId ||
      context.messages.some(message => message.conversationId !== conversationId)) {
    throw new DeepSeekQuestionError('local-source', '未找到当前会话的本地对话数据，请确认软件“对话”中已保存该会话。')
  }
  if (!context.messages.length) throw new DeepSeekQuestionError('local-empty', '当前会话尚未保存对话文字。请等待回答保存后再提问。')
  const answer = normalize(selection.answerText), selected = normalize(selection.selectedText)
  if (!answer || !selected || !answer.includes(selected)) throw new DeepSeekQuestionError('local-selection', '选区已失效，请重新选择回答中的文字。')
  const matchesBody = (message: ConversationMessage): boolean => {
    const body = normalize(message.content)
    return message.role === 'assistant' && body.includes(selected) && (body === answer ||
      (answer.length >= 96 && body.includes(answer.slice(0, 48)) && body.includes(answer.slice(-48))))
  }
  const sourceMatches = selection.sourceMessageId ? context.messages.filter(message =>
    message.role === 'assistant' && message.sourceMessageId === selection.sourceMessageId) : []
  // A stable app capture key survives Markdown formatting differences. If it is
  // absent from an older capture, require a unique match against the full answer.
  const candidates = sourceMatches.length ? sourceMatches.filter(message => normalize(message.content).includes(selected))
    : context.messages.filter(matchesBody)
  if (candidates.length !== 1) throw new DeepSeekQuestionError('local-answer', candidates.length
    ? '本地数据中存在多条相同回答，无法确定上下文范围，请选择另一条回答。'
    : '所选回答尚未保存到本地对话数据中，请等待保存后重试。')
  const target = context.messages.indexOf(candidates[0])
  return { title: context.title.trim() || 'DeepSeek 对话', messages: context.messages.slice(0, target + 1)
    .map(({ id, role, content }) => ({ id, role, content })) }
}

export function questionContextMarkdown(snapshot: QuestionContextSnapshot): string {
  const title = snapshot.title.replace(/[\r\n\t]+/g, ' ').trim() || 'DeepSeek 对话'
  return [`# ${title}`, '', '以下为本软件本地保存的对话文字，范围截至所选回答。', '',
    ...snapshot.messages.flatMap((message, index) => [
      `## ${index + 1}. ${message.role === 'user' ? '用户' : 'AI'}`, '',
      message.content.replace(/\r\n?/g, '\n').trim() || '（此消息没有文字正文。）', ''
    ])].join('\n')
}
