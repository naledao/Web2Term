import { open, realpath, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { LIST_APPS_DEFINITION, LAUNCH_APP_DEFINITION, OPEN_RESOURCE_DEFINITION, localResourcePath, normalizeResourceUrl, requiresExplicitResourceApp } from '../shared/windows-apps'
import type { WindowsApp, WindowsAppCatalogPage, WindowsAppSource, WindowsAppLaunchResult, WindowsResourceOpenResult } from '../shared/windows-apps'
import { ComputerUseActionError, throwIfDesktopInterrupted } from './computer-use-tool'
import type { ComputerUseTool, ComputerUseDispatchContext } from './computer-use-tool'
import type { WindowsHelperManager } from './windows-helper'

const sources: WindowsAppSource[] = ['applications_folder', 'start_menu', 'app_paths', 'running_process', 'registered_path']
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && value.length <= max && (empty || !!value.trim()) && !value.includes('\0')
const id = (value: unknown, prefix: string): value is string => typeof value === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(value)
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value))
const unique = (values: unknown[]): boolean => new Set(values).size === values.length
const fields = (value: Record<string, unknown>, expected: string[]): boolean => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))

export function localExecutablePath(value: unknown): value is string {
  return text(value, 1024) && /^[a-z]:[\\/]/i.test(value) && !/[\x00-\x1f<>"|?*]/.test(value) &&
    !value.slice(2).includes(':') && win32.extname(value).toLowerCase() === '.exe'
}

/** Validate an actual local PE image, not a guessed command, shortcut, directory or file extension. */
export async function verifyLocalExecutable(path: string): Promise<string> {
  if (!localExecutablePath(path)) throw new Error('invalid-executable-path')
  const canonical = await realpath(path)
  if (!localExecutablePath(canonical)) throw new Error('invalid-executable-path')
  const file = await open(canonical, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size < 88) throw new Error('invalid-executable-image')
    const header = Buffer.alloc(64)
    if ((await file.read(header, 0, 64, 0)).bytesRead !== 64 || header.readUInt16LE(0) !== 0x5a4d) throw new Error('invalid-executable-image')
    const offset = header.readUInt32LE(60)
    if (offset < 64 || offset > before.size - 24) throw new Error('invalid-executable-image')
    const pe = Buffer.alloc(24)
    if ((await file.read(pe, 0, 24, offset)).bytesRead !== 24 || pe.readUInt32LE(0) !== 0x4550 ||
      ![0x14c, 0x8664].includes(pe.readUInt16LE(4)) || !(pe.readUInt16LE(22) & 2) || (pe.readUInt16LE(22) & 0x2000)) throw new Error('invalid-executable-image')
    const optionalSize = pe.readUInt16LE(20)
    if (pe.readUInt16LE(6) < 1 || pe.readUInt16LE(6) > 96 || optionalSize < (pe.readUInt16LE(4) === 0x14c ? 96 : 112) || optionalSize > 4096 || offset + 24 + optionalSize > before.size) throw new Error('invalid-executable-image')
    const optional = Buffer.alloc(70)
    if ((await file.read(optional, 0, 70, offset + 24)).bytesRead !== 70 ||
      optional.readUInt16LE(0) !== (pe.readUInt16LE(4) === 0x14c ? 0x10b : 0x20b) || ![2, 3].includes(optional.readUInt16LE(68))) throw new Error('invalid-executable-image')
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('executable-changed')
    return canonical
  } finally { await file.close() }
}

export function validateListAppsParameters(parameters: Record<string, unknown>): string | null {
  if (Object.keys(parameters).some(key => !['query', 'limit', 'cursor', 'refresh', 'register_path'].includes(key)) ||
    (parameters.query !== undefined && !text(parameters.query, 200, true)) ||
    (parameters.limit !== undefined && (!count(parameters.limit, 25) || parameters.limit === 0)) ||
    (parameters.cursor !== undefined && !id(parameters.cursor, 'apc_')) ||
    (parameters.refresh !== undefined && typeof parameters.refresh !== 'boolean') ||
    (parameters.register_path !== undefined && !localExecutablePath(parameters.register_path))) return 'list_apps 参数无效；请使用名称查询或已经找到的本机绝对 exe 路径。'
  if (parameters.cursor && (parameters.refresh === true || parameters.register_path !== undefined)) return '分页不能同时刷新或登记路径，请先发起新的 list_apps 查询。'
  return null
}

export function validateLaunchAppParameters(parameters: Record<string, unknown>): string | null {
  return Object.keys(parameters).some(key => !['app_id', 'launch_reference_id', 'wait_ms'].includes(key)) ||
    !id(parameters.app_id, 'app_') || !id(parameters.launch_reference_id, 'launch_') ||
    (parameters.wait_ms !== undefined && !count(parameters.wait_ms, 5000)) ? 'launch_app 仅接受 list_apps 已返回的应用／启动引用和 0—5000 毫秒等待，不能覆盖路径、参数或命令。' : null
}

export function validateOpenResourceParameters(parameters: Record<string, unknown>): string | null {
  if (Object.keys(parameters).some(key => !['kind', 'target', 'app_id', 'launch_reference_id', 'wait_ms'].includes(key)) ||
    !['file', 'directory', 'url'].includes(parameters.kind as string) ||
    (parameters.kind === 'url' ? !normalizeResourceUrl(parameters.target) : !localResourcePath(parameters.target)) ||
    ((parameters.app_id !== undefined || parameters.launch_reference_id !== undefined) &&
      (!id(parameters.app_id, 'app_') || !id(parameters.launch_reference_id, 'launch_'))) ||
    (parameters.wait_ms !== undefined && !count(parameters.wait_ms, 5000))) return 'open 仅接受 file／directory 的真实本机绝对路径或 http(s) URL；应用引用须成对提供，不能传命令、额外参数或目录编号。'
  return parameters.kind === 'file' && parameters.app_id === undefined && requiresExplicitResourceApp(parameters.target as string)
    ? '程序、脚本和快捷方式不能作为普通文档通过系统关联运行；启动应用请使用 launch_app，查看脚本请显式选择已发现的编辑器。' : null
}

export async function verifyLocalResource(kind: 'file' | 'directory', path: string): Promise<string> {
  if (!localResourcePath(path)) throw new Error('invalid-resource-path')
  const canonical = await realpath(path)
  if (!localResourcePath(canonical)) throw new Error('invalid-resource-path')
  const info = await stat(canonical)
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new Error('resource-kind-mismatch')
  return canonical
}

export function validateWindowsResourceOpenResult(value: unknown, kind: string, target: string,
  selection: { catalogId: string; appId: string; referenceId: string } | null): value is WindowsResourceOpenResult {
  if (!record(value) || value.kind !== kind || value.target !== target || value.handler !== (selection ? 'discovered_app' : 'system_association') ||
    value.catalog_id !== (selection?.catalogId ?? null) || value.app_id !== (selection?.appId ?? null) || value.launch_reference_id !== (selection?.referenceId ?? null) ||
    value.control_conversation_preserved !== true || value.content_verified !== false) return false
  if (value.application !== null && (!record(value.application) || !fields(value.application, ['executable_path', 'app_user_model_id', 'basis']) ||
    value.application.basis !== (selection ? 'selected_reference' : 'association_query') ||
    (value.application.executable_path !== null && !localExecutablePath(value.application.executable_path)) ||
    (value.application.app_user_model_id !== null && !text(value.application.app_user_model_id, 512)) ||
    (value.application.executable_path === null && value.application.app_user_model_id === null))) return false
  const { kind: _kind, target: _target, handler: _handler, application: _application, control_conversation_preserved: _preserved, content_verified: _verified, ...launch } = value
  return validateWindowsAppLaunchResult({ ...launch, catalog_id: selection?.catalogId ?? '', app_id: selection?.appId ?? '',
    launch_reference_id: selection?.referenceId ?? '' }, selection?.catalogId ?? '', selection?.appId ?? '', selection?.referenceId ?? '') &&
    (selection !== null || value.method === 'shell_execute')
}

export function validateWindowsAppLaunchResult(value: unknown, catalogId: string, appId: string, referenceId: string): value is WindowsAppLaunchResult {
  if (!record(value) || !fields(value, ['catalog_id', 'app_id', 'launch_reference_id', 'dispatch_status', 'method', 'native_error', 'returned_process',
    'before_at', 'observed_at', 'observation_complete', 'candidate_windows', 'target_window_confirmed', 'goal_verified']) ||
    value.catalog_id !== catalogId || value.app_id !== appId || value.launch_reference_id !== referenceId ||
    !['dispatched', 'unknown'].includes(value.dispatch_status as string) || !['shell_execute', 'application_activation'].includes(value.method as string) ||
    (value.native_error !== null && (!Number.isSafeInteger(value.native_error) || (value.native_error as number) < -2147483648 || (value.native_error as number) > 0xffffffff)) ||
    (value.dispatch_status === 'dispatched' && value.native_error !== null) || !date(value.before_at) || !date(value.observed_at) ||
    Date.parse(value.observed_at) < Date.parse(value.before_at) || typeof value.observation_complete !== 'boolean' ||
    value.target_window_confirmed !== false || value.goal_verified !== false || !Array.isArray(value.candidate_windows) || value.candidate_windows.length > 12) return false
  if (value.returned_process !== null && (!record(value.returned_process) || !fields(value.returned_process, ['pid', 'started_at']) ||
    !count(value.returned_process.pid, 0xffffffff) || value.returned_process.pid === 0 ||
    (value.returned_process.started_at !== null && !date(value.returned_process.started_at)))) return false
  return unique(value.candidate_windows.map(window => record(window) ? window.hwnd : null)) && value.candidate_windows.every(window => record(window) &&
    fields(window, ['hwnd', 'title', 'visible', 'minimized', 'pid', 'process_started_at', 'foreground', 'match_basis', 'change']) &&
    text(window.hwnd, 18) && /^0x[a-f0-9]+$/.test(window.hwnd) && text(window.title, 256, true) && typeof window.visible === 'boolean' &&
    typeof window.minimized === 'boolean' && typeof window.foreground === 'boolean' && count(window.pid, 0xffffffff) && window.pid !== 0 &&
    date(window.process_started_at) && ['app_user_model_id', 'executable_path', 'returned_pid', 'window_change'].includes(window.match_basis as string) &&
    ['new', 'changed', 'existing', 'unconfirmed'].includes(window.change as string) &&
    (window.match_basis !== 'returned_pid' || (record(value.returned_process) && value.returned_process.pid === window.pid && value.returned_process.started_at === window.process_started_at)) &&
    (window.match_basis !== 'window_change' || ['new', 'changed'].includes(window.change as string)))
}

/** Trust a result only after checking bounded shapes and all declared identities. No page can register references. */
export function validateWindowsAppCatalogPage(value: unknown, query: string, limit: number): value is WindowsAppCatalogPage {
  if (!record(value) || !fields(value, ['catalog_id', 'collected_at', 'query', 'apps', 'total_matches', 'has_more', 'next_cursor', 'complete', 'sources', 'registered_app_id']) ||
    !id(value.catalog_id, 'cat_') || !date(value.collected_at) || value.query !== query ||
    !Array.isArray(value.apps) || value.apps.length > limit || !count(value.total_matches, 4096) || value.total_matches < value.apps.length ||
    typeof value.complete !== 'boolean' || typeof value.has_more !== 'boolean' ||
    (value.has_more ? !id(value.next_cursor, 'apc_') || !value.apps.length : value.next_cursor !== null) ||
    (value.registered_app_id !== null && !id(value.registered_app_id, 'app_')) || !Array.isArray(value.sources) || value.sources.length !== 5) return false
  if (!unique(value.sources.map(source => record(source) ? source.source : null)) || value.sources.some(source => !record(source) ||
    !fields(source, ['source', 'status', 'checked', 'errors']) ||
    !sources.includes(source.source as WindowsAppSource) || !['complete', 'partial', 'unavailable'].includes(source.status as string) ||
    !count(source.checked, 20_000) || !count(source.errors, 20_000)) ||
    (value.complete && value.sources.some(source => source.status !== 'complete'))) return false
  const apps = value.apps as unknown[]
  if (!unique(apps.map(app => record(app) ? app.app_id : null))) return false
  return apps.every(app => {
    if (!record(app) || !fields(app, ['app_id', 'name', 'aliases', 'sources', 'executable_path', 'launch_references', 'processes']) ||
      !id(app.app_id, 'app_') || !text(app.name, 200) || !Array.isArray(app.aliases) || app.aliases.length > 8 ||
      app.aliases.some(alias => !text(alias, 200)) || !unique(app.aliases) || !Array.isArray(app.sources) || !app.sources.length ||
      app.sources.length > 5 || !unique(app.sources) || app.sources.some(source => !sources.includes(source as WindowsAppSource)) ||
      (app.executable_path !== null && !localExecutablePath(app.executable_path)) || !Array.isArray(app.launch_references) || app.launch_references.length > 4 ||
      !unique(app.launch_references.map(reference => record(reference) ? reference.reference_id : null)) ||
      app.launch_references.some(reference => !record(reference) || !fields(reference, ['reference_id', 'kind', 'verified']) || !id(reference.reference_id, 'launch_') || reference.verified !== true ||
        (reference.kind !== 'shell_item' && app.executable_path === null) ||
        !['shell_item', 'shortcut', 'executable'].includes(reference.kind as string)) || !Array.isArray(app.processes) || app.processes.length > 8) return false
    return unique(app.processes.map(process => record(process) ? process.pid : null)) && app.processes.every(process => record(process) &&
      fields(process, ['pid', 'started_at', 'identity_verified', 'windows']) && count(process.pid, 0xffffffff) && process.pid !== 0 &&
      (process.started_at === null || date(process.started_at)) && typeof process.identity_verified === 'boolean' &&
      (!process.identity_verified || process.started_at !== null) && Array.isArray(process.windows) && process.windows.length <= 4 &&
      unique(process.windows.map(window => record(window) ? window.hwnd : null)) &&
      process.windows.every(window => record(window) && fields(window, ['hwnd', 'title', 'visible', 'minimized']) && text(window.hwnd, 18) && /^0x[a-f0-9]+$/.test(window.hwnd) &&
        text(window.title, 256, true) && typeof window.visible === 'boolean' && typeof window.minimized === 'boolean'))
  })
}

/** Application-scoped catalog of references learned from the current helper incarnation. */
export class WindowsAppCatalog {
  private readonly apps = new Map<string, WindowsApp>()
  private readonly owners = new Map<ComputerUseTool, { key: string; catalogId: string | null; references: Set<string>; cursors: Map<string, string>; revision: number }>()
  private readonly unsubscribe: () => void
  private generation = -1
  private catalogId: string | null = null
  private disposed = false

  constructor(private readonly helper: WindowsHelperManager,
    private readonly verifyExecutable: (path: string) => Promise<string> = verifyLocalExecutable,
    private readonly verifyResource: (kind: 'file' | 'directory', path: string) => Promise<string> = verifyLocalResource) {
    this.unsubscribe = helper.subscribe(() => this.reconcile())
  }

  register(tool: ComputerUseTool): () => void {
    const unregisterList = tool.register(LIST_APPS_DEFINITION, { validate: validateListAppsParameters, execute: (parameters, context) => this.list(parameters, context, tool) })
    let unregisterLaunch: (() => void) | undefined
    try {
      unregisterLaunch = tool.register(LAUNCH_APP_DEFINITION, { validate: validateLaunchAppParameters, execute: (parameters, context) => this.launch(parameters, context, tool) })
      const unregisterOpen = tool.register(OPEN_RESOURCE_DEFINITION, { validate: validateOpenResourceParameters, execute: (parameters, context) => this.openResource(parameters, context, tool) })
      return () => { this.owners.delete(tool); unregisterOpen(); unregisterLaunch!(); unregisterList() }
    } catch (error) { unregisterLaunch?.(); unregisterList(); throw error }
  }

  /** Resolve an actually learned reference; native launch revalidates its current target. */
  lookup(appId: string, referenceId: string): WindowsApp | null {
    this.reconcile()
    const app = this.apps.get(appId)
    return app?.launch_references.some(reference => reference.reference_id === referenceId) ? structuredClone(app) : null
  }

  dispose(): void { this.disposed = true; this.unsubscribe(); this.apps.clear(); this.owners.clear() }

  private reconcile(): void {
    const state = this.helper.getState()
    if (state.generation !== this.generation || state.phase !== 'ready') { this.apps.clear(); this.catalogId = null; this.owners.clear() }
    this.generation = state.generation
  }

  private key(context: ComputerUseDispatchContext): string | null {
    const lease = context.lease, capability = context.capability()
    return lease && [lease.sessionId, lease.platformId, lease.conversationId, lease.taskId].every(v => typeof v === 'string' && !!v.trim() && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v)) &&
      Number.isSafeInteger(lease.generation) && lease.generation > 0 && lease.sessionId === capability.context.sessionId && lease.platformId === capability.context.platformId
      ? JSON.stringify([lease.sessionId, lease.platformId, lease.conversationId, lease.taskId, lease.generation]) : null
  }
  private learned(tool: ComputerUseTool, context: ComputerUseDispatchContext, appId: string, referenceId: string): boolean {
    const owner = this.owners.get(tool)
    return !!owner && owner.key === this.key(context) && owner.catalogId === this.catalogId && owner.references.has(JSON.stringify([appId, referenceId])) && !!this.lookup(appId, referenceId)
  }
  private async openResource(parameters: Record<string, unknown>, context: ComputerUseDispatchContext, tool: ComputerUseTool): Promise<{ message: string; data: WindowsResourceOpenResult }> {
    const key = this.key(context)
    const current = (): boolean => !this.disposed && context.isCurrent() && !context.signal?.aborted && context.capability().enabled
      && key !== null && this.key(context) === key
    const ensureCurrent = (): void => {
      if (!current()) throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: 'not_executed', message: '原资源打开上下文已失效，本次未派发。' })
    }
    ensureCurrent(); this.reconcile()
    const generation = this.helper.getState().generation
    const kind = parameters.kind as 'file' | 'directory' | 'url'
    const selected = parameters.app_id !== undefined
    const selection = selected && this.catalogId ? { catalogId: this.catalogId, appId: parameters.app_id as string, referenceId: parameters.launch_reference_id as string } : null
    if (selected && (!selection || !this.learned(tool, context, selection.appId, selection.referenceId))) {
      throw new ComputerUseActionError({ code: 'stale_catalog', execution: 'not_executed', message: '指定应用引用未在当前目录中发现，请重新 list_apps。' })
    }
    let target: string
    try {
      target = kind === 'url' ? normalizeResourceUrl(parameters.target)! : await this.verifyResource(kind, parameters.target as string)
      if (!target || (kind !== 'url' && (!localResourcePath(target) || (kind === 'file' && !selected && requiresExplicitResourceApp(target))))) throw new Error('invalid-resource')
    } catch {
      ensureCurrent()
      throw new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: '无法核实资源的真实本机路径、类型或 URL，本次未派发；请使用现有文件／终端工具检查实际资源。' })
    }
    ensureCurrent(); this.reconcile()
    if (this.helper.getState().generation !== generation || (selection && (selection.catalogId !== this.catalogId || !this.learned(tool, context, selection.appId, selection.referenceId)))) {
      throw new ComputerUseActionError({ code: 'stale_catalog', execution: 'not_executed', message: '资源核实期间 helper 或应用目录已变化，请重新查询，本次未派发。' })
    }
    const response = await this.helper.request('open', { kind, target, wait_ms: parameters.wait_ms ?? 1500,
      ...(selection ? { catalog_id: selection.catalogId, app_id: selection.appId, launch_reference_id: selection.referenceId } : {})
    }, { signal: context.signal, timeoutMs: 30_000, expectedGeneration: generation })
    throwIfDesktopInterrupted(response)
    if (!current()) throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: response.execution,
      message: '原资源打开上下文已结束；已派发的操作不能据此视为撤销，请检查实际状态。' })
    const hasData = response.data !== undefined && response.data !== null
    if ((response.ok || hasData) && (this.helper.getState().phase !== 'ready' || this.helper.getState().generation !== generation ||
      !validateWindowsResourceOpenResult(response.data, kind, target, selection) ||
      (response.ok && (response.execution !== 'executed' || response.data.dispatch_status !== 'dispatched')) ||
      (hasData && response.data.dispatch_status === 'dispatched' && response.execution !== 'executed') ||
      (hasData && response.data.dispatch_status === 'unknown' && response.execution !== 'unknown'))) {
      throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '资源打开返回未通过主进程校验，是否生效尚未确认；请先查状态，不要重复打开。' })
    }
    if (!response.ok) {
      if (response.code === 'stale_catalog') { this.apps.clear(); this.catalogId = null }
      const code = response.code === 'stale_catalog' ? 'stale_catalog' : response.code === 'invalid_parameters' ? 'invalid_parameters'
        : response.code === 'cancelled' ? 'cancelled' : response.code === 'open_failed' ? 'open_failed'
          : response.execution === 'not_executed' ? 'unavailable' : 'executor_error'
      throw new ComputerUseActionError({ code, execution: response.execution, message: response.message,
        data: { helper_code: response.code, ...(hasData ? { open: response.data } : {}) } })
    }
    return { message: response.message, data: structuredClone(response.data as WindowsResourceOpenResult) }
  }

  private async launch(parameters: Record<string, unknown>, context: ComputerUseDispatchContext, tool: ComputerUseTool): Promise<{ message: string; data: WindowsAppLaunchResult }> {
    const key = this.key(context)
    const current = (): boolean => !this.disposed && context.isCurrent() && !context.signal?.aborted && context.capability().enabled
      && key !== null && this.key(context) === key
    if (!current()) throw new ComputerUseActionError({ code: 'inactive_context', execution: 'not_executed', message: '原应用启动请求已失效，本次未派发。' })
    this.reconcile()
    const catalogId = this.catalogId
    const appId = parameters.app_id as string, referenceId = parameters.launch_reference_id as string
    if (!catalogId || !this.learned(tool, context, appId, referenceId)) throw new ComputerUseActionError({ code: 'stale_catalog', execution: 'not_executed', message: '应用或启动引用未由当前任务发现，请先用 list_apps 重新查询。' })
    const generation = this.helper.getState().generation
    const response = await this.helper.request('launch_app', { app_id: appId, launch_reference_id: referenceId, catalog_id: catalogId,
      wait_ms: parameters.wait_ms ?? 1500 }, { signal: context.signal, timeoutMs: 30_000, expectedGeneration: generation })
    throwIfDesktopInterrupted(response)
    // Cancellation/settings changes after dispatch do not prove that the app was never launched.
    if (!current()) throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context',
      execution: response.execution, message: '原应用启动上下文已结束；已派发操作不能据此视为撤销，请核对实际状态。', data: { helper_code: response.code } })
    const hasData = response.data !== undefined && response.data !== null
    if ((response.ok || hasData) && (this.helper.getState().phase !== 'ready' || this.helper.getState().generation !== generation ||
      !validateWindowsAppLaunchResult(response.data, catalogId, appId, referenceId) ||
      (response.ok && (response.execution !== 'executed' || response.data.dispatch_status !== 'dispatched')) ||
      (hasData && response.data.dispatch_status === 'dispatched' && response.execution !== 'executed') ||
      (hasData && response.data.dispatch_status === 'unknown' && response.execution !== 'unknown'))) {
      throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '启动返回内容未通过主进程校验，是否生效尚未确认；请先检查实际状态，不要重复启动。' })
    }
    if (!response.ok) {
      if (response.code === 'stale_catalog') { this.apps.clear(); this.catalogId = null }
      const code = response.code === 'stale_catalog' ? 'stale_catalog' : response.code === 'invalid_parameters' ? 'invalid_parameters'
        : response.code === 'cancelled' ? 'cancelled' : response.code === 'launch_failed' ? 'launch_failed'
          : response.execution === 'not_executed' ? 'unavailable' : 'executor_error'
      throw new ComputerUseActionError({ code, execution: response.execution, message: response.message,
        data: { helper_code: response.code, ...(hasData ? { launch: response.data } : {}) } })
    }
    return { message: response.message, data: structuredClone(response.data as WindowsAppLaunchResult) }
  }

  private async list(parameters: Record<string, unknown>, context: ComputerUseDispatchContext, tool: ComputerUseTool): Promise<{ message: string; data: WindowsAppCatalogPage }> {
    const key = this.key(context)
    const ensureCurrent = (requireAvailable = true): void => {
      const capability = context.capability()
      if (this.disposed || key === null || this.key(context) !== key || !context.isCurrent() || context.signal?.aborted || !capability.enabled ||
        (requireAvailable && (!capability.available || !capability.actions.includes('list_apps')))) {
        throw new ComputerUseActionError({ code: context.signal?.aborted ? 'cancelled' : 'inactive_context', execution: 'not_executed', message: '原应用发现请求已失效，本次未查询或登记。' })
      }
    }
    ensureCurrent(); this.reconcile()
    let owner = this.owners.get(tool)
    if (!owner || owner.key !== key) {
      if (parameters.cursor !== undefined) throw new ComputerUseActionError({ code: 'stale_catalog', execution: 'not_executed', message: '分页引用不属于当前任务，请重新 list_apps。' })
      owner = { key: key!, catalogId: null, references: new Set(), cursors: new Map(), revision: 0 }; this.owners.set(tool, owner)
    }
    const saved = owner, revision = ++owner.revision
    const generation = this.helper.getState().generation
    const request: Record<string, unknown> & { query: string; limit: number } = { ...parameters,
      query: typeof parameters.query === 'string' ? parameters.query.trim() : '', limit: typeof parameters.limit === 'number' ? parameters.limit : 12 }
    if (parameters.cursor !== undefined && saved.cursors.get(parameters.cursor as string) !== request.query)
      throw new ComputerUseActionError({ code: 'stale_catalog', execution: 'not_executed', message: '分页引用未由当前任务在相同查询中取得，请重新 list_apps。' })
    if (typeof parameters.register_path === 'string') {
      try { request.register_path = await this.verifyExecutable(parameters.register_path) }
      catch { throw new ComputerUseActionError({ code: 'invalid_parameters', execution: 'not_executed', message: '无法核实该本机 exe 文件；请先通过文件／终端工具找到真实可读取的可执行文件，不能猜测路径。' }) }
    }
    ensureCurrent()
    const response = await this.helper.request('list_apps', request, { signal: context.signal, timeoutMs: 30_000, expectedGeneration: generation })
    throwIfDesktopInterrupted(response)
    ensureCurrent(false)
    if (this.owners.get(tool) !== saved || saved.revision !== revision) throw new ComputerUseActionError({ code: 'inactive_context', execution: response.execution, message: '原应用查询已被后续查询替换，未登记迟到引用。' })
    if (!response.ok) {
      if (response.code === 'stale_catalog') { this.apps.clear(); this.catalogId = null }
      const code = response.code === 'stale_catalog' ? 'stale_catalog' : response.code === 'invalid_parameters' ? 'invalid_parameters'
        : response.code === 'cancelled' ? 'cancelled' : response.execution === 'not_executed' ? 'unavailable' : 'executor_error'
      throw new ComputerUseActionError({ code, execution: response.execution, message: response.message, data: { helper_code: response.code } })
    }
    if (this.helper.getState().generation !== generation || this.helper.getState().phase !== 'ready' || !validateWindowsAppCatalogPage(response.data, request.query, request.limit)) {
      this.apps.clear(); this.catalogId = null
      throw new ComputerUseActionError({ code: 'invalid_result', execution: 'unknown', message: '应用发现返回内容未通过主进程校验，未登记启动引用；请重新查询。' })
    }
    const page = response.data
    if (this.catalogId !== page.catalog_id) {
      this.apps.clear(); this.catalogId = page.catalog_id
      for (const entry of this.owners.values()) { entry.catalogId = null; entry.references.clear(); entry.cursors.clear() }
    }
    saved.catalogId = page.catalog_id
    for (const app of page.apps) {
      this.apps.delete(app.app_id); this.apps.set(app.app_id, structuredClone(app))
      for (const reference of app.launch_references) saved.references.add(JSON.stringify([app.app_id, reference.reference_id]))
      if (this.apps.size > 2048) this.apps.delete(this.apps.keys().next().value!)
    }
    while (saved.references.size > 8192) saved.references.delete(saved.references.values().next().value!)
    if (page.next_cursor) saved.cursors.set(page.next_cursor, request.query)
    while (saved.cursors.size > 64) saved.cursors.delete(saved.cursors.keys().next().value!)
    return { message: response.message, data: structuredClone(page) }
  }
}
