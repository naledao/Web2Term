import { useRef } from 'react'
import type { JSX } from 'react'
import { Dialog } from '@base-ui/react/dialog'

interface Props {
  source: string
  name: string
  onClose(): void
}

/** Portal to the document so scrolling and animated chat containers cannot clip the preview. */
export default function ImagePreviewDialog({ source, name, onClose }: Props): JSX.Element {
  const closeButton = useRef<HTMLButtonElement>(null)
  return <Dialog.Root open disablePointerDismissal onOpenChange={next => { if (!next) onClose() }}>
    <Dialog.Portal>
      <Dialog.Popup className="conversation-attachment-preview" aria-label="图片预览" initialFocus={closeButton}
        onClick={event => { if (event.target === event.currentTarget) onClose() }}
        onWheel={event => event.stopPropagation()}>
        <Dialog.Close ref={closeButton} className="conversation-attachment-preview__close" aria-label="关闭图片预览" title="关闭">×</Dialog.Close>
        <img className="conversation-attachment-preview__image" src={source} alt={name || '图片附件'} />
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
