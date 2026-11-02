import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { FocusOwner } from '@shared/focus-chat'
import { focusOwnerKey } from '@shared/focus-chat'
import type { CompactionAction, CompactionState } from '@shared/conversation-compaction'
import { COMPACTION_ACTIVE } from '@shared/conversation-compaction'
import './FocusCompaction.css'

export function useConversationCompaction(owner: FocusOwner, visible: boolean): {
  state: CompactionState | null; pending: boolean; error: string; blocked: boolean
  start(): Promise<boolean>; act(action: CompactionAction): Promise<boolean>
} {
  const ownerKey = focusOwnerKey(owner)
  const [state, setState] = useState<CompactionState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const readRevision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!visible) return
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const revision = readRevision.current
      try {
        if (lock.current) return
        const next = await window.api.getCompaction(owner)
        if (!disposed && revision === readRevision.current && (!next || focusOwnerKey(next.owner) === ownerKey)) setState(next)
      } catch { /* A transient poll failure does not erase a running task. */ }
      finally { if (!disposed) timer = setTimeout(() => { void poll() }, 900) }
    }
    void poll()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [ownerKey, visible])
  const start = useCallback(async (): Promise<boolean> => {
    if (lock.current) return false
    readRevision.current++
    lock.current = true; setPending(true); setError('')
    try {
      const next = await window.api.startCompaction(owner)
      if (mounted.current) setState(next)
      return true
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '无法开始压缩。')
      return false
    } finally { lock.current = false; if (mounted.current) setPending(false) }
  }, [ownerKey])
  const act = useCallback(async (action: CompactionAction): Promise<boolean> => {
    if (!state || lock.current) return false
    readRevision.current++
    lock.current = true; setPending(true); setError('')
    try {
      await window.api.compactionAction({ ...owner, jobId: state.id }, action)
      const next = await window.api.getCompaction(owner)
      if (mounted.current) setState(next)
      return true
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '压缩操作失败，请重试。')
      return false
    }
    finally { lock.current = false; if (mounted.current) setPending(false) }
  }, [ownerKey, state?.id])
  // Keep the cancellation record on disk, while removing its panel and input lock.
  const displayState = state?.phase === 'cancelled' ? null : state
  return { state: displayState, pending, error, start, act,
    blocked: pending || !!displayState && (COMPACTION_ACTIVE.includes(displayState.phase) || displayState.workerVisible) }
}

export default function FocusCompaction({ owner, visible, state, pending, error, act }: {
  owner: FocusOwner; visible: boolean; state: CompactionState | null; pending: boolean; error: string
  act(action: CompactionAction): Promise<boolean>
}): JSX.Element | null {
  const slot = useRef<HTMLDivElement>(null)
  const [recoveryCopiedFor, setRecoveryCopiedFor] = useState('')
  const ownerKey = focusOwnerKey(owner)
  useLayoutEffect(() => {
    const element = slot.current
    if (!state?.workerVisible || !element) return
    const request = { ...owner, jobId: state.id }
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      window.api.setCompactionViewport(request, { x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height) }, visible && rect.width > 0 && rect.height > 0)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    window.addEventListener('scroll', report, true)
    return () => {
      observer.disconnect(); window.removeEventListener('resize', report); window.removeEventListener('scroll', report, true)
      window.api.setCompactionViewport(request, { x: 0, y: 0, width: 0, height: 0 }, false)
    }
  }, [ownerKey, visible, state?.id, state?.workerVisible])
  if (!state && !pending && !error) return null
  const active = !!state && COMPACTION_ACTIVE.includes(state.phase)
  const interrupted = !!state && !active && !['completed', 'cancelled'].includes(state.phase)
  const status = active || pending ? '正在压缩对话…' : state?.phase === 'completed' ? '对话已压缩' :
    state?.phase === 'paused' ? '会话压缩已暂停' : '会话压缩暂未完成'
  return <section className="focus-compaction" aria-label="会话压缩">
    <div className="focus-compaction__status">
      <span className="focus-compaction__label" role="status" aria-live="polite">
        {active || pending ? <span className="focus-compaction__spinner" aria-hidden="true" /> : null}{status}
      </span>
      <div className="focus-compaction__actions">
        {interrupted ? <>
          <button type="button" disabled={pending} onClick={() => void act('resume')}>重试</button>
          <button type="button" disabled={pending} onClick={() => void act('show-page')}>处理问题</button>
        </> : null}
        {state && !['completed', 'cancelled'].includes(state.phase) ? <button type="button" disabled={pending} onClick={() => void act('cancel')}>取消</button> : null}
        {state?.targetSessionId && state.targetSessionId !== owner.sessionId ? <button type="button" disabled={pending} onClick={() => void act('target')}>继续对话</button> : null}
      </div>
    </div>
    {error ? <p className="focus-compaction__error" role="alert">{error}</p> : null}
    {state?.workerVisible ? <div className="focus-compaction__dialog" role="dialog" aria-label="处理会话压缩" aria-modal="false">
      <div className="focus-compaction__head">
        <div className="focus-compaction__dialog-title"><strong>处理会话压缩</strong>
          <button type="button" onClick={() => void act('hide-page')}>收起页面</button></div>
        <p>{state.message}</p>
        <div className="focus-compaction__actions">
          <button type="button" disabled={pending} onClick={() => void act('resume')}>处理完成，继续压缩</button>
          {state.phase === 'failed' && !state.hasSummary ? <button type="button" disabled={pending}
            onClick={() => { void act('copy-recovery').then(copied => { if (copied) setRecoveryCopiedFor(state.id) }) }}>
            {recoveryCopiedFor === state.id ? '补全提示词已复制' : '复制补全提示词'}</button> : null}
          {state.hasSource ? <button type="button" disabled={pending} onClick={() => void act('source')}>定位原始快照</button> : null}
          {state.hasSummary ? <button type="button" disabled={pending} onClick={() => void act('summary')}>定位交接摘要</button> : null}
        </div>
        {state.phase === 'failed' && recoveryCopiedFor === state.id ? <p role="status">在下方网页粘贴并发送，回答结束后继续压缩，无需重新上传快照。</p> : null}
      </div>
      <div className="focus-compaction__page" ref={slot} aria-label="压缩处理网页"><p>正在加载网页…</p></div>
    </div> : null}
  </section>
}
