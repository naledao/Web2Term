/** Plain presentation data extracted from an already rendered native DIL layout. */
export interface FocusLayoutNode {
  tag: string
  style?: Record<string, string>
  attrs?: Record<string, string>
  children?: Array<string | FocusLayoutNode>
}
export interface FocusLayoutData {
  version: 1
  sourceMessageId: string
  label: string
  width: number
  /** Lists, metric summaries and image cards wrap with the transcript. */
  kind?: 'list' | 'metrics' | 'gallery'
  root: FocusLayoutNode
}

const tags = new Set(['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'small',
  'ul', 'ol', 'li', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'figure', 'figcaption',
  'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])
const geometry = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])
const enums: Record<string, string[]> = {
  display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'table', 'table-row', 'table-cell'],
  flexDirection: ['row', 'column', 'row-reverse', 'column-reverse'], flexWrap: ['nowrap', 'wrap', 'wrap-reverse'],
  alignItems: ['normal', 'stretch', 'start', 'end', 'flex-start', 'flex-end', 'center', 'baseline'],
  alignSelf: ['auto', 'normal', 'stretch', 'start', 'end', 'flex-start', 'flex-end', 'center', 'baseline'],
  justifyContent: ['normal', 'start', 'end', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  textAlign: ['left', 'right', 'center', 'start', 'end'], whiteSpace: ['normal', 'pre-wrap', 'pre-line', 'nowrap'],
  fontStyle: ['normal', 'italic'], borderStyle: ['solid', 'dashed', 'dotted', 'none'], boxSizing: ['border-box'],
  overflow: ['hidden'], objectFit: ['contain', 'cover', 'fill', 'none', 'scale-down']
}
const lengths = new Set(['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'flexBasis',
  'gap', 'rowGap', 'columnGap', 'padding', 'margin', 'borderWidth', 'borderRadius', 'fontSize', 'lineHeight'])
const tones = /^\$(?:text|muted|bg|soft|border|accent|success|warning|danger|accentSoft|successSoft|warningSoft|dangerSoft)$|^(?:transparent|currentColor|none)$/
export function validFocusLayoutStyle(key: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 180) return false
  if (enums[key]) return enums[key].includes(value)
  if (['color', 'backgroundColor', 'borderColor'].includes(key)) return tones.test(value)
  if (key === 'aspectRatio') {
    const parts = value.split(/\s*\/\s*/)
    return parts.length === 2 && parts.every(part => /^\d+(?:\.\d+)?$/.test(part) && Number(part) > 0 && Number(part) <= 10000) &&
      Number(parts[0]) / Number(parts[1]) >= .05 && Number(parts[0]) / Number(parts[1]) <= 20
  }
  if (['flexGrow', 'flexShrink', 'opacity'].includes(key)) return /^(?:\d|\d?\.\d+)$/.test(value) && Number(value) <= 9
  if (key === 'fontWeight') return /^(?:[1-9]00|normal|bold)$/.test(value)
  if (key === 'gridColumn' || key === 'gridRow') return /^(?:auto|[1-9]|span [1-8])(?: \/ (?:auto|[1-9]|span [1-8]))?$/.test(value)
  if (key === 'gridTemplateColumns') return value === 'none' ||
    /^repeat\([1-8],\s*minmax\(0(?:px)?,\s*1fr\)\)$/.test(value) ||
    /^(?:\d+(?:\.\d+)?(?:px|fr|%)\s*){1,8}$/.test(value)
  if (lengths.has(key)) return value.split(/\s+/).length <= 4 && value.split(/\s+/).every(part =>
    /^(?:0|auto|normal|none|\d+(?:\.\d+)?(?:px|%|rem|em))$/.test(part) &&
    (!/^\d/.test(part) || parseFloat(part) <= 2000))
  return false
}

/** Images are passive HTTPS resources; links may also point at ordinary HTTP pages. */
export function validFocusLayoutUrl(value: unknown, image = false): value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return (image ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol)) && !!url.hostname && !url.username && !url.password
  } catch { return false }
}

function validAttribute(tag: string, key: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16000) return false
  if (tag === 'img') return key === 'src' ? validFocusLayoutUrl(value, true) : key === 'alt' && value.length <= 500
  if (tag === 'a') return key === 'href' && validFocusLayoutUrl(value)
  if (tag === 'div') {
    if (key === 'role') return value === 'progressbar'
    if (key === 'aria-label') return value.length <= 500
    if (['aria-valuemin', 'aria-valuemax', 'aria-valuenow'].includes(key)) return /^-?\d+(?:\.\d+)?$/.test(value) && Math.abs(Number(value)) <= 1e9
  }
  if (!geometry.has(tag)) return false
  if (key === 'd') return tag === 'path' && /^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]*$/.test(value)
  if (key === 'viewBox') return tag === 'svg' && /^-?\d+(?:\.\d+)?(?:[ ,]+-?\d+(?:\.\d+)?){3}$/.test(value)
  if (key === 'fill' || key === 'stroke') return ['none', 'currentColor', 'transparent'].includes(value)
  if (key === 'strokeLinecap') return ['butt', 'round', 'square'].includes(value)
  if (key === 'strokeLinejoin') return ['miter', 'round', 'bevel'].includes(value)
  if (key === 'fillRule' || key === 'clipRule') return ['evenodd', 'nonzero'].includes(value)
  if (key === 'points') return /^[0-9.,+\s-]+$/.test(value)
  return ['width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'strokeWidth'].includes(key) &&
    /^-?\d+(?:\.\d+)?$/.test(value) && Math.abs(Number(value)) <= 2000
}

/** Validate the presentation tree at the renderer boundary; never admit HTML, CSS URLs or handlers. */
export function parseFocusLayout(json: string): FocusLayoutData | null {
  if (json.length > 180000) return null
  try {
    const item = JSON.parse(json) as FocusLayoutData
    if (!item || item.version !== 1 || typeof item.sourceMessageId !== 'string' || !/^[a-zA-Z0-9_:-]{1,160}$/.test(item.sourceMessageId) ||
      typeof item.label !== 'string' || item.label.length > 500 || !Number.isFinite(item.width) || item.width < 32 || item.width > 2000 ||
      (item.kind !== undefined && item.kind !== 'list' && item.kind !== 'metrics' && item.kind !== 'gallery')) return null
    let nodes = 0, chars = 0, images = 0
    const read = (node: unknown, depth: number): string | FocusLayoutNode | null => {
      if (++nodes > 700 || depth > 24) return null
      if (typeof node === 'string') { chars += node.length; return node.length <= 10000 && chars <= 50000 ? node : null }
      if (!node || typeof node !== 'object' || Array.isArray(node)) return null
      const value = node as FocusLayoutNode
      if (!tags.has(value.tag)) return null
      const result: FocusLayoutNode = { tag: value.tag }
      for (const kind of ['style', 'attrs'] as const) {
        const entries = value[kind]
        if (entries === undefined) continue
        if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length > 35) return null
        const clean: Record<string, string> = {}
        for (const [key, content] of Object.entries(entries)) {
          if (!(kind === 'style' ? validFocusLayoutStyle(key, content) : validAttribute(value.tag, key, content))) return null
          clean[key] = content
        }
        result[kind] = clean
      }
      if (value.children !== undefined) {
        if (!Array.isArray(value.children) || value.children.length > 150) return null
        const children = value.children.map(child => read(child, depth + 1))
        if (children.some(child => child === null)) return null
        result.children = children as Array<string | FocusLayoutNode>
      }
      if (value.tag === 'img' && (++images > 12 || !result.attrs?.src || result.children?.length)) return null
      return result
    }
    const root = read(item.root, 0)
    return root && typeof root !== 'string' ? { version: 1, sourceMessageId: item.sourceMessageId, label: item.label, width: item.width,
      ...(item.kind ? { kind: item.kind } : {}), root } : null
  } catch { return null }
}
