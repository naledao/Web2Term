import { useToolSurface } from './ToolSurfaceContext'
import { useRef } from 'react'
import { Popover } from '@base-ui/react/popover'
import AppPopover from './AppPopover'
import type { ReactElement, ReactNode } from 'react'
import './ConfirmPopover.css'

export interface ConfirmDialogItem {
  icon: ReactNode
  label: string
  value: string
  tone?: 'danger' | 'success' | 'neutral'
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  icon?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  danger?: boolean
  dismissOnBackdrop?: boolean
  dismissOnEscape?: boolean
  anchor?: HTMLElement | null
  items?: ConfirmDialogItem[]
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  busy = false,
  danger = false,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  anchor,
  items = [],
  onConfirm,
  onCancel
}: ConfirmDialogProps): ReactElement | null {
  const { visible } = useToolSurface()
  const cancelButton = useRef<HTMLButtonElement>(null)

  if (!open) return null

  return (
    <AppPopover
      className="confirm-popover"
      aria-label={title}
      anchor={anchor}
      open={visible} keepMounted busy={busy} onClose={onCancel}
      dismissOnOutside={dismissOnBackdrop} dismissOnEscape={dismissOnEscape} initialFocus={cancelButton}
    >
      <div className="confirm-popover__body">
        <Popover.Title className="confirm-popover__title">{title}</Popover.Title>
        {description ? <Popover.Description className="confirm-popover__description">{description}</Popover.Description> : null}
        {items.length > 0 ? (
          <dl className="confirm-popover__details">
            {items.map((item, index) => (
              <div className="confirm-popover__detail" key={`${item.label}-${index}`}>
                <dt>{item.label}</dt>
                <dd data-tone={item.tone ?? 'neutral'}>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="confirm-popover__actions">
          <button ref={cancelButton} type="button" className="confirm-popover__cancel" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="confirm-popover__confirm" data-danger={danger} disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </AppPopover>
  )
}
