import type { JSX } from 'react'
import { remainingFocusInjectionTokens } from '@shared/focus-token-usage'
import type { FocusContextUsage, FocusPromptInjectionState, FocusTextUsage } from '@shared/focus-token-usage'

export function formatEstimatedTokens(value: number): string {
  return value >= 1000000 ? (value / 1000000).toFixed(1) + 'M' : value >= 1000 ? (value / 1000).toFixed(1) + 'K' : String(value)
}

export default function FocusTokenUsage({ usage, injection, loading }: {
  usage: FocusTextUsage | FocusContextUsage; injection?: FocusPromptInjectionState; loading: boolean
}): JSX.Element {
  const phase = injection?.phase ?? 'loading'
  const reason = injection?.reason
  const details = 'details' in usage ? usage.details : null
  const rows = details ? [
    ['对话消息', details.conversation.estimatedTokens], ['提示词注入', details.recorded.injections.estimatedTokens],
    ['工具完整说明', details.recorded.toolDefinitions.estimatedTokens], ['工具请求', details.recorded.toolRequests.estimatedTokens],
    ['已回传的工具与自动消息', details.recorded.toolResults.estimatedTokens]
  ] as const : []
  const nextReason = reason === 'budget' ? '已达到字符阈值。' : reason === 'violations' ? '连续回复格式错误，需要刷新完整约定。'
    : reason === 'mostly-changed' ? '提示词更新较多，需要完整注入。' : '尚无完整注入记录。'
  const injectionHint = phase === 'disabled' ? '终端模式或提示词注入已关闭。' : phase === 'loading' ? '正在读取当前会话的提示词注入状态。'
    : phase === 'full-next' ? nextReason + '下次新任务开始时注入完整提示词。'
      : '按当前已记录文本的字符与 Token 比例折算。实际阈值为 ' + injection!.characterBudget.toLocaleString('zh-CN') +
        ' 字符；在新任务开始时检查。提示词大幅变化或连续格式错误也可能提前触发完整注入。'
  return <div className="focus-chat__token-usage" role="group" aria-label="Token 估算">
    <details className="focus-context-details">
      <summary title="查看上下文估算明细">
        上下文 <strong>{loading ? '读取中…' : '≈' + formatEstimatedTokens(usage.estimatedTokens) + ' tokens'}</strong>
        {details?.incompleteHistory ? <small> · 部分记录</small> : null}
      </summary>
      <div className="focus-context-details__body" aria-label="上下文估算明细">
        <strong>上下文估算明细</strong>
        <dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>≈{formatEstimatedTokens(value)} tokens</dd></div>)}</dl>
      </div>
    </details>
    <span title={injectionHint} data-injection-phase={phase}>
      完整提示词注入{phase === 'countdown' || phase === 'full-next' ? '剩余 ' : ' '}
      <strong>{phase === 'disabled' ? '已关闭' : phase === 'loading' ? '读取中…' : phase === 'full-next' ? '0 tokens · 下次任务注入'
        : '≈' + formatEstimatedTokens(remainingFocusInjectionTokens(injection!, usage)) + ' tokens'}</strong>
    </span>
  </div>
}
