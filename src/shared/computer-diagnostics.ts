import type { ComputerUseToolResult } from './computer-use'

export interface ComputerDiagnosticContext {
  /** Actual currently advertised actions, not a static list of planned features. */
  actions: readonly string[]
  otherTools: readonly ('command' | 'read_files')[]
  recoveryRequiresObservation?: boolean
}

export interface ComputerDiagnosis {
  version: 1
  category: 'reference_stale' | 'focus_unconfirmed' | 'loading_timeout' | 'ambiguous_target' | 'target_not_found'
    | 'input_failed' | 'observation_failed' | 'partial_observation' | 'protocol_error' | 'backend_unavailable'
    | 'context_ended' | 'effect_unconfirmed' | 'action_failed' | 'verification_required' | 'no_progress' | 'progress_limit'
  basis: 'structured_tool_result'
  facts: {
    action: string; code: string; execution: ComputerUseToolResult['execution']
    post_observation_failed: boolean
    latest_observation: { observation_id: string; target: string; window_id: string | null; observed_at: string;
      controls_complete: boolean | null } | null
  }
  may_have_side_effects: boolean
  requires_fresh_observation: boolean
  same_action_retry: 'read_only_after_scope_check' | 'after_correction' | 'verify_effect_first' | 'stop'
  candidate_paths: Array<{ tool: 'computer' | 'command' | 'read_files'; action: string | null; purpose: string }>
  guidance: string
  model_selects_next_step: true
  goal_verified: false
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const readOnly = new Set(['list_apps', 'list_windows', 'observe', 'validate_observation', 'inspect_interactions', 'wait_for', 'complete_task'])
const referenceCodes = new Set(['stale_catalog', 'stale_window', 'stale_observation', 'recovery_required'])
const focusCodes = new Set(['focus_denied', 'focus_unconfirmed', 'restore_required', 'window_blocked'])
const protocolCodes = new Set(['invalid_json', 'duplicate_field', 'unsafe_field', 'limit_exceeded', 'invalid_envelope', 'invalid_parameters',
  'unsupported_version', 'unknown_action', 'invalid_step_token', 'stale_step_token', 'ambiguous_request', 'invalid_description'])

/** Reads only bounded metadata from executor-validated observations; never an input permit. */
function latestObservation(result: ComputerUseToolResult): ComputerDiagnosis['facts']['latest_observation'] {
  if (!object(result.data)) return null
  const data = result.data
  const candidate = object(data.observation) ? data.observation : object(data.refreshed_observation) ? data.refreshed_observation
    : result.action === 'observe' && result.ok ? data : null
  const controls = candidate && object(candidate.controls) ? candidate.controls : null
  const observedAt = candidate?.target === 'controls' ? controls?.observed_at : candidate?.observed_at
  if (!candidate || typeof candidate.observation_id !== 'string' || !/^obs_[a-f0-9]{32}$/.test(candidate.observation_id) ||
    !['desktop', 'window', 'region', 'controls'].includes(candidate.target as string) ||
    candidate.window_id !== null && (typeof candidate.window_id !== 'string' || !/^win_[a-f0-9]{32}$/.test(candidate.window_id)) ||
    typeof observedAt !== 'string' || observedAt.length > 64 || !Number.isFinite(Date.parse(observedAt))) return null
  return { observation_id: candidate.observation_id, target: candidate.target as string, window_id: candidate.window_id as string | null,
    observed_at: observedAt, controls_complete: typeof controls?.complete === 'boolean' ? controls.complete : null }
}

/** Evidence and available options for the model, without executing, retrying or choosing a path. */
export function diagnoseComputerResult(result: ComputerUseToolResult, context: ComputerDiagnosticContext): ComputerDiagnosis | null {
  const data = object(result.data) ? result.data : null
  const observation = latestObservation(result)
  const postFailed = data !== null && (object(data.post_observation_error) || object(data.refresh_error))
  const partial = observation?.controls_complete === false
  const empty = result.ok && data !== null && (result.action === 'list_apps' && Array.isArray(data.apps) && data.apps.length === 0 ||
    result.action === 'list_windows' && Array.isArray(data.windows) && data.windows.length === 0)
  const noProgress = result.progress_control?.signals.some(s => ['repeated_action', 'unchanged_observations'].includes(s)) === true
  const timedOut = result.progress_control?.action_timed_out === true
  const halted = result.progress_control?.halted === true
  // A single stray physical input interrupts like interference: re-observe and continue the same goal.
  const external = ['external_input', 'human_input'].includes(result.code) || ['external_input', 'human_input'].includes(data?.helper_code as string)
  const monitorUnavailable = result.code === 'input_monitor_unavailable' || data?.helper_code === 'input_monitor_unavailable'
  if (result.ok && result.execution === 'executed' && !postFailed && !partial && !empty && !noProgress && !halted) return null
  const ended = result.code === 'human_takeover' || !external && !timedOut && (result.code === 'cancelled' || result.code === 'inactive_context')
  let category: ComputerDiagnosis['category']
  if (ended) category = 'context_ended'
  else if (halted || result.code === 'progress_limit') category = 'progress_limit'
  else if (result.code === 'no_progress' || noProgress && !timedOut) category = 'no_progress'
  else if (result.code === 'verification_required') category = 'verification_required'
  else if (referenceCodes.has(result.code)) category = 'reference_stale'
  else if (focusCodes.has(result.code) || external) category = 'focus_unconfirmed'
  else if (monitorUnavailable) category = 'backend_unavailable'
  else if (result.code === 'wait_timeout' || timedOut) category = 'loading_timeout'
  else if (result.code === 'wait_ambiguous') category = 'ambiguous_target'
  else if (empty) category = 'target_not_found'
  else if (postFailed || ['capture_failed', 'capture_blocked'].includes(result.code) || result.code === 'invalid_result' && readOnly.has(result.action)) category = 'observation_failed'
  else if (partial) category = 'partial_observation'
  else if (protocolCodes.has(result.code)) category = 'protocol_error'
  else if (result.code === 'unavailable') category = 'backend_unavailable'
  else if (/^(click|type_text|press_key|scroll|drag)_(failed|blocked)$/.test(result.code)) category = 'input_failed'
  else category = result.execution === 'unknown' ? 'effect_unconfirmed' : 'action_failed'
  const mayHaveEffects = !readOnly.has(result.action) && result.execution !== 'not_executed'
  const verify = !ended && (external || focusCodes.has(result.code) && !observation || result.execution === 'unknown' || result.code === 'recovery_required' ||
    mayHaveEffects && !observation && (!result.ok || postFailed || timedOut))
  const barrier = verify || context.recoveryRequiresObservation === true && !(result.action === 'observe' && result.ok && result.execution === 'executed')
  const paths: ComputerDiagnosis['candidate_paths'] = []
  const add = (action: string, purpose: string): void => {
      if (context.actions.includes(action) && (!barrier || ['list_apps', 'list_windows', 'observe', 'inspect_interactions', 'validate_observation', 'wait_for', 'focus_window'].includes(action)) &&
      !paths.some(p => p.tool === 'computer' && p.action === action)) paths.push({ tool: 'computer', action, purpose })
  }
  if (!ended && !halted) {
    if (category === 'protocol_error') add(result.action, '按当前动作定义修正字段和参数，使用当前新令牌与真实引用后再请求；不重放原请求。')
    if (category === 'reference_stale' || category === 'target_not_found' || category === 'backend_unavailable') {
      if (result.action === 'list_apps' || result.action === 'launch_app' || result.code === 'stale_catalog') add('list_apps', '重新发现实际应用；调整查询或从首个分页重新读取，不复用过期 app_id。')
      add('list_windows', '重新发现真实窗口并核对身份；空结果不证明应用不存在，不默认选择第一个。')
    }
    add('observe', category === 'partial_observation' ? '控件树不完整时可使用本结果已有的窗口图像，或按需改用 target=window 截图；不要仅因控件未列出就认定不存在。'
      : category === 'observation_failed' ? '截图不可用时可尝试 target=controls，UIA 不可用时可尝试窗口图像；仍遵守窗口与采集限制，不重复原输入来补图。'
        : observation && !verify ? '必要时获取不同形式的观察；本结果的新观察已在 data 中，无需为诊断摘要重复采集。'
          : '核对当前真实后状态；取得新控件或图像后再判断，不能复用失败步骤的旧定位。')
    if (category === 'focus_unconfirmed' || category === 'input_failed') {
      add('list_windows', '核对窗口是否已移动、关闭、最小化或有其他前台窗口。')
      add('inspect_interactions', '发现真实弹窗／菜单及其来源关系，使用实际新引用；结合新观察选择控件语义或图像定位，不盲目重复失败方法。')
      add('focus_window', '在当前发现的窗口身份上恢复／激活并核对焦点，再观察输入目标。')
    }
    if (['loading_timeout', 'ambiguous_target', 'observation_failed', 'partial_observation'].includes(category)) {
      add('list_windows', '检查真实窗口是否变化；条件有歧义时缩小选择范围。')
      add('wait_for', '需要时调整真实条件并使用有界等待；超时不等于加载失败或可以重复提交。')
    }
    // These are options under their existing protocols and confirmation rules, never a fallback executor.
    if (context.otherTools.includes('read_files')) paths.push({ tool: 'read_files', action: null, purpose: '若任务有已知文件产物，读取真实文件核对内容；附件发送或打开成功不等于业务完成。' })
    if (context.otherTools.includes('command')) paths.push({ tool: 'command', action: null, purpose: '若任务适合命令／脚本，可按原工具及确认规则诊断或处理；先检查已生效事实，不重复提交、启动或保存。' })
  }
  const guidance = halted ? result.progress_control!.guidance : ended ? '尊重取消和会话失效，不自动恢复或向其他任务发送诊断。'
    : category === 'protocol_error' ? '按当前动作定义修正请求；不要猜测引用、增加权限或改变现有确认规则。'
      : category === 'partial_observation' ? '部分控件树不能证明目标不存在；可换窗口截图、缩小观察范围或使用其他实际可用工具。'
        : category === 'loading_timeout' ? timedOut ? '本步达到执行期限，已请求取消并等待真实回执；是否生效仍以 execution 和后状态为准。先核对再选择方法或工具，不因超时重放。'
          : '只确认等待条件未在期限内满足，不能据此断言加载故障；先查状态，再决定调整条件、继续等待或换工具。'
          : category === 'verification_required' ? '目标尚未完成；按 completion_report 的 blockers、未确认事项和逐项检查继续取得真实证据。文件内容用原 read_files 核对，后台依赖用实际等待结果核对；只有界面事实不足或后状态未知时重新观察，不为核对报告重做原输入。'
          : '由模型结合实际错误和最新观察诊断并选择下一步；常规窗口定位、焦点修复和方法调整继续自主处理，不直接要求用户代操作。确需缺失资料或授权时沿用原有提问与确认规则。'
  return { version: 1, category, basis: 'structured_tool_result', facts: { action: result.action, code: result.code, execution: result.execution,
    post_observation_failed: postFailed, latest_observation: observation }, may_have_side_effects: mayHaveEffects, requires_fresh_observation: verify,
    same_action_retry: ended || halted ? 'stop' : readOnly.has(result.action) ? 'read_only_after_scope_check' : mayHaveEffects ? 'verify_effect_first' : 'after_correction',
    candidate_paths: paths, guidance, model_selects_next_step: true, goal_verified: false }
}
