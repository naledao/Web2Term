import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react'

/** Read Prism's React token tree as plain code, keeping whitespace and line breaks. */
export function codeBlockText(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? codeBlockText(child.props.children) : '').join('')
}

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  java: 'Java', javascript: 'JavaScript', js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript',
  jsx: 'JSX', tsx: 'TSX', python: 'Python', py: 'Python', csharp: 'C#', cs: 'C#', cpp: 'C++',
  c: 'C', go: 'Go', rust: 'Rust', ruby: 'Ruby', php: 'PHP', kotlin: 'Kotlin', swift: 'Swift',
  sql: 'SQL', json: 'JSON', xml: 'XML', html: 'HTML', css: 'CSS', scss: 'SCSS',
  bash: 'Bash', shell: 'Shell', sh: 'Shell', powershell: 'PowerShell', ps1: 'PowerShell',
  yaml: 'YAML', yml: 'YAML', markdown: 'Markdown', md: 'Markdown', dockerfile: 'Dockerfile',
  text: '纯文本', plaintext: '纯文本', txt: '纯文本'
}

type Props = ComponentPropsWithoutRef<'pre'> & { node?: unknown }

const FocusCodeBlock = memo(function FocusCodeBlock({ children, node: _node, ...props }: Props): JSX.Element {
  const [wrap, setWrap] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const alive = useRef(true)
  const code = Children.toArray(children).find(child => isValidElement(child) && child.type === 'code')
  const info = useMemo(() => {
    const element = isValidElement<{ className?: string; children?: ReactNode }>(code) ? code : null
    const language = /(?:language-|lang-)([\w+-]+)/i.exec(element?.props.className ?? props.className ?? '')?.[1].toLowerCase() ?? ''
    return { label: LANGUAGE_LABELS[language] ?? (language || '代码'),
      text: codeBlockText(element?.props.children ?? children).replace(/\n$/, '') }
  }, [code, children, props.className])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setCopyState('idle') }, [info.text])
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])

  return <div className="focus-code-block" data-wrap={wrap}>
    <div className="focus-code-block__toolbar">
      <span className="focus-code-block__language">{info.label}</span>
      <div className="focus-code-block__actions">
        <button type="button" aria-label="代码自动换行" aria-pressed={wrap} title={wrap ? '关闭自动换行' : '开启自动换行'} onClick={() => setWrap(value => !value)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 11h12a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M4 16h3" /></svg>
        </button>
        <button type="button" aria-label={copyState === 'copied' ? '代码已复制' : copyState === 'failed' ? '复制失败，点击重试' : '复制代码'}
          title={copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，点击重试' : '复制代码'} onClick={async () => {
            try { await navigator.clipboard.writeText(info.text); if (alive.current) setCopyState('copied') }
            catch { if (alive.current) setCopyState('failed') }
          }}>
          {copyState === 'copied' ? <span>已复制</span> : copyState === 'failed' ? <span role="alert">复制失败</span> :
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="3" width="12" height="13" rx="2" /><path d="M16 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3" /></svg>}
        </button>
      </div>
    </div>
    <pre {...props}>{children}</pre>
  </div>
})

export default FocusCodeBlock
