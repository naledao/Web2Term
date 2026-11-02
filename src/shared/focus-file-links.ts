import type { FocusOwner } from './focus-chat'

export interface FocusFileLinkTarget { sourceMessageId: string; href: string; label: string }
export interface FocusFileLinkRequest extends FocusFileLinkTarget, FocusOwner {}
const PREFIX = '#web2term-file='

/** A sandbox path belongs to the chat page, never to the local filesystem or OS shell. */
export function normalizeFocusFileHref(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || !/^sandbox:\/(?!\/)/i.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'sandbox:' && !url.host && url.pathname.startsWith('/') ? url.href : null
  } catch { return null }
}
export function validFocusFileLinkTarget(value: unknown): value is FocusFileLinkTarget {
  const item = value as FocusFileLinkTarget | null
  return !!item && typeof item.sourceMessageId === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(item.sourceMessageId)
    && typeof item.href === 'string' && normalizeFocusFileHref(item.href) === item.href
    && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 1000
    && !/[\u0000-\u001f\u007f]/.test(item.label) && item.label === item.label.replace(/\s+/g, ' ').trim()
}
export function parseFocusFileHref(value: string | undefined): string | null {
  if (!value?.startsWith(PREFIX) || value.length > 16000) return null
  try { return normalizeFocusFileHref(decodeURIComponent(value.slice(PREFIX.length))) } catch { return null }
}

interface MarkdownNode {
  type: string
  tagName?: string
  properties?: { href?: unknown }
  children?: MarkdownNode[]
}
/** Convert only file anchors before Markdown's normal URL sanitizer runs. HTML and other protocols keep its defaults. */
export function rehypeFocusFileLinks(): (tree: MarkdownNode) => void {
  return function visit(node): void {
    if (node.type === 'element' && node.tagName === 'a' && node.properties) {
      const href = normalizeFocusFileHref(node.properties.href)
      if (href) node.properties.href = PREFIX + encodeURIComponent(href)
    }
    node.children?.forEach(visit)
  }
}
