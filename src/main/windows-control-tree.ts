import type { DesktopWindow } from '../shared/windows-desktop'
import type { ObservationBinding } from '../shared/windows-observation-binding'
import { CONTROL_LIMITATIONS, UIA_PATTERNS, UIA_ROLES } from '../shared/windows-controls'
import type { ControlBounds, ControlTreeObservation, DesktopControl } from '../shared/windows-controls'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown, low: number, high: number): v is number => Number.isSafeInteger(v) && Number(v) >= low && Number(v) <= high
const id = (v: unknown, prefix: string): v is string => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
const flag = (v: unknown): v is boolean | null => v === true || v === false || v === null
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0')
const bounds = (v: unknown): v is ControlBounds => object(v) && fields(v, ['x', 'y', 'width', 'height']) &&
  ['x', 'y', 'width', 'height'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k])) && Math.abs(Number(v.x)) <= 1_000_000 && Math.abs(Number(v.y)) <= 1_000_000 &&
  Number(v.width) > 0 && Number(v.width) <= 32768 && Number(v.height) > 0 && Number(v.height) <= 32768

/** No provider strings, raw runtime IDs, or helper success flags can substitute for this independent result check. */
export function validateControlTree(value: unknown, p: Record<string, unknown>, selected: DesktopWindow, now: number): value is ControlTreeObservation {
  if (!object(value) || !fields(value, ['observation_id', 'window_id', 'window_identity', 'before_at', 'observed_at', 'window_bounds', 'root_element_id', 'elements', 'focus', 'selection', 'complete', 'limitations', 'visited_count', 'geometry_consistent', 'snapshot_atomic', 'content_verified', 'input_ready', 'goal_verified']) ||
      !id(value.observation_id, 'obs_') || value.window_id !== p.window_id || value.geometry_consistent !== true || value.snapshot_atomic !== false ||
      value.content_verified !== false || value.input_ready !== false || value.goal_verified !== false || !bounds(value.window_bounds) ||
      !['x', 'y', 'width', 'height'].every(k => Number.isSafeInteger((value.window_bounds as unknown as Record<string, unknown>)[k]))) return false
  const identity = value.window_identity
  if (!object(identity) || !fields(identity, ['hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name']) ||
      !['hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name'].every(k => identity[k] === selected[k as keyof DesktopWindow])) return false
  const before = text(value.before_at, 64) ? Date.parse(value.before_at) : NaN, after = text(value.observed_at, 64) ? Date.parse(value.observed_at) : NaN
  if (!Number.isFinite(before) || !Number.isFinite(after) || before > after || after > now + 10_000 || now - before > 120_000) return false
  if (!Array.isArray(value.limitations) || value.limitations.length > CONTROL_LIMITATIONS.length || new Set(value.limitations).size !== value.limitations.length ||
      value.limitations.some(v => !CONTROL_LIMITATIONS.includes(v)) || value.complete !== (value.limitations.length === 0)) return false
  const max = Number(p.max_elements ?? 100), depth = Number(p.max_depth ?? 4)
  if (!Array.isArray(value.elements) || value.elements.length > max || !integer(value.visited_count, value.elements.length, max * 4) ||
      (value.elements.length === 0 ? value.root_element_id !== null || value.complete : value.root_element_id !== value.elements[0]?.element_id)) return false
  const known = new Map<string, DesktopControl>()
  for (const [index, raw] of value.elements.entries()) {
    if (!object(raw) || !fields(raw, ['element_id', 'parent_id', 'depth', 'control_type', 'role', 'name', 'name_truncated', 'password', 'enabled', 'focused', 'offscreen', 'selected', 'bounds', 'patterns', 'properties_complete']) ||
        !id(raw.element_id, 'el_') || known.has(raw.element_id) || !integer(raw.depth, 0, depth) ||
        (index === 0 ? raw.parent_id !== null || raw.depth !== 0 : typeof raw.parent_id !== 'string' || !known.has(raw.parent_id) || raw.depth !== known.get(raw.parent_id)!.depth + 1) ||
        (raw.control_type !== null && !integer(raw.control_type, 50000, 50040)) || raw.role !== (raw.control_type === null ? 'unknown' : UIA_ROLES[Number(raw.control_type) - 50000]) ||
        ![raw.password, raw.enabled, raw.focused, raw.offscreen, raw.selected].every(flag) || (raw.name !== null && !text(raw.name, 256)) ||
        typeof raw.name_truncated !== 'boolean' || typeof raw.properties_complete !== 'boolean' || (raw.bounds !== null && !bounds(raw.bounds)) ||
        (raw.password !== false && (raw.name !== null || raw.name_truncated)) || (raw.name_truncated && (!value.limitations.includes('name_truncated') || !text(raw.name, 256))) ||
        !Array.isArray(raw.patterns) || raw.patterns.length > UIA_PATTERNS.length || new Set(raw.patterns).size !== raw.patterns.length || raw.patterns.some(v => !UIA_PATTERNS.includes(v))) return false
    if (index > 0) {
      if (raw.offscreen !== false || !bounds(raw.bounds)) return false
      const box = raw.bounds, window = value.window_bounds
      if (!(box.x < window.x + window.width && box.y < window.y + window.height && box.x + box.width > window.x && box.y + box.height > window.y)) return false
      if (known.get(raw.parent_id as string)!.password !== false) return false
    }
    if (raw.properties_complete ? raw.control_type === null || raw.password === null || raw.enabled === null || raw.focused === null || raw.offscreen === null ||
        raw.bounds === null || (raw.password === false && raw.name === null) : !value.limitations.includes('properties_unavailable')) return false
    known.set(raw.element_id, raw as unknown as DesktopControl)
  }
  const focus = value.focus, selection = value.selection
  if (!object(focus) || !fields(focus, ['status', 'element_id']) || !['inside_target', 'outside_target', 'unavailable', 'changed'].includes(focus.status as string) ||
      (focus.element_id !== null && (focus.status !== 'inside_target' || typeof focus.element_id !== 'string' || known.get(focus.element_id)?.focused !== true)) ||
      (focus.status === 'changed' && !value.limitations.includes('focus_changed'))) return false
  if (!object(selection) || !fields(selection, ['requested', 'status', 'element_id', 'text', 'truncated']) || selection.requested !== (p.include_selection === true) ||
      !['not_requested', 'text', 'empty', 'unsupported', 'protected', 'unavailable', 'focus_outside', 'not_in_tree', 'changed'].includes(selection.status as string) ||
      typeof selection.truncated !== 'boolean' || (selection.text !== null && !text(selection.text, 2048)) ||
      (selection.element_id !== null && (focus.status !== 'inside_target' || selection.element_id !== focus.element_id))) return false
  if (!selection.requested) {
    if (selection.status !== 'not_requested' || selection.text !== null || selection.element_id !== null || selection.truncated) return false
  } else {
    if (selection.status === 'not_requested') return false
    if (selection.status === 'text') {
      const node = typeof selection.element_id === 'string' ? known.get(selection.element_id) : null
      if (!node || node.password !== false || !node.patterns.includes('text') || !text(selection.text, 2048) || !selection.text ||
          (selection.truncated && !value.limitations.includes('selection_truncated'))) return false
    } else if (selection.text !== null || selection.truncated) return false
    if (['empty', 'unsupported', 'protected'].includes(selection.status as string) && selection.element_id === null) return false
    if (selection.status === 'focus_outside' && (focus.status !== 'outside_target' || selection.element_id !== null)) return false
    if (selection.status === 'not_in_tree' && (focus.status !== 'inside_target' || focus.element_id !== null || selection.element_id !== null)) return false
    if (selection.status === 'changed' && (focus.status !== 'changed' || selection.element_id !== null)) return false
  }
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 140 * 1024 } catch { return false }
}

export interface ControlsOnlyObservation {
  binding?: ObservationBinding
  observation_id: string; target: 'controls'; window_id: string; controls: ControlTreeObservation
  content_verified: false; input_ready: false; goal_verified: false
}
export function validateControlsOnly(value: unknown, p: Record<string, unknown>, selected: DesktopWindow, now: number): value is ControlsOnlyObservation {
  return object(value) && fields(value, ['observation_id', 'target', 'window_id', 'controls', 'content_verified', 'input_ready', 'goal_verified']) &&
    value.target === 'controls' && value.window_id === p.window_id && value.content_verified === false && value.input_ready === false && value.goal_verified === false &&
    validateControlTree(value.controls, p, selected, now) && value.observation_id === value.controls.observation_id
}
