import { memo, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { OUTPUT_WINDOW_CHARS, outputWindow } from '@shared/output-window'
import './OutputText.css'

/** Large output stays intact; mount a recent window until the reader asks for more. */
const OutputText = memo(function OutputText({ text, className }: { text: string; className: string }): JSX.Element {
  const [start, setStart] = useState<number | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyRequest = useRef(0)
  const preview = outputWindow(text, start)
  useEffect(() => {
    copyRequest.current++
    setCopyState('idle')
    return () => { copyRequest.current++ }
  }, [text])
  return <>
    {preview.start > 0 ? <div className="output-text__controls">
      <span>已显示最近的输出，更早的 {preview.start.toLocaleString()} 个字符可展开。</span>
      <button type="button" onClick={() => setStart(Math.max(0, preview.start - OUTPUT_WINDOW_CHARS))}>显示更早的输出</button>
      <button type="button" onClick={() => setStart(0)}>显示全部</button>
      <button type="button" onClick={async () => {
        const request = ++copyRequest.current
        try { await navigator.clipboard.writeText(text); if (request === copyRequest.current) setCopyState('copied') }
        catch { if (request === copyRequest.current) setCopyState('failed') }
      }}>{copyState === 'copied' ? '已复制全部' : copyState === 'failed' ? '复制失败，点击重试' : '复制全部'}</button>
    </div> : null}
    <pre className={className}>{preview.text}</pre>
  </>
})

export default OutputText
