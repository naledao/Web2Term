import type { WindowsClickReceipt } from '../shared/windows-click'
import type { WindowsObservation } from '../shared/windows-observation'
import type { ControlsOnlyObservation } from './windows-control-tree'
import { resolveImagePoint } from '../shared/windows-coordinates'
import { OBSERVATION_STALE_REASONS } from '../shared/windows-observation-binding'
import type { WindowsHelperActionResult } from '../shared/windows-helper'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi
const nullable = (v: unknown, hi: number): boolean => v === null || integer(v, 0, hi)
const inside = (r: { x: number; y: number; width: number; height: number }, p: { x: number; y: number }): boolean => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height

/** Cross-check original intent, returned facts and trusted observation; never infer input success from a helper message. */
export function validateWindowsClickReceipt(value: unknown, p: Record<string, unknown>, observed: WindowsObservation | ControlsOnlyObservation,
  requestId: string, sourceStep: string, response: WindowsHelperActionResult, now: number): value is WindowsClickReceipt {
  if (!object(value) || !fields(value, ['request_id', 'observation_id', 'source_step_id', 'window_id', 'button', 'click_count', 'requested_method', 'method',
    'move_attempted', 'move_accepted', 'click_attempted', 'click_completed', 'button_events_requested', 'button_events_accepted',
    'release_required', 'release_attempted', 'release_accepted', 'point', 'before_at', 'completed_at', 'goal_verified', 'input_ready', ...(value.validation === undefined ? [] : ['validation'])]) ||
    value.request_id !== requestId || value.observation_id !== p.observation_id || value.source_step_id !== sourceStep ||
    value.button !== (p.button ?? 'left') || value.click_count !== (p.click_count ?? 1) || value.requested_method !== (p.method ?? 'auto') ||
    !['none', 'mouse', 'uia_invoke', 'uia_toggle', 'uia_select'].includes(value.method as string) || value.goal_verified !== false || value.input_ready !== false ||
    ['move_attempted', 'click_attempted', 'click_completed', 'release_required', 'release_attempted'].some(k => typeof value[k] !== 'boolean') ||
    !nullable(value.move_accepted, 1) || !nullable(value.release_accepted, 1)) return false
  const v = value as unknown as WindowsClickReceipt
  const before = Date.parse(v.before_at), completed = Date.parse(v.completed_at)
  if (typeof v.before_at !== 'string' || typeof v.completed_at !== 'string' || !Number.isFinite(before) || !Number.isFinite(completed) || before > completed || completed > now + 10000 || now - before > 120000 ||
      (v.window_id !== observed.window_id && !(v.window_id === null && !v.move_attempted && !v.click_attempted)) ||
      (!v.move_attempted && v.move_accepted !== null) || v.move_attempted && v.method !== 'mouse' ||
      v.click_attempted && v.method === 'none' || v.method.startsWith('uia_') && (!v.click_attempted || v.button !== 'left' || v.click_count !== 1 || v.requested_method !== 'auto') ||
      v.click_completed && !v.click_attempted) return false
  const mouseButtons = v.click_attempted && v.method === 'mouse'
  if (v.button_events_requested !== (mouseButtons ? v.click_count * 2 : 0) || !nullable(v.button_events_accepted, v.button_events_requested) ||
      !mouseButtons && v.button_events_accepted !== null || mouseButtons && (!v.move_attempted || v.move_accepted !== 1)) return false
  const needsRelease = mouseButtons && (v.button_events_accepted === null || v.button_events_accepted > 0 && v.button_events_accepted < v.button_events_requested && v.button_events_accepted % 2 === 1)
  if (v.release_required !== needsRelease || v.release_attempted !== needsRelease || !v.release_attempted && v.release_accepted !== null ||
      v.click_completed && (v.method === 'mouse' && v.button_events_accepted !== v.button_events_requested || v.release_required)) return false
  if (v.point !== null) {
    if (!object(v.point) || !fields(v.point, ['x', 'y']) || !integer(v.point.x, -1_000_000, 1_032_768) || !integer(v.point.y, -1_000_000, 1_032_768)) return false
    if (p.element_id !== undefined) {
      const row = observed.controls?.elements.find(item => item.element_id === p.element_id)
      if (!row?.bounds || row.control_type === null || !inside(row.bounds, v.point) || !inside(observed.controls!.window_bounds, v.point)) return false
      if ((v.move_attempted || v.click_attempted) && (row.enabled !== true || row.offscreen !== false)) return false
    } else {
      const mapped = observed.target === 'controls' ? null : resolveImagePoint(observed, Number(p.x), Number(p.y))
      if (!mapped || mapped.desktop.x !== v.point.x || mapped.desktop.y !== v.point.y) return false
    }
  } else if (v.move_attempted || v.click_attempted) return false
  if (v.method.startsWith('uia_')) {
    const row = observed.controls?.elements.find(item => item.element_id === p.element_id)
    const expected = row?.role === 'check_box' && row.patterns.includes('toggle') ? 'uia_toggle'
      : row && ['radio_button', 'list_item', 'tab_item', 'tree_item', 'data_item'].includes(row.role) && row.patterns.includes('selection_item') ? 'uia_select'
        : row && ['button', 'hyperlink', 'menu_item', 'split_button'].includes(row.role) && row.patterns.includes('invoke') ? 'uia_invoke' : null
    if (v.method !== expected || v.move_attempted) return false
  }
  if (v.validation !== undefined) {
    const check = v.validation
    if (!object(check) || !fields(check, ['observation_id', 'source_step_id', 'checked_at', 'valid', 'reason', 'action_not_executed', 'input_ready', 'snapshot_atomic']) ||
        check.observation_id !== p.observation_id || check.source_step_id !== sourceStep || check.valid !== false || check.action_not_executed !== true || check.input_ready !== false || check.snapshot_atomic !== false ||
        typeof check.checked_at !== 'string' || !Number.isFinite(Date.parse(check.checked_at)) || Math.abs(now - Date.parse(check.checked_at)) > 120000 ||
        !OBSERVATION_STALE_REASONS.includes(check.reason as typeof OBSERVATION_STALE_REASONS[number]) || v.click_attempted) return false
  }
  const expectedExecution = v.click_completed ? 'executed' : v.click_attempted ? v.method === 'mouse' && v.button_events_accepted === 0 ? 'executed' : 'unknown'
    : v.move_attempted ? v.move_accepted === 0 ? 'not_executed' : v.move_accepted === 1 ? 'executed' : 'unknown' : 'not_executed'
  return response.execution === expectedExecution && response.ok === v.click_completed &&
    (v.click_completed ? response.code === 'ok' : ['stale_observation', 'click_blocked', 'click_failed', 'cancelled', 'invalid_parameters'].includes(response.code))
}
