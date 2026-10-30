export const OUTPUT_WINDOW_CHARS = 32 * 1024

/** A display window only. The source string remains available for expansion and copying. */
export function outputWindow(text: string, requestedStart: number | null = null): { start: number; text: string } {
  let start = requestedStart === null ? Math.max(0, text.length - OUTPUT_WINDOW_CHARS)
    : Math.max(0, Math.min(text.length, requestedStart))
  // Do not cut a UTF-16 surrogate pair in half.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1])) start--
  return { start, text: text.slice(start) }
}
