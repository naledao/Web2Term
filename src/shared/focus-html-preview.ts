export const FOCUS_HTML_PREVIEW_MAX_CHARS = 2_000_000

export interface FocusHtmlPreviewRequest {
  html: string
  theme: 'light' | 'dark'
}

export type FocusHtmlPreviewOutcome = 'ok' | 'invalid' | 'too-large' | 'unavailable'

/** Only code fences participate; prose and explicitly different languages stay untouched. */
export function isFocusHtmlCode(language: string, text: string): boolean {
  if (!text.trim()) return false
  const name = language.toLowerCase()
  if (['html', 'htm', 'xhtml'].includes(name)) return true
  if (!['', 'text', 'plaintext', 'txt', 'xml', 'markup'].includes(name)) return false
  const start = text.trimStart().replace(/^(?:<!--[\s\S]*?-->\s*)+/, '')
  if (/^(?:<!doctype\s+html\b|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>))/i.test(start)) return true
  // XML and markup can also be SVG or configuration files; require an HTML document there.
  return !['xml', 'markup'].includes(name) &&
    /^<(?:div|main|section|article|header|footer|nav|h[1-6]|p|button|form|table|ul|ol|style|script)(?:\s|>)/i.test(start)
}

export function validateFocusHtmlPreview(value: unknown): FocusHtmlPreviewOutcome {
  if (!value || typeof value !== 'object') return 'invalid'
  const request = value as Partial<FocusHtmlPreviewRequest>
  if (typeof request.html !== 'string' || !request.html.trim() ||
    (request.theme !== 'light' && request.theme !== 'dark')) return 'invalid'
  return request.html.length > FOCUS_HTML_PREVIEW_MAX_CHARS ? 'too-large' : 'ok'
}
