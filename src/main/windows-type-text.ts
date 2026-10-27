import { createHash } from 'node:crypto'
import { unicodeTextChunks } from '../shared/windows-type-text'
import type { WindowsTypeTextReceipt } from '../shared/windows-type-text'
import type { WindowsObservation } from '../shared/windows-observation'
import type { ControlsOnlyObservation } from './windows-control-tree'
import type { WindowsHelperActionResult } from '../shared/windows-helper'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown, low: number, high: number): boolean => Number.isSafeInteger(v) && Number(v) >= low && Number(v) <= high

/** Recompute the exact UTF-16 batches from the original text; helper acknowledgement never proves a business goal. */
export function validateWindowsTypeTextReceipt(value: unknown, p: Record<string, unknown>, observed: WindowsObservation | ControlsOnlyObservation,
  requestId: string, sourceStep: string, response: WindowsHelperActionResult, now: number): value is WindowsTypeTextReceipt {
  if (!object(value) || !fields(value, ['request_id', 'observation_id', 'source_step_id', 'window_id', 'element_id', 'mode', 'method', 'text_utf16_length', 'text_sha256',
    'input_attempted', 'input_completed', 'batches', 'verification', 'content_verified', 'before_at', 'completed_at', 'goal_verified', 'input_ready']) ||
    value.request_id !== requestId || value.observation_id !== p.observation_id || value.source_step_id !== sourceStep || value.element_id !== (p.element_id ?? null) ||
    value.mode !== (p.mode ?? 'insert') || !['none', 'unicode', 'uia_value'].includes(value.method as string) || typeof p.text !== 'string' ||
    value.text_utf16_length !== p.text.length || value.text_sha256 !== createHash('sha256').update(p.text).digest('hex') ||
    ['input_attempted', 'input_completed', 'content_verified'].some(k => typeof value[k] !== 'boolean') ||
    !Array.isArray(value.batches) || value.batches.length > 274 || !['matched', 'mismatched', 'unavailable'].includes(value.verification as string) ||
    value.goal_verified !== false || value.input_ready !== false) return false
  const v = value as unknown as WindowsTypeTextReceipt
  const row = observed.controls?.elements.find(row => row.element_id === p.element_id)
  const before = typeof v.before_at === 'string' ? Date.parse(v.before_at) : NaN, end = typeof v.completed_at === 'string' ? Date.parse(v.completed_at) : NaN
  if (!Number.isFinite(before) || !Number.isFinite(end) || before > end || end > now + 10000 || now - before > 120000 ||
    v.window_id !== observed.window_id && !(v.window_id === null && !v.input_attempted) ||
    v.input_completed && !v.input_attempted || v.input_attempted && v.method === 'none' ||
    v.content_verified !== (v.verification === 'matched') || v.verification !== 'unavailable' &&
    (!v.input_completed || row?.password !== false || !row.patterns.includes('text'))) return false
  if (v.input_attempted && p.element_id !== undefined && (!row?.bounds || row.control_type === null || row.enabled !== true || row.offscreen !== false || row.focused !== true || row.password === null ||
    observed.controls?.focus.status !== 'inside_target' || observed.controls.focus.element_id !== p.element_id ||
    !['edit', 'document'].includes(row.role) && !row.patterns.includes('value'))) return false
  if (p.element_id === undefined && (observed.window_id === null || v.mode !== 'insert' || v.method === 'uia_value' || v.verification !== 'unavailable' || v.content_verified)) return false
  let execution: WindowsHelperActionResult['execution'] = 'not_executed'
  if (v.method === 'uia_value') {
    if (v.mode !== 'replace' || !v.input_attempted || v.batches.length || row?.password !== false || !row.patterns.includes('value')) return false
    execution = v.input_completed ? 'executed' : 'unknown'
  } else if (v.method === 'unicode') {
    if (v.mode !== 'insert' || v.input_attempted !== (v.batches.length > 0)) return false
    const chunks = unicodeTextChunks(p.text)
    if (v.batches.length > chunks.length) return false
    let offset = 0, uncertain = false, accepted = false
    for (let i = 0; i < v.batches.length; i++) {
      const batch = v.batches[i], length = chunks[i].length
      if (!object(batch) || !fields(batch, ['offset', 'length', 'accepted', 'release_attempted', 'release_accepted']) || batch.offset !== offset || batch.length !== length ||
        batch.accepted !== null && !integer(batch.accepted, 0, length * 2) || batch.release_accepted !== null && !integer(batch.release_accepted, 0, 1)) return false
      const release = batch.accepted === null || batch.accepted > 0 && batch.accepted < length * 2 && batch.accepted % 2 === 1
      if (batch.release_attempted !== release || !release && batch.release_accepted !== null || i < v.batches.length - 1 && batch.accepted !== length * 2) return false
      uncertain ||= batch.accepted === null || batch.accepted > 0 && batch.accepted < length * 2
      accepted ||= batch.accepted !== null && batch.accepted > 0; offset += length
    }
    if (v.input_completed && (v.batches.length !== chunks.length || v.batches.some(b => b.accepted !== b.length * 2))) return false
    execution = v.input_completed ? 'executed' : uncertain ? 'unknown' : accepted ? 'executed' : 'not_executed'
  } else if (v.input_attempted || v.batches.length || v.input_completed) return false
  return response.execution === execution && response.ok === v.input_completed && (v.input_completed ? response.code === 'ok' :
    ['stale_observation', 'type_text_blocked', 'type_text_failed', 'cancelled', 'invalid_parameters'].includes(response.code))
}
