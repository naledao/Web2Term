/** Bound the in-memory copy crossing the Electron bridge. */
export const MAX_PDF_PREVIEW_BYTES = 32 * 1024 * 1024

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path)
}
