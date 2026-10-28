export interface MailNotificationRequest {
  type: 'send_email'
  subject: string
  body: string
}

/** Provenance belongs to the live page, never to the model's JSON. */
export interface MailNotificationCall {
  messageId: string
  rawJson: string
  conversationId: string
  pageEpoch: string
  sourceSubmissionId: string
}

export interface MailNotificationResult {
  type: 'email_result'
  ok: boolean
  status: 'sent' | 'failed' | 'unknown' | 'cancelled'
  message: string
}

export function parseMailNotificationRequest(value: unknown): MailNotificationRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.type !== 'send_email' || Object.keys(input).some(key => !['type', 'subject', 'body'].includes(key)) ||
    typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 200 || /[\r\n\0]/.test(input.subject) ||
    typeof input.body !== 'string' || !input.body.trim() || input.body.length > 20_000 || input.body.includes('\0')) return null
  return { type: 'send_email', subject: input.subject.trim(), body: input.body.trim() }
}

export const mailNotificationToolPrompt = [
  '【工具：send_email】',
  '需要向用户发送邮件通知时调用。发件邮箱、SMTP 授权信息和默认收件邮箱由软件读取已保存配置，你只提供标题 subject 和纯文本正文 body。',
  '单独输出一个 JSON 代码块，每次调用发送一封邮件，不要与命令或其他工具混在同一条回复中。',
  '```json',
  '{"type":"send_email","subject":"任务完成通知","body":"任务已完成。这里填写结果、需要注意的事项和后续操作。"}',
  '```',
  'subject 为 1–200 个字符，不能换行；body 为 1–20000 个字符，可用 \\n 换行。两项均不能为空。不接受收件人、发件人、附件、HTML 或 SMTP 参数。',
  '发送后等待 email_result。status=sent 表示 SMTP 服务器已接受邮件，不代表已送达收件箱；简短告知用户结果，不要重复调用。',
  'status=failed 表示未能完成发送，按 message 说明原因；配置缺失时请用户进入「设置 → 邮件通知」配置。status=unknown 表示无法确认是否已发送，先提醒用户检查邮箱；不要自行重发。只有用户明确要求重发时才发起新的调用。',
  '不要通过终端命令读取邮箱授权码或自行编写 SMTP 发信脚本。'
].join('\n')
