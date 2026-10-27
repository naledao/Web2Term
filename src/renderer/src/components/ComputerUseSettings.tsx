import type { JSX } from 'react'
import type { ComputerUseCapability, ComputerUsePreferences } from '@shared/computer-use'
import { resolveComputerUseCapability } from '@shared/computer-use'
import { platformById } from '@shared/platforms'
import { COMPUTER_PROGRESS_LIMIT_FIELDS, COMPUTER_PROGRESS_LIMIT_KEYS, MAX_COMPUTER_RESULT_DELAY_SECONDS, normalizeComputerProgressLimits, normalizeComputerResultDelay } from '@shared/computer-progress'
import './ComputerUseSettings.css'

interface Props {
  preferences: ComputerUsePreferences
  onChange(value: ComputerUsePreferences): void
  capability: ComputerUseCapability | null
  error: string
  disabled: boolean
}

export default function ComputerUseSettings({ preferences, onChange, capability, error, disabled }: Props): JSX.Element {
  const preview = capability ? resolveComputerUseCapability(preferences, capability.context, capability.actionDefinitions, capability.helper) : null
  const context = capability?.context
  const limits = preferences.computerUseLimits ?? normalizeComputerProgressLimits()
  const connection = context?.connection === 'local' ? '本机' : context?.connection === 'ssh' ? 'SSH'
    : context?.connection === 'web2term' ? 'Web2Term 远程设备' : '未选择会话'
  const host = context?.hostPlatform === 'win32' ? 'Windows' : context?.hostPlatform === 'darwin' ? 'macOS'
    : context?.hostPlatform === 'linux' ? 'Linux' : context?.hostPlatform
  return <div className="computer-use-settings">
    <p className="computer-use-settings__intro">在支持的会话中启用 computer use 并记录任务上下文。桌面能力以当前实际接入的动作为准。</p>
    <div className="settings-appearance-row">
      <div>
        <div className="settings-proxy-row__label" id="computer-use-computerUseEnabled-label">启用 computer use</div>
        <p className="computer-use-settings__hint" id="computer-use-computerUseEnabled-hint">启用此工具及任务上下文记录，同时允许桌面控制（发现和启动应用、截图及键鼠操作）和按桌面截图坐标点击任务栏、系统托盘等业务窗口以外的位置。终端、文件和后台任务工具沿用原有设置。</p>
      </div>
      {/* Desktop control and coordinate clicks follow this switch; they have no separate toggles. */}
      <button type="button" role="switch" aria-checked={preferences.computerUseEnabled}
        aria-labelledby="computer-use-computerUseEnabled-label" aria-describedby="computer-use-computerUseEnabled-hint"
        className={preferences.computerUseEnabled ? 'switch switch--on' : 'switch'} disabled={disabled}
        onClick={() => {
          const on = !preferences.computerUseEnabled
          onChange({ ...preferences, computerUseEnabled: on, desktopControlEnabled: on, desktopPointClickEnabled: on })
        }}>
        <span className="switch__knob" />
      </button>
    </div>
    <fieldset className="computer-use-settings__limits" disabled={disabled}>
      <legend>运行上限</legend>
      <p className="computer-use-settings__hint">用于新目标；恢复原任务沿用原预算。暂停和等待用户回答不计入任务时长。达到上限后保留未完成状态，不自动重新开始。</p>
      <div className="computer-use-settings__limit-grid">
        {COMPUTER_PROGRESS_LIMIT_KEYS.map(key => {
          const field = COMPUTER_PROGRESS_LIMIT_FIELDS[key]
          return <label key={key} className="computer-use-settings__limit">
            <span>{field.label}</span>
            <span><input type="number" min={field.min / field.unit} max={field.max / field.unit} step={1}
              value={limits[key] / field.unit} aria-label={`${field.label}（${field.suffix}）`}
              onChange={event => onChange({ ...preferences, computerUseLimits: { ...limits, [key]: Number(event.currentTarget.value) * field.unit } })} /> {field.suffix}</span>
          </label>
        })}
      </div>
      <p className="computer-use-settings__hint">单步时限从实际进入执行器起计；条件等待单独使用等待时限，并受任务剩余预算约束。</p>
    </fieldset>
    <fieldset className="computer-use-settings__limits" disabled={disabled}>
      <legend>结果回传</legend>
      <div className="computer-use-settings__limit-grid">
        <label className="computer-use-settings__limit">
          <span>回传间隔</span>
          <span><input type="number" min={0} max={MAX_COMPUTER_RESULT_DELAY_SECONDS} step={1}
            value={preferences.computerResultDelaySeconds ?? 0} aria-label="computer 结果回传间隔（秒）"
            onChange={event => onChange({ ...preferences, computerResultDelaySeconds: normalizeComputerResultDelay(event.currentTarget.value) })} /> 秒</span>
        </label>
      </div>
      <p className="computer-use-settings__hint">computer 动作返回后，等待这么多秒再把结果发给 AI，便于界面先稳定下来；0 表示立即回传。每个结果只等一次，重试回传不再等待，动作也不会重做。终端命令的回传等待仍在终端操作菜单中单独设置。</p>
    </fieldset>
    <dl className="computer-use-settings__facts">
      <div><dt>支持范围</dt><dd>DeepSeek、ChatGPT · Windows x64 · 本机会话</dd></div>
      <div><dt>当前客户端</dt><dd>{context ? `${host} ${context.hostArch}` : '正在读取…'}</dd></div>
      <div><dt>当前会话</dt><dd>{context ? `${platformById(context.platformId)?.label ?? '未选择模型'} · ${connection}` : '正在读取…'}</dd></div>
      <div><dt>视觉理解</dt><dd>截图直接作为图片发给网页端模型，无需额外 API Key。</dd></div>
    </dl>
    {error ? <p className="settings-feedback" role="alert">{error}</p>
      : <p className="computer-use-settings__state" role="status">{preview?.message ?? '正在读取当前环境的能力状态…'}</p>}
    <p className="computer-use-settings__hint">保存后更新已打开对话的能力说明。桌面执行器接入前，模型不会获得可调用的桌面动作。</p>
  </div>
}
