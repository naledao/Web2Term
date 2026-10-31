import { useRef, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import type { FocusOwner } from '@shared/focus-chat'
import type { RemoteRipgrepState } from '@shared/remote-ripgrep'
import './RemoteRipgrepDialog.css'

export default function RemoteRipgrepDialog({ state, owner, container, onDefer }: {
  state: RemoteRipgrepState
  owner: FocusOwner
  container: HTMLElement
  onDefer: () => void
}) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [sendUncertain, setSendUncertain] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const actionPending = useRef(false)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const busy = pending || state.prompt === 'sending'
  const uncertain = sendUncertain || state.prompt === 'uncertain'
  const request = { ...owner, connectionId: state.connectionId }

  const dismiss = async (): Promise<void> => {
    if (actionPending.current || busy) return
    actionPending.current = true
    setPending(true)
    try {
      if (!await window.api.dismissRemoteRipgrep(request)) setMessage('远端连接已变化，请关闭后重新打开当前会话。')
    } catch { setMessage('暂时无法关闭提示，请重试。') }
    finally { actionPending.current = false; setPending(false) }
  }

  const install = async (): Promise<void> => {
    if (actionPending.current || busy || uncertain) return
    actionPending.current = true
    setPending(true)
    setMessage('')
    try {
      const result = await window.api.requestRemoteRipgrepInstall(request)
      setBlocked(result.status === 'blocked')
      if (result.status !== 'sent') setMessage(result.message)
    } catch { setSendUncertain(true); setMessage('发送结果尚未确认，请先查看 AI 对话，避免重复发送。') }
    finally { actionPending.current = false; setPending(false) }
  }

  return <Dialog.Root open disablePointerDismissal onOpenChange={(open, details) => {
    if (open) return
    if (busy) { details.cancel(); return }
    if (blocked && !uncertain) onDefer()
    else void dismiss()
  }}>
    <Dialog.Portal container={container}>
      <Dialog.Backdrop className="remote-rg-backdrop" />
      <Dialog.Popup className="remote-rg-dialog" initialFocus={cancelButton}>
        <div className="remote-rg-dialog__body">
          <Dialog.Title className="remote-rg-dialog__title">建议在远端安装 rg</Dialog.Title>
          <Dialog.Description className="remote-rg-dialog__description">
            当前远端终端未检测到可用的 ripgrep（rg）。安装后可以更快地查找文件、搜索代码内容。
          </Dialog.Description>
          <dl className="remote-rg-dialog__target">
            <div><dt>{state.transport === 'ssh' ? 'SSH 主机' : '远程设备'}</dt><dd>{state.name || state.target}</dd></div>
            <div><dt>目标</dt><dd>{state.target}</dd></div>
          </dl>
          <p className="remote-rg-dialog__description">同意后会向当前 AI 对话发送安装要求，由 AI 使用已连接的远端终端安装并检查版本。你可以在对话中查看执行过程；暂不安装仍可继续使用终端。</p>
          {message || state.message ? <p className="remote-rg-dialog__message" role="alert">{message || state.message}</p> : null}
          {blocked && !uncertain ? <p className="remote-rg-dialog__description">可先返回处理草稿、登录或终端设置，再点击顶部工具栏的“重试安装 rg”。</p> : null}
        </div>
        <div className="remote-rg-dialog__actions">
          <Dialog.Close ref={cancelButton} type="button" disabled={busy}>{uncertain ? '我知道了' : blocked ? '先处理，再重试' : '暂不安装'}</Dialog.Close>
          {!uncertain ? <button type="button" className="remote-rg-dialog__install" disabled={busy} onClick={() => void install()}>{busy ? '正在发送…' : '让 AI 安装'}</button> : null}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
