import type { FocusOwner } from './focus-chat'

export interface FocusCitationTarget { sourceMessageId: string; index: number; signature: string }
export interface FocusCitation extends FocusCitationTarget { label: string }
export interface FocusCitationRequest extends FocusCitationTarget, FocusOwner {}
export interface FocusCitationSource { title: string; url: string; site: string }
export interface FocusCitationResult {
  outcome: 'ok' | 'busy' | 'unavailable' | 'cancelled'
  sources: FocusCitationSource[]
}
export const FOCUS_CITATION_PREFIX = '#web2term-citation='

export function validFocusCitationTarget(value: unknown): value is FocusCitationTarget {
  const item = value as FocusCitationTarget | null
  return !!item && typeof item.sourceMessageId === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(item.sourceMessageId) &&
    Number.isSafeInteger(item.index) && item.index >= 0 && item.index < 100 &&
    typeof item.signature === 'string' && /^[a-f0-9]{8}$/.test(item.signature)
}
export function parseFocusCitationHref(href: string | undefined): FocusCitation | null {
  if (!href?.startsWith(FOCUS_CITATION_PREFIX) || href.length > 4000) return null
  try {
    const value = JSON.parse(decodeURIComponent(href.slice(FOCUS_CITATION_PREFIX.length))) as FocusCitation
    return validFocusCitationTarget(value) && typeof value.label === 'string' && value.label.trim() && value.label.length <= 500 ? value : null
  } catch { return null }
}
export function parseFocusCitationSources(value: unknown): FocusCitationSource[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) return null
  const seen = new Set<string>(), sources: FocusCitationSource[] = []
  for (const item of value) {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1000 ||
      typeof item.site !== 'string' || item.site.length > 200 || typeof item.url !== 'string' || item.url.length > 4096 ||
      /[\s\u0000-\u001f\u007f]/.test(item.url)) return null
    try {
      const url = new URL(item.url)
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
      if (seen.has(url.href)) continue
      seen.add(url.href); sources.push({ title: item.title, site: item.site || url.hostname, url: url.href })
    } catch { return null }
  }
  return sources.length ? sources : null
}
/** Copy the readable citation label, without serializing page-action metadata. */
export function cleanFocusCitationCopy(text: string): string {
  return text.replace(/\[((?:\\.|[^\]\\\n])*)\]\(#web2term-citation=[^\s)]*\)/g,
    (_, label: string) => label.replace(/\\([\\\[\]])/g, '$1'))
}
