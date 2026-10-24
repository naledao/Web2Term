import type { JSX } from 'react'
import type { FocusModelSettings as ModelSettings, FocusModelSettingKind } from '@shared/focus-chat'

export default function FocusModelSettings({ settings, disabled, pending, onChange, onRefresh }: {
  settings: ModelSettings | null
  disabled: boolean
  pending: FocusModelSettingKind | null
  onChange(kind: 'model' | 'effort', value: string): void
  onRefresh(): void
}): JSX.Element {
  return <div className="focus-chat__model-controls" role="group" aria-label="ChatGPT 模型设置" aria-busy={pending !== null}>
    {([{ kind: 'model', label: '当前模型', options: settings?.models ?? [], value: settings?.model },
      { kind: 'effort', label: '思考强度', options: settings?.efforts ?? [], value: settings?.effort }] as const).map(item =>
      <label className="focus-chat__model-field" key={item.kind}>
        <span>{item.label}</span>
        <span className="focus-chat__model-select">
          <select value={item.value ?? ''} disabled={disabled || pending !== null || item.options.length === 0}
            onChange={event => onChange(item.kind, event.currentTarget.value)}>
            {!item.value ? <option value="" disabled>{pending === 'read' ? '读取中…' : '尚未读取'}</option> : null}
            {item.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <svg viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 2 4 4 4-4" /></svg>
        </span>
      </label>)}
    <button type="button" className="focus-chat__model-refresh" disabled={disabled || pending !== null}
      aria-label="刷新模型和思考强度" title={pending ? '正在同步原网页设置' : '从原网页重新读取模型和思考强度'} onClick={onRefresh}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 6a7 7 0 1 0 1 7M16 2v4h-4" /></svg>
    </button>
    {pending ? <span className="focus-chat__model-status" role="status">{pending === 'read' ? '读取中…' : '切换中…'}</span> : null}
  </div>
}
