import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { evaluateWaitControls } from '../shared/windows-wait'
import type { DesktopWindow } from '../shared/windows-desktop'
import type { ControlTreeObservation } from '../shared/windows-controls'
import { validateWindowsWindowPage } from './windows-window-catalog'
import { validateControlTree } from './windows-control-tree'

export interface WindowsWaitClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export const windowsWaitClock: WindowsWaitClock = { now: () => performance.now(), sleep: async (ms, signal) => { await delay(ms, undefined, { signal }) } }
export interface WaitProbe {
  wait_id: string; condition: string; snapshot_id: string; scope_collected_at: string; scope_expires_at: string; before_at: string; checked_at: string
  window: DesktopWindow | null; controls: ControlTreeObservation | null; status: 'met' | 'not_met' | 'ambiguous' | 'unavailable'; matches: number
  complete: boolean; limitations: string[]; revision: string | null; input_ready: false; goal_verified: false
}
export interface WaitWindowLease {
  scope_id: string; generation: number; isCurrent(): boolean
  publish(probe: WaitProbe): boolean
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function validateWaitProbe(v: unknown, p: Record<string, unknown>, waitId: string, selected: DesktopWindow | null, now: number): v is WaitProbe {
  const keys = ['wait_id', 'condition', 'snapshot_id', 'scope_collected_at', 'scope_expires_at', 'before_at', 'checked_at', 'window', 'controls', 'status', 'matches', 'complete', 'limitations', 'revision', 'input_ready', 'goal_verified']
  if (!object(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k)) || v.wait_id !== waitId || v.condition !== p.condition ||
    !['met', 'not_met', 'ambiguous', 'unavailable'].includes(v.status as string) || !Number.isSafeInteger(v.matches) || Number(v.matches) < 0 || Number(v.matches) > 512 ||
    typeof v.complete !== 'boolean' || !Array.isArray(v.limitations) || new Set(v.limitations).size !== v.limitations.length || v.limitations.length > 5 ||
    v.limitations.some(r => !['enumeration_incomplete', 'controls_incomplete', 'controls_unavailable', 'target_unavailable', 'state_changed'].includes(r)) || v.complete !== (v.limitations.length === 0) ||
    v.revision !== null && (typeof v.revision !== 'string' || v.revision.length > 200 || !/^[a-zA-Z0-9:._-]+$/.test(v.revision)) || v.input_ready !== false || v.goal_verified !== false ||
    typeof v.before_at !== 'string' || typeof v.checked_at !== 'string' || !Number.isFinite(Date.parse(v.before_at)) || !Number.isFinite(Date.parse(v.checked_at)) ||
    Date.parse(v.before_at) > Date.parse(v.checked_at) || Date.parse(v.checked_at) > now + 10000 || now - Date.parse(v.before_at) > 120000) return false
  const page = { snapshot_id: v.snapshot_id, collected_at: v.scope_collected_at, expires_at: v.scope_expires_at, query: '', pid: null, include_hidden: true,
    windows: v.window === null ? [] : [v.window], total_matches: v.window === null ? 0 : 1, has_more: false, next_cursor: null, complete: false, limitations: [] }
  if (!validateWindowsWindowPage(page, { query: '', pid: null, include_hidden: true, limit: 1 }, now) || v.window !== null && (!object(v.window) || v.window.identity_verified !== true)) return false
  const w = v.window as DesktopWindow | null
  if (p.condition === 'window_present') {
    if (v.controls !== null || v.limitations.some(r => r === 'controls_incomplete' || r === 'controls_unavailable') || v.status === 'unavailable' && v.complete ||
      v.status === 'met' && (!w || v.matches !== 1 || !v.complete) || v.status !== 'met' && w !== null ||
      v.status === 'not_met' && (!v.complete || v.matches !== 0) || v.status === 'ambiguous' && Number(v.matches) < 2) return false
    if (w && (!w.visible || w.minimized || w.cloaked !== false || w.class_name === '#32768' || p.pid !== undefined && w.pid !== p.pid ||
      ![w.title, w.application.name, w.application.executable_path, w.application.app_user_model_id].some(s => s?.toLowerCase().includes((p.query as string).trim().toLowerCase())))) return false
  } else {
    if (!w || !selected || ['window_id', 'hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name'].some(k => w[k as keyof DesktopWindow] !== selected[k as keyof DesktopWindow])) return false
    if (v.controls !== null && !validateControlTree(v.controls, { window_id: w.window_id, max_depth: 4, max_elements: 100 }, w, now)) return false
    if (v.limitations.includes('enumeration_incomplete') || v.limitations.includes('controls_unavailable') !== (v.controls === null) ||
      v.limitations.includes('controls_incomplete') !== (v.controls !== null && !(v.controls as ControlTreeObservation).complete) ||
      v.limitations.includes('target_unavailable') !== (!w.visible || w.minimized || w.cloaked !== false) ||
      v.limitations.includes('state_changed') && v.status !== 'unavailable') return false
    const expected = evaluateWaitControls(p, w, v.controls as ControlTreeObservation | null)
    if (v.matches !== expected.matches || (v.status !== expected.status && !(v.status === 'unavailable' && v.limitations.includes('state_changed'))) ||
      v.controls === null && !v.limitations.includes('controls_unavailable') || v.status === 'met' && v.limitations.includes('state_changed')) return false
  }
  return true
}
export async function pollWindowsWait(p: Record<string, unknown>, check: (budget: number) => Promise<WaitProbe>, clock: WindowsWaitClock, current: () => boolean, signal?: AbortSignal): Promise<{
  status: 'met' | 'timeout' | 'ambiguous'; checks: number; elapsed_ms: number; last: WaitProbe
}> {
  const start = clock.now(), timeout = Number(p.timeout_ms ?? 10000); let checks = 0, last: WaitProbe | undefined, previous: string | null = null, backoff = 250
  const valid = (): void => { if (signal?.aborted || !current()) throw new Error('wait_context_inactive') }
  while (checks < 128) {
    valid(); const remaining = timeout - (clock.now() - start)
    if (last && remaining < 100) { if (remaining > 0) await clock.sleep(remaining, signal); break }
    last = await check(Math.max(100, Math.min(4000, Math.floor(remaining)))); checks++; valid()
    const elapsed = Math.max(0, Math.floor(clock.now() - start))
    if (elapsed >= timeout) return { status: 'timeout', checks, elapsed_ms: elapsed, last }
    if (last.status === 'met' || last.status === 'ambiguous') return { status: last.status, checks, elapsed_ms: elapsed, last }
    backoff = checks > 1 && last.revision === previous ? Math.min(1000, backoff * 2) : 250; previous = last.revision
    const wait = Math.min(backoff, timeout - (clock.now() - start)); if (wait <= 0) break
    await clock.sleep(wait, signal)
  }
  valid(); return { status: 'timeout', checks, elapsed_ms: Math.max(0, Math.floor(clock.now() - start)), last: last! }
}
