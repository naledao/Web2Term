import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { ACCOUNT_PLATFORMS, DEFAULT_PLATFORM_ACCOUNT_ID } from '@shared/platform-accounts'
import type { AccountPlatformId, PlatformAccount } from '@shared/platform-accounts'

interface Props {
  platformId: AccountPlatformId
  accounts: PlatformAccount[]
  accountId: string
  disabled: boolean
  container: HTMLElement
  onSelect(id: string): Promise<void>
  onAdd(label: string): Promise<void>
  onRemove(id: string): Promise<void>
}

export default function PlatformAccountPicker({ platformId, accounts, accountId, disabled, container, onSelect, onAdd, onRemove }: Props) {
  const { label: platformLabel, sampleLabel } = ACCOUNT_PLATFORMS[platformId]
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const current = accounts.find(account => account.id === accountId)
  const confirmAccount = accounts.find(account => account.id === confirmDeleteId && account.id !== DEFAULT_PLATFORM_ACCOUNT_ID) ?? null
  const updateOpen = (next: boolean): void => {
    if (pending) return
    setOpen(next)
    setError('')
    setConfirmDeleteId(null)
  }
  const run = async (action: () => Promise<void>, options: { close?: boolean; clearLabel?: boolean } = {}): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await action()
      setConfirmDeleteId(null)
      if (options.clearLabel) setLabel('')
      if (options.close) setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error
        ? failure.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : `${platformLabel} 账号操作失败。`)
    } finally { setPending(false) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={updateOpen}>
      <Dialog.Trigger className="focus-chat__account" disabled={disabled || pending}
        aria-label={`切换 ${platformLabel} 账号，当前为${current?.label ?? platformLabel}`}
        title={disabled ? `当前操作结束后可切换 ${platformLabel} 账号` : `切换 ${platformLabel} 账号`}>
        <span>{current?.label ?? `${platformLabel} 账号`}</span><span aria-hidden="true">▾</span>
      </Dialog.Trigger>
      <Dialog.Portal container={container}>
        <Dialog.Popup className="modal" onMouseDown={event => {
          if (!pending && event.target === event.currentTarget && event.button === 0) updateOpen(false)
        }}>
          <div className="modal__box focus-compaction__picker">
            <Dialog.Title className="modal__head">切换 {platformLabel} 账号</Dialog.Title>
            <div className="modal__body focus-chat__accounts">
              <ul>
                {accounts.map(account => {
                  const isCurrent = account.id === accountId
                  const removable = account.id !== DEFAULT_PLATFORM_ACCOUNT_ID
                  const confirming = confirmAccount?.id === account.id
                  return (
                    <li key={account.id}>
                      <button type="button" className="focus-chat__account-select" aria-current={isCurrent ? 'true' : undefined}
                        disabled={disabled || pending || isCurrent}
                        onClick={() => void run(() => onSelect(account.id), { close: true, clearLabel: true })}>
                        <span>{account.label}</span>{isCurrent ? <span>当前账号</span> : null}
                      </button>
                      {removable ? (
                        <button type="button" className="focus-chat__account-delete"
                          aria-label={`删除账号 ${account.label}`} aria-expanded={confirming}
                          title={`删除账号 ${account.label}`} disabled={disabled || pending}
                          onClick={() => { setError(''); setConfirmDeleteId(id => id === account.id ? null : account.id) }}>
                          删除
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {confirmAccount ? (
                <div className="focus-chat__account-confirm" role="region" aria-label={`确认删除 ${platformLabel} 账号`}>
                  <p>
                    确定删除账号“{confirmAccount.label}”？将清除该账号的本地登录状态
                    {confirmAccount.id === accountId ? '，并切回默认账号' : ''}。
                  </p>
                  <div className="focus-chat__account-confirm-actions">
                    <button type="button" disabled={pending} onClick={() => { setConfirmDeleteId(null); setError('') }}>取消</button>
                    <button type="button" className="focus-chat__account-confirm-danger" disabled={disabled || pending}
                      onClick={() => void run(() => onRemove(confirmAccount.id), { close: confirmAccount.id === accountId })}>
                      {pending ? '删除中…' : '确认删除'}
                    </button>
                  </div>
                </div>
              ) : null}
              <form onSubmit={event => {
                event.preventDefault()
                if (!pending && !disabled && label.trim()) void run(() => onAdd(label), { close: true, clearLabel: true })
              }}>
                <label>新账号备注<input value={label} maxLength={40} disabled={disabled || pending}
                  onChange={event => setLabel(event.target.value)} placeholder={sampleLabel} /></label>
                <button type="submit" disabled={disabled || pending || !label.trim()}>添加并登录</button>
              </form>
              {error ? <p className="focus-chat__error" role="alert">{error}</p> : null}
            </div>
            <div className="modal__foot"><Dialog.Close type="button" disabled={pending}>取消</Dialog.Close></div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
