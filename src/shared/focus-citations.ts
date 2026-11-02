import type { FocusOwner } from './focus-chat'

export interface FocusCitationTarget { sourceMessageId: string; index: number; signature: string }
export interface FocusCitation extends FocusCitationTarget { label: string }
export interface FocusCitationRequest extends FocusCitationTarget, FocusOwner {}
export interface FocusCitationSourceTarget { index: number; signature: string }
export interface FocusCitationOpenRequest extends FocusCitationRequest { source: FocusCitationSourceTarget }
export interface FocusCitationSource {
  title: string; site: string; url?: string
  /** Native button cards expose preview metadata without a public destination URL. */
  kind?: 'preview'; description?: string; icon?: string; image?: string; native?: FocusCitationSourceTarget
}
export interface FocusCitationResult {
  outcome: 'ok' | 'busy' | 'unavailable' | 'cancelled'
  sources: FocusCitationSource[]
}
export const FOCUS_CITATION_PREFIX = '#web2term-citation='
export function validFocusCitationSourceTarget(value: unknown): value is FocusCitationSourceTarget {
  const item = value as FocusCitationSourceTarget | null
  return !!item && Number.isSafeInteger(item.index) && item.index >= 0 && item.index < 40 &&
    typeof item.signature === 'string' && /^[a-f0-9]{8}$/.test(item.signature)
}

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
      typeof item.site !== 'string' || item.site.length > 200) return null
    if (item.kind === 'preview') {
      if (item.url !== undefined || !item.site.trim() || (item.description !== undefined &&
        (typeof item.description !== 'string' || item.description.length > 2000))) return null
      const source: FocusCitationSource = { kind: 'preview', title: item.title, site: item.site }
      if (item.native !== undefined) {
        if (!validFocusCitationSourceTarget(item.native)) return null
        source.native = { index: item.native.index, signature: item.native.signature }
      }
      if (item.description) source.description = item.description
      for (const key of ['icon', 'image'] as const) {
        if (item[key] === undefined) continue
        if (typeof item[key] !== 'string' || item[key].length > 4096 || /[\s\u0000-\u001f\u007f]/.test(item[key])) return null
        try {
          const url = new URL(item[key])
          if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
          source[key] = url.href
        } catch { return null }
      }
      const key = JSON.stringify(source)
      if (!seen.has(key)) { seen.add(key); sources.push(source) }
      continue
    }
    if (item.kind !== undefined || typeof item.url !== 'string' || item.url.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(item.url)) return null
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
