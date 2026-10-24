import type { FocusOwner } from './focus-chat'

export interface FocusUiWidget {
  version: 1
  sourceMessageId: string
  index: number
  signature: string
  title: string
  description: string
  label: string
  disabled: boolean
  options: { value: string; label: string; title: string; description: string; selected: boolean; disabled: boolean }[]
  buttons: { label: string; disabled: boolean }[]
}
export interface FocusUiAction {
  sourceMessageId: string
  index: number
  signature: string
  kind: 'choose' | 'submit'
  selectedValue: string
  optionValue?: string
  buttonIndex?: number
}
export interface FocusUiRequest extends FocusUiAction, FocusOwner {}
/** A native user row immediately after a known local smart-card answer, for read-only recovery. */
export interface FocusUiRecovery { sourceMessageId: string; userMessageId: string; userText: string }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
export function validFocusUiAction(value: unknown): value is FocusUiAction {
  const item = value as FocusUiAction | null
  return !!item && text(item.sourceMessageId, 160) && /^[a-zA-Z0-9_:-]+$/.test(item.sourceMessageId) &&
    Number.isSafeInteger(item.index) && item.index >= 0 && item.index < 8 &&
    typeof item.signature === 'string' && /^[a-f0-9]{8}$/.test(item.signature) && text(item.selectedValue, 500) &&
    (item.kind === 'choose' ? text(item.optionValue, 500) && !!item.optionValue :
      item.kind === 'submit' && Number.isSafeInteger(item.buttonIndex) && item.buttonIndex! >= 0 && item.buttonIndex! < 4)
}
export function parseFocusUi(json: string): FocusUiWidget | null {
  if (json.length > 50000) return null
  try {
    const item = JSON.parse(json) as FocusUiWidget
    if (!item || item.version !== 1 || !validFocusUiAction({ ...item, kind: 'submit', selectedValue: '', buttonIndex: 0 }) ||
      !text(item.title, 500) || !text(item.description, 3000) || !text(item.label, 500) || typeof item.disabled !== 'boolean' ||
      !Array.isArray(item.options) || item.options.length < 2 || item.options.length > 32 ||
      !Array.isArray(item.buttons) || item.buttons.length < 1 || item.buttons.length > 4) return null
    if (item.options.some(option => !option || !text(option.value, 500) || !option.value || !text(option.label, 3000) || !option.label ||
      !text(option.title, 500) || !text(option.description, 3000) || typeof option.selected !== 'boolean' || typeof option.disabled !== 'boolean') ||
      item.buttons.some(button => !button || !text(button.label, 500) || !button.label || typeof button.disabled !== 'boolean') ||
      new Set(item.options.map(option => option.value)).size !== item.options.length || item.options.filter(option => option.selected).length > 1) return null
    return item
  } catch { return null }
}
