import SMTPConnection from 'nodemailer/lib/smtp-connection'
import MailComposer from 'nodemailer/lib/mail-composer'
import { QQ_MAIL_SMTP } from '../shared/qq-mail'
import type { QqMailMessage } from './qq-mail'

/** One SMTP transaction. Abort/timeout closes the actual socket; no automatic retry. */
export async function sendQqMailNotification(message: QqMailMessage, signal: AbortSignal, current: () => boolean): Promise<void> {
  const mime = await new MailComposer({
    from: { address: message.auth.user, name: 'Web2Term' },
    to: { address: message.recipientEmail, name: '' },
    subject: message.subject, text: message.body,
    disableFileAccess: true, disableUrlAccess: true
  }).compile().build()
  const connection = new SMTPConnection({
    host: QQ_MAIL_SMTP.host, port: QQ_MAIL_SMTP.port, secure: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    dnsTimeout: 10_000, connectionTimeout: 10_000, greetingTimeout: 10_000,
    socketTimeout: 15_000, logger: false, debug: false
  })
  await new Promise<void>((resolve, reject) => {
    let settled = false, sending = false
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      connection.close()
      if (error) {
        const smtpError = error as Error & { code?: string; responseCode?: number }
        // A definite SMTP rejection is different from losing the acceptance response.
        reject(sending && !smtpError.responseCode ? Object.assign(new Error('SMTP result unknown'), { code: 'EUNCERTAIN' }) : error)
      } else resolve()
    }
    const abort = (): void => finish(Object.assign(new Error('Cancelled'), { code: 'ECANCELLED' }))
    const timer = setTimeout(() => finish(Object.assign(new Error('SMTP timeout'), { code: 'ETIMEDOUT' })), 30_000)
    signal.addEventListener('abort', abort, { once: true })
    connection.on('error', finish)
    connection.once('end', () => finish(new Error('SMTP connection ended')))
    if (signal.aborted || !current()) { abort(); return }
    connection.connect(error => {
      if (settled) return
      if (error) { finish(error); return }
      if (signal.aborted || !current()) { abort(); return }
      connection.login(message.auth, error => {
        if (settled) return
        if (error) { finish(error); return }
        if (signal.aborted || !current()) { abort(); return }
        sending = true
        connection.send({ from: message.auth.user, to: [message.recipientEmail] }, mime, (error, info) => {
          if (settled) return
          if (error) { finish(error); return }
          if (!info?.accepted.includes(message.recipientEmail)) { finish(new Error('SMTP acceptance unknown')); return }
          finish()
        })
      })
    })
  })
}

/** Explicit user-triggered connection check; never sends a message or retries automatically. */
export async function verifyQqMailConnection(auth: { user: string; pass: string }): Promise<void> {
  const connection = new SMTPConnection({
    host: QQ_MAIL_SMTP.host,
    port: QQ_MAIL_SMTP.port,
    secure: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    dnsTimeout: 10_000,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    logger: false,
    debug: false
  })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Close the actual SMTP socket, including when the overall deadline expires.
      connection.close()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(Object.assign(new Error('SMTP connection timed out'), { code: 'ETIMEDOUT' })), 20_000)
    connection.on('error', finish)
    connection.once('end', () => finish(new Error('SMTP connection closed')))
    connection.connect(error => {
      if (settled) return
      if (error) { finish(error); return }
      connection.login(auth, finish)
    })
  })
}
