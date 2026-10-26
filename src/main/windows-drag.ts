import { interpolateDragPath } from '../shared/windows-drag'
import type { DragPoint, WindowsDragReceipt } from '../shared/windows-drag'
import { resolveImagePoint } from '../shared/windows-coordinates'
import { OBSERVATION_STALE_REASONS } from '../shared/windows-observation-binding'
import type { WindowsObservation } from '../shared/windows-observation'
import type { ControlsOnlyObservation } from './windows-control-tree'
import type { WindowsHelperActionResult } from '../shared/windows-helper'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const accepted = (v: unknown): boolean => v === null || v === 0 || v === 1
const same = (v: unknown, p: DragPoint): boolean => object(v) && fields(v, ['x', 'y']) && v.x === p.x && v.y === p.y
export function resolveDragPath(o: WindowsObservation, path: readonly DragPoint[]): DragPoint[] | null {
  const anchors = path.map(p => resolveImagePoint(o, p.x, p.y)?.desktop)
  if (anchors.some(p => !p)) return null
  const points = interpolateDragPath(anchors as DragPoint[]), pixels = points && interpolateDragPath(anchors as DragPoint[], 1)
  if (!pixels || !points) return null
  const route = [...pixels, ...points] // Coarse rounded waypoints need not be members of the stride=1 raster.
  if (route.some(p => p.x < o.source_bounds.x || p.y < o.source_bounds.y || p.x >= o.source_bounds.x + o.source_bounds.width || p.y >= o.source_bounds.y + o.source_bounds.height ||
    o.monitors.filter(m => p.x >= m.bounds.x && p.y >= m.bounds.y && p.x < m.bounds.x + m.bounds.width && p.y < m.bounds.y + m.bounds.height).length !== 1)) return null
  // Match the native check for the whole raster route, rather than snapping an unrepresentable pixel.
  const r = o.coordinate_context.virtual_bounds
  if (route.some(p => ['x', 'y'].some(k => {
    const key = k as 'x' | 'y', size = k === 'x' ? r.width : r.height, offset = p[key] - r[key]
    const value = Math.floor((2 * offset + 1) * 65536 / (2 * size))
    return value < 0 || value > 65535 || Math.floor(value * size / 65536) !== offset
  }))) return null
  return points
}
/** Recompute the path, accepted prefix, cleanup obligation and execution; a helper message alone is not evidence. */
export function validateWindowsDragReceipt(value: unknown, p: Record<string, unknown>, observed: WindowsObservation | ControlsOnlyObservation,
  requestId: string, sourceStep: string, response: WindowsHelperActionResult, now: number): value is WindowsDragReceipt {
  if (!object(value) || !fields(value, ['request_id', 'observation_id', 'source_step_id', 'window_id', 'button', 'duration_ms', 'start', 'end', 'segments_planned',
    'move_attempted', 'move_accepted', 'move_arrived', 'down_attempted', 'down_accepted', 'down_confirmed', 'segments', 'up_attempted', 'up_accepted',
    'release_required', 'release_attempted', 'release_accepted', 'drag_completed', 'before_at', 'completed_at', 'drag_verified', 'goal_verified', 'input_ready', ...(value.validation === undefined ? [] : ['validation'])]) ||
    value.request_id !== requestId || value.observation_id !== p.observation_id || value.source_step_id !== sourceStep || value.button !== (p.button ?? 'left') || value.duration_ms !== (p.duration_ms ?? 600) ||
    ['move_attempted', 'move_arrived', 'down_attempted', 'down_confirmed', 'up_attempted', 'release_required', 'release_attempted', 'drag_completed'].some(k => typeof value[k] !== 'boolean') ||
    !['move_accepted', 'down_accepted', 'up_accepted', 'release_accepted'].every(k => accepted(value[k])) || value.drag_verified !== false || value.goal_verified !== false || value.input_ready !== false ||
    !Array.isArray(value.segments)) return false
  const v = value as unknown as WindowsDragReceipt, points = observed.target === 'controls' ? null : resolveDragPath(observed, p.path as DragPoint[])
  if (v.window_id !== observed.window_id && !(v.window_id === null && !v.move_attempted) || v.move_attempted && (!observed.window_id || !points)) return false
  if (v.start === null || v.end === null) { if (v.start !== null || v.end !== null || v.segments_planned !== 0 || v.move_attempted) return false }
  else if (!points || !same(v.start, points[0]) || !same(v.end, points.at(-1)!) || v.segments_planned !== points.length - 1) return false
  const before = typeof v.before_at === 'string' ? Date.parse(v.before_at) : NaN, end = typeof v.completed_at === 'string' ? Date.parse(v.completed_at) : NaN
  if (!Number.isFinite(before) || !Number.isFinite(end) || before > end || end > now + 10000 || now - before > 120000 ||
    !v.move_attempted && v.move_accepted !== null || v.move_arrived && v.move_accepted !== 1 ||
    v.down_attempted && (!v.move_attempted || v.move_accepted !== 1 || !v.move_arrived) || !v.down_attempted && v.down_accepted !== null ||
    v.down_confirmed && v.down_accepted !== 1 || v.segments.length > 256 || v.segments.length > v.segments_planned ||
    v.segments.length > 0 && (!v.down_attempted || v.down_accepted !== 1 || !v.down_confirmed)) return false
  for (let i = 0; i < v.segments.length; i++) {
    const s = v.segments[i]
    if (!object(s) || !fields(s, ['index', 'accepted', 'arrived']) || s.index !== i + 1 || !accepted(s.accepted) || typeof s.arrived !== 'boolean' ||
      s.arrived && s.accepted !== 1 || i < v.segments.length - 1 && (s.accepted !== 1 || !s.arrived)) return false
  }
  const full = v.down_confirmed && v.segments.length === v.segments_planned && v.segments_planned > 0 && v.segments.every(s => s.accepted === 1 && s.arrived)
  const releaseRequired = v.down_attempted && v.down_accepted !== 0 && v.up_accepted !== 1
  if (v.up_attempted && !full || !v.up_attempted && v.up_accepted !== null || v.release_required !== releaseRequired || v.release_attempted !== releaseRequired ||
    !v.release_attempted && v.release_accepted !== null || v.drag_completed !== (full && v.up_attempted && v.up_accepted === 1)) return false
  if (v.validation !== undefined) {
    const c = v.validation
    if (!object(c) || !fields(c, ['observation_id', 'source_step_id', 'checked_at', 'valid', 'reason', 'action_not_executed', 'input_ready', 'snapshot_atomic']) ||
      c.observation_id !== p.observation_id || c.source_step_id !== sourceStep || c.valid !== false || c.action_not_executed !== true || c.input_ready !== false || c.snapshot_atomic !== false ||
      typeof c.checked_at !== 'string' || !Number.isFinite(Date.parse(c.checked_at)) || Math.abs(now - Date.parse(c.checked_at)) > 120000 ||
      !OBSERVATION_STALE_REASONS.includes(c.reason as typeof OBSERVATION_STALE_REASONS[number]) || v.down_attempted) return false
  }
  const execution = v.drag_completed ? 'executed' : v.down_attempted && v.down_accepted !== 0 ? 'unknown'
    : v.move_attempted ? v.move_accepted === 1 ? 'executed' : v.move_accepted === 0 ? 'not_executed' : 'unknown' : 'not_executed'
  return response.execution === execution && response.ok === v.drag_completed && (v.drag_completed ? response.code === 'ok' :
    ['stale_observation', 'drag_blocked', 'drag_failed', 'cancelled', 'invalid_parameters'].includes(response.code))
}
