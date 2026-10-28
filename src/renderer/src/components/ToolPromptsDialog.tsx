import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import MDEditor from '@uiw/react-md-editor'
import { sameConversationToolsOwner } from '@shared/conversation-tools'
import type { ConversationToolId, ConversationToolsOwner, ConversationToolsState, ConversationToolsUpdate } from '@shared/conversation-tools'
import type { AppTheme } from '@shared/types'
import ComputerUseSettings from './ComputerUseSettings'
import './ToolPromptsDialog.css'

interface Props {
  owner: ConversationToolsOwner
  container: HTMLElement
  theme: AppTheme
  trigger: RefObject<HTMLButtonElement | null>
  onClose(): void
}

export default function ToolPromptsDialog({ owner, container, theme, trigger, onClose }: Props) {
  const [state, setState] = useState<ConversationToolsState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [copied, setCopied] = useState<ConversationToolId | null>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  const busy = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; if (copyTimer.current) clearTimeout(copyTimer.current) }
  }, [])

  useEffect(() => {
    let cancelled = false, revision = 0
    setLoading(true); setError('')
    const accept = (value: ConversationToolsState): void => {
      if (cancelled || !sameConversationToolsOwner(value.owner, owner)) return
      setState(value); setLoading(false)
    }
    const unsubscribe = window.api.onConversationToolsChanged(value => {
      if (!sameConversationToolsOwner(value.owner, owner)) return
      revision++; accept(value)
    })
    void window.api.getConversationTools(owner).then(value => {
      if (revision === 0) accept(value)
    }).catch(cause => {
      if (!cancelled && revision === 0) { setError(cause instanceof Error ? cause.message : '读取工具设置失败，请重试。'); setLoading(false) }
    })
    return () => { cancelled = true; unsubscribe() }
  }, [owner.sessionId, owner.platformId, owner.conversationId, retry])

  const save = async (patch: ConversationToolsUpdate['patch']): Promise<void> => {
    if (!state || busy.current) return
    busy.current = true; setSaving(true); setError('')
    try {
      const next = await window.api.updateConversationTools({ ...owner, patch })
      if (alive.current && sameConversationToolsOwner(next.owner, owner)) setState(next)
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '工具设置保存失败，请重试。')
    } finally {
      busy.current = false
      if (alive.current) setSaving(false)
    }
  }

  const copy = async (id: ConversationToolId, prompt: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(prompt)
      if (!alive.current) return
      setCopied(id)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(null), 1600)
    } catch { if (alive.current) setError('复制失败，请选择提示词文字后手动复制。') }
  }

  return <Dialog.Root open modal onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal container={container}>
      <Dialog.Popup className="modal modal--tools" initialFocus={closeButton} finalFocus={trigger}
        onMouseDown={event => { if (event.target === event.currentTarget && event.button === 0) onClose() }}>
        <div className="tool-prompts-dialog" data-color-mode={theme}>
          <div className="tool-prompts-dialog__head">
            <div>
              <Dialog.Title className="tool-prompts-dialog__title">工具提示词</Dialog.Title>
              <Dialog.Description className="tool-prompts-dialog__description">仅应用于{owner.conversationId ? '当前对话' : '这个新对话'}，修改后自动保存。</Dialog.Description>
            </div>
            <Dialog.Close ref={closeButton} className="tool-prompts-dialog__close" aria-label="关闭工具提示词">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </Dialog.Close>
          </div>
          <div className="tool-prompts-dialog__body" aria-busy={loading || saving}>
            {error ? <div className="tool-prompts-dialog__error" role="alert"><p>{error}</p>
              {!state ? <button type="button" onClick={() => setRetry(value => value + 1)}>重新加载</button> : null}
            </div> : null}
            {loading && !state ? <p className="tool-prompts-dialog__loading" role="status">正在读取当前对话的工具…</p> : null}
            {state?.tools.map(tool => <section className="tool-prompts-dialog__tool" key={tool.id} aria-labelledby={`conversation-tool-${tool.id}`}>
              <div className="tool-prompts-dialog__tool-head">
                <h3 id={`conversation-tool-${tool.id}`}>{tool.name}</h3>
                <span className="tool-prompts-dialog__state">{tool.enabled ? '已启用' : '已关闭'}</span>
                <button type="button" role="switch" aria-checked={tool.enabled} aria-labelledby={`conversation-tool-${tool.id}`}
                  className={tool.enabled ? 'switch switch--on' : 'switch'} disabled={saving || loading}
                  onClick={() => void save(tool.id === 'files' ? { fileReadingEnabled: !tool.enabled }
                    : tool.id === 'background' ? { backgroundTasksEnabled: !tool.enabled }
                      : tool.id === 'scheduled' ? { scheduledTasksEnabled: !tool.enabled }
                        : tool.id === 'mail' ? { mailNotificationsEnabled: !tool.enabled } : { computerUseEnabled: !tool.enabled })}>
                  <span className="switch__knob" />
                </button>
              </div>
              {!tool.available ? <p className="tool-prompts-dialog__availability">{tool.message}</p> : null}
              <details className="tool-prompts-dialog__details">
                <summary>查看工具提示词</summary>
                <div className="tool-prompts-dialog__prompt">
                  <div className="tool-prompts-dialog__prompt-head">
                    <span>{tool.enabled ? '当前配置的提示词' : '启用后使用的提示词预览'}</span>
                    <button type="button" onClick={() => void copy(tool.id, tool.prompt)}>{copied === tool.id ? '已复制' : '复制提示词'}</button>
                  </div>
                  <div className="tool-prompts-dialog__prompt-content" role="region" aria-label={`${tool.name}提示词`} tabIndex={0}>
                    <MDEditor.Markdown source={tool.prompt} wrapperElement={{ 'data-color-mode': theme }} />
                  </div>
                </div>
              </details>
              {tool.id === 'computer' ? <details className="tool-prompts-dialog__details">
                <summary>电脑操作设置</summary>
                <ComputerUseSettings preferences={state.preferences} disabled={saving || loading}
                  onChange={value => void save({ computerResultDelaySeconds: value.computerResultDelaySeconds })} />
              </details> : null}
            </section>)}
          </div>
          <div className="tool-prompts-dialog__footer" role="status">{saving ? '正在保存…' : error ? '操作未完成，请查看提示。' : state ? '开关状态已按对话保存' : ''}</div>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
