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
  '向已配置的收件邮箱发送一封纯文本通知，收发配置由软件读取。只传 type、subject、body，不支持自定义收发地址、附件、HTML 或 SMTP 参数。',
  '',
  '仅输出一个 JSON 代码块，标题和正文按实际任务填写：',
  '```json',
  '{"type":"send_email","subject":"任务通知","body":"通知内容第一行。\\n通知内容第二行。"}',
  '```',
  '',
  'subject 为 1–200 字符且不能换行；body 为 1–20000 字符，换行按 JSON 写成 \\n；均不能仅含空白。',
  '等待 email_result，按 status 和 message 告知结果：sent 表示 SMTP 已接受，送达以收件邮箱为准；failed 为发送失败；unknown 为发送结果不确定，先请用户检查邮箱；cancelled 为调用已取消。',
  '勿因未收到回执或结果不确定重复发送；重发须有用户明确要求。配置缺失或失效时引导至「设置 → 邮件通知」，勿读取授权码或自行编写发信脚本。'
].join('\n')
