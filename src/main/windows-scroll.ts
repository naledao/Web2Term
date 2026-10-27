import { scrollAxis, scrollDelta } from '../shared/windows-scroll'
import type { WindowsScrollReceipt } from '../shared/windows-scroll'
import { resolveImagePoint } from '../shared/windows-coordinates'
import { OBSERVATION_STALE_REASONS } from '../shared/windows-observation-binding'
import type { WindowsObservation } from '../shared/windows-observation'
import type { ControlsOnlyObservation } from './windows-control-tree'
import type { WindowsHelperActionResult } from '../shared/windows-helper'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown, low: number, high: number): v is number => Number.isSafeInteger(v) && Number(v) >= low && Number(v) <= high
const accepted = (v: unknown): boolean => v === null || integer(v, 0, 1)
const inside = (r: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): boolean => point.x >= r.x && point.y >= r.y && point.x < r.x + r.width && point.y < r.y + r.height

/** Keep cursor movement separate from wheel submission; independently recompute direction, delta, point and execution. */
export function validateWindowsScrollReceipt(value: unknown, p: Record<string, unknown>, observed: WindowsObservation | ControlsOnlyObservation,
  requestId: string, sourceStep: string, response: WindowsHelperActionResult, now: number): value is WindowsScrollReceipt {
  if (!object(value) || !fields(value, ['request_id', 'observation_id', 'source_step_id', 'window_id', 'element_id', 'direction', 'amount', 'axis', 'wheel_delta',
    'move_attempted', 'move_accepted', 'scroll_attempted', 'scroll_completed', 'wheel_events_requested', 'wheel_events_accepted', 'routing', 'point', 'before_at', 'completed_at',
    'scroll_verified', 'goal_verified', 'input_ready', ...(value.validation === undefined ? [] : ['validation'])]) ||
    value.request_id !== requestId || value.observation_id !== p.observation_id || value.source_step_id !== sourceStep || value.element_id !== (p.element_id ?? null) ||
    value.direction !== p.direction || value.amount !== (p.amount ?? 3) || value.axis !== scrollAxis(p.direction as string) || value.wheel_delta !== scrollDelta(p.direction as string, Number(p.amount ?? 3)) ||
    ['move_attempted', 'scroll_attempted', 'scroll_completed'].some(k => typeof value[k] !== 'boolean') || !accepted(value.move_accepted) || !accepted(value.wheel_events_accepted) ||
    value.routing !== null && !['mouse_position', 'focused_hit', 'focused_descendant'].includes(value.routing as string) || value.scroll_verified !== false || value.goal_verified !== false || value.input_ready !== false) return false
  const v = value as unknown as WindowsScrollReceipt
  const before = typeof v.before_at === 'string' ? Date.parse(v.before_at) : NaN, end = typeof v.completed_at === 'string' ? Date.parse(v.completed_at) : NaN
  if (!Number.isFinite(before) || !Number.isFinite(end) || before > end || end > now + 10000 || now - before > 120000 ||
    (v.move_attempted || v.scroll_attempted) && observed.window_id === null ||
    v.window_id !== observed.window_id && !(v.window_id === null && !v.move_attempted && !v.scroll_attempted) ||
    !v.move_attempted && v.move_accepted !== null || v.scroll_attempted && (!v.move_attempted || v.move_accepted !== 1 || v.routing === null) ||
    v.axis === 'horizontal' && v.routing === 'mouse_position' ||
    v.wheel_events_requested !== (v.scroll_attempted ? 1 : 0) || !v.scroll_attempted && v.wheel_events_accepted !== null ||
    v.scroll_completed !== (v.scroll_attempted && v.wheel_events_accepted === 1)) return false
  if (v.point !== null) {
    if (!object(v.point) || !fields(v.point, ['x', 'y']) || !integer(v.point.x, -1_000_000, 1_032_768) || !integer(v.point.y, -1_000_000, 1_032_768)) return false
    if (p.element_id !== undefined) {
      const row = observed.controls?.elements.find(row => row.element_id === p.element_id)
      if (!row?.bounds || row.control_type === null || !inside(row.bounds, v.point) || !inside(observed.controls!.window_bounds, v.point)) return false
      if ((v.move_attempted || v.scroll_attempted) && (row.enabled !== true || row.offscreen !== false || observed.target !== 'controls' && observed.monitors.filter(m => inside(m.bounds, v.point!)).length !== 1)) return false
    } else {
      const mapped = observed.target === 'controls' ? null : resolveImagePoint(observed, Number(p.x), Number(p.y))
      if (!mapped || mapped.desktop.x !== v.point.x || mapped.desktop.y !== v.point.y) return false
    }
  } else if (v.move_attempted || v.scroll_attempted) return false
  if (v.validation !== undefined) {
    const check = v.validation
    if (!object(check) || !fields(check, ['observation_id', 'source_step_id', 'checked_at', 'valid', 'reason', 'action_not_executed', 'input_ready', 'snapshot_atomic']) ||
      check.observation_id !== p.observation_id || check.source_step_id !== sourceStep || check.valid !== false || check.action_not_executed !== true || check.input_ready !== false || check.snapshot_atomic !== false ||
      typeof check.checked_at !== 'string' || !Number.isFinite(Date.parse(check.checked_at)) || Math.abs(now - Date.parse(check.checked_at)) > 120000 ||
      !OBSERVATION_STALE_REASONS.includes(check.reason as typeof OBSERVATION_STALE_REASONS[number]) || v.scroll_attempted) return false
  }
  const execution = v.scroll_completed ? 'executed' : v.scroll_attempted && v.wheel_events_accepted === null ? 'unknown'
    : v.move_attempted ? v.move_accepted === 1 ? 'executed' : v.move_accepted === 0 ? 'not_executed' : 'unknown' : 'not_executed'
  return response.execution === execution && response.ok === v.scroll_completed && (v.scroll_completed ? response.code === 'ok' :
    ['stale_observation', 'scroll_blocked', 'scroll_failed', 'cancelled', 'invalid_parameters'].includes(response.code))
}
