import type { FocusOwner, FocusSendOutcome } from './focus-chat'

export interface FocusNativeFileLink { sourceMessageId: string; nativeIndex: number; signature: string; label: string }
export type FocusFileLinkTarget = { sourceMessageId: string; label: string } & (
  { href: string; nativeIndex?: never; signature?: never } | { href?: never; nativeIndex: number; signature: string }
)
export type FocusFileLinkRequest = FocusFileLinkTarget & FocusOwner
export type FocusFilePreviewRequest = FocusFileLinkRequest & { token: string }
export interface FocusFilePreviewHandle extends FocusOwner { token: string }
export interface FocusFilePreview {
  token: string; fileName: string; sizeBytes: number; kind: 'html' | 'text' | 'unsupported'; text: string
}
export type FocusFilePreviewStage = 'prepare' | 'open' | 'viewer' | 'download' | 'read'
export interface FocusFilePreviewResult {
  outcome: FocusSendOutcome; preview?: FocusFilePreview; reason?: 'too-large' | 'timeout' | 'file-unavailable'
  fileStage?: FocusFilePreviewStage
}
export const MAX_FOCUS_FILE_PREVIEW_BYTES = 10 * 1024 * 1024
export const validFocusFilePreviewToken = (token: unknown): token is string => typeof token === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
const PREFIX = '#web2term-file='
const NATIVE_PREFIX = '#web2term-native-file='

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
    && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 1000
    && !/[\u0000-\u001f\u007f]/.test(item.label) && item.label === item.label.replace(/\s+/g, ' ').trim()
    && (typeof item.href === 'string' ? normalizeFocusFileHref(item.href) === item.href && item.nativeIndex === undefined && item.signature === undefined :
      item.href === undefined && Number.isSafeInteger(item.nativeIndex) && item.nativeIndex! >= 0 && item.nativeIndex! < 100
      && typeof item.signature === 'string' && /^[a-f0-9]{8}$/.test(item.signature))
}
export function parseFocusNativeFileHref(value: string | undefined): FocusNativeFileLink | null {
  if (!value?.startsWith(NATIVE_PREFIX) || value.length > 16000) return null
  try {
    const item = JSON.parse(decodeURIComponent(value.slice(NATIVE_PREFIX.length)))
    return validFocusFileLinkTarget(item) && item.href === undefined ? {
      sourceMessageId: item.sourceMessageId, nativeIndex: item.nativeIndex!, signature: item.signature!, label: item.label
    } : null
  } catch { return null }
}
export function cleanFocusFileLinkCopy(text: string): string {
  return text.replace(/\[((?:\\.|[^\]\\\n])*)\]\(#web2term-native-file=[^\s)]*\)/g,
    (_, label: string) => label.replace(/\\([\\\[\]])/g, '$1'))
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
