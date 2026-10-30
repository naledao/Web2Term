import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode, RefObject } from 'react'
import { Popover } from '@base-ui/react/popover'
import './TerminalActionsMenu.css'

export type TerminalActionId = 'interrupt' | 'reset' | 'close' | 'local' | 'ssh' | 'web2term'
  | 'directory' | 'edit-directory' | 'upload' | 'files'

interface TerminalActionsMenuProps {
  containerRef: RefObject<HTMLElement | null>
  triggerRef: RefObject<HTMLButtonElement | null>
  visible: boolean
  mode: 'local' | 'ssh' | 'web2term'
  connected: boolean
  resetDisabled: boolean
  closeDisabled: boolean
  closing: boolean
  uploading: boolean
  sendDelaySeconds: number
  onAction: (action: TerminalActionId) => void
  onSendDelayChange: (seconds: number) => Promise<void>
}

type MenuPage = 'main' | 'connection'
type IconName = 'down' | 'stop' | 'reset' | 'connection' | 'folder' | 'edit' | 'upload'
  | 'files' | 'back' | 'next' | 'close' | 'local'

const ICON_PATHS: Record<IconName, string> = {
  down: 'm6 9 6 6 6-6',
  stop: 'M5 5h14v14H5z',
  reset: 'M3 11a9 9 0 1 1 2.6 7M3 4v7h7',
  local: 'M4 4h16v12H4zM12 16v4m-4 0h8',
  connection: 'M7 3v4m10-4v4M5 7h14v4a7 7 0 0 1-14 0V7zm7 11v3',
  folder: 'M3 8V5h6l2 3h10v3M3 8h18l-3 11H1L3 8z',
  edit: 'm15 4 5 5M4 15 15 4a3.5 3.5 0 0 1 5 5L9 20H4v-5z',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
  files: 'M3 5h7l2 3h9v12H3V5z',
  back: 'm14 6-6 6 6 6',
  next: 'm9 6 6 6-6 6',
  close: 'm6 6 12 12M6 18 18 6'
}

function ActionIcon({ name }: { name: IconName }): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICON_PATHS[name]} />
  </svg>
}

function ActionButton({ children, icon, disabled, danger, trailing, onClick }: {
  children: ReactNode
  icon: ReactNode
  disabled?: boolean
  danger?: boolean
  trailing?: ReactNode
  onClick: () => void
}): JSX.Element {
  return <button type="button" className={danger ? 'terminal-actions__item terminal-actions__item--danger' : 'terminal-actions__item'} disabled={disabled} onClick={onClick}>
    <span className="terminal-actions__icon">{icon}</span>
    <span className="terminal-actions__label">{children}</span>
    {trailing}
  </button>
}

export default function TerminalActionsMenu(props: TerminalActionsMenuProps): JSX.Element {
  const { containerRef, triggerRef, visible, mode, connected, resetDisabled, closeDisabled,
    closing, uploading, sendDelaySeconds, onAction, onSendDelayChange } = props
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<MenuPage>('main')
  const [delayDraft, setDelayDraft] = useState<string | null>(null)
  const [delayError, setDelayError] = useState('')
  const delayDraftRef = useRef<string | null>(null)
  const delaySaveIdRef = useRef(0)
  const popupRef = useRef<HTMLDivElement>(null)
  const suppressRestoreRef = useRef(false)

  // Blur, selection and dismissal may happen together. Consume each draft once.
  const commitDelay = useCallback((): void => {
    const raw = delayDraftRef.current
    delayDraftRef.current = null
    if (raw === null) return
    const value = raw.trim() === '' ? 0 : Number(raw)
    if (!Number.isFinite(value)) { setDelayDraft(null); return }
    const seconds = Math.min(600, Math.max(0, Math.floor(value)))
    const saveId = ++delaySaveIdRef.current
    // Keep the edited value visible until IPC acknowledges it. An older save
    // must not reset a newer edit or a subsequent save.
    setDelayDraft(String(seconds))
    setDelayError('')
    void onSendDelayChange(seconds).then(() => {
      if (saveId === delaySaveIdRef.current && delayDraftRef.current === null) setDelayDraft(null)
    }).catch(() => {
      if (saveId !== delaySaveIdRef.current || delayDraftRef.current !== null) return
      setDelayDraft(null)
      setDelayError('保存失败，请重新设置回传等待时间。')
    })
  }, [onSendDelayChange])

  useEffect(() => {
    if (visible) return
    suppressRestoreRef.current = true
    commitDelay()
    setOpen(false)
  }, [visible, commitDelay])

  useEffect(() => {
    if (!open || !visible) return
    // Focus after the portal has mounted and positioning has settled. Hidden-overflow
    // ancestors can otherwise scroll to reveal the popup's temporary coordinates.
    const frame = requestAnimationFrame(() => {
      popupRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, page, visible])

  const choose = (action: TerminalActionId): void => {
    // Dialogs and inline directory editors manage their own focus after selection.
    suppressRestoreRef.current = action !== 'interrupt' && action !== 'reset' && action !== 'local'
    commitDelay()
    setOpen(false)
    onAction(action)
  }

  const next = <span className="terminal-actions__next"><ActionIcon name="next" /></span>

  return <Popover.Root open={open && visible} onOpenChange={(nextOpen) => {
    if (nextOpen) {
      suppressRestoreRef.current = false
      setPage('main')
    } else commitDelay()
    setOpen(nextOpen)
  }}>
    <Popover.Trigger ref={triggerRef} className="terminal-actions__trigger" title="终端操作" aria-label="终端操作">
      <span>终端操作</span>
      <span className="terminal-actions__trigger-chevron"><ActionIcon name="down" /></span>
    </Popover.Trigger>
    <Popover.Portal container={containerRef} className="terminal-actions__portal">
      <Popover.Positioner positionMethod="fixed" side="bottom" align="end" sideOffset={8} collisionPadding={8}
        collisionAvoidance={{ side: 'shift', align: 'shift', fallbackAxisSide: 'none' }}
        collisionBoundary={containerRef.current ?? undefined} className="terminal-actions__positioner">
        <Popover.Popup ref={popupRef} className="terminal-actions__popup" initialFocus={false} finalFocus={() => !suppressRestoreRef.current}>
          {page === 'main' ? <>
            <Popover.Title className="terminal-actions__heading">终端操作</Popover.Title>
            <ActionButton icon={<ActionIcon name="stop" />} danger onClick={() => choose('interrupt')}>中断当前命令</ActionButton>
            <ActionButton icon={<ActionIcon name="reset" />} disabled={resetDisabled} onClick={() => choose('reset')}>
              {mode === 'web2term' && !connected ? '重新连接' : '重置终端'}
            </ActionButton>
            {mode !== 'web2term' ? <ActionButton icon={<ActionIcon name="connection" />} trailing={next} onClick={() => setPage('connection')}>切换连接</ActionButton> : null}
            {mode !== 'local' ? <ActionButton icon={<ActionIcon name="close" />} disabled={closeDisabled} onClick={() => choose('close')}>
              {closing ? '关闭中…' : mode === 'ssh' ? '关闭 SSH 面板' : '关闭设备终端'}
            </ActionButton> : null}
            <div className="terminal-actions__separator" />
            <ActionButton icon={<ActionIcon name="folder" />} disabled={!connected} onClick={() => choose('directory')}>选择工作目录</ActionButton>
            {mode === 'local' ? <ActionButton icon={<ActionIcon name="edit" />} onClick={() => choose('edit-directory')}>手动输入目录</ActionButton> : null}
            {mode === 'ssh' ? <>
              <ActionButton icon={<ActionIcon name="upload" />} disabled={!connected || uploading} onClick={() => choose('upload')}>{uploading ? '上传中…' : '上传文件'}</ActionButton>
              <ActionButton icon={<ActionIcon name="files" />} disabled={!connected} onClick={() => choose('files')}>浏览远程文件</ActionButton>
            </> : null}
            <div className="terminal-actions__separator" />
            <label className="terminal-actions__delay">
              <span>回传等待</span>
              <span className="terminal-actions__delay-field">
                <input type="number" inputMode="numeric" min={0} max={600} step={1} aria-label="回传前的等待秒数"
                  aria-invalid={delayError ? true : undefined}
                  title="命令执行完成后的回传等待时间：0–600 秒。0 表示立即发送；上下箭头每次调整 1 秒，离开输入框或按 Enter 保存。"
                  value={delayDraft ?? String(sendDelaySeconds)}
                  onChange={(event) => { delayDraftRef.current = event.target.value; setDelayDraft(event.target.value); setDelayError('') }}
                  onBlur={commitDelay}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitDelay()
                      setOpen(false)
                    }
                    if (event.key === 'Escape') {
                      delayDraftRef.current = null
                      setDelayDraft(null)
                    }
                  }} />
                <span>秒</span>
              </span>
            </label>
            {delayError ? <p className="terminal-actions__delay-error" role="alert">{delayError}</p> : null}
          </> : <>
            <Popover.Title className="terminal-actions__sr-only">连接方式</Popover.Title>
            <button type="button" className="terminal-actions__item terminal-actions__back" onClick={() => setPage('main')}>
              <span className="terminal-actions__icon"><ActionIcon name="back" /></span>
              连接方式
            </button>
            <div className="terminal-actions__separator" />
            <ActionButton icon={<ActionIcon name="local" />} disabled={mode === 'local'} onClick={() => choose('local')}>本地终端</ActionButton>
            <ActionButton icon={<ActionIcon name="connection" />} onClick={() => choose('ssh')}>SSH 连接</ActionButton>
            <ActionButton icon={<ActionIcon name="connection" />} onClick={() => choose('web2term')}>web2term 设备</ActionButton>
          </>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
