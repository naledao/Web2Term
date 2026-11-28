import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { focusOwnerAccountId, type FocusOwner } from '@shared/focus-chat'
import { GEMINI_USAGE_REFRESH_MS, type GeminiUsageResult } from '@shared/gemini-usage'

const LIMITS = [{ id: 'current', label: '当前用量' }, { id: 'weekly', label: '每周限额' }] as const

export default function FocusGeminiUsage({ owner, visible }: { owner: FocusOwner; visible: boolean }): JSX.Element {
  const { sessionId, platformId, conversationId } = owner
  const accountId = focusOwnerAccountId(owner)
  const [result, setResult] = useState<GeminiUsageResult | null>(null)
  const [pending, setPending] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const handledRefresh = useRef(0)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const read = async (force: boolean): Promise<void> => {
      setPending(true)
      const next = await window.api.getFocusGeminiUsage({ sessionId, platformId, conversationId, accountId }, force).catch(() => null)
      if (cancelled) return
      setResult(next)
      setPending(false)
      const retryAfter = next?.outcome === 'ok' ? GEMINI_USAGE_REFRESH_MS : next ? 60_000 : 15_000
      timer = setTimeout(() => { void read(false) }, retryAfter)
    }
    const forced = refresh !== handledRefresh.current
    handledRefresh.current = refresh
    void read(forced)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [sessionId, platformId, conversationId, accountId, visible, refresh])

  const snapshot = result?.snapshot
  const checkedAt = snapshot ? new Date(snapshot.checkedAt).toLocaleString('zh-CN', { hour12: false }) : null
  return <div className="focus-chat__gemini-usage" role="group" aria-label="Gemini 用量限额" aria-busy={pending}>
    <div className="focus-chat__gemini-usage-data">
      {snapshot ? <dl title={`上次读取 ${checkedAt}`}>{LIMITS.map(({ id, label }) => <div key={id}>
        <dt>{label}</dt>
        <dd><strong>已用 {snapshot[id].usedPercent}%</strong>
          {snapshot[id].resetLabel ? <small>重置时间 {snapshot[id].resetLabel}</small> : null}
        </dd>
      </div>)}</dl> : null}
      {!snapshot || (!pending && result?.outcome !== 'ok') ? <span role="status" className="focus-chat__gemini-usage-status">
        {snapshot ? '更新失败 · 显示上次用量' : pending ? '额度读取中…' : '额度暂不可用'}
      </span> : null}
    </div>
    <button type="button" className="focus-chat__model-refresh" disabled={pending || !visible}
      aria-label="刷新 Gemini 额度" title={pending ? '正在读取 Gemini 额度' : '刷新 Gemini 额度'}
      onClick={() => setRefresh(value => value + 1)}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 6a7 7 0 1 0 1 7M16 2v4h-4" /></svg>
    </button>
  </div>
}
