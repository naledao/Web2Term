/** QQ personal mail only. Connection parameters are fixed, never supplied over IPC. */
export const QQ_MAIL_SMTP = { host: 'smtp.qq.com', port: 465, encryption: 'SSL/TLS' } as const

/** Public settings: the saved authorization code never crosses back into the renderer. */
export interface QqMailSettings {
  /** Default notification recipient, saved independently of sender credentials. */
  recipientEmail: string
  recipientError: string | null
  senderEmail: string
  hasAuthorizationCode: boolean
  encryptionAvailable: boolean
  credentialError: string | null
}

export interface QqMailSettingsDraft {
  senderEmail: string
  /** Empty preserves the saved code only when the sender is unchanged. */
  authorizationCode: string
}

export interface QqMailResult {
  ok: boolean
  message: string
  settings?: QqMailSettings
}
