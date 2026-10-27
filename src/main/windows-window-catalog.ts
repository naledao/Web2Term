import { randomUUID } from 'node:crypto'
import { LIST_WINDOWS_DEFINITION, FOCUS_WINDOW_DEFINITION, INSPECT_INTERACTIONS_DEFINITION, TINY_WINDOW_EDGE, tinyWindow } from '../shared/windows-desktop'
import type { DesktopWindow, WindowsWindowPage, WindowsWindowFocusResult, WindowsInteractions } from '../shared/windows-desktop'
import { ComputerUseActionError, throwIfDesktopInterrupted } from './computer-use-tool'
import type { ComputerUseTool, ComputerUseDispatchContext } from './computer-use-tool'
import type { WindowsHelperManager } from './windows-helper'
import { localExecutablePath } from './windows-app-catalog'
import type { WaitWindowLease, WaitProbe } from './windows-wait'

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const string = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || !!v.trim()) && !v.includes('\0')
const number = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const id = (v: unknown, prefix: string): v is string => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
const hwnd = (v: unknown): v is string => string(v, 18) && /^0x[1-9a-f][a-f0-9]*$/.test(v)
const time = (v: unknown): v is string => string(v, 64) && Number.isFinite(Date.parse(v))
const fields = (v: Record<string, unknown>, names: string[]): boolean => Object.keys(v).length === names.length && names.every(name => Object.hasOwn(v, name))
const unique = (values: unknown[]): boolean => new Set(values).size === values.length

export function validateListWindowsParameters(p: Record<string, unknown>): string | null {
  return Object.keys(p).some(key => !['query', 'pid', 'include_hidden', 'limit', 'cursor'].includes(key)) ||
    (p.query !== undefined && !string(p.query, 200, true)) || (p.pid !== undefined && !number(p.pid, 1, 0xffffffff)) ||
    (p.include_hidden !== undefined && typeof p.include_hidden !== 'boolean') || (p.limit !== undefined && !number(p.limit, 1, 50)) ||
    (p.cursor !== undefined && !id(p.cursor, 'wcur_')) ? 'list_windows 仅接受有界查询、PID 筛选、隐藏窗口选项、页长和真实分页引用，不能提交句柄、窗口编号或任务字段。' : null
}

export function validateFocusWindowParameters(p: Record<string, unknown>): string | null {
  return Object.keys(p).some(key => !['window_id', 'restore', 'wait_ms'].includes(key)) || !id(p.window_id, 'win_') ||
    (p.restore !== undefined && typeof p.restore !== 'boolean') || (p.wait_ms !== undefined && !number(p.wait_ms, 0, 3000))
    ? 'focus_window 仅接受当前任务发现的有效普通窗口 window_id、restore 和 0—3000 毫秒等待，不能覆盖句柄、进程或任务作用域。' : null
}

export function validateWindowsWindowFocusResult(value: unknown, snapshotId: string, expected: DesktopWindow): value is WindowsWindowFocusResult {
  if (!object(value) || !fields(value, ['snapshot_id', 'window_id', 'status', 'before_at', 'observed_at', 'restore', 'activation_attempts', 'target', 'identity_verified',
    'observation', 'blocking_window_hwnd', 'focus_confirmed', 'input_ready', 'goal_verified']) || value.snapshot_id !== snapshotId || value.window_id !== expected.window_id ||
    !['focused', 'foreground_only', 'denied', 'blocked', 'restore_required', 'stale', 'cancelled', 'unknown'].includes(value.status as string) ||
    !time(value.before_at) || !time(value.observed_at) || Date.parse(value.observed_at) < Date.parse(value.before_at) ||
    !object(value.restore) || !fields(value.restore, ['attempted', 'accepted']) || typeof value.restore.attempted !== 'boolean' ||
    (value.restore.accepted !== null && typeof value.restore.accepted !== 'boolean') || (!value.restore.attempted && value.restore.accepted !== null) ||
    !Array.isArray(value.activation_attempts) || value.activation_attempts.length > 2 || value.activation_attempts.some(v => v !== null && typeof v !== 'boolean') ||
    typeof value.identity_verified !== 'boolean' || typeof value.focus_confirmed !== 'boolean' || value.input_ready !== false || value.goal_verified !== false ||
    (value.blocking_window_hwnd !== null && (!hwnd(value.blocking_window_hwnd) || value.blocking_window_hwnd === expected.hwnd))) return false
  const target = value.target, observation = value.observation
  if (target === null) {
    if (value.identity_verified || !['stale', 'cancelled', 'unknown'].includes(value.status as string)) return false
  } else if (!object(target) || !fields(target, ['hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name', 'title', 'visible', 'minimized', 'foreground', 'enabled', 'cloaked', 'owner_hwnd']) ||
    target.hwnd !== expected.hwnd || target.pid !== expected.pid || target.process_started_at !== expected.process_started_at || target.thread_id !== expected.thread_id || target.class_name !== expected.class_name ||
    !string(target.title, 256, true) || !value.identity_verified || ['stale', 'unknown'].includes(value.status as string) ||
    ['visible', 'minimized', 'foreground', 'enabled'].some(key => typeof target[key] !== 'boolean') || (target.cloaked !== null && typeof target.cloaked !== 'boolean') ||
    (target.owner_hwnd !== null && (!hwnd(target.owner_hwnd) || target.owner_hwnd === target.hwnd))) return false
  if (!object(observation) || !fields(observation, ['foreground_hwnd', 'active_hwnd', 'focus_hwnd', 'focus_root_hwnd', 'win32_focus', 'uia_focus']) ||
    ['foreground_hwnd', 'active_hwnd', 'focus_hwnd', 'focus_root_hwnd'].some(key => observation[key] !== null && !hwnd(observation[key])) ||
    !['confirmed', 'outside_target', 'unavailable'].includes(observation.win32_focus as string) ||
    !object(observation.uia_focus) || !fields(observation.uia_focus, ['status', 'root_hwnd', 'has_keyboard_focus']) ||
    !['confirmed', 'outside_target', 'unavailable', 'not_checked'].includes(observation.uia_focus.status as string) ||
    (observation.uia_focus.root_hwnd !== null && !hwnd(observation.uia_focus.root_hwnd)) ||
    (observation.uia_focus.has_keyboard_focus !== null && typeof observation.uia_focus.has_keyboard_focus !== 'boolean')) return false
  if (observation.win32_focus === 'confirmed' && (observation.foreground_hwnd !== expected.hwnd || observation.active_hwnd !== expected.hwnd ||
    observation.focus_root_hwnd !== expected.hwnd || observation.focus_hwnd === null)) return false
  // has_keyboard_focus may be false or null on a confirmed root: Office reports false on its own focused element.
  if (observation.uia_focus.status === 'confirmed' && observation.uia_focus.root_hwnd !== expected.hwnd) return false
  if (['unavailable', 'not_checked'].includes(observation.uia_focus.status as string) && (observation.uia_focus.root_hwnd !== null || observation.uia_focus.has_keyboard_focus !== null)) return false
  return value.focus_confirmed === (value.status === 'focused') &&
    (value.status !== 'focused' || (object(target) && target.visible === true && target.minimized === false && target.foreground === true && target.enabled === true && target.cloaked === false &&
      observation.win32_focus === 'confirmed' && observation.uia_focus.status === 'confirmed')) &&
    (value.status !== 'foreground_only' || (object(target) && target.foreground === true && observation.foreground_hwnd === target.hwnd)) &&
    (value.status !== 'stale' || (target === null && !value.identity_verified))
}

export function validateWindowsWindowPage(value: unknown, request: { query: string; pid: number | null; include_hidden: boolean; limit: number }, now = Date.now()): value is WindowsWindowPage {
  if (!object(value) || !fields(value, ['snapshot_id', 'collected_at', 'expires_at', 'query', 'pid', 'include_hidden', 'windows', 'total_matches', 'has_more', 'next_cursor', 'complete', 'limitations']) ||
    !id(value.snapshot_id, 'wset_') || !time(value.collected_at) || !time(value.expires_at) || Date.parse(value.expires_at) <= now ||
    Date.parse(value.expires_at) <= Date.parse(value.collected_at) || Date.parse(value.expires_at) - Date.parse(value.collected_at) > 15 * 60_000 + 1 || Date.parse(value.collected_at) > now + 5000 ||
    value.query !== request.query || value.pid !== request.pid || value.include_hidden !== request.include_hidden ||
    !Array.isArray(value.windows) || value.windows.length > request.limit || !number(value.total_matches, value.windows.length, 512) ||
    typeof value.has_more !== 'boolean' || (value.has_more ? !id(value.next_cursor, 'wcur_') || value.windows.length === 0 || value.total_matches <= value.windows.length : value.next_cursor !== null) ||
    typeof value.complete !== 'boolean' || !Array.isArray(value.limitations) || !unique(value.limitations) || value.limitations.length > 4 ||
    value.limitations.some(reason => !['enumeration_limited', 'metadata_unavailable', 'lifetime_unavailable', 'window_changed'].includes(reason)) ||
    (value.complete && value.limitations.length > 0)) return false
  const rows = value.windows
  if (!unique(rows.map(row => object(row) ? row.hwnd : null)) || !unique(rows.filter(row => object(row) && row.window_id !== null).map(row => row.window_id))) return false
  if (!rows.every(row => object(row) && fields(row, ['window_id', 'hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name', 'title', 'application', 'visible', 'minimized', 'foreground', 'enabled', 'cloaked', 'owner_hwnd', 'owner_window_id', 'identity_verified', 'identity_status', 'bounds']) &&
    (row.bounds === null || (object(row.bounds) && fields(row.bounds, ['x', 'y', 'width', 'height']) && number(row.bounds.x, -1_000_000, 1_000_000) &&
      number(row.bounds.y, -1_000_000, 1_000_000) && number(row.bounds.width, 1, 32768) && number(row.bounds.height, 1, 32768))) &&
    hwnd(row.hwnd) && number(row.pid, 1, 0xffffffff) && (request.pid === null || row.pid === request.pid) && number(row.thread_id, 1, 0xffffffff) &&
    (row.process_started_at === null || time(row.process_started_at)) && string(row.class_name, 256, true) && string(row.title, 256, true) &&
    object(row.application) && fields(row.application, ['name', 'executable_path', 'app_user_model_id']) &&
    (row.application.name === null || string(row.application.name, 200)) && (row.application.executable_path === null || localExecutablePath(row.application.executable_path)) &&
    (row.application.app_user_model_id === null || string(row.application.app_user_model_id, 512)) &&
    ['visible', 'minimized', 'foreground', 'enabled', 'identity_verified'].every(key => typeof row[key] === 'boolean') &&
    (row.cloaked === null || typeof row.cloaked === 'boolean') && (request.include_hidden || row.visible || row.minimized) &&
    (row.owner_hwnd === null || (hwnd(row.owner_hwnd) && row.owner_hwnd !== row.hwnd)) &&
    (row.owner_window_id === null || id(row.owner_window_id, 'win_')) &&
    (row.identity_verified ? id(row.window_id, 'win_') && time(row.process_started_at) && !!row.class_name && row.identity_status === 'verified'
      : row.window_id === null && ['process_unavailable', 'lifetime_unavailable', 'changed'].includes(row.identity_status as string)))) return false
  return rows.every(row => row.owner_window_id === null || rows.some(owner => owner.window_id === row.owner_window_id && owner.hwnd === row.owner_hwnd && owner.identity_verified)) &&
    (!value.complete || rows.every(row => row.identity_verified))
}

export function validateInspectInteractionsParameters(p: Record<string, unknown>): string | null {
  return Object.keys(p).some(k => !['window_id', 'limit'].includes(k)) || !id(p.window_id, 'win_') || p.limit !== undefined && !number(p.limit, 1, 16)
    ? 'inspect_interactions 只接受当前普通业务窗口的 window_id 和 1—16 的 limit，不接受原生句柄、脚本、路径或确认指令。' : null
}
export function validateWindowsInteractions(value: unknown, expected: DesktopWindow, snapshotId: string, limit: number, now: number): value is WindowsInteractions {
  if (!object(value) || !fields(value, ['snapshot_id', 'parent_window_id', 'before_at', 'observed_at', 'expires_at', 'parent', 'windows', 'menu', 'complete', 'limitations', 'snapshot_atomic', 'input_ready', 'goal_verified']) ||
    value.snapshot_id !== snapshotId || value.parent_window_id !== expected.window_id || !time(value.before_at) || !time(value.observed_at) || !time(value.expires_at) ||
    Date.parse(value.before_at) > Date.parse(value.observed_at) || Date.parse(value.observed_at) > now + 5000 || now - Date.parse(value.before_at) > 120000 ||
    Date.parse(value.expires_at) <= now || Date.parse(value.expires_at) - Date.parse(value.before_at) > 15 * 60_000 + 1 || Date.parse(value.expires_at) <= Date.parse(value.observed_at) ||
    !object(value.parent) || ['window_id', 'hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name'].some(k => (value.parent as Record<string, unknown>)[k] !== expected[k as keyof DesktopWindow]) ||
    !Array.isArray(value.windows) || value.windows.length > limit || value.snapshot_atomic !== false || value.input_ready !== false || value.goal_verified !== false ||
    typeof value.complete !== 'boolean' || !Array.isArray(value.limitations) || !unique(value.limitations) || value.limitations.length > 4 ||
    value.limitations.some(r => !['enumeration_incomplete', 'limit_reached', 'modality_unavailable', 'menu_unavailable'].includes(r)) || value.complete !== (value.limitations.length === 0)) return false
  const entries = value.windows
  if (entries.some(r => !object(r) || !fields(r, ['kind', 'is_modal', 'owner_chain', 'window']) || !['dialog', 'owned_window', 'menu'].includes(r.kind as string) ||
    r.is_modal !== null && typeof r.is_modal !== 'boolean' || !Array.isArray(r.owner_chain) || r.owner_chain.length > 8 || !unique(r.owner_chain) || r.owner_chain.some(h => !hwnd(h)) || !object(r.window))) return false
  const rows = [value.parent, ...entries.map(r => r.window)]
  const syntheticPage = { snapshot_id: snapshotId, collected_at: value.before_at, expires_at: value.expires_at, query: '', pid: null, include_hidden: true,
    windows: rows, total_matches: rows.length, has_more: false, next_cursor: null, complete: false, limitations: [] }
  if (!validateWindowsWindowPage(syntheticPage, { query: '', pid: null, include_hidden: true, limit: limit + 1 }, now) || rows.some(r => !r.identity_verified)) return false
  const menu = value.menu
  if (!object(menu) || !fields(menu, ['active', 'mode', 'flags', 'owner_hwnd', 'root_hwnd', 'owner_window_id', 'keyboard_window_id']) || typeof menu.active !== 'boolean' || !['none', 'popup', 'owner', 'unavailable'].includes(menu.mode as string) || !number(menu.flags, 0, 31) ||
    ['owner_hwnd', 'root_hwnd'].some(k => menu[k] !== null && !hwnd(menu[k])) || ['owner_window_id', 'keyboard_window_id'].some(k => menu[k] !== null && !id(menu[k], 'win_')) ||
    menu.active !== ((menu.flags & 0x1c) !== 0 && menu.owner_hwnd !== null)) return false
  const menus = entries.filter(r => r.kind === 'menu'), anchor = rows.find(r => r.window_id === menu.owner_window_id)
  if (!menu.active && (menus.length > 0 || menu.owner_window_id !== null || menu.keyboard_window_id !== null) ||
    menu.owner_window_id !== null && (!anchor || anchor.hwnd !== menu.root_hwnd || !anchor.foreground || entries.some(r => r.window.window_id === menu.owner_window_id && r.kind === 'menu')) ||
    (menus.length > 0 ? menu.mode !== 'popup' || !anchor || !menus.some(r => r.window.window_id === menu.keyboard_window_id) : menu.mode === 'popup') ||
    menu.mode === 'owner' && (!menu.active || !anchor || menu.keyboard_window_id !== menu.owner_window_id) ||
    menu.mode === 'unavailable' && (!menu.active || menu.keyboard_window_id !== null || !value.limitations.includes('menu_unavailable')) ||
    menu.mode === 'none' && menu.active || !menu.active && menu.mode !== 'none') return false
  for (const entry of entries) {
    const w = entry.window
    if (!w.visible || w.cloaked !== false) return false
    if (entry.kind === 'menu') {
      if (!menu.active || !anchor || w.class_name !== '#32768' || !w.enabled || w.pid !== anchor.pid || w.thread_id !== anchor.thread_id || entry.owner_chain.length !== 0 || entry.is_modal !== null) return false
    } else {
      if (w.class_name === '#32768' || (entry.kind === 'dialog') !== (w.class_name === '#32770') || entry.is_modal === null && !value.limitations.includes('modality_unavailable')) return false
      let row = w
      for (let i = 0; i < entry.owner_chain.length; i++) {
        if (entry.owner_chain[i] !== row.owner_hwnd || row.owner_hwnd === w.hwnd) return false
        const owner = rows.find(r => r.hwnd === row.owner_hwnd)
        if (!owner || row.owner_window_id !== owner.window_id || owner.hwnd === expected.hwnd && i !== entry.owner_chain.length - 1) return false
        row = owner
      }
      if (entry.owner_chain.length === 0 || row.hwnd !== expected.hwnd) return false
    }
  }
  return true
}
interface Binding { key: string; scopeId: string; generation: number; pageId: string | null; expires: number; revision: number; windows: Map<string, DesktopWindow>
  related: Map<string, { parentId: string; expires: number; kind: 'dialog' | 'owned_window' | 'menu' }>; menuOwners: Map<string, { parentId: string; expires: number }> }

/** Learned references are private to one tool registration, task and helper incarnation. Native must revalidate before any later action. */
export class WindowsWindowCatalog {
  private readonly bindings = new Map<ComputerUseTool, Binding>()
  private readonly unregister = new Map<ComputerUseTool, () => void>()
  private readonly unsubscribe: () => void
  private disposed = false
  constructor(private readonly helper: WindowsHelperManager, private readonly now: () => number = Date.now, private readonly uuid: () => string = randomUUID) {
    this.unsubscribe = helper.subscribe(() => {
      const state = helper.getState()
      for (const [tool, binding] of this.bindings) if (state.phase !== 'ready' || state.generation !== binding.generation) this.bindings.delete(tool)
    })
  }
  register(tool: ComputerUseTool): () => void {
    if (this.disposed) throw new Error('windows-window-catalog-disposed')
    const remove = tool.register(LIST_WINDOWS_DEFINITION, { validate: validateListWindowsParameters, execute: (p, context) => this.list(tool, p, context) })
    let removeFocus: (() => void) | undefined, removeInteractions: (() => void) | undefined
    try {
      removeFocus = tool.register(FOCUS_WINDOW_DEFINITION, { validate: validateFocusWindowParameters, execute: (p, context) => this.focus(tool, p, context) })
      removeInteractions = tool.register(INSPECT_INTERACTIONS_DEFINITION, { validate: validateInspectInteractionsParameters, execute: (p, context) => this.inspect(tool, p, context) })
    } catch (error) { removeInteractions?.(); removeFocus?.(); remove(); throw error }
    let removed = false
    const cleanup = (): void => { if (removed) return; removed = true; removeInteractions?.(); removeFocus?.(); remove(); this.bindings.delete(tool); this.unregister.delete(tool) }
    this.unregister.set(tool, cleanup)
    return cleanup
  }
  dispose(): void { this.disposed = true; for (const cleanup of [...this.unregister.values()]) cleanup(); this.bindings.clear(); this.unsubscribe() }

  /** This lookup alone never authorizes an input: pass its private scope and ID to native WindowCatalog.Resolve. */
  lookup(tool: ComputerUseTool, windowId: string, context: ComputerUseDispatchContext): { scope_id: string; window: DesktopWindow } | null {
    const binding = this.bindings.get(tool), state = this.helper.getState()
    if (!binding || this.disposed || state.phase !== 'ready' || state.generation !== binding.generation || binding.expires <= this.now()) {
      this.bindings.delete(tool); return null
    }
    if (!this.current(context) || binding.key !== this.key(context)) return null
    for (const [id, related] of binding.related) if (related.expires <= this.now()) { binding.windows.delete(id); binding.related.delete(id) }
    for (const [id, r] of binding.menuOwners) if (r.expires <= this.now() || !binding.windows.has(id)) binding.menuOwners.delete(id)
    const window = binding.windows.get(windowId)
    return window ? { scope_id: binding.scopeId, window: structuredClone(window) } : null
  }
  interactionContext(tool: ComputerUseTool, windowId: string, context: ComputerUseDispatchContext): { parent_window_id: string; kind: string } | null {
    if (!this.lookup(tool, windowId, context)) return null
    const binding = this.bindings.get(tool), menu = binding?.menuOwners.get(windowId)
    if (menu) return { parent_window_id: menu.parentId, kind: 'menu_owner' }
    const r = binding?.related.get(windowId)
    return r ? { parent_window_id: r.parentId, kind: r.kind } : null
  }
  private key(context: ComputerUseDispatchContext): string | null {
    const lease = context.lease, capability = context.capability()
    return lease && [lease.sessionId, lease.platformId, lease.conversationId, lease.taskId].every(v => string(v, 512)) && number(lease.generation, 1, Number.MAX_SAFE_INTEGER) &&
      lease.sessionId === capability.context.sessionId && lease.platformId === capability.context.platformId
      ? JSON.stringify([lease.sessionId, lease.platformId, lease.conversationId, lease.taskId, lease.generation]) : null
  }
  private current(context: ComputerUseDispatchContext): boolean {
    return !this.disposed && context.isCurrent() && !context.signal?.aborted && context.capability().enabled && this.key(context) !== null
  }
  beginWait(tool: ComputerUseTool, context: ComputerUseDispatchContext): WaitWindowLease {
    if (!this.current(context) || !this.unregister.has(tool)) throw new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '等待需要当前已登记的窗口工具与任务。' })
    const generation = this.helper.getState().generation, key = this.key(context)!
    let owner = this.bindings.get(tool)
    if (!owner || owner.key !== key || owner.generation !== generation || owner.expires <= this.now()) {
      owner = { key, generation, scopeId: 'ws_' + this.uuid().replaceAll('-', ''), pageId: null, expires: Infinity, revision: 0, windows: new Map(), related: new Map(), menuOwners: new Map() }
      this.bindings.set(tool, owner)
    }
    const saved = owner, revision = ++saved.revision
    const current = (): boolean => this.current(context) && this.key(context) === key && this.bindings.get(tool) === saved && saved.key === key && saved.revision === revision &&
      this.helper.getState().generation === generation && this.helper.getState().phase === 'ready' && saved.expires > this.now()
    return { scope_id: saved.scopeId, generation, isCurrent: current, publish: (probe: WaitProbe): boolean => {
      if (!current() || saved.pageId !== null && saved.pageId !== probe.snapshot_id || !id(probe.snapshot_id, 'wset_') ||
        !time(probe.scope_expires_at) || Date.parse(probe.scope_expires_at) <= this.now() || Date.parse(probe.scope_expires_at) > this.now() + 15 * 60_000 + 5000 || saved.expires !== Infinity && Date.parse(probe.scope_expires_at) < saved.expires) return false
      const w = probe.window, previous = w?.window_id ? saved.windows.get(w.window_id) : null
      if (w && (!w.window_id || saved.windows.size >= 608 && !previous || previous && ['hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name'].some(k => previous[k as keyof DesktopWindow] !== w[k as keyof DesktopWindow]))) return false
      saved.pageId = probe.snapshot_id; saved.expires = Date.parse(probe.scope_expires_at)
      if (w?.window_id) saved.windows.set(w.window_id, structuredClone(w))
      return true
    } }
  }
  private async inspect(tool: ComputerUseTool, p: Record<string, unknown>, context: ComputerUseDispatchContext): Promise<{ message: string; data: WindowsInteractions }> {
    const learned = this.lookup(tool, p.window_id as string, context), owner = this.bindings.get(tool)
    if (!learned || !owner?.pageId) throw new ComputerUseActionError({ code: 'stale_window', execution: 'not_executed', message: '交互发现需要当前任务中已发现的业务窗口，请先 list_windows。' })
    if (owner.related.get(p.window_id as string)?.kind === 'menu') throw new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: '请检查菜单来源的 parent_window_id，不检查菜单自身。' })
    for (const [id, r] of owner.related) if (r.parentId === p.window_id) { owner.windows.delete(id); owner.related.delete(id) }
    for (const [id, r] of owner.menuOwners) if (r.parentId === p.window_id || id === p.window_id || !owner.windows.has(id)) owner.menuOwners.delete(id)
    const revision = ++owner.revision, generation = owner.generation, key = owner.key, limit = Number(p.limit ?? 8)
    const response = await this.helper.request('inspect_interactions', { scope_id: owner.scopeId, window_id: p.window_id, limit },
      { signal: context.signal, expectedGeneration: generation, timeoutMs: 20_000 })
    throwIfDesktopInterrupted(response)
    if (!this.current(context) || this.key(context) !== key || this.bindings.get(tool) !== owner || owner.revision !== revision ||
      this.helper.getState().generation !== generation || this.helper.getState().phase !== 'ready')
      throw new ComputerUseActionError({ code: 'inactive_context', execution: response.execution, message: '原交互发现任务或 helper 已失效，未登记返回引用。', data: { helper_code: response.code } })
    if (!response.ok) throw new ComputerUseActionError({ code: response.code === 'cancelled' ? 'cancelled' : response.code === 'stale_window' ? 'stale_window' : response.code === 'window_blocked' ? 'window_blocked' : response.code === 'invalid_parameters' ? 'invalid_parameters' : 'unavailable',
      execution: response.execution, message: response.message, data: { helper_code: response.code } })
    if (response.code !== 'ok' || response.execution !== 'executed' || !validateWindowsInteractions(response.data, learned.window, owner.pageId, limit, this.now()) ||
      Date.parse(response.data.expires_at) > owner.expires || response.data.windows.some(r => owner.windows.has(r.window.window_id!)) || owner.related.size + response.data.windows.length > 64 || owner.windows.size + response.data.windows.length > 608)
      throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '交互关系、窗口身份或有效期未通过主进程校验，未登记新引用。' })
    const data = response.data
    owner.windows.set(data.parent_window_id, structuredClone(data.parent))
    for (const r of data.windows) {
      owner.windows.set(r.window.window_id!, structuredClone(r.window))
      owner.related.set(r.window.window_id!, { parentId: data.parent_window_id, expires: r.kind === 'menu' ? Math.min(Date.parse(data.before_at) + 30_000, Date.parse(data.expires_at)) : Date.parse(data.expires_at), kind: r.kind })
    }
    if (data.menu.mode === 'owner') owner.menuOwners.set(data.menu.owner_window_id!, { parentId: data.parent_window_id, expires: Math.min(Date.parse(data.before_at) + 30_000, Date.parse(data.expires_at)) })
    return { message: response.message, data: structuredClone(data) }
  }
  private async focus(tool: ComputerUseTool, parameters: Record<string, unknown>, context: ComputerUseDispatchContext): Promise<{ message: string; data: WindowsWindowFocusResult }> {
    if (!this.current(context)) throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: 'not_executed', message: '窗口激活上下文已失效，本次未派发。' })
    const learned = this.lookup(tool, parameters.window_id as string, context), owner = this.bindings.get(tool)
    if (!learned || !owner?.pageId) throw new ComputerUseActionError({ code: 'stale_window', execution: 'not_executed', message: '窗口引用未在当前任务中发现或已过期，请重新 list_windows。' })
    const key = owner.key, revision = owner.revision, snapshotId = owner.pageId, generation = owner.generation
    const response = await this.helper.request('focus_window', { scope_id: learned.scope_id, window_id: parameters.window_id, restore: parameters.restore ?? true, wait_ms: parameters.wait_ms ?? 1500 },
      { signal: context.signal, timeoutMs: 15_000, expectedGeneration: generation })
    throwIfDesktopInterrupted(response)
    if (!this.current(context) || this.key(context) !== key || this.bindings.get(tool) !== owner || owner.revision !== revision) {
      throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: response.execution,
        message: '原窗口激活上下文已结束；已派发的恢复或激活不能据此视为撤销，未更新新任务引用。', data: { helper_code: response.code } })
    }
    const hasData = response.data !== undefined && response.data !== null
    const statusCodes: Record<WindowsWindowFocusResult['status'], string[]> = { focused: ['ok'], foreground_only: ['focus_unconfirmed'], denied: ['focus_denied'],
      blocked: ['window_blocked'], restore_required: ['restore_required'], stale: ['stale_window'], cancelled: ['cancelled'], unknown: ['executor_error', 'unavailable'] }
    if ((response.ok || hasData) && (this.helper.getState().phase !== 'ready' || this.helper.getState().generation !== generation ||
      !validateWindowsWindowFocusResult(response.data, snapshotId, learned.window) ||
      !statusCodes[response.data.status].includes(response.code) ||
      (response.ok && (response.execution !== 'executed' || response.data.status !== 'focused' || !response.data.focus_confirmed)) ||
      (!response.ok && response.data.status === 'focused') ||
      (response.execution === 'not_executed' && (response.data.restore.attempted || response.data.activation_attempts.length > 0)))) {
      owner.windows.delete(learned.window.window_id!)
      throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '激活结果未通过主进程校验，焦点是否已改变尚未确认；请重新观察窗口，不要直接输入。' })
    }
    if (hasData && response.data && typeof response.data === 'object') {
      const data = response.data as WindowsWindowFocusResult
      if (data.status === 'stale') owner.windows.delete(learned.window.window_id!)
      else if (data.target && data.identity_verified) owner.windows.set(learned.window.window_id!, { ...learned.window, ...data.target, owner_window_id: null })
    }
    if (!response.ok) {
      if (response.code === 'stale_window') owner.windows.delete(learned.window.window_id!)
      const code = response.code === 'stale_window' ? 'stale_window' : response.code === 'invalid_parameters' ? 'invalid_parameters' : response.code === 'cancelled' ? 'cancelled'
        : response.code === 'focus_denied' ? 'focus_denied' : response.code === 'focus_unconfirmed' ? 'focus_unconfirmed' : response.code === 'window_blocked' ? 'window_blocked'
          : response.code === 'restore_required' ? 'restore_required' : response.execution === 'not_executed' ? 'unavailable' : 'executor_error'
      throw new ComputerUseActionError({ code, execution: response.execution, message: response.message, data: { helper_code: response.code, ...(hasData ? { focus: response.data } : {}) } })
    }
    return { message: response.message, data: structuredClone(response.data as WindowsWindowFocusResult) }
  }
  private async list(tool: ComputerUseTool, parameters: Record<string, unknown>, context: ComputerUseDispatchContext): Promise<{ message: string; data: WindowsWindowPage }> {
    if (!this.current(context)) {
      if (this.bindings.get(tool)?.key === this.key(context)) this.bindings.delete(tool)
      throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: 'not_executed', message: '窗口查询需要当前真实任务上下文，本次未采集。' })
    }
    const key = this.key(context)!, generation = this.helper.getState().generation
    let binding = this.bindings.get(tool)
    if (!binding || binding.key !== key || binding.generation !== generation || binding.expires <= this.now()) {
      if (parameters.cursor !== undefined) { if (binding?.key === key) this.bindings.delete(tool); throw new ComputerUseActionError({ code: 'stale_window', execution: 'not_executed', message: '窗口分页已过期或不属于当前任务，请重新 list_windows。' }) }
      binding = { key, generation, scopeId: 'ws_' + this.uuid().replaceAll('-', ''), pageId: null, expires: Infinity, revision: 0, windows: new Map(), related: new Map(), menuOwners: new Map() }
      this.bindings.set(tool, binding)
    }
    const owner = binding
    const revision = ++owner.revision
    if (parameters.cursor === undefined) { owner.windows.clear(); owner.related.clear(); owner.menuOwners.clear(); owner.pageId = null }
    const request = { query: typeof parameters.query === 'string' ? parameters.query.trim() : '', pid: typeof parameters.pid === 'number' ? parameters.pid : null,
      include_hidden: parameters.include_hidden === true, limit: typeof parameters.limit === 'number' ? parameters.limit : 25 }
    const response = await this.helper.request('list_windows', { ...request, ...(parameters.cursor !== undefined ? { cursor: parameters.cursor } : {}), scope_id: owner.scopeId },
      { signal: context.signal, timeoutMs: 15_000, expectedGeneration: generation })
    throwIfDesktopInterrupted(response)
    if (!this.current(context) || this.key(context) !== key || this.bindings.get(tool) !== owner || owner.revision !== revision) {
      if (this.bindings.get(tool) === owner && owner.revision === revision) this.bindings.delete(tool)
      throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: response.execution, message: '原窗口查询上下文已结束，未登记返回引用。', data: { helper_code: response.code } })
    }
    if (!response.ok) {
      this.bindings.delete(tool)
      const code = response.code === 'stale_window' ? 'stale_window' : response.code === 'invalid_parameters' ? 'invalid_parameters' : response.code === 'cancelled' ? 'cancelled'
        : response.execution === 'not_executed' ? 'unavailable' : 'executor_error'
      throw new ComputerUseActionError({ code, execution: response.execution, message: response.message, data: { helper_code: response.code } })
    }
    if (this.helper.getState().phase !== 'ready' || this.helper.getState().generation !== generation || response.execution !== 'executed' ||
      !validateWindowsWindowPage(response.data, request, this.now()) || (parameters.cursor !== undefined && response.data.snapshot_id !== owner.pageId)) {
      this.bindings.delete(tool)
      throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '窗口返回内容未通过主进程校验，未登记引用，请重新查询。' })
    }
    const page = response.data
    owner.pageId = page.snapshot_id; owner.expires = Date.parse(page.expires_at)
    for (const row of page.windows) if (row.identity_verified && row.window_id) owner.windows.set(row.window_id, structuredClone(row))
    if (owner.windows.size > 608) { this.bindings.delete(tool); throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '窗口引用数量异常，已清理本次引用。' }) }
    // Same-titled windows of one app (QQ: a 60×71 helper next to the chat window) are otherwise indistinguishable.
    const data = structuredClone(page)
    for (const row of data.windows) row.tiny = tinyWindow(row)
    const tiny = data.windows.filter(row => row.tiny).length
    return { message: tiny ? response.message + ` 其中 ${tiny} 个窗口宽或高不足 ${TINY_WINDOW_EDGE} 像素（tiny=true），通常是托盘、通知或辅助窗口；同名窗口请优先选择尺寸正常的。` : response.message, data }
  }
}
