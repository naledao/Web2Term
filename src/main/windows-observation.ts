import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, open, rm, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import type { TaskLease } from '../shared/autonomous-task'
import { TaskObservationPreviewCache } from './task-observation-preview'
import type { TaskObservationSummary } from '../shared/task-presentation'
import type { ComputerUseImageReference } from '../shared/computer-use'
import { OBSERVE_DEFINITION, validateObserveParameters } from '../shared/windows-observation'
import type { ObservationRect, WindowsObservation } from '../shared/windows-observation'
import { ComputerUseActionError, throwIfDesktopInterrupted } from './computer-use-tool'
import type { ComputerUseDispatchContext, ComputerUseTool } from './computer-use-tool'
import type { WindowsHelperManager } from './windows-helper'
import type { WindowsWindowCatalog } from './windows-window-catalog'
import type { DesktopWindow } from '../shared/windows-desktop'
import type { PreparedAttachment } from './file-access'
import { validateControlTree, validateControlsOnly } from './windows-control-tree'
import type { ControlsOnlyObservation } from './windows-control-tree'
import { VALIDATE_OBSERVATION_DEFINITION, validateObservationCheckParameters, OBSERVATION_STALE_REASONS } from '../shared/windows-observation-binding'
import { validCoordinateContext, resolveImagePoint, matchesImagePointResolution } from '../shared/windows-coordinates'
import { CLICK_DEFINITION, validateClickParameters } from '../shared/windows-click'
import { validateWindowsClickReceipt } from './windows-click'
import { TYPE_TEXT_DEFINITION, validateTypeTextParameters } from '../shared/windows-type-text'
import { validateWindowsTypeTextReceipt } from './windows-type-text'
import { PRESS_KEY_DEFINITION, validatePressKeyParameters } from '../shared/windows-press-key'
import { validateWindowsPressKeyReceipt } from './windows-press-key'
import { SCROLL_DEFINITION, validateScrollParameters } from '../shared/windows-scroll'
import { validateWindowsScrollReceipt } from './windows-scroll'
import { DRAG_DEFINITION, validateDragParameters } from '../shared/windows-drag'
import type { DragPoint } from '../shared/windows-drag'
import { resolveDragPath, validateWindowsDragReceipt } from './windows-drag'
import { WAIT_FOR_DEFINITION, validateWaitParameters, evaluateWaitControls, isBackgroundWait } from '../shared/windows-wait'
import { pollWindowsWait, validateWaitProbe, windowsWaitClock } from './windows-wait'
import type { WindowsWaitClock, WaitProbe } from './windows-wait'
import type { ComputerUseToolResult } from '../shared/computer-use'
import type { WindowsHelperActionResult } from '../shared/windows-helper'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const integer = (v: unknown, low: number, high: number): v is number => Number.isSafeInteger(v) && Number(v) >= low && Number(v) <= high
const id = (v: unknown, prefix: string): v is string => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
const rect = (v: unknown): v is ObservationRect => object(v) && fields(v, ['x', 'y', 'width', 'height']) && integer(v.x, -1_000_000, 1_000_000) && integer(v.y, -1_000_000, 1_000_000) && integer(v.width, 1, 32768) && integer(v.height, 1, 32768)
const sameRect = (a: ObservationRect, b: ObservationRect): boolean => ['x', 'y', 'width', 'height'].every(k => a[k as keyof ObservationRect] === b[k as keyof ObservationRect])
const leaseKey = (lease: TaskLease): string => JSON.stringify([lease.sessionId, lease.platformId, lease.conversationId, lease.taskId, lease.generation])
const MAX_BYTES = 8 * 1024 * 1024
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
function validPng(bytes: Buffer, width: number, height: number): boolean {
  try {
    if (!bytes.subarray(24, 29).equals(Buffer.from([8, 2, 0, 0, 0]))) return false
    let offset = 8, compressed: Buffer | null = null
    for (const type of ['IHDR', 'IDAT', 'IEND']) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length
      if (end > bytes.length || bytes.toString('ascii', offset + 4, offset + 8) !== type || (type === 'IEND' && length !== 0)) return false
      let crc = 0xffffffff
      for (const value of bytes.subarray(offset + 4, end - 4)) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8)
      if (((~crc) >>> 0) !== bytes.readUInt32BE(end - 4)) return false
      if (type === 'IDAT') compressed = bytes.subarray(offset + 8, end - 4)
      offset = end
    }
    if (offset !== bytes.length || !compressed) return false
    const stride = width * 3 + 1, pixels = inflateSync(compressed, { maxOutputLength: stride * height })
    if (pixels.length !== stride * height) return false
    for (let row = 0; row < height; row++) if (pixels[row * stride] !== 0) return false
    return true
  } catch { return false }
}

/** Independently checks helper metadata and the actual PNG, before any image is made available to the page. */
export function validateWindowsObservation(value: unknown, p: Record<string, unknown>, selected: DesktopWindow | null, bytes: Buffer, now: number): value is WindowsObservation {
  if (!object(value) || !fields(value, ['observation_id', 'target', 'window_id', 'monitor_id', 'window_identity', 'before_at', 'captured_at', 'observed_at', 'source_bounds', 'source_size', 'crop', 'image', 'transform', 'monitors', 'coordinate_context', 'geometry_consistent', 'content_verified', 'input_ready', 'goal_verified', ...(p.include_controls === true ? ['controls'] : [])]) ||
      !id(value.observation_id, 'obs_') || value.target !== p.target || value.window_id !== (p.window_id ?? null) ||
      value.geometry_consistent !== true || value.content_verified !== false || value.input_ready !== false || value.goal_verified !== false ||
      !rect(value.source_bounds) || !rect(value.crop) || !object(value.source_size) || !fields(value.source_size, ['width', 'height']) ||
      value.source_size.width !== value.source_bounds.width || value.source_size.height !== value.source_bounds.height ||
      value.source_bounds.width * value.source_bounds.height > 32_000_000 ||
      value.crop.x < 0 || value.crop.y < 0 || value.crop.x + value.crop.width > value.source_bounds.width || value.crop.y + value.crop.height > value.source_bounds.height) return false
  const times = [value.before_at, value.captured_at, value.observed_at].map(v => typeof v === 'string' && v.length <= 64 ? Date.parse(v) : NaN)
  if (times.some(v => !Number.isFinite(v)) || times[0] > times[1] || times[1] > times[2] || times[2] > now + 10_000 || now - times[0] > 120_000) return false
  if (selected) {
    const w = value.window_identity
    if (value.monitor_id !== null || !object(w) || !fields(w, ['hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name']) ||
        !['hwnd', 'pid', 'process_started_at', 'thread_id', 'class_name'].every(k => w[k] === selected[k as keyof DesktopWindow])) return false
  } else if (value.window_identity !== null || !id(value.monitor_id, 'mon_') || (p.monitor_id !== undefined && value.monitor_id !== p.monitor_id)) return false
  const crop: ObservationRect = p.target === 'region' ? { x: p.x as number, y: p.y as number, width: p.width as number, height: p.height as number }
    : { x: 0, y: 0, width: value.source_bounds.width, height: value.source_bounds.height }
  if (!sameRect(value.crop, crop) || !object(value.image) || !fields(value.image, ['width', 'height', 'mime_type', 'size_bytes', 'sha256'])) return false
  const image = value.image, maximum = Number(p.max_dimension ?? 1600), scale = Math.min(1, maximum / Math.max(crop.width, crop.height))
  if (image.width !== Math.max(1, Math.floor(crop.width * scale)) || image.height !== Math.max(1, Math.floor(crop.height * scale)) ||
      image.mime_type !== 'image/png' || image.size_bytes !== bytes.length || bytes.length < 57 || bytes.length > MAX_BYTES ||
      image.sha256 !== createHash('sha256').update(bytes).digest('hex') || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height ||
      bytes[24] !== 8 || bytes[25] !== 2 || bytes.subarray(-8, -4).toString('ascii') !== 'IEND' || !validPng(bytes, Number(image.width), Number(image.height))) return false
  const t = value.transform
  if (!object(t) || !fields(t, ['origin_x', 'origin_y', 'scale_x', 'scale_y', 'coordinate_space', 'content_bounds', 'pixel_mapping']) || t.coordinate_space !== 'desktop_physical_pixels' ||
      t.pixel_mapping !== 'nearest_floor' || !rect(t.content_bounds) || !sameRect(t.content_bounds, { x: 0, y: 0, width: Number(image.width), height: Number(image.height) }) ||
      t.origin_x !== value.source_bounds.x + crop.x || t.origin_y !== value.source_bounds.y + crop.y ||
      t.scale_x !== crop.width / Number(image.width) || t.scale_y !== crop.height / Number(image.height)) return false
  if (!Array.isArray(value.monitors) || value.monitors.length < 1 || value.monitors.length > 16) return false
  const seen = new Set<string>()
  let primary = 0, found = false
  for (const monitor of value.monitors) {
    if (!object(monitor) || !fields(monitor, ['monitor_id', 'bounds', 'primary', 'dpi_x', 'dpi_y', 'scale_percent']) || !id(monitor.monitor_id, 'mon_') || seen.has(monitor.monitor_id) ||
        !rect(monitor.bounds) || typeof monitor.primary !== 'boolean' || (monitor.dpi_x !== null && !integer(monitor.dpi_x, 48, 960)) ||
        (monitor.dpi_y !== null && !integer(monitor.dpi_y, 48, 960)) || ((monitor.dpi_x === null) !== (monitor.dpi_y === null)) ||
        (monitor.scale_percent !== null && !integer(monitor.scale_percent, 50, 1000))) return false
    seen.add(monitor.monitor_id); if (monitor.primary) primary++
    if (monitor.monitor_id === value.monitor_id) { found = sameRect(monitor.bounds, value.source_bounds) && (p.monitor_id !== undefined || monitor.primary) }
  }
  if (p.include_controls === true && (!selected || !validateControlTree(value.controls, p, selected, now) ||
      !sameRect(value.controls.window_bounds, value.source_bounds) || Date.parse(value.controls.before_at) < times[2])) return false
  return primary === 1 && (!!selected || found) && validCoordinateContext(value.coordinate_context, value.monitors as WindowsObservation['monitors'], !!selected)
}

interface Artifact { tool: ComputerUseTool; owner: string; directory: string; attachment: PreparedAttachment; expires: number }
type ObservationData = WindowsObservation | ControlsOnlyObservation
interface BoundObservation {
  ids: string[]; elements: Set<string>; source: Record<string, unknown>; data: ObservationData
  step: string; digest: string; expires: number; windowScope: string | null
}
interface ObservationOwner { key: string; generation: number; scope: string; latest: BoundObservation | null }

/** Temporary image ownership stays in main; the model sees only opaque references and capture metadata. */
export class WindowsObservationService {
  private readonly display: TaskObservationPreviewCache
  private readonly artifacts = new Map<string, Artifact>()
  private readonly registrations = new Map<ComputerUseTool, () => void>()
  private readonly owners = new Map<ComputerUseTool, ObservationOwner>()
  private readonly sweep: ReturnType<typeof setInterval>
  private disposed = false
  constructor(private readonly helper: WindowsHelperManager, private readonly windows: WindowsWindowCatalog, private readonly now = Date.now, private readonly waitClock: WindowsWaitClock = windowsWaitClock) {
    this.display = new TaskObservationPreviewCache(now)
    this.sweep = setInterval(() => { for (const [id, item] of this.artifacts) if (item.expires <= this.now()) this.remove(id) }, 60_000)
    this.sweep.unref()
  }
  register(tool: ComputerUseTool): () => void {
    if (this.disposed) throw new Error('observation-service-disposed')
    const unregister = tool.register(OBSERVE_DEFINITION, { validate: validateObserveParameters, execute: (p, context) => this.observe(tool, p, context) })
    let unregisterCheck: (() => void) | undefined, unregisterClick: (() => void) | undefined, unregisterText: (() => void) | undefined, unregisterKey: (() => void) | undefined, unregisterScroll: (() => void) | undefined, unregisterDrag: (() => void) | undefined, unregisterWait: (() => void) | undefined
    try {
      unregisterCheck = tool.register(VALIDATE_OBSERVATION_DEFINITION, { validate: validateObservationCheckParameters, execute: (p, context) => this.check(tool, p, context) })
      unregisterClick = tool.register(CLICK_DEFINITION, { validate: validateClickParameters, execute: (p, context) => this.input(tool, p, context, 'click') })
      unregisterText = tool.register(TYPE_TEXT_DEFINITION, { validate: validateTypeTextParameters, execute: (p, context) => this.input(tool, p, context, 'type_text') })
      unregisterKey = tool.register(PRESS_KEY_DEFINITION, { validate: validatePressKeyParameters, execute: (p, context) => this.input(tool, p, context, 'press_key') })
      unregisterScroll = tool.register(SCROLL_DEFINITION, { validate: validateScrollParameters, execute: (p, context) => this.input(tool, p, context, 'scroll') })
      unregisterDrag = tool.register(DRAG_DEFINITION, { validate: validateDragParameters, execute: (p, context) => this.input(tool, p, context, 'drag') })
      unregisterWait = tool.register(WAIT_FOR_DEFINITION, { validate: validateWaitParameters, execute: (p, context) => this.wait(tool, p, context) })
    } catch (error) { unregisterWait?.(); unregisterDrag?.(); unregisterScroll?.(); unregisterKey?.(); unregisterText?.(); unregisterClick?.(); unregisterCheck?.(); unregister(); throw error }
    let removed = false
    const cleanup = (): void => {
      if (removed) return; removed = true; unregisterWait?.(); unregisterDrag?.(); unregisterScroll?.(); unregisterKey?.(); unregisterText?.(); unregisterClick?.(); unregisterCheck?.(); unregister(); this.registrations.delete(tool); this.owners.delete(tool)
      for (const [id, item] of this.artifacts) if (item.tool === tool) this.remove(id)
      this.display.removeOwner(tool)
    }
    this.registrations.set(tool, cleanup); return cleanup
  }
  private current(context: ComputerUseDispatchContext): context is ComputerUseDispatchContext & { lease: TaskLease } {
    const lease = context.lease, capability = context.capability()
    return !this.disposed && !!lease && !!context.step && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(context.step.id) &&
      id(context.step.token, 'cu_') && typeof context.step.sourceMessageId === 'string' && !!context.step.sourceMessageId && context.step.sourceMessageId.length <= 512 &&
      [lease.sessionId, lease.platformId, lease.conversationId, lease.taskId].every(v => typeof v === 'string' && !!v && v.length <= 512) &&
      integer(lease.generation, 1, Number.MAX_SAFE_INTEGER) && lease.sessionId === capability.context.sessionId && lease.platformId === capability.context.platformId &&
      context.isCurrent() && !context.signal?.aborted && capability.enabled && capability.available && capability.actions.includes('observe')
  }
  private owner(tool: ComputerUseTool, context: ComputerUseDispatchContext & { lease: TaskLease }): ObservationOwner {
    const key = leaseKey(context.lease), generation = this.helper.getState().generation
    let value = this.owners.get(tool)
    if (!value || value.key !== key || value.generation !== generation) {
      value = { key, generation, scope: 'os_' + randomUUID().replaceAll('-', ''), latest: null }; this.owners.set(tool, value)
    }
    return value
  }
  /** A target switch or terminal step revokes input bindings, while already prepared images can still be delivered. */
  invalidateInput(tool: ComputerUseTool, lease: TaskLease): void {
    const owner = this.owners.get(tool)
    if (owner?.key === leaseKey(lease)) owner.latest = null
  }
  invalidateAllInputs(): void { for (const owner of this.owners.values()) owner.latest = null }
  /** Viewing saved facts must never call helper.observe, extend a binding or consume a grant. */
  displaySummary(lease: TaskLease): TaskObservationSummary | null { return this.display.summary(lease) }
  displayImage(lease: TaskLease, observationId: string): string | null {
    const bytes = this.display.image(lease, observationId)
    return bytes ? 'data:image/png;base64,' + Buffer.from(bytes).toString('base64') : null
  }
  private recordDisplay(tool: ComputerUseTool, context: ComputerUseDispatchContext & { lease: TaskLease }, data: ObservationData, window: DesktopWindow | null, bytes: Buffer | null): void {
    try {
      const image = 'image' in data ? data.image : null
      this.display.record(tool, context.lease, { observationId: data.observation_id, stepId: context.step!.id, observedAt: 'observed_at' in data ? data.observed_at : data.controls.observed_at,
        target: data.target, windowTitle: window?.title ?? null, application: window?.application.name ?? null,
        width: image?.width ?? null, height: image?.height ?? null, previewAvailable: !!bytes,
        controls: data.controls ? { count: data.controls.elements.length, complete: data.controls.complete, focus: data.controls.focus.status } : null }, bytes)
    } catch { /* Optional display must not block execution or delivery. */ }
  }
  private bind(owner: ObservationOwner, data: ObservationData, p: Record<string, unknown>, context: ComputerUseDispatchContext, windowScope: string | null): ObservationData {
    const expires = this.now() + 120_000, step = context.step!.id, digest = createHash('sha256').update(context.step!.token!).digest('hex')
    const binding = { source_step_id: step, expires_at: new Date(expires).toISOString() }
    data.binding = binding
    if (data.controls) data.controls.binding = { ...binding }
    owner.latest = { ids: [...new Set([data.observation_id, ...(data.controls ? [data.controls.observation_id] : [])])],
      elements: new Set(data.controls?.elements.map(element => element.element_id) ?? []), source: structuredClone(p), data: structuredClone(data),
      expires, step, digest, windowScope }
    return data
  }
  private async wait(tool: ComputerUseTool, p: Record<string, unknown>, context: ComputerUseDispatchContext): Promise<{ message: string; data: unknown; attachments?: ComputerUseImageReference[] }> {
    if (!this.current(context) || !this.registrations.has(tool)) throw new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '条件等待需要当前真实任务与步骤来源。' })
    if (isBackgroundWait(p)) {
      if (!context.waitForBackground) throw new ComputerUseActionError({ code: 'unavailable', execution: 'not_executed', message: '当前会话未接入后台监控等待。' })
      return context.waitForBackground(p)
    }
    const selected = p.window_id ? this.windows.lookup(tool, p.window_id as string, context) : null
    if (p.window_id && !selected) throw new ComputerUseActionError({ code: 'stale_window', execution: 'not_executed', message: '等待窗口引用已失效，请重新发现，不选择其他窗口。' })
    const owner = this.owner(tool, context), lease = this.windows.beginWait(tool, context)
    owner.latest = null
    const active = (): boolean => this.current(context) && this.registrations.has(tool) && this.owners.get(tool) === owner && lease.isCurrent()
    let last: WaitProbe | undefined, checks = 0, waitStatus = 'failed', elapsed = 0, failure: { code: string; message: string } | undefined
    const progress = { execution: 'not_executed' as ComputerUseToolResult['execution'] }
    const started = this.waitClock.now()
    try {
      const result = await pollWindowsWait(p, async budget => {
        if (!active()) throw new Error('wait_context_inactive')
        const previousExecution = progress.execution; progress.execution = 'unknown'
        const response = await this.helper.request('wait_for', { scope_id: lease.scope_id, wait_id: context.step!.id, condition: p.condition,
          window_id: p.window_id ?? null, query: p.query ?? null, pid: p.pid ?? null, text: p.text ?? null,
          selector: p.selector ? { name: (p.selector as Record<string, unknown>).name, role: (p.selector as Record<string, unknown>).role ?? null } : null,
          budget_ms: Math.max(100, Math.min(500, budget)) }, { signal: context.signal, expectedGeneration: lease.generation, timeoutMs: budget })
        throwIfDesktopInterrupted(response)
        checks++
        progress.execution = previousExecution === 'unknown' || response.execution === 'unknown' ? 'unknown' : previousExecution === 'executed' || response.execution === 'executed' ? 'executed' : 'not_executed'
        if (!active()) throw new Error('wait_context_inactive')
        if (!response.ok) throw new ComputerUseActionError({ code: 'wait_failed', execution: response.execution, message: response.message, data: { helper_code: response.code } })
        if (response.code !== 'ok' || response.execution !== 'executed' || !validateWaitProbe(response.data, p, context.step!.id, selected?.window ?? null, this.now()) || !lease.publish(response.data))
          throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '条件检查的身份、谓词、证据或来源未通过独立校验。' })
        last = structuredClone(response.data); return last
      }, this.waitClock, active, context.signal)
      waitStatus = result.status; elapsed = result.elapsed_ms
    } catch (error) {
      elapsed = Math.max(0, Math.floor(this.waitClock.now() - started))
      failure = error instanceof ComputerUseActionError ? { code: error.result.code, message: error.result.message } : { code: 'wait_failed', message: '条件检查管道或等待已中断。' }
    }
    if (!active()) throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: progress.execution, message: '原等待任务或 helper 已失效，停止检查及后观察，未向新任务回传。' })
    const target = last?.window ?? selected?.window
    let after: Awaited<ReturnType<WindowsObservationService['observe']>> | undefined, observationError: unknown
    if (target?.window_id) {
      try { after = await this.observe(tool, { target: p.observation ?? 'controls', window_id: target.window_id,
        ...(p.observation === 'window' ? { include_controls: true } : {}), max_depth: 4, max_elements: 100, timeout_ms: 500 }, context)
        if (progress.execution !== 'unknown') progress.execution = 'executed'
      } catch (error) {
        const outcome = error instanceof ComputerUseActionError ? error.result.execution : 'unknown'
        if (outcome === 'unknown' || progress.execution !== 'unknown' && outcome === 'executed') progress.execution = outcome
        observationError = error instanceof ComputerUseActionError ? { code: error.result.code, execution: outcome, message: error.result.message } : { code: 'capture_failed', execution: outcome }
      }
    } else observationError = { code: 'target_unresolved', message: '未唯一定位窗口，最后发现状态见 last_check；未猜测来源或捕获整个桌面。' }
    if (!active()) { if (after?.attachments) this.release(after.attachments, context.lease); throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: progress.execution, message: '等待后观察的原任务已失效，未向新任务发布结果。' }) }
    let met = waitStatus === 'met' && !!after && !!last?.window
    if (met && p.condition !== 'window_present') {
      const tree = after!.data.controls, window = last!.window!
      const root = tree?.elements[0]
      met = !!tree && evaluateWaitControls(p, { ...window, enabled: typeof root?.enabled === 'boolean' ? root.enabled : window.enabled }, tree).status === 'met'
    }
    if (waitStatus === 'met' && !met) waitStatus = after ? 'changed' : 'observation_failed'
    const data = { condition: p.condition, condition_met: met, status: waitStatus, timeout_ms: p.timeout_ms ?? 10000, wait_elapsed_ms: elapsed, checks,
      last_check: last ? { status: last.status, matches: last.matches, checked_at: last.checked_at, complete: last.complete, limitations: last.limitations, revision: last.revision, window_id: last.window?.window_id ?? null } : null,
      ...(failure ? { check_error: failure } : {}), ...(after ? { observation: after.data } : { post_observation_error: observationError }), snapshot_atomic: false, input_ready: false, goal_verified: false }
    const message = met ? '条件在检查及结束后的新观察中得到支持；仅代表当前固定条件满足，业务目标仍需验证。'
      : waitStatus === 'timeout' ? '等待已到检查期限，未确认条件满足；请根据最后检查和新观察诊断或调整路径，不无界等待。'
        : waitStatus === 'ambiguous' ? '匹配目标不唯一，未任意选择；请进一步发现／观察并细化条件。' : '条件未能在新观察中确认，未执行桌面输入，请根据真实结果继续判断。'
    if (!met) throw new ComputerUseActionError({ code: waitStatus === 'timeout' ? 'wait_timeout' : waitStatus === 'ambiguous' ? 'wait_ambiguous' : 'wait_failed', execution: progress.execution, message, data, attachments: after?.attachments })
    return { message, data, attachments: after?.attachments }
  }
  private async input(tool: ComputerUseTool, p: Record<string, unknown>, context: ComputerUseDispatchContext, action: 'click' | 'type_text' | 'press_key' | 'scroll' | 'drag'): Promise<{ message: string; data: unknown; attachments?: ComputerUseImageReference[] }> {
    const typing = action === 'type_text', pressing = action === 'press_key', scrolling = action === 'scroll', dragging = action === 'drag'
    const blocked = dragging ? 'drag_blocked' : scrolling ? 'scroll_blocked' : pressing ? 'press_key_blocked' : typing ? 'type_text_blocked' : 'click_blocked', failed = dragging ? 'drag_failed' : scrolling ? 'scroll_failed' : pressing ? 'press_key_failed' : typing ? 'type_text_failed' : 'click_failed'
    if (!this.current(context) || !this.registrations.has(tool)) throw new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '输入操作需要当前真实任务、已占用步骤与工具上下文。' })
    const owner = this.owner(tool, context), saved = owner.latest
    if (!saved || !saved.ids.includes(p.observation_id as string)) throw new ComputerUseActionError({ code: 'stale_observation', execution: 'not_executed', message: '输入操作引用不属于当前任务最新观察，请重新 observe。' })
    if (!saved.source.window_id) throw new ComputerUseActionError({ code: blocked, execution: 'not_executed', message: '显示器概览不能直接作为输入目标，请发现、激活并观察业务窗口。' })
    if (dragging && (saved.data.target === 'controls' || !resolveDragPath(saved.data, p.path as DragPoint[])))
      throw new ComputerUseActionError({ code: blocked, execution: 'not_executed', message: '拖拽需要同组窗口图像中的完整有界可见轨迹，请观察业务窗口并重新规划。' })
    if (p.element_id !== undefined && !saved.elements.has(p.element_id as string) || p.x !== undefined && (saved.data.target === 'controls' || Number(p.x) >= saved.data.image.width || Number(p.y) >= saved.data.image.height))
      throw new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: '输入操作控件或图像点不属于该观察，未派发输入。' })
    if (typing || pressing && p.element_id !== undefined) {
      const row = saved.data.controls?.elements.find(row => row.element_id === p.element_id), focus = saved.data.controls?.focus
      if (!row?.properties_complete || row.focused !== true || row.enabled !== true || row.offscreen !== false ||
        focus?.status !== 'inside_target' || focus.element_id !== p.element_id || typing && (row.password === null || !['edit', 'document'].includes(row.role) && !row.patterns.includes('value')))
        throw new ComputerUseActionError({ code: blocked, execution: 'not_executed', message: '输入需要最近观察中已确认焦点和可用状态的目标控件，请由 AI 定位并重新观察。' })
    }
    let code: ComputerUseToolResult['code'] = 'stale_observation', execution: ComputerUseToolResult['execution'] = 'not_executed'
    let message = '旧观察或窗口引用已失效，未派发输入操作。', receipt: unknown
    let helperCode: string | null = null
    const interaction = this.windows.interactionContext?.(tool, saved.source.window_id as string, context)
    owner.latest = null // Consume the main-side reference before sending any mutating request, including uncertain replies.
    if (saved.expires > this.now() && this.windows.lookup(tool, saved.source.window_id as string, context)?.scope_id === saved.windowScope) {
      let response: WindowsHelperActionResult
      try { response = await this.helper.request(action, { binding_scope: owner.scope, source_step_id: saved.step, source_token_digest: saved.digest,
        request_id: context.step!.id, request_token_digest: createHash('sha256').update(context.step!.token!).digest('hex'),
        observation_id: p.observation_id,
        ...(dragging ? { path: p.path, button: p.button ?? 'left', duration_ms: p.duration_ms ?? 600 } : { element_id: p.element_id ?? null,
          ...(scrolling ? { x: p.x ?? null, y: p.y ?? null, direction: p.direction, amount: p.amount ?? 3 } : pressing ? { key: p.key } : typing ? { text: p.text, mode: p.mode ?? 'insert' } : { x: p.x ?? null, y: p.y ?? null, button: p.button ?? 'left', click_count: p.click_count ?? 1, method: p.method ?? 'auto' }) })
      }, { signal: context.signal, expectedGeneration: owner.generation, timeoutMs: typing ? 60_000 : dragging ? 30_000 : 20_000 }) }
      catch { response = { ok: false, execution: 'unknown', code: 'executor_error', message: '输入操作管道结果异常，实际输入需先观察确认。' } }
      throwIfDesktopInterrupted(response)
      helperCode = response.code
      if (!this.current(context) || this.owners.get(tool) !== owner || !this.registrations.has(tool))
        throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: response.execution, message: '原输入操作任务已结束；已派发输入不会回滚或重放，未发布到新任务。', data: { helper_code: response.code } })
      if (this.helper.getState().generation !== owner.generation || this.helper.getState().phase !== 'ready')
        throw new ComputerUseActionError({ code: failed, execution: response.execution === 'not_executed' ? 'not_executed' : 'unknown', message: 'helper 已停止或更换，输入结果需重新发现并观察核对，不自动重放。', data: { helper_code: response.code } })
      const valid = dragging ? validateWindowsDragReceipt(response.data, p, saved.data, context.step!.id, saved.step, response, this.now())
        : scrolling ? validateWindowsScrollReceipt(response.data, p, saved.data, context.step!.id, saved.step, response, this.now())
        : pressing ? validateWindowsPressKeyReceipt(response.data, p, saved.data, context.step!.id, saved.step, response, this.now())
        : typing ? validateWindowsTypeTextReceipt(response.data, p, saved.data, context.step!.id, saved.step, response, this.now())
        : validateWindowsClickReceipt(response.data, p, saved.data, context.step!.id, saved.step, response, this.now())
      if (!valid) {
        // A contradictory/malformed receipt cannot establish that no input occurred, even if its execution field says so.
        code = 'invalid_result'; execution = 'unknown'; message = '输入操作回执未通过独立校验；输入是否生效需先看新观察，不得据此重复输入操作。'
        receipt = { result_unconfirmed: true }
      } else { code = response.code as ComputerUseToolResult['code']; execution = response.execution; message = response.message; receipt = structuredClone(response.data) }
    }
    let after: Awaited<ReturnType<WindowsObservationService['observe']>> | undefined, observationError: unknown
    // Exactly one read after the attempt, including uncertain input. It never calls the input action again.
    try { after = await this.observe(tool, saved.source, context) }
    catch (error) { observationError = error instanceof ComputerUseActionError ? { code: error.result.code, execution: error.result.execution, message: error.result.message } : { code: 'capture_failed' } }
    if (!this.current(context) || this.owners.get(tool) !== owner || this.helper.getState().generation !== owner.generation || !this.registrations.has(tool)) {
      if (after?.attachments) this.release(after.attachments, context.lease)
      throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution, message: '输入操作后的原任务或 helper 已失效，未向新任务发布结果；不重放输入操作。' })
    }
    const data = { ...(helperCode ? { helper_code: helperCode } : {}), ...(receipt === undefined ? { action_not_executed: true } : { [action]: receipt }),
      ...(after ? { observation: after.data } : { post_observation_error: observationError }),
      ...(interaction ? { interaction_hint: { ...interaction, next_action: 'inspect_interactions' } } : {}), goal_verified: false }
    message += after ? ' 已补取操作后的新观察，请据此判断下一步。' : ' 本次后续观察失败，请先重新发现／观察；不要为补截图重做输入操作。'
    if (code !== 'ok') throw new ComputerUseActionError({ code, execution, message, data, attachments: after?.attachments })
    return { message, data, attachments: after?.attachments }
  }
  private async check(tool: ComputerUseTool, p: Record<string, unknown>, context: ComputerUseDispatchContext): Promise<{ message: string; data: unknown }> {
    if (!this.current(context) || !this.registrations.has(tool)) throw new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '观察复核需要当前真实任务和步骤来源。' })
    const owner = this.owner(tool, context), saved = owner.latest
    if (!saved || !saved.ids.includes(p.observation_id as string)) throw new ComputerUseActionError({ code: 'stale_observation', execution: 'not_executed',
      message: '该观察不属于当前任务最近一次观察，请重新 observe。', data: { reason: 'unknown_observation', action_not_executed: true, input_ready: false } })
    if (p.element_id !== undefined && !saved.elements.has(p.element_id as string)) throw new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: '控件编号不属于此观察，请使用本轮真实控件编号。' })
    if (p.x !== undefined && (saved.data.target === 'controls' || Number(p.x) >= saved.data.image.width || Number(p.y) >= saved.data.image.height))
      throw new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: '坐标必须位于此观察实际上传的图像内。' })
    let validation: Record<string, unknown>, execution: 'not_executed' | 'executed' | 'unknown' = 'not_executed'
    if (saved.expires <= this.now()) validation = { observation_id: p.observation_id, source_step_id: saved.step, checked_at: new Date(this.now()).toISOString(), valid: false, reason: 'expired', action_not_executed: true, input_ready: false, snapshot_atomic: false }
    else if (saved.source.window_id && this.windows.lookup(tool, saved.source.window_id as string, context)?.scope_id !== saved.windowScope)
      validation = { observation_id: p.observation_id, source_step_id: saved.step, checked_at: new Date(this.now()).toISOString(), valid: false, reason: 'window_changed', action_not_executed: true, input_ready: false, snapshot_atomic: false }
    else {
      const response = await this.helper.request('validate_observation', { binding_scope: owner.scope, source_step_id: saved.step, source_token_digest: saved.digest,
        observation_id: p.observation_id, element_id: p.element_id ?? null, x: p.x ?? null, y: p.y ?? null, purpose: p.purpose ?? 'inspect'
      }, { signal: context.signal, expectedGeneration: owner.generation, timeoutMs: 20_000 })
      throwIfDesktopInterrupted(response)
      if (!this.current(context) || this.owners.get(tool) !== owner || owner.latest !== saved || this.helper.getState().generation !== owner.generation || this.helper.getState().phase !== 'ready')
        throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: response.execution, message: '复核期间原任务、helper 或观察已失效，未发布复核结果。' })
      const value = response.data
      const expectsPoint = object(value) && value.valid === true && p.x !== undefined
      const expectedPoint = expectsPoint && saved.data.target !== 'controls' ? resolveImagePoint(saved.data, Number(p.x), Number(p.y)) : null
      if (!object(value) || !fields(value, ['observation_id', 'source_step_id', 'checked_at', 'valid', 'reason', 'action_not_executed', 'input_ready', 'snapshot_atomic', ...(expectsPoint ? ['coordinate'] : [])]) ||
          value.observation_id !== p.observation_id || value.source_step_id !== saved.step || value.action_not_executed !== true || value.input_ready !== false || value.snapshot_atomic !== false ||
          typeof value.checked_at !== 'string' || !Number.isFinite(Date.parse(value.checked_at)) || Math.abs(this.now() - Date.parse(value.checked_at)) > 120_000 ||
          response.execution !== 'executed' || typeof value.valid !== 'boolean' || response.ok !== value.valid ||
          (value.valid ? value.reason !== null || response.code !== 'ok' : !OBSERVATION_STALE_REASONS.includes(value.reason as typeof OBSERVATION_STALE_REASONS[number]) || response.code !== 'stale_observation') ||
          (expectsPoint && (!expectedPoint || !matchesImagePointResolution(value.coordinate, expectedPoint)))) {
        owner.latest = null
        throw new ComputerUseActionError({ code: response.code === 'cancelled' ? 'cancelled' : 'invalid_result', execution: response.execution, message: '观察复核结果未通过主进程校验，请重新观察。' })
      }
      validation = structuredClone(value); execution = 'executed'
    }
    if (validation.valid === true) return { message: '观察只读复核通过；图像定位已转换为桌面物理坐标（如有）。未执行输入，后续输入仍须原生入口实时复核和转换。', data: validation }
    owner.latest = null
    let refreshed: Awaited<ReturnType<WindowsObservationService['observe']>> | undefined, refreshError: unknown
    // Exactly one bounded re-observation; never retry or replay a native input action.
    try { refreshed = await this.observe(tool, saved.source, context) }
    catch (error) {
      refreshError = error instanceof ComputerUseActionError ? { code: error.result.code, execution: error.result.execution, message: error.result.message } : { code: 'capture_failed' }
      if (error instanceof ComputerUseActionError && error.result.execution !== 'not_executed') execution = error.result.execution
    }
    if (!this.current(context) || this.owners.get(tool) !== owner || this.helper.getState().generation !== owner.generation) {
      if (refreshed?.attachments) this.release(refreshed.attachments, context.lease)
      throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution, message: '刷新期间原任务或 helper 已失效，未向新任务发布结果。' })
    }
    throw new ComputerUseActionError({ code: 'stale_observation', execution: refreshed ? 'executed' : execution,
      message: refreshed ? '旧观察已失效，原定位未执行；已补取一次新观察，请根据新编号重新判断下一步。' : '旧观察已失效，原定位未执行；本次自动刷新失败，请按错误重新发现／观察。',
      data: { validation, ...(refreshed ? { refreshed_observation: refreshed.data } : { refresh_error: refreshError }) }, attachments: refreshed?.attachments })
  }
  private async observe(tool: ComputerUseTool, p: Record<string, unknown>, context: ComputerUseDispatchContext): Promise<{ message: string; data: WindowsObservation | ControlsOnlyObservation; attachments?: ComputerUseImageReference[] }> {
    if (!this.current(context) || !this.registrations.has(tool)) throw new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '观察需要当前真实任务上下文。' })
    const owner = this.owner(tool, context), key = owner.key, generation = owner.generation
    owner.latest = null // Even a failed new capture prevents reuse of the previous observation.
    const selected = p.window_id ? this.windows.lookup(tool, p.window_id as string, context) : null
    if (p.window_id && !selected) throw new ComputerUseActionError({ code: 'stale_window', execution: 'not_executed', message: '窗口引用未在当前任务发现或已失效，请重新 list_windows。' })
    if (p.target !== 'controls' && this.artifacts.size >= 32) throw new ComputerUseActionError({ code: 'unavailable', execution: 'not_executed', message: '待交付截图已达到缓存上限，请先完成或取消原步骤。' })
    const directory = p.target === 'controls' ? null : await mkdtemp(join(tmpdir(), 'web2term-observe-')), path = directory ? join(directory, 'capture.png') : null
    let kept = false
    try {
      if (!this.current(context)) throw new ComputerUseActionError({ code: 'cancelled', execution: 'not_executed', message: '观察已取消，本次未捕获。' })
      const response = await this.helper.request('observe', { binding_scope: owner.scope, source_step_id: context.step!.id,
        source_token_digest: createHash('sha256').update(context.step!.token!).digest('hex'), scope_id: selected?.scope_id ?? 'ws_' + randomUUID().replaceAll('-', ''), target: p.target,
        window_id: p.window_id ?? null, monitor_id: p.monitor_id ?? null, crop: p.target === 'region' ? { x: p.x, y: p.y, width: p.width, height: p.height } : null,
        max_dimension: p.max_dimension ?? 1600, output_path: path,
        controls_options: p.target === 'controls' || p.include_controls === true ? { max_depth: p.max_depth ?? 4, max_elements: p.max_elements ?? 100, timeout_ms: p.timeout_ms ?? 1200, include_selection: p.include_selection === true } : null
      }, { signal: context.signal, expectedGeneration: generation, timeoutMs: 20_000 })
      throwIfDesktopInterrupted(response)
      if (!this.current(context) || leaseKey(context.lease) !== key || !this.registrations.has(tool) || this.owners.get(tool) !== owner)
        throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: response.execution, message: '原观察任务已结束，截图未发布给新任务。', data: { helper_code: response.code } })
      if (!response.ok) {
        const code = ['stale_window', 'stale_observation', 'capture_blocked', 'window_blocked', 'restore_required', 'cancelled', 'invalid_parameters', 'unavailable'].includes(response.code)
          ? response.code as 'stale_window' | 'stale_observation' | 'capture_blocked' | 'window_blocked' | 'restore_required' | 'cancelled' | 'invalid_parameters' | 'unavailable' : 'capture_failed'
        throw new ComputerUseActionError({ code, execution: response.execution, message: response.message, data: { helper_code: response.code } })
      }
      if (p.target === 'controls') {
        if (this.helper.getState().phase !== 'ready' || this.helper.getState().generation !== generation || response.execution !== 'executed' || response.code !== 'ok' ||
            !selected || this.windows.lookup(tool, p.window_id as string, context)?.scope_id !== selected.scope_id || !validateControlsOnly(response.data, p, selected.window, this.now()))
          throw new ComputerUseActionError({ code: 'invalid_result', execution: response.execution, message: '控件树、焦点或窗口身份未通过主进程校验，未发布控件观察。' })
        const data = this.bind(owner, structuredClone(response.data), p, context, selected.scope_id)
        this.recordDisplay(tool, context, data, selected.window, null)
        return { message: response.message, data }
      }
      let bytes: Buffer
      try { bytes = await this.read(path!) }
      catch { throw new ComputerUseActionError({ code: 'invalid_result', execution: response.execution, message: '截图文件缺失、超出预算或已变化，未发布图像。' }) }
      if (!this.current(context) || leaseKey(context.lease) !== key || !this.registrations.has(tool) || this.owners.get(tool) !== owner)
        throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: response.execution, message: '截图读取期间原任务已结束，未发布图像。' })
      if (this.helper.getState().phase !== 'ready' || this.helper.getState().generation !== generation || response.execution !== 'executed' || response.code !== 'ok' ||
          (p.window_id && this.windows.lookup(tool, p.window_id as string, context)?.scope_id !== selected?.scope_id) ||
          !validateWindowsObservation(response.data, p, selected?.window ?? null, bytes, this.now()))
        throw new ComputerUseActionError({ code: 'invalid_result', execution: response.execution, message: '截图、身份或几何信息未通过主进程核对，未发布观察。' })
      const data = structuredClone(response.data), id = 'img_' + randomUUID().replaceAll('-', '')
      const attachment: PreparedAttachment = { path: path!, fileName: data.observation_id + '.png', mimeType: 'image/png', sizeBytes: bytes.length, sha256: data.image.sha256 }
      this.artifacts.set(id, { tool, owner: key, directory: directory!, attachment, expires: this.now() + 15 * 60_000 }); kept = true
      const bound = this.bind(owner, data, p, context, selected?.scope_id ?? null)
      this.recordDisplay(tool, context, bound, selected?.window ?? null, bytes)
      return { message: response.message, data: bound, attachments: [{ id, mime_type: 'image/png', sha256: attachment.sha256 }] }
    } finally { if (!kept && directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}) }
  }
  async prepare(references: ComputerUseImageReference[], lease: TaskLease): Promise<PreparedAttachment[]> {
    if (this.disposed || references.length !== 1) throw new Error('invalid-observation-attachment')
    const reference = references[0], item = this.artifacts.get(reference.id)
    if (!item || item.owner !== leaseKey(lease) || item.expires <= this.now() || reference.mime_type !== 'image/png' || reference.sha256 !== item.attachment.sha256)
      throw new Error('stale-observation-attachment')
    const bytes = await this.read(item.attachment.path)
    if (bytes.length !== item.attachment.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('changed-observation-attachment')
    return [{ ...item.attachment }]
  }
  release(references: ComputerUseImageReference[], lease: TaskLease): void {
    for (const ref of references) if (this.artifacts.get(ref.id)?.owner === leaseKey(lease)) this.remove(ref.id)
  }
  private async read(path: string): Promise<Buffer> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error('invalid-capture-file')
    const handle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid-capture-file')
      const bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead }
      if (offset !== stat.size) throw new Error('changed-capture-file')
      return bytes.subarray(0, offset)
    } finally { await handle.close() }
  }
  private remove(id: string): void {
    const item = this.artifacts.get(id); if (!item) return
    this.artifacts.delete(id); void rm(item.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
  dispose(): void { this.disposed = true; clearInterval(this.sweep); this.display.clear(); for (const remove of [...this.registrations.values()]) remove(); for (const id of this.artifacts.keys()) this.remove(id) }
}
