import type { QqMailResult, QqMailSettings, QqMailSettingsDraft } from '../shared/qq-mail'
import { createHash } from 'node:crypto'
import { parseMailNotificationRequest } from '../shared/mail-notification'
import type { MailNotificationResult } from '../shared/mail-notification'

const SETTINGS_KEY = 'qqMail'
const RECIPIENT_KEY = 'qqMailRecipient'

interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}

interface MailDependencies {
  encryptionAvailable(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
  verify(credentials: { user: string; pass: string }): Promise<void>
  send?(message: QqMailMessage, signal: AbortSignal, current: () => boolean): Promise<void>
}

export interface QqMailMessage {
  auth: { user: string; pass: string }
  recipientEmail: string
  subject: string
  body: string
}

interface SavedSettings {
  senderEmail: string
  secret: string
}

function normalizeSender(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入完整的 QQ 邮箱地址。')
  const email = value.trim().toLowerCase()
  const local = email.slice(0, -7)
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?@qq\.com$/.test(email) || local.length > 64 || local.includes('..')) {
    throw new Error('仅支持个人 QQ 邮箱，请填写完整的 @qq.com 地址。')
  }
  return email
}

function normalizeCode(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入 QQ 邮箱 SMTP 授权码。')
  const code = value.replace(/\s/g, '')
  if (code && !/^[a-z0-9]{16}$/i.test(code)) throw new Error('QQ 邮箱授权码应为 16 位字母或数字，请检查后重试。')
  return code
}

function normalizeRecipient(value: unknown): string {
  try {
    return normalizeSender(value)
  } catch {
    throw new Error('请填写一个完整的 QQ 收件邮箱地址（@qq.com）。')
  }
}

/** Configuration stays offline. Network operations require an explicit check or a live tool call. */
export class QqMailService {
  private checking = false
  private readonly store: SettingsStore
  private readonly dependencies: MailDependencies

  constructor(store: SettingsStore, dependencies: MailDependencies) {
    this.store = store
    this.dependencies = dependencies
  }

  private readSaved(): SavedSettings | null {
    const raw = this.store.getSetting(SETTINGS_KEY)
    if (!raw) return null
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object') throw new Error()
      const saved = value as Record<string, unknown>
      if (typeof saved.secret !== 'string' || !saved.secret) throw new Error()
      return { senderEmail: normalizeSender(saved.senderEmail), secret: saved.secret }
    } catch {
      throw new Error('已保存的 QQ 邮箱配置损坏，请重新填写邮箱和授权码后保存。')
    }
  }

  private decryptCode(secret: string): string {
    try {
      if (!this.dependencies.encryptionAvailable()) throw new Error()
      const code = normalizeCode(this.dependencies.decrypt(secret))
      if (!code) throw new Error()
      return code
    } catch {
      throw new Error('无法读取已保存的授权码，请重新填写授权码后保存。')
    }
  }

  getSettings(): QqMailSettings {
    const state: QqMailSettings = {
      recipientEmail: '', recipientError: null,
      senderEmail: '', hasAuthorizationCode: false,
      encryptionAvailable: this.dependencies.encryptionAvailable(), credentialError: null
    }
    try {
      const recipient = this.store.getSetting(RECIPIENT_KEY)
      if (recipient) state.recipientEmail = normalizeRecipient(recipient)
    } catch {
      state.recipientError = '无法读取已保存的默认收件邮箱，请重新填写并保存，或清除后重试。'
    }
    try {
      const saved = this.readSaved()
      if (saved) {
        state.senderEmail = saved.senderEmail
        state.hasAuthorizationCode = true
        this.decryptCode(saved.secret)
      }
    } catch (error) {
      state.credentialError = (error as Error).message
    }
    return state
  }

  saveRecipient(value: unknown): QqMailResult {
    let recipientEmail: string
    try {
      recipientEmail = normalizeRecipient(value)
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
    try {
      this.store.setSetting(RECIPIENT_KEY, recipientEmail)
    } catch {
      return { ok: false, message: '默认收件邮箱保存失败，请重试。' }
    }
    return { ok: true, message: '默认收件邮箱已保存。', settings: this.getSettings() }
  }

  clearRecipient(): QqMailResult {
    try {
      this.store.setSetting(RECIPIENT_KEY, '')
    } catch {
      return { ok: false, message: '默认收件邮箱清除失败，请重试。' }
    }
    return { ok: true, message: '默认收件邮箱已清除。', settings: this.getSettings() }
  }

  availability(): { available: boolean; message: string } {
    const settings = this.getSettings()
    const message = settings.recipientError || settings.credentialError ||
      (!settings.recipientEmail ? '请在「设置 → 邮件通知」保存收件邮箱。' : '') ||
      (!settings.senderEmail || !settings.hasAuthorizationCode ? '请在「设置 → 邮件通知」保存发件邮箱和 SMTP 授权码。' : '')
    return { available: !message, message }
  }

  async sendNotification(value: unknown, sourceKey: string, signal: AbortSignal, current: () => boolean): Promise<MailNotificationResult> {
    const result = (status: MailNotificationResult['status'], message: string): MailNotificationResult =>
      ({ type: 'email_result', ok: status === 'sent', status, message })
    const request = parseMailNotificationRequest(value)
    if (!request) return result('failed', '邮件参数无效：只接受 type、subject 和 body；标题最多 200 字符且不能换行，正文最多 20000 字符，均不能为空。')
    if (!sourceKey || sourceKey.length > 4096) return result('failed', '邮件调用来源无效，未发送。')
    if (signal.aborted || !current()) return result('cancelled', '原任务已变化，邮件发送已取消。')
    const key = 'qqMailDelivery:' + createHash('sha256').update(sourceKey).digest('hex')
    let senderRaw: string | null, recipientRaw: string | null, message: QqMailMessage
    try {
      const previous = this.store.getSetting(key)
      if (previous) {
        try {
          const saved = JSON.parse(previous) as MailNotificationResult
          if (saved.type === 'email_result' && ['sent', 'failed', 'unknown', 'cancelled'].includes(saved.status)) return saved
        } catch { /* A claim interrupted by shutdown is never replayed. */ }
        return result('unknown', '此邮件调用已开始发送，结果尚未确认。请检查收件邮箱，不要重复发送。')
      }
      senderRaw = this.store.getSetting(SETTINGS_KEY)
      recipientRaw = this.store.getSetting(RECIPIENT_KEY)
      const sender = this.readSaved()
      if (!sender) return result('failed', '请先在「设置 → 邮件通知」保存发件邮箱和 SMTP 授权码。')
      if (!recipientRaw) return result('failed', '请先在「设置 → 邮件通知」保存接收通知的 QQ 邮箱。')
      message = { auth: { user: sender.senderEmail, pass: this.decryptCode(sender.secret) },
        recipientEmail: normalizeRecipient(recipientRaw), subject: request.subject, body: request.body }
    } catch {
      return result('failed', '无法读取有效的邮件配置，请在「设置 → 邮件通知」检查并重新保存邮箱和授权码。')
    }
    if (!this.dependencies.send) return result('failed', '邮件发送服务不可用。')
    const eligible = (): boolean => {
      try {
        return !signal.aborted && current() && this.store.getSetting(SETTINGS_KEY) === senderRaw &&
          this.store.getSetting(RECIPIENT_KEY) === recipientRaw
      } catch { return false }
    }
    if (!eligible()) return result('cancelled', '任务或邮件配置已变化，未发送邮件。')
    try {
      // Commit before opening SMTP. A crash or duplicate page event cannot replay this call.
      this.store.setSetting(key, JSON.stringify({ status: 'sending' }))
    } catch { return result('failed', '无法记录邮件发送状态，未发送邮件，请检查本地存储后重试。') }
    let outcome: MailNotificationResult
    try {
      await this.dependencies.send(message, signal, eligible)
      outcome = result('sent', '邮件已提交给 QQ 邮箱 SMTP 服务器，请在收件邮箱查看，实际送达情况以邮箱为准。')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      outcome = code === 'EUNCERTAIN' ? result('unknown', '发送连接中断，无法确认邮件是否已发送。请先检查收件邮箱，不要自动重发。')
        : code === 'ECANCELLED' ? result('cancelled', '任务或邮件配置已变化，邮件发送已取消。')
          : result('failed', code === 'EAUTH' ? 'SMTP 登录失败，请在「设置 → 邮件通知」检查发件邮箱和授权码。'
            : '邮件发送未完成，请检查网络、收发邮箱及 SMTP 服务。请勿自动重试。')
    }
    try { this.store.setSetting(key, JSON.stringify(outcome)) }
    catch {
      // Keep the original durable claim. Never turn an accepted email into a retryable error.
      outcome = { ...outcome, message: outcome.message + ' 本地发送记录未能更新，请勿重复发送。' }
    }
    return outcome
  }

  private credentials(draft: QqMailSettingsDraft): { user: string; pass: string } {
    if (!draft || typeof draft !== 'object') throw new Error('邮件配置无效，请重新填写。')
    const user = normalizeSender(draft.senderEmail)
    const code = normalizeCode(draft.authorizationCode)
    if (code) return { user, pass: code }
    const saved = this.readSaved()
    if (!saved || saved.senderEmail !== user) throw new Error('首次配置或更换发件邮箱时，请填写对应的 SMTP 授权码。')
    return { user, pass: this.decryptCode(saved.secret) }
  }

  save(draft: QqMailSettingsDraft): QqMailResult {
    if (this.checking) return { ok: false, message: '请等待当前连接检查结束。' }
    let credentials: { user: string; pass: string }
    try {
      credentials = this.credentials(draft)
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
    if (!this.dependencies.encryptionAvailable()) return { ok: false, message: '系统安全存储不可用，无法加密保存授权码，请解锁系统密钥存储后重试。' }
    let secret: string
    try {
      secret = this.dependencies.encrypt(credentials.pass)
      if (!secret) throw new Error()
    } catch {
      return { ok: false, message: '授权码加密失败，原配置已保留，请重试。' }
    }
    try {
      // One row keeps the sender and its encrypted authorization code atomic.
      this.store.setSetting(SETTINGS_KEY, JSON.stringify({ senderEmail: credentials.user, secret }))
    } catch {
      return { ok: false, message: '邮件配置保存失败，请重试。' }
    }
    return { ok: true, message: 'QQ 邮箱发信配置已保存。', settings: this.getSettings() }
  }

  clear(): QqMailResult {
    if (this.checking) return { ok: false, message: '请等待当前连接检查结束。' }
    try {
      this.store.setSetting(SETTINGS_KEY, '')
    } catch {
      return { ok: false, message: '邮件配置清除失败，请重试。' }
    }
    return { ok: true, message: 'QQ 邮箱发信配置已清除。', settings: this.getSettings() }
  }

  async verify(draft: QqMailSettingsDraft): Promise<QqMailResult> {
    if (this.checking) return { ok: false, message: '正在检查 QQ 邮箱连接，请稍候。' }
    let credentials: { user: string; pass: string }
    try {
      credentials = this.credentials(draft)
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
    this.checking = true
    try {
      await this.dependencies.verify(credentials)
      return { ok: true, message: 'SMTP 连接和授权校验通过，未发送邮件。当前输入需点击“保存配置”才会保存。' }
    } catch (error) {
      // SMTP errors can contain server replies or credentials. Return only fixed messages.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code === 'EAUTH') return { ok: false, message: 'SMTP 登录失败，请确认已开启 SMTP 服务，并使用当前邮箱的有效授权码。' }
      if (code === 'ETIMEDOUT') return { ok: false, message: '连接 QQ 邮箱超时，请检查网络后手动重试。' }
      return { ok: false, message: '无法连接 QQ 邮箱 SMTP 服务，请检查网络、SMTP 服务状态和授权码后重试。' }
    } finally {
      this.checking = false
    }
  }
}
