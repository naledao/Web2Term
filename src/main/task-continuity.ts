import { createHash } from 'node:crypto'
import { parseTaskContinuity } from '../shared/autonomous-task'
import type { TaskContinuity, TaskLease, TaskToolContext } from '../shared/autonomous-task'
import type { ComputerUseToolCall, ComputerUseToolResult } from '../shared/computer-use'
import { localResourcePath, normalizeResourceUrl } from '../shared/windows-apps'
import type { PreparedFileSource } from './file-access'
import type { TaskCoordinator } from './task-coordinator'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): string | null => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : null
const id = (v: unknown, prefix: string): v is string => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
const upsert = <T>(items: T[], value: T, same: (a: T) => boolean, limit: number): void => {
  const index = items.findIndex(same)
  if (index >= 0) items.splice(index, 1)
  items.push(value)
  if (items.length > limit) items.shift()
}

/** Extracts only structured executor evidence. It neither discovers targets nor performs actions. */
export class TaskContinuityService {
  constructor(private readonly coordinator: TaskCoordinator, private readonly now = Date.now) {}

  summary(lease: TaskLease): unknown {
    if (!this.coordinator.owns(lease)) return undefined
    const c = this.coordinator.current(lease.platformId)?.continuity
    if (!c) return undefined
    return { history_only: true, requires_fresh_observation: true, machine_id: c.machineId,
      last_window: c.windows.find(w => w.key === c.lastWindowKey) ?? null,
      applications: c.apps.slice(-6), windows: c.windows.slice(-8), resources: c.resources.slice(-8), transitions: c.transitions.slice(-6),
      totals: { applications: c.apps.length, windows: c.windows.length, resources: c.resources.length }, goal_verified: false }
  }

  computer(call: ComputerUseToolCall, result: ComputerUseToolResult, lease: TaskLease, stepId: string): unknown {
    const c = this.index(lease, stepId)
    if (!c) return undefined
    const data = object(result.data) ? result.data : null, seenAt = this.now(), from = c.lastWindowKey
    let target: string | null = null, evidence: TaskContinuity['transitions'][number]['evidence'] | null = null
    const learnWindow = (v: unknown): string | null => {
      if (!object(v) || !id(v.window_id, 'win_') || v.identity_verified === false) return null
      const native = object(v.window_identity) ? v.window_identity : v
      const hwnd = text(native.hwnd, 18), started = text(native.process_started_at, 64), klass = text(native.class_name, 256)
      if (!hwnd || !/^0x[1-9a-f][a-f0-9]*$/.test(hwnd) || !started || !Number.isFinite(Date.parse(started)) || !klass ||
        !Number.isSafeInteger(native.pid) || Number(native.pid) < 1 || Number(native.pid) > 0xffffffff || !Number.isSafeInteger(native.thread_id) || Number(native.thread_id) < 1 || Number(native.thread_id) > 0xffffffff) return null
      const key = 'tw_' + createHash('sha256').update(JSON.stringify([hwnd, native.pid, started, native.thread_id, klass])).digest('hex').slice(0, 32)
      const previous = c.windows.find(w => w.key === key), application = object(v.application) ? v.application : null
      upsert(c.windows, { key, windowId: v.window_id, hwnd, pid: Number(native.pid), processStartedAt: started, threadId: Number(native.thread_id), className: klass,
        title: text(v.title, 256) ?? previous?.title ?? null, executablePath: text(application?.executable_path, 1024) ?? previous?.executablePath ?? null,
        stepId, seenAt }, w => w.key === key, 48)
      return key
    }
    if (result.ok && result.execution === 'executed' && data) {
      if (call.action === 'list_apps' && Array.isArray(data.apps)) for (const app of data.apps.slice(0, 25)) {
        if (!object(app) || !id(app.app_id, 'app_') || !text(app.name, 200)) continue
        upsert(c.apps, { appId: app.app_id, name: app.name as string, executablePath: text(app.executable_path, 1024), stepId, seenAt }, a => a.appId === app.app_id, 32)
      }
      if (call.action === 'list_windows' && Array.isArray(data.windows)) for (const window of data.windows.slice(0, 50)) learnWindow(window)
      if (call.action === 'inspect_interactions') {
        learnWindow(data.parent)
        if (Array.isArray(data.windows)) for (const related of data.windows.slice(0, 16)) if (object(related)) learnWindow(related.window)
      }
      if (call.action === 'focus_window' && data.focus_confirmed === true && object(data.target) && data.identity_verified === true) {
        target = learnWindow({ ...data.target, window_id: data.window_id }); evidence = target ? 'focus-confirmed' : null
      }
      if (call.action === 'open' && ['file', 'directory', 'url'].includes(data.kind as string)) {
        const resource = data.kind === 'url' ? normalizeResourceUrl(data.target) : localResourcePath(data.target) ? data.target : null
        if (resource && data.dispatch_status === 'dispatched') {
          this.resource(c, data.kind as 'file' | 'directory' | 'url', resource, 'open-dispatched', stepId, seenAt)
          evidence = 'dispatched'
        }
      }
      if (call.action === 'launch_app' && data.dispatch_status === 'dispatched') evidence = 'dispatched'
    }
    // Validated post-input observations remain useful even when the input's outcome is uncertain.
    if (data) {
      const observation = call.action === 'observe' && result.ok ? data : object(data.observation) ? data.observation : object(data.refreshed_observation) ? data.refreshed_observation : null
      if (observation) { const learned = learnWindow(observation); if (learned) { target = learned; evidence = 'observed' } }
    }
    if (!result.ok && ['focus_window', 'open', 'launch_app', 'click', 'type_text', 'press_key', 'scroll', 'drag'].includes(call.action) && !target) {
      evidence = 'unconfirmed'
      if (call.action === 'open' && data && object(data.open)) {
        const open = data.open, resource = open.kind === 'url' ? normalizeResourceUrl(open.target) : localResourcePath(open.target) ? open.target : null
        if (resource && ['file', 'directory', 'url'].includes(open.kind as string) && open.dispatch_status === 'unknown')
          this.resource(c, open.kind as 'file' | 'directory' | 'url', resource, 'open-unconfirmed', stepId, seenAt)
      }
    }
    if (evidence) {
      c.lastWindowKey = target
      upsert(c.transitions, { stepId, action: call.action, fromWindowKey: from, toWindowKey: target, evidence, seenAt }, t => t.stepId === stepId, 32)
    }
    if (c.lastWindowKey && !c.windows.some(w => w.key === c.lastWindowKey)) c.lastWindowKey = null
    this.save(lease, stepId, c)
    return this.summary(lease)
  }

  files(context: TaskToolContext, sources: readonly PreparedFileSource[]): void {
    if (context.tool !== 'read_files' || !this.coordinator.ownsToolStep(context)) return
    const c = this.index(context, context.stepId)
    if (!c) return
    const seenAt = this.now()
    let added = false
    for (const source of sources.slice(0, 3)) {
      if (!localResourcePath(source.path) || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(source.sha256)) continue
      this.resource(c, 'file', source.path, 'read-snapshot', context.stepId, seenAt, source.sizeBytes, source.sha256)
      added = true
    }
    if (!added) return
    upsert(c.transitions, { stepId: context.stepId, action: 'read_files', fromWindowKey: c.lastWindowKey, toWindowKey: null, evidence: 'files-read', seenAt }, t => t.stepId === context.stepId, 32)
    this.save(context, context.stepId, c)
  }

  private index(lease: TaskLease, stepId: string): TaskContinuity | null {
    const task = this.coordinator.current(lease.platformId), step = task?.progress?.currentStep
    if (!this.coordinator.owns(lease) || step?.id !== stepId || step.status !== 'executing' || step.machine?.id !== task?.machine.id ||
      step.machine?.platform !== task?.machine.platform || step.machine?.arch !== task?.machine.arch || step.machine?.connection !== 'local') return null
    return task!.continuity ? structuredClone(task!.continuity) : { version: 1, machineId: task!.machine.id, apps: [], windows: [], resources: [], lastWindowKey: null, transitions: [] }
  }
  private resource(c: TaskContinuity, kind: 'file' | 'directory' | 'url', target: string, evidence: TaskContinuity['resources'][number]['evidence'], stepId: string,
    seenAt: number, sizeBytes: number | null = null, sha256: string | null = null): void {
    upsert(c.resources, { kind, target, evidence, stepId, seenAt, sizeBytes, sha256 }, r => r.kind === kind && r.target === target, 64)
  }
  private save(lease: TaskLease, stepId: string, c: TaskContinuity): void {
    if (!parseTaskContinuity(c) || !this.coordinator.recordContinuity(lease, stepId, c)) throw new Error('task-continuity-not-saved')
  }
}
