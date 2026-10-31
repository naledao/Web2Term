import type { AppTheme } from '@shared/types'

export const MAX_MERMAID_TEXT_SIZE = 50_000
let sequence = 0
let renderQueue: Promise<void> = Promise.resolve()

class FocusMermaidError extends Error {
  override name = 'FocusMermaidError'
}

/** Mermaid shares global configuration, so configure and render each diagram together. */
export function renderFocusMermaid(source: string, theme: AppTheme, cancelled: () => boolean): Promise<string | null> {
  const render = async (): Promise<string | null> => {
    if (cancelled()) return null
    if (source.length > MAX_MERMAID_TEXT_SIZE) throw new FocusMermaidError('图表内容过长，请查看源码。')
    const { default: mermaid } = await import('mermaid')
    if (cancelled()) return null
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      maxTextSize: MAX_MERMAID_TEXT_SIZE,
      maxEdges: 500,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
        'suppressErrorRendering', 'htmlLabels', 'dompurifyConfig', 'themeCSS']
    })
    // getDiagramFromText strips frontmatter/init directives without applying them.
    // Parse first to reset previous directives and apply this diagram's secure config.
    await mermaid.parse(source)
    if (cancelled()) return null
    // Image-shaped nodes fetch resources during layout, even in strict mode, and
    // external resources cannot display inside the resulting SVG image. Check the
    // parsed nodes (including quoted/YAML attributes) before starting DOM layout.
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source)
    if (cancelled()) return null
    const database = diagram.db as { getVertices?: () => Map<string, { img?: unknown }> }
    if ([...(database.getVertices?.().values() ?? [])].some(node => node.img)) {
      throw new FocusMermaidError('含图片节点的 Mermaid 图表暂不支持预览，已保留源码。')
    }
    // Layout needs a measurable DOM node. Never render temporary SVGs into the transcript.
    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none'
    document.body.appendChild(container)
    try {
      const { svg } = await mermaid.render(`focus-mermaid-${++sequence}`, source, container)
      return cancelled() ? null : svg
    } finally {
      container.remove()
    }
  }
  const result = renderQueue.then(render)
  // One malformed or unfinished streamed diagram must not block later diagrams.
  renderQueue = result.then(() => undefined, () => undefined)
  return result
}
