import type { FocusOwner } from './focus-chat'

export interface FocusUiOption { value: string; label: string; title: string; description: string; selected: boolean; disabled: boolean }
/** One native radiogroup. A card can ask several questions that share one submit button. */
export interface FocusUiGroup { label: string; disabled: boolean; options: FocusUiOption[] }
/**
 * Normalized widget. Version 1 markers (saved before multi-question cards) carried one group
 * as top-level `label`/`options`; `parseFocusUi` folds them into `groups`.
 */
export interface FocusUiWidget {
  version: 1 | 2
  sourceMessageId: string
  index: number
  signature: string
  title: string
  description: string
  disabled: boolean
  groups: FocusUiGroup[]
  buttons: { label: string; disabled: boolean }[]
}
export const FOCUS_UI_MAX_GROUPS = 8
export interface FocusUiAction {
  sourceMessageId: string
  index: number
  signature: string
  kind: 'choose' | 'submit'
  /** The first group's selection; kept so single-question requests read as before. */
  selectedValue: string
  /** Every group's selection, in group order. Absent on single-question requests. */
  selectedValues?: string[]
  /** choose: the group the option belongs to (default 0). */
  groupIndex?: number
  optionValue?: string
  buttonIndex?: number
}
export interface FocusUiRequest extends FocusUiAction, FocusOwner {}
/** A native user row immediately after a known local smart-card answer, for read-only recovery. */
export interface FocusUiRecovery { sourceMessageId: string; userMessageId: string; userText: string }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
export function validFocusUiAction(value: unknown): value is FocusUiAction {
  const item = value as FocusUiAction | null
  if (!item || !text(item.sourceMessageId, 160) || !/^[a-zA-Z0-9_:-]+$/.test(item.sourceMessageId) ||
    !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= 8 ||
    typeof item.signature !== 'string' || !/^[a-f0-9]{8}$/.test(item.signature) || !text(item.selectedValue, 500)) return false
  if (item.selectedValues !== undefined && (!Array.isArray(item.selectedValues) || item.selectedValues.length < 1 ||
    item.selectedValues.length > FOCUS_UI_MAX_GROUPS || item.selectedValues.some(entry => !text(entry, 500)) ||
    item.selectedValues[0] !== item.selectedValue)) return false
  if (item.groupIndex !== undefined && (!Number.isSafeInteger(item.groupIndex) || item.groupIndex < 0 || item.groupIndex >= FOCUS_UI_MAX_GROUPS)) return false
  return item.kind === 'choose' ? text(item.optionValue, 500) && !!item.optionValue :
    item.kind === 'submit' && Number.isSafeInteger(item.buttonIndex) && item.buttonIndex! >= 0 && item.buttonIndex! < 4
}
const validOptions = (options: unknown): options is FocusUiOption[] => Array.isArray(options) && options.length >= 2 && options.length <= 32 &&
  !options.some(option => !option || !text(option.value, 500) || !option.value || !text(option.label, 3000) || !option.label ||
    !text(option.title, 500) || !text(option.description, 3000) || typeof option.selected !== 'boolean' || typeof option.disabled !== 'boolean') &&
  new Set(options.map(option => option.value)).size === options.length && options.filter(option => option.selected).length <= 1
export function parseFocusUi(json: string): FocusUiWidget | null {
  if (json.length > 100000) return null
  try {
    const item = JSON.parse(json) as FocusUiWidget & { label?: unknown; options?: unknown }
    if (!item || (item.version !== 1 && item.version !== 2) || !validFocusUiAction({ ...item, kind: 'submit', selectedValue: '', buttonIndex: 0 }) ||
      !text(item.title, 500) || !text(item.description, 3000) || typeof item.disabled !== 'boolean' ||
      !Array.isArray(item.buttons) || item.buttons.length < 1 || item.buttons.length > 4 ||
      item.buttons.some(button => !button || !text(button.label, 500) || !button.label || typeof button.disabled !== 'boolean')) return null
    if (item.version === 1) {
      if (!text(item.label, 500) || !validOptions(item.options)) return null
      return { version: 1, sourceMessageId: item.sourceMessageId, index: item.index, signature: item.signature, title: item.title,
        description: item.description, disabled: item.disabled, groups: [{ label: item.label, disabled: item.disabled, options: item.options }], buttons: item.buttons }
    }
    if (!Array.isArray(item.groups) || item.groups.length < 1 || item.groups.length > FOCUS_UI_MAX_GROUPS ||
      item.groups.some(group => !group || !text(group.label, 500) || typeof group.disabled !== 'boolean' || !validOptions(group.options))) return null
    return { version: 2, sourceMessageId: item.sourceMessageId, index: item.index, signature: item.signature, title: item.title,
      description: item.description, disabled: item.disabled, groups: item.groups, buttons: item.buttons }
  } catch { return null }
}
