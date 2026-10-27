import { parsePressKey, pressKeyReleaseNames } from '../shared/windows-press-key'
import type { WindowsPressKeyReceipt } from '../shared/windows-press-key'
import type { WindowsObservation } from '../shared/windows-observation'
import type { ControlsOnlyObservation } from './windows-control-tree'
import type { WindowsHelperActionResult } from '../shared/windows-helper'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown, low: number, high: number): boolean => Number.isSafeInteger(v) && Number(v) >= low && Number(v) <= high

/** Independently reconstruct event counts and reverse cleanup keys from the actual requested chord. */
export function validateWindowsPressKeyReceipt(value: unknown, p: Record<string, unknown>, observed: WindowsObservation | ControlsOnlyObservation,
  requestId: string, sourceStep: string, response: WindowsHelperActionResult, now: number): value is WindowsPressKeyReceipt {
  const chord = parsePressKey(p.key)
  if (!chord || !object(value) || !fields(value, ['request_id', 'observation_id', 'source_step_id', 'window_id', 'element_id', 'key', 'input_attempted', 'input_completed',
    'events_requested', 'events_accepted', 'release_keys', 'release_accepted', 'before_at', 'completed_at', 'goal_verified', 'input_ready']) ||
    value.request_id !== requestId || value.observation_id !== p.observation_id || value.source_step_id !== sourceStep || value.element_id !== (p.element_id ?? null) || value.key !== chord.key ||
    typeof value.input_attempted !== 'boolean' || typeof value.input_completed !== 'boolean' || value.goal_verified !== false || value.input_ready !== false ||
    !Array.isArray(value.release_keys) || value.release_keys.length > 5) return false
  const v = value as unknown as WindowsPressKeyReceipt
  const before = typeof v.before_at === 'string' ? Date.parse(v.before_at) : NaN, end = typeof v.completed_at === 'string' ? Date.parse(v.completed_at) : NaN
  if (!Number.isFinite(before) || !Number.isFinite(end) || before > end || end > now + 10000 || now - before > 120000 ||
    v.input_attempted && observed.window_id === null ||
    v.window_id !== observed.window_id && !(v.window_id === null && !v.input_attempted) ||
    v.events_requested !== (v.input_attempted ? chord.down.length * 2 : 0) ||
    v.events_accepted !== null && !integer(v.events_accepted, 0, v.events_requested) || !v.input_attempted && v.events_accepted !== null ||
    v.input_completed !== (v.input_attempted && v.events_accepted === v.events_requested)) return false
  if (v.input_attempted && p.element_id !== undefined) {
    const row = observed.controls?.elements.find(row => row.element_id === p.element_id)
    if (!row?.bounds || row.control_type === null || row.enabled !== true || row.offscreen !== false || row.focused !== true ||
      observed.controls?.focus.status !== 'inside_target' || observed.controls.focus.element_id !== p.element_id) return false
  }
  const release = v.input_attempted ? pressKeyReleaseNames(chord, v.events_accepted) : []
  if (release.length !== v.release_keys.length || release.some((key, i) => key !== v.release_keys[i]) ||
    v.release_accepted !== null && !integer(v.release_accepted, 0, release.length) || !release.length && v.release_accepted !== null) return false
  const execution = v.input_completed ? 'executed' : !v.input_attempted || v.events_accepted === 0 ? 'not_executed' : 'unknown'
  return response.execution === execution && response.ok === v.input_completed && (v.input_completed ? response.code === 'ok' :
    ['stale_observation', 'press_key_blocked', 'press_key_failed', 'cancelled', 'invalid_parameters'].includes(response.code))
}
