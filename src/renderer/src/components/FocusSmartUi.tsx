import { createContext, useContext, useId, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { FocusUiAction, FocusUiWidget } from '@shared/focus-smart-ui'
import type { FocusSendOutcome } from '@shared/focus-chat'

export const FocusSmartUiContext = createContext<{
  disabled: boolean
  liveSources: Set<string>
  act(action: FocusUiAction): Promise<FocusSendOutcome>
  onOriginal(): void
} | null>(null)

/** Safe local controls backed by the corresponding native DIL card. No HTML replay. */
export default function FocusSmartUi({ data }: { data: FocusUiWidget }): JSX.Element {
  const context = useContext(FocusSmartUiContext)
  const id = useId()
  const lock = useRef(false)
  const [pending, setPending] = useState<'choose' | 'submit' | null>(null)
  const [error, setError] = useState('')
  const live = context?.liveSources.has(data.sourceMessageId) === true
  const disabled = !live || !context || context.disabled || data.disabled || pending !== null
  const multiple = data.groups.length > 1
  const selectedValues = data.groups.map(group => group.options.find(option => option.selected)?.value ?? '')
  const complete = selectedValues.every(Boolean)
  const act = async (kind: 'choose' | 'submit', value: string | number, groupIndex = 0): Promise<void> => {
    if (lock.current || disabled || !context) return
    lock.current = true
    setPending(kind); setError('')
    try {
      const result = await context.act({ sourceMessageId: data.sourceMessageId, index: data.index, signature: data.signature,
        selectedValue: selectedValues[0], ...(multiple ? { selectedValues } : {}), kind,
        ...(kind === 'choose' ? { optionValue: String(value), ...(multiple ? { groupIndex } : {}) } : { buttonIndex: Number(value) }) })
      if (result !== 'ok') setError(result === 'busy' ? '网页正在处理任务或保留着草稿，请稍后再操作。' :
        result === 'stuck' ? '操作结果尚未确认，请先到原始视图核对。' :
          '原始组件已变化或尚未载入，请到原始视图检查。')
    } catch { setError('操作结果尚未确认，请先到原始视图核对。') }
    finally { lock.current = false; setPending(null) }
  }
  return <section className="focus-smart-ui" aria-busy={pending !== null} aria-label={data.title || data.groups[0].label || '可交互选项'}>
    {data.title ? <h3>{data.title}</h3> : null}
    {data.description ? <p className="focus-smart-ui__description">{data.description}</p> : null}
    <form onSubmit={event => { event.preventDefault(); void act('submit', 0) }}>
      {data.groups.map((group, groupIndex) => <fieldset key={groupIndex} disabled={disabled || group.disabled}
        className={multiple ? 'focus-smart-ui__group' : undefined}>
        {multiple
          ? <legend className="focus-smart-ui__question">{group.label || `问题 ${groupIndex + 1}`}</legend>
          : <legend className="focus-smart-ui__legend">{group.label || data.title || '选择一个选项'}</legend>}
        {group.options.map((option, index) => <label className="focus-smart-ui__option" key={option.value} data-selected={option.selected}>
          <input type="radio" name={id + '-' + groupIndex} id={id + '-' + groupIndex + '-' + index} value={option.value} checked={option.selected}
            disabled={disabled || group.disabled || option.disabled} onChange={() => void act('choose', option.value, groupIndex)} />
          <span className="focus-smart-ui__option-text">{option.title ? <><strong>{option.title}</strong>{option.description ? <span>{option.description}</span> : null}</> : option.label}</span>
        </label>)}
      </fieldset>)}
      <div className="focus-smart-ui__actions">{data.buttons.map((button, index) => <button key={index} type={index === 0 ? 'submit' : 'button'}
        disabled={disabled || button.disabled || !complete} onClick={index === 0 ? undefined : () => void act('submit', index)}>
        {pending === 'submit' ? '正在提交…' : button.label}
      </button>)}</div>
    </form>
    {pending === 'choose' ? <p className="focus-smart-ui__status" role="status">正在切换选项…</p> : null}
    {error ? <p className="focus-smart-ui__error" role="alert">{error} <button type="button" onClick={context?.onOriginal}>查看原始组件</button></p> : null}
    {!live && !error ? <p className="focus-smart-ui__status">这组选项尚未在原网页中载入。{context ? <button type="button" onClick={context.onOriginal}>查看原始组件</button> : null}</p> : null}
  </section>
}
