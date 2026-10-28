import type { QqMailService } from './qq-mail'
import type { MailNotificationCall, MailNotificationResult } from '../shared/mail-notification'
import type { TaskResultSendOutcome } from './task-progression'

interface Dependencies {
  mail(): Pick<QqMailService, 'sendNotification'> | undefined
  current(call: MailNotificationCall): boolean
  send(text: string, call: MailNotificationCall, signal: AbortSignal, current: () => boolean): Promise<TaskResultSendOutcome>
  note(message: string): void
}

/** Retries only a definitively unsubmitted AI receipt, never the SMTP operation. */
export class MailNotifications {
  private operation: { call: MailNotificationCall; abort: AbortController; text?: string; attempts: number;
    timer?: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly dependencies: Dependencies) {}

  get busy(): boolean { return this.operation !== null }

  receive(call: MailNotificationCall, sourceKey: string): void {
    const mail = this.dependencies.mail()
    if (this.operation || !mail || !this.dependencies.current(call)) return
    const operation = { call, abort: new AbortController(), attempts: 0 }
    this.operation = operation
    void this.run(operation, mail, sourceKey).catch(() => {
      if (this.operation === operation) {
        this.dependencies.note('邮件通知未完成，请检查收件邮箱后再决定是否重发。')
        this.cancel()
      }
    })
  }

  private current(operation: NonNullable<MailNotifications['operation']>): boolean {
    try { return this.operation === operation && !operation.abort.signal.aborted && this.dependencies.current(operation.call) }
    catch { return false }
  }

  private async run(operation: NonNullable<MailNotifications['operation']>, mail: Pick<QqMailService, 'sendNotification'>, sourceKey: string): Promise<void> {
    let request: unknown
    try { request = JSON.parse(operation.call.rawJson) } catch { request = null }
    const result: MailNotificationResult = await mail.sendNotification(request, sourceKey, operation.abort.signal, () => this.current(operation))
    if (!this.current(operation)) { if (this.operation === operation) this.cancel(); return }
    this.dependencies.note('邮件通知：' + result.message)
    operation.text = '【邮件通知工具结果】\n' + JSON.stringify(result) + '\n请根据结果向用户说明，不要重复发送这封邮件。'
    await this.deliver(operation)
  }

  private async deliver(operation: NonNullable<MailNotifications['operation']>): Promise<void> {
    if (!this.current(operation) || !operation.text) { if (this.operation === operation) this.cancel(); return }
    let outcome: TaskResultSendOutcome
    try { outcome = await this.dependencies.send(operation.text, operation.call, operation.abort.signal, () => this.current(operation)) }
    catch { outcome = 'unknown' }
    if (!this.current(operation)) { if (this.operation === operation) this.cancel(); return }
    if ((outcome === 'busy' || outcome === 'no-composer') && ++operation.attempts < 60) {
      operation.timer = setTimeout(() => {
        void this.deliver(operation).catch(() => { if (this.operation === operation) this.cancel() })
      }, 2000)
      operation.timer.unref?.()
      return
    }
    if (outcome !== 'ok') this.dependencies.note('邮件发送结果未能自动回传 AI，请查看终端中的邮件通知结果；不要据此重新发信。')
    this.cancel()
  }

  reconcile(): void {
    if (this.operation && !this.current(this.operation)) this.cancel()
  }

  cancel(): void {
    const operation = this.operation
    this.operation = null
    if (!operation) return
    if (operation.timer) clearTimeout(operation.timer)
    operation.abort.abort()
  }
}
