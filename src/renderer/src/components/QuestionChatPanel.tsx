import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import type { QuestionChatState } from '@shared/deepseek-question'
import './QuestionChatPanel.css'

export default function QuestionChatPanel({ sessionId, state, visible }: {
  sessionId: string
  state: QuestionChatState
  visible: boolean
}): JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = slot.current
    if (!element) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      window.api.setQuestionChatViewport(sessionId, state.id, {
        x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height)
      }, visible)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.api.setQuestionChatViewport(sessionId, state.id, { x: 0, y: 0, width: 0, height: 0 }, false)
    }
  }, [sessionId, state.id, visible])

  return <section className="question-chat-sidebar" aria-label="询问 AI 对话">
    <header className="question-chat-sidebar__head">
      <div className="question-chat-sidebar__heading">
        <h2>询问 AI <span>DeepSeek</span></h2>
        <button type="button" className="question-chat-sidebar__close" aria-label="关闭追问" title="关闭追问"
          onClick={() => window.api.questionChatAction(sessionId, state.id, 'close')}>
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </div>
      <blockquote className="question-chat-sidebar__quote" title={state.selectedText}>{state.selectedText}</blockquote>
      <div className="question-chat-sidebar__actions">
        <button type="button" disabled={!state.htmlPath} title={state.htmlPath}
          onClick={() => window.api.questionChatAction(sessionId, state.id, 'open-html')}>打开 HTML</button>
        <button type="button" disabled={!state.htmlPath}
          onClick={() => window.api.questionChatAction(sessionId, state.id, 'reveal-html')}>定位文件</button>
        <button type="button" onClick={() => window.api.questionChatAction(sessionId, state.id, 'copy-link')}>复制来源链接</button>
        <button type="button" onClick={() => window.api.questionChatAction(sessionId, state.id, 'copy-prompt')}>复制提问</button>
      </div>
      <p className={'question-chat-sidebar__status' + (state.error ? ' question-chat-sidebar__status--error' : '')}
        role="status" aria-live="polite">{state.status}</p>
    </header>
    <div className="question-chat-sidebar__slot" ref={slot} aria-label="DeepSeek 追问网页">
      <p>正在加载 DeepSeek…</p>
    </div>
  </section>
}
