import { useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { QqMailResult, QqMailSettings as Settings } from '@shared/qq-mail'
import './QqMailSettings.css'

interface Props {
  onBusyChange(busy: boolean): void
}

type Operation = 'save' | 'verify' | 'clear' | 'saveRecipient' | 'clearRecipient'

export default function QqMailSettings({ onBusyChange }: Props): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [recipientEmail, setRecipientEmail] = useState('')
  const [recipientFeedback, setRecipientFeedback] = useState<QqMailResult | null>(null)
  const [senderEmail, setSenderEmail] = useState('')
  const [authorizationCode, setAuthorizationCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [feedback, setFeedback] = useState<QqMailResult | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadFailed(false)
    setFeedback(null)
    setRecipientFeedback(null)
    void window.api.getQqMailSettings().then(value => {
      if (cancelled) return
      setSettings(value)
      setRecipientEmail(value.recipientEmail)
      setSenderEmail(value.senderEmail)
      setAuthorizationCode('')
      setShowCode(false)
    }).catch(() => {
      if (cancelled) return
      setLoadFailed(true)
      setFeedback({ ok: false, message: '读取 QQ 邮箱配置失败，请重试。' })
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reload])

  useEffect(() => () => { onBusyChange(false) }, [onBusyChange])

  const reusableCode = Boolean(settings?.hasAuthorizationCode && !settings.credentialError
    && senderEmail.trim().toLowerCase() === settings.senderEmail)
  const configured = Boolean(settings?.senderEmail && settings.hasAuthorizationCode && !settings.credentialError)
  const recipientConfigured = Boolean(settings?.recipientEmail && !settings.recipientError)
  const disabled = loading || loadFailed || operation !== null
  const ready = Boolean(senderEmail.trim() && (authorizationCode.trim() || reusableCode))

  const perform = async (action: Operation): Promise<void> => {
    if (busyRef.current || loading || loadFailed) return
    const isRecipientAction = action === 'saveRecipient' || action === 'clearRecipient'
    const report = isRecipientAction ? setRecipientFeedback : setFeedback
    busyRef.current = true
    setOperation(action)
    onBusyChange(true)
    report(null)
    try {
      const draft = { senderEmail, authorizationCode }
      const result = action === 'saveRecipient' ? await window.api.saveQqMailRecipient(recipientEmail)
        : action === 'clearRecipient' ? await window.api.clearQqMailRecipient()
        : action === 'clear' ? await window.api.clearQqMailSettings()
        : action === 'verify' ? await window.api.verifyQqMailSettings(draft)
          : await window.api.saveQqMailSettings(draft)
      report(result)
      if (result.ok && result.settings) {
        setSettings(result.settings)
        if (isRecipientAction) {
          setRecipientEmail(result.settings.recipientEmail)
        } else {
          setSenderEmail(result.settings.senderEmail)
          setAuthorizationCode('')
          setShowCode(false)
        }
      }
    } catch {
      report({ ok: false, message: '操作未完成，请重新读取配置，确认保存状态后重试。' })
    } finally {
      busyRef.current = false
      setOperation(null)
      onBusyChange(false)
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (ready) void perform('save')
  }

  return <div className="qq-mail-settings" aria-busy={loading || operation !== null}>
    <section className="qq-mail-settings__recipient" aria-labelledby="qq-mail-recipient-label">
      <form className="qq-mail-settings__form" onSubmit={event => {
        event.preventDefault()
        if (recipientEmail.trim()) void perform('saveRecipient')
      }}>
        <div className="settings-backend-field">
          <div className="qq-mail-settings__section-heading">
            <label id="qq-mail-recipient-label" className="settings-proxy-row__label" htmlFor="qq-mail-recipient">接收通知的 QQ 邮箱</label>
            <span className={`qq-mail-settings__status ${recipientConfigured ? 'qq-mail-settings__status--ready' : ''}`}>
              <i aria-hidden="true" />{loading ? '正在读取…' : loadFailed ? '读取失败' : settings?.recipientError ? '需要重新配置' : recipientConfigured ? '已配置' : '未配置'}
            </span>
          </div>
          <input id="qq-mail-recipient" className="address__input settings-input" type="email" required maxLength={71}
            placeholder="例如：123456789@qq.com" autoComplete="off" spellCheck={false} autoCapitalize="none"
            disabled={disabled}
            value={recipientEmail} onChange={event => { setRecipientEmail(event.target.value); setRecipientFeedback(null) }} />
        </div>
        {settings?.recipientError ? <p className="settings-feedback" role="alert">{settings.recipientError}</p> : null}
        <div className="qq-mail-settings__actions">
          <button type="submit" className="settings-save-btn" disabled={disabled || !recipientEmail.trim()}>
            {operation === 'saveRecipient' ? '保存中…' : '保存收件邮箱'}
          </button>
          <button type="button" className="settings-cancel-btn"
            disabled={disabled || !(settings?.recipientEmail || settings?.recipientError)} onClick={() => void perform('clearRecipient')}>
            {operation === 'clearRecipient' ? '清除中…' : '清除收件邮箱'}
          </button>
        </div>
        {recipientFeedback ? <p className={recipientFeedback.ok ? 'qq-mail-settings__success' : 'settings-feedback'}
          role={recipientFeedback.ok ? 'status' : 'alert'}>{recipientFeedback.message}</p> : null}
      </form>
    </section>
    <div className={`qq-mail-settings__status ${configured ? 'qq-mail-settings__status--ready' : ''}`}>
      <i aria-hidden="true" />{loading ? '正在读取配置…' : loadFailed ? '配置读取失败' : configured ? '已保存发信配置' : settings?.credentialError ? '配置需要修复' : '尚未配置发件邮箱'}
    </div>
    <form className="qq-mail-settings__form" onSubmit={submit}>
      <div className="settings-backend-field">
        <label className="settings-proxy-row__label" htmlFor="qq-mail-sender">发件邮箱</label>
        <input id="qq-mail-sender" className="address__input settings-input" type="email" required maxLength={71}
          placeholder="QQ邮箱" autoComplete="off" spellCheck={false} disabled={disabled}
          value={senderEmail} onChange={event => { setSenderEmail(event.target.value); setFeedback(null) }} />
      </div>
      <div className="settings-backend-field">
        <label className="settings-proxy-row__label" htmlFor="qq-mail-code">SMTP 授权码</label>
        <div className="qq-mail-settings__secret">
          <input id="qq-mail-code" className="address__input settings-input" type={showCode ? 'text' : 'password'}
            placeholder={reusableCode ? '授权码已保存，留空保留；输入新授权码可替换' : '填写 16 位 SMTP 授权码'}
            autoComplete="new-password" spellCheck={false} autoCapitalize="none" maxLength={64} disabled={disabled}
            value={authorizationCode}
            onChange={event => { setAuthorizationCode(event.target.value); setFeedback(null) }} />
          <button type="button" className="settings-outline-btn" disabled={disabled || !authorizationCode}
            aria-label={showCode ? '隐藏新输入的授权码' : '显示新输入的授权码'} aria-pressed={showCode}
            onClick={() => setShowCode(value => !value)}>{showCode ? '隐藏' : '显示'}</button>
        </div>
      </div>
      {settings?.credentialError ? <p className="settings-feedback" role="alert">{settings.credentialError}</p> : null}
      {settings && !settings.encryptionAvailable ? <p className="settings-feedback" role="alert">系统安全存储不可用，暂时无法保存授权码。请解锁系统密钥存储后重新打开设置。</p> : null}
      <div className="qq-mail-settings__actions">
        <button type="submit" className="settings-save-btn" disabled={disabled || !ready || !settings?.encryptionAvailable}>
          {operation === 'save' ? '保存中…' : '保存配置'}
        </button>
        <button type="button" className="settings-outline-btn" disabled={disabled || !ready} onClick={() => void perform('verify')}>
          {operation === 'verify' ? <><span className="btn-spinner" aria-hidden="true" />检查中…</> : '测试连接'}
        </button>
        <button type="button" className="settings-cancel-btn" disabled={disabled || !(settings?.hasAuthorizationCode || settings?.credentialError)} onClick={() => void perform('clear')}>
          {operation === 'clear' ? '清除中…' : '清除发信配置'}
        </button>
      </div>
      {feedback ? <p className={feedback.ok ? 'qq-mail-settings__success' : 'settings-feedback'} role={feedback.ok ? 'status' : 'alert'}>{feedback.message}</p> : null}
      {loadFailed ? <button type="button" className="settings-outline-btn" onClick={() => setReload(value => value + 1)}>重新读取配置</button> : null}
    </form>
    <details className="qq-mail-settings__help">
      <summary>如何获取 SMTP 授权码</summary>
      <ol>
        <li>登录 QQ 邮箱网页版，进入“设置 → 账号与安全 → 安全设置”。</li>
        <li>开启 POP3/IMAP/SMTP 服务，再选择“生成授权码”。</li>
        <li>完成身份验证，将生成的 16 位授权码填入上方。</li>
      </ol>
      <a href="https://help.mail.qq.com/detail/106/985" target="_blank" rel="noopener noreferrer">查看 QQ 邮箱官方说明 ↗</a>
    </details>
  </div>
}
