import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import type { QuestionChatState } from '@shared/deepseek-question'
import { platformById } from '@shared/platforms'
import './QuestionChatPanel.css'

export default function QuestionChatPanel({ sessionId, state, visible }: {
  sessionId: string
  state: QuestionChatState
  visible: boolean
}): JSX.Element {
  const platformLabel = platformById(state.platformId)?.label ?? 'AI'
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

  return <section className="question-chat-sidebar" aria-label="侧边聊天">
    <header className="question-chat-sidebar__head">
      <div className="question-chat-sidebar__heading">
        <blockquote className="question-chat-sidebar__quote" title={state.selectedText}>{state.selectedText}</blockquote>
        <button type="button" className="question-chat-sidebar__close" aria-label="关闭侧边聊天" title="关闭侧边聊天"
          onClick={() => window.api.questionChatAction(sessionId, state.id, 'close')}>
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </div>
      <div className="question-chat-sidebar__actions">
        <button type="button" disabled={!state.contextPath} title={state.contextPath}
          onClick={() => window.api.questionChatAction(sessionId, state.id, 'open-context')}>打开 Markdown</button>
        <button type="button" disabled={!state.contextPath}
          onClick={() => window.api.questionChatAction(sessionId, state.id, 'reveal-context')}>定位文件</button>
        <button type="button" onClick={() => window.api.questionChatAction(sessionId, state.id, 'copy-prompt')}>复制提问</button>
      </div>
      {state.status ? <p className={'question-chat-sidebar__status' + (state.error ? ' question-chat-sidebar__status--error' : '')}
        role="status" aria-live="polite">{state.status}</p> : null}
    </header>
    <div className="question-chat-sidebar__slot" ref={slot} aria-label={`${platformLabel} 侧边聊天网页`}>
      <p>正在加载 {platformLabel}…</p>
    </div>
  </section>
}
