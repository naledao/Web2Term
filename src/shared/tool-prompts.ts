import { fileReadingPlatform } from './types'

/** Names the model uses for tools; each maps to one conversation tool switch. */
export type ToolPromptName = 'read_files' | 'background_task' | 'scheduled_task' | 'send_email' | 'computer'

export const TOOL_PROMPT_NAMES: readonly ToolPromptName[] = Object.freeze(['read_files', 'background_task', 'scheduled_task', 'send_email', 'computer'])

/** Injected instead of the full definitions; the model reads a definition only when it needs it. */
export const TOOL_PROMPT_SUMMARIES: Readonly<Record<ToolPromptName, string>> = Object.freeze({
  read_files: '将当前终端对应机器上的文件完整上传为当前会话附件，供查看源码、图片和文档。',
  background_task: '在当前终端对应机器启动非交互后台任务或常驻服务，自动回传就绪或结束结果。',
  scheduled_task: '按用户要求创建、查询、修改和删除当前对话的周期计划，到期向绑定的 AI 对话提交任务；创建时不立即执行。',
  send_email: '需要邮件通知时，向已配置的收件邮箱发送一封纯文本邮件。',
  computer: '发现、观察并操作本机桌面应用；命令、文件和后台任务使用对应工具。'
})

export interface ReadToolPromptRequest {
  type: 'read_tool_prompt'
  tools: ToolPromptName[]
}

/** Provenance belongs to the live page, never to the model's JSON. */
export interface ToolPromptReadCall {
  messageId: string
  rawJson: string
  conversationId: string
  pageEpoch: string
  sourceSubmissionId: string
}

export function parseReadToolPromptRequest(value: unknown): ReadToolPromptRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.type !== 'read_tool_prompt' || Object.keys(input).some(key => key !== 'type' && key !== 'tools') ||
    !Array.isArray(input.tools) || input.tools.length < 1 || input.tools.length > TOOL_PROMPT_NAMES.length ||
    input.tools.some(name => typeof name !== 'string' || !TOOL_PROMPT_NAMES.includes(name as ToolPromptName))) return null
  return { type: 'read_tool_prompt', tools: [...new Set(input.tools as ToolPromptName[])] }
}

export interface ToolCatalogEntry {
  name: ToolPromptName
  /** State that changes with settings (an unconfigured mailbox); stays inline. */
  note?: string
}

/**
 * The injected tool section: one summary line per enabled tool plus how to read a full definition.
 * `notes` carries what must stay inline because it changes with state (disabled tools, computer use status).
 */
export function toolCatalogPrompt(platformId: string, entries: ToolCatalogEntry[], notes = ''): string {
  if (!fileReadingPlatform(platformId)) return ''
  const tail = notes.trim()
  if (entries.length === 0) return tail
  return [
    [
      '【工具目录】',
      '以下只列出当前对话可用工具的摘要，不含调用格式：',
      ...entries.map(entry => `- ${entry.name}：${TOOL_PROMPT_SUMMARIES[entry.name]}${entry.note ? entry.note : ''}`),
      '',
      '需要使用某个工具时，先单独输出一个 JSON 代码块读取它的完整说明，软件会把说明作为下一条消息发回，读完后严格按说明调用：',
      '```json',
      `{"type":"read_tool_prompt","tools":["${entries[0].name}"]}`,
      '```',
      `tools 为 1–${TOOL_PROMPT_NAMES.length} 个上面列出的工具名，可一次读取多个；该请求与 command、questions 及其他工具请求互斥。不要凭摘要猜测调用格式；本任务中已读过且确定格式时可直接调用，不确定时重新读取。`
    ].join('\n'),
    ...(tail ? [tail] : [])
  ].join('\n\n')
}

export type ToolPromptLookup = { prompt: string } | { unavailable: string }

/** The receipt sent back for one read_tool_prompt request. */
export function toolPromptReadReply(request: ReadToolPromptRequest | null, lookup: (name: ToolPromptName) => ToolPromptLookup): string {
  if (!request) {
    return ['【工具说明读取失败】',
      `请求格式无效。单独输出一个 JSON 代码块：{"type":"read_tool_prompt","tools":["工具名"]}，tools 为 1–${TOOL_PROMPT_NAMES.length} 个工具目录中列出的工具名。`].join('\n')
  }
  const sections = request.tools.map(name => {
    const result = lookup(name)
    return 'prompt' in result ? result.prompt : `【工具：${name}】\n当前不可用：${result.unavailable}不要调用该工具。`
  })
  return ['【工具说明】', '以下是你请求读取的工具完整说明。本条消息不是用户的新要求，读完后按说明继续原任务。', '', sections.join('\n\n')].join('\n')
}
