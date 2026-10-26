import { useEffect, useState } from 'react'
import type { AutonomousTask } from '@shared/autonomous-task'
import { samePresentationLease, taskPresentationLease } from '@shared/task-presentation'
import type { TaskActivity } from '@shared/task-presentation'
import './TaskActivityPanel.css'

const actions: Record<string, string> = { list_apps: '发现应用', launch_app: '启动应用', open: '打开资源', list_windows: '发现窗口',
  focus_window: '激活窗口', observe: '观察界面', validate_observation: '复核观察', click: '点击', type_text: '输入文字',
  press_key: '按键', scroll: '滚动', drag: '拖拽', inspect_interactions: '发现交互', wait_for: '等待条件', complete_task: '核对任务结果',
  command: '终端命令', read_files: '读取文件' }
const executions = { queued: '排队中', dispatching: '已派发，等待回执', completed: '执行器已正常返回', failed: '执行器报告失败', cancelled: '执行流程已取消', unknown: '执行结果未确认' }
const facts = { not_executed: '未执行', executed: '已有执行回执', unknown: '是否执行尚未确认' }
const deliveries = { pending: '等待回传', uploading: '正在上传截图', sending: '正在回传', sent: '已确认回传', failed: '回传失败', unknown: '回传未确认', uncertain: '回传未确认', cancelled: '回传已取消' }
const steps = { queued: '等待执行', executing: '执行中', 'result-ready': '结果已保存', delivered: '结果已回传', interrupted: '步骤已中断' }
const targets = { desktop: '桌面概览', window: '窗口截图', region: '区域截图', controls: '控件观察' }
const focus: Record<string, string> = { inside_target: '焦点在目标窗口内', outside_target: '焦点在目标窗口外', unavailable: '焦点不可读', changed: '读取时焦点发生变化' }
const dependencies = { waiting: '等待中', satisfied: '条件已满足', failed: '条件失败', unconfirmed: '尚未确认', 'timed-out': '等待超时', cancelled: '等待已取消' }
const time = (value: number | string): string => new Date(value).toLocaleString('zh-CN', { hour12: false })

/** Optional inspector: nothing in the execution loop waits for this component to mount or refresh. */
export default function TaskActivityPanel({ task, visible }: { task: AutonomousTask; visible: boolean }) {
  const [activity, setActivity] = useState<TaskActivity | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [showImage, setShowImage] = useState(false)
  const [image, setImage] = useState<{ id: string; url: string } | null>(null)
  const [imageError, setImageError] = useState('')
  const lease = taskPresentationLease(task), leaseKey = lease ? JSON.stringify(lease) : ''
  useEffect(() => {
    if (!visible || !lease) return
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        if (document.visibilityState !== 'hidden') {
          const result = await window.api.getTaskActivity(lease)
          if (!cancelled) {
            if (result && samePresentationLease(result.lease, lease)) { setActivity(result); setError('') }
            else { setActivity(null); setError('当前任务已变化或记录不可用，请重新展开当前任务。') }
          }
        }
      } catch { if (!cancelled) setError('进度暂时无法读取；任务仍按原流程运行。可刷新重试。') }
      finally { if (!cancelled) timer = setTimeout(() => void read(), 2000) }
    }
    void read()
    return () => { cancelled = true; clearTimeout(timer) }
  // The full lease key rejects stale replies after any session/conversation/task/generation switch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaseKey, visible, task.updatedAt, refresh])
  const observation = activity?.observation
  useEffect(() => {
    setImage(null); setImageError('')
    if (!visible || !showImage || !lease || !observation?.previewAvailable) return
    let cancelled = false
    const id = observation.observationId
    void window.api.getTaskObservationImage({ ...lease, observationId: id }).then(url => {
      if (cancelled) return
      if (url?.startsWith('data:image/png;base64,')) setImage({ id, url })
      else setImageError('截图预览已清理或过期；不会为展示重新截图。')
    }).catch(() => { if (!cancelled) setImageError('截图预览暂时无法读取，请收起后重试。') })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaseKey, visible, showImage, observation?.observationId, observation?.previewAvailable])
  if (!visible || !lease) return null
  const current = activity?.currentTool, app = activity?.application
  const observedWindow = observation && (observation.application || observation.windowTitle) ? observation : null
  const appName = observedWindow?.application || (observedWindow ? '已观察的目标窗口' : app?.executable) || '尚无已确认的应用记录'
  const appTitle = observedWindow ? observedWindow.windowTitle : app?.title
  const appTime = observedWindow?.observedAt ?? app?.confirmedAt
  return <section className="task-activity" aria-label="任务动作与最近观察">
    <div className="task-activity__heading"><h3>动作与观察</h3>
      <button type="button" className="terminal__prompt-link" onClick={() => setRefresh(n => n + 1)}>刷新进度</button>
    </div>
    {error ? <p className="autonomous-task-summary__error" role="status">{error}</p> : null}
    {!activity && !error ? <p role="status">正在读取已保存的进度…</p> : null}
    {activity ? <>
      <dl>
        <div><dt>最近应用</dt><dd>{appName}
          {appTitle ? <span className="task-activity__block">{appTitle}</span> : null}
          <span className="task-activity__note">{appTime !== undefined ? `最近确认于 ${time(appTime)}；仅代表当时的界面。` : '以实际观察或焦点回执为准；启动请求不代表已进入应用。'}</span>
        </dd></div>
        <div><dt>当前步骤</dt><dd>{current ? `${actions[current.action] ?? current.action} · ${steps[current.status]} · ${facts[current.execution]} · ${deliveries[current.delivery]}` : '暂无工具步骤'}</dd></div>
      </dl>
      <div className="task-activity__observation">
        <h4>最近观察</h4>
        {observation ? <>
          <p>{targets[observation.target]} · <time dateTime={observation.observedAt}>{time(observation.observedAt)}</time>
            {observation.width ? ` · ${observation.width} × ${observation.height}` : ''}</p>
          {observation.controls ? <p>读取到 {observation.controls.count} 个控件 · {observation.controls.complete ? '本次范围内读取完整' : '部分读取'} · {focus[observation.controls.focus] ?? '焦点状态不可读'}</p> : null}
          <p className="task-activity__note">这是已采集的历史观察。界面可能已变化，任务后续操作仍需按原规则复核。</p>
          {observation.previewAvailable ? <button type="button" className="terminal__prompt-link" aria-expanded={showImage} onClick={() => setShowImage(v => !v)}>{showImage ? '收起截图' : '查看最近截图'}</button> : null}
          {showImage && observation.previewAvailable ? image?.id === observation.observationId
            ? <figure><img src={image.url} alt={`${targets[observation.target]}，采集于 ${time(observation.observedAt)}${observation.windowTitle ? `，${observation.windowTitle}` : ''}`} />
              <figcaption>{observation.windowTitle ?? targets[observation.target]} · {time(observation.observedAt)}</figcaption></figure>
            : <p role="status">{imageError || '正在读取截图预览…'}</p> : null}
        </> : <p className="task-activity__note">暂无可展示的观察缓存；尚未采集、重启或缓存过期时均可能出现此状态。任务不会因此重新截图。</p>}
      </div>
      <h4>最近桌面动作{activity.hasMoreActions ? '（仅展示最近 50 条）' : ''}</h4>
      <p className="task-activity__note">执行、回传与业务完成分别记录。执行器返回或结果已发送均不代表用户目标完成。</p>
      {activity.actions.length ? <ol className="task-activity__actions">{activity.actions.map(action => <li key={action.id}>
        <div className="task-activity__action-title"><strong>{action.kind === 'feedback' ? '请求校验反馈' : actions[action.action] ?? action.action}</strong><time dateTime={new Date(action.createdAt).toISOString()}>{time(action.createdAt)}</time></div>
        <span>{executions[action.state]} · {facts[action.execution]}</span>
        <span className="task-activity__block">{deliveries[action.delivery]}{action.deliveryAttempts ? ` · 回传尝试 ${action.deliveryAttempts} 次` : ''}</span>
      </li>)}</ol> : <p>暂无桌面动作记录。终端和文件工具的最近状态显示在当前步骤中。</p>}
      {task.backgroundDependencies?.length ? <><h4>后台依赖</h4><ul className="task-activity__dependencies">{task.backgroundDependencies.slice(-5).map(d => <li key={`${d.backgroundId}:${d.waitingStepId}`}>
        {d.condition === 'background_ready' ? '等待服务就绪' : '等待后台任务结束'} · {dependencies[d.state]}<span className="task-activity__note">{d.backgroundId}</span>
      </li>)}</ul></> : null}
      <p className="task-activity__note">进度读取于 {time(activity.readAt)}；展开时自动刷新。查看、收起或刷新均不影响任务执行。</p>
    </> : null}
  </section>
}

export function TaskArtifactEntry({ task, evidenceId }: { task: AutonomousTask; evidenceId: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const reveal = async () => {
    const lease = taskPresentationLease(task)
    if (!lease || busy) return
    setBusy(true); setError('')
    try { setError(await window.api.revealTaskArtifact({ ...lease, evidenceId })) }
    catch { setError('产物位置暂时无法打开，请按报告中的路径查找。') }
    finally { setBusy(false) }
  }
  return <span className="task-activity__block">
    <button type="button" className="terminal__prompt-link" disabled={busy || !task.conversationId} onClick={() => void reveal()}>{busy ? '正在核对文件…' : '在文件夹中显示'}</button>
    {error ? <span className="autonomous-task-summary__error task-activity__block" role="status">{error}</span> : null}
  </span>
}
