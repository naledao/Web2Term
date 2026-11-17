import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import type { ClaudeAccount } from '@shared/claude-accounts'

interface Props {
  accounts: ClaudeAccount[]
  accountId: string
  disabled: boolean
  container: HTMLElement
  onSelect(id: string): Promise<void>
  onAdd(label: string): Promise<void>
}

export default function ClaudeAccountPicker({ accounts, accountId, disabled, container, onSelect, onAdd }: Props) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const current = accounts.find(account => account.id === accountId)
  const change = async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await action()
      setOpen(false)
      setLabel('')
    } catch (failure) {
      setError(failure instanceof Error
        ? failure.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Claude 账号操作失败。')
    } finally { setPending(false) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={next => { if (!pending) { setOpen(next); setError('') } }}>
      <Dialog.Trigger className="focus-chat__account" disabled={disabled || pending}
        aria-label={`切换 Claude 账号，当前为${current?.label ?? 'Claude'}`}
        title={disabled ? '当前操作结束后可切换 Claude 账号' : '切换 Claude 账号'}>
        <span>{current?.label ?? 'Claude 账号'}</span><span aria-hidden="true">▾</span>
      </Dialog.Trigger>
      <Dialog.Portal container={container}>
        <Dialog.Popup className="modal" onMouseDown={event => {
          if (!pending && event.target === event.currentTarget && event.button === 0) setOpen(false)
        }}>
          <div className="modal__box focus-compaction__picker">
            <Dialog.Title className="modal__head">切换 Claude 账号</Dialog.Title>
            <div className="modal__body focus-chat__accounts">
              <Dialog.Description>选择账号打开对应的对话。添加账号后，请在 Claude 网页完成登录，再切回专注对话。</Dialog.Description>
              <ul>
                {accounts.map(account => <li key={account.id}>
                  <button type="button" aria-current={account.id === accountId ? 'true' : undefined}
                    disabled={disabled || pending || account.id === accountId} onClick={() => void change(() => onSelect(account.id))}>
                    <span>{account.label}</span>{account.id === accountId ? <span>当前账号</span> : null}
                  </button>
                </li>)}
              </ul>
              <form onSubmit={event => {
                event.preventDefault()
                if (!pending && !disabled && label.trim()) void change(() => onAdd(label))
              }}>
                <label>新账号备注<input value={label} maxLength={40} disabled={disabled || pending}
                  onChange={event => setLabel(event.target.value)} placeholder="例如 Claude 工作账号" /></label>
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
