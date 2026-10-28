import { useEffect, useRef, useState } from 'react'
import type { JSX, FormEvent } from 'react'
import type { ConversationToolsOwner } from '@shared/conversation-tools'
import { scheduleLabel } from '@shared/scheduled-tasks'
import type { ScheduledTask, ScheduledTaskAction, ScheduledTasksState, TaskSchedule, ScheduledRunStatus } from '@shared/scheduled-tasks'
import './ScheduledTasksPane.css'

const STATUS: Record<ScheduledRunStatus, string> = {
  pending: '等待投递', sending: '投递中', sent: '已投递', 'needs-attention': '需要核对', cancelled: '已取消', skipped: '已跳过'
}
const formatTime = (value: number): string => new Date(value).toLocaleString()
const ownerKey = (owner: ConversationToolsOwner): string => JSON.stringify([owner.sessionId, owner.platformId, owner.conversationId])
type Cycle = 'interval' | 'daily' | 'weekdays' | 'weekly' | 'cron'

export default function ScheduledTasksPane({ owner, visible }: { owner: ConversationToolsOwner; visible: boolean }): JSX.Element {
  const [state, setState] = useState<ScheduledTasksState | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<{ owner: ConversationToolsOwner; requestId: string; task?: ScheduledTask } | null>(null)
  const [cycle, setCycle] = useState<Cycle>('interval')
  const [interval, setIntervalValue] = useState('30')
  const [unit, setUnit] = useState('1')
  const [time, setTime] = useState('09:00')
  const [weekday, setWeekday] = useState('1')
  const [expression, setExpression] = useState('0 9 * * 1-5')
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [prompt, setPrompt] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const locked = useRef(false)
  const scope = useRef({ active: true, owner: ownerKey(owner) })
  scope.current.owner = ownerKey(owner)

  useEffect(() => {
    const current = { active: true, owner: ownerKey(owner) }
    scope.current = current
    let version = 0
    setState(null); setError('')
    const off = window.api.onScheduledTasksChanged((next, sessionId) => {
      if (!current.active || sessionId !== owner.sessionId) return
      version++; setState(next); setError('')
    })
    void window.api.getScheduledTasks(owner.sessionId).then(next => {
      if (current.active && version === 0) setState(next)
    }).catch(reason => { if (current.active && version === 0) setError(reason instanceof Error ? reason.message : '读取失败，请重试。') })
    return () => { current.active = false; off() }
  }, [owner.sessionId, reload])

  const openEditor = (task?: ScheduledTask): void => {
    setEditor({ owner: { ...owner }, requestId: crypto.randomUUID(), task })
    setPrompt(task?.prompt ?? ''); setError(''); setDeleteId(null)
    const schedule = task?.schedule
    if (schedule?.kind === 'cron') {
      setCycle('cron'); setExpression(schedule.expression); setTimeZone(schedule.timeZone)
    } else {
      setCycle('interval'); setIntervalValue(String(schedule?.minutes ?? 30)); setUnit('1')
      setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
    }
  }
  const operate = async (work: () => Promise<ScheduledTasksState>, complete?: () => void): Promise<void> => {
    if (locked.current) return
    const current = scope.current, key = ownerKey(owner)
    locked.current = true; setBusy(true); setError('')
    try {
      const next = await work()
      if (current.active && current.owner === key) { setState(next); complete?.() }
    } catch (reason) {
      if (current.active && current.owner === key) setError(reason instanceof Error ? reason.message : '操作失败，请重试。')
    } finally { locked.current = false; if (current.active) setBusy(false) }
  }
  const save = (event: FormEvent): void => {
    event.preventDefault()
    if (!editor || ownerKey(editor.owner) !== ownerKey(owner)) { setError('当前对话已变化，请取消后重新新建或编辑。'); return }
    let schedule: TaskSchedule
    if (cycle === 'interval') {
      const minutes = Number(interval) * Number(unit)
      if (!interval.trim() || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 5_256_000) { setError('请输入有效周期，最短 1 分钟。'); return }
      schedule = { kind: 'interval', minutes }
    } else {
      const [hour, minute] = time.split(':').map(Number)
      if (cycle !== 'cron' && (!Number.isInteger(hour) || !Number.isInteger(minute))) { setError('请选择触发时间。'); return }
      schedule = { kind: 'cron', expression: cycle === 'cron' ? expression : `${minute} ${hour} * * ${cycle === 'daily' ? '*' : cycle === 'weekdays' ? '1-5' : weekday}`, timeZone }
    }
    void operate(() => window.api.saveScheduledTask({ owner: editor.owner, requestId: editor.requestId,
      ...(editor.task ? { id: editor.task.id, revision: editor.task.revision } : {}), schedule, prompt }), () => setEditor(null))
  }
  const act = (task: ScheduledTask, action: ScheduledTaskAction, runId?: string): void => {
    void operate(() => window.api.actOnScheduledTask(owner.sessionId, task.id, action, runId), () => {
      if (action === 'delete') { setDeleteId(null); if (selectedId === task.id) setSelectedId(null); if (editor?.task?.id === task.id) setEditor(null) }
    })
  }
  const currentEditor = !editor || ownerKey(editor.owner) === ownerKey(owner)

  return <section className="scheduled-tasks panel__view" hidden={!visible} aria-label="定时任务">
    <div className="scheduled-tasks__heading">
      <strong>定时任务</strong>
      <span>{state ? `${state.tasks.filter(task => task.enabled).length} 个已启用` : '读取中…'}</span>
      <button type="button" disabled={busy || !owner.conversationId} onClick={() => openEditor()}>新建计划</button>
    </div>
    <div className="scheduled-tasks__body">
      {!owner.conversationId ? <p className="scheduled-tasks__notice">先在当前 AI 对话发送一条消息，即可为这个对话创建计划。</p> : null}
      {error ? <div className="scheduled-tasks__error" role="alert"><p>{error}</p>
        {!state ? <button type="button" onClick={() => setReload(value => value + 1)}>重新加载</button> : null}</div> : null}
      {editor ? <form className="scheduled-tasks__form" onSubmit={save}>
        <h3>{editor.task ? '编辑计划' : '新建计划'}</h3>
        {!currentEditor ? <p className="scheduled-tasks__error">当前对话已变化。已保留输入，请取消后重新打开表单。</p> : null}
        <fieldset disabled={busy || !currentEditor}>
          <legend>任务周期</legend>
          <div className="scheduled-tasks__cycle">
            <select aria-label="周期类型" value={cycle} onChange={event => setCycle(event.target.value as Cycle)}>
              <option value="interval">固定间隔</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="cron">Cron 表达式</option>
            </select>
            {cycle === 'interval' ? <><input aria-label="间隔数值" type="number" min="1" step="1" required value={interval} onChange={event => setIntervalValue(event.target.value)} />
              <select aria-label="间隔单位" value={unit} onChange={event => setUnit(event.target.value)}><option value="1">分钟</option><option value="60">小时</option><option value="1440">天</option></select></>
              : cycle === 'cron' ? <input aria-label="五段 Cron 表达式" value={expression} maxLength={120} required placeholder="0 9 * * 1-5" onChange={event => setExpression(event.target.value)} />
                : <>{cycle === 'weekly' ? <select aria-label="每周触发日" value={weekday} onChange={event => setWeekday(event.target.value)}>
                  {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, index) => <option key={index} value={index}>{label}</option>)}</select> : null}
                <input aria-label="触发时间" type="time" value={time} required onChange={event => setTime(event.target.value)} /></>}
          </div>
          {cycle !== 'interval' ? <label className="scheduled-tasks__timezone">时区<input value={timeZone} maxLength={100} required onChange={event => setTimeZone(event.target.value)} /></label> : null}
        </fieldset>
        <label className="scheduled-tasks__prompt">任务描述<textarea value={prompt} maxLength={16000} required rows={5}
          disabled={busy || !currentEditor} placeholder="例如：检查当前项目的后台服务状态，发现异常时分析原因并告诉我。"
          onChange={event => setPrompt(event.target.value)} /></label>
        <div className="scheduled-tasks__actions"><button type="button" disabled={busy} onClick={() => setEditor(null)}>取消</button>
          <button type="submit" className="scheduled-tasks__primary" disabled={busy || !currentEditor || !prompt.trim()}>{busy ? '保存中…' : '保存计划'}</button></div>
      </form> : null}
      {!state && !error ? <p role="status" className="scheduled-tasks__notice">正在读取定时计划…</p> : null}
      <div className="scheduled-tasks__list">
        {state?.tasks.map(task => {
          const runs = state.runs.filter(run => run.taskId === task.id)
          const latest = runs.find(run => run.kind === 'task')
          const outstanding = runs.some(run => run.kind === 'task' && ['pending', 'sending', 'needs-attention'].includes(run.status))
          const expanded = selectedId === task.id
          return <article className="scheduled-tasks__task" key={task.id}>
            <button type="button" className="scheduled-tasks__open" aria-expanded={expanded} onClick={() => setSelectedId(expanded ? null : task.id)}>
              <span className="scheduled-tasks__title">{task.prompt.split('\n')[0].slice(0, 100)}{task.prompt.split('\n')[0].length > 100 ? '…' : ''}<span>{task.enabled ? '已启用' : '已暂停'}</span></span>
              <span className="scheduled-tasks__meta">{scheduleLabel(task.schedule)}</span>
              <span className="scheduled-tasks__meta">{task.enabled ? `下次：${formatTime(task.nextRunAt)}` : '恢复后重新计算下次时间'}</span>
              {latest ? <span className="scheduled-tasks__run-state" data-status={latest.status}>{STATUS[latest.status]} · {latest.message}</span> : null}
            </button>
            <div className="scheduled-tasks__actions">
              <button type="button" disabled={busy} onClick={() => act(task, task.enabled ? 'pause' : 'resume')}>{task.enabled ? '暂停' : '恢复'}</button>
              <button type="button" disabled={busy || !task.enabled || outstanding} title={outstanding ? '先处理已有运行' : '加入投递队列，不改变周期'} onClick={() => act(task, 'run')}>立即运行</button>
              <button type="button" disabled={busy} onClick={() => openEditor(task)}>编辑</button>
              {deleteId === task.id ? <><button type="button" className="scheduled-tasks__danger" disabled={busy} onClick={() => act(task, 'delete')}>确认删除</button><button type="button" disabled={busy} onClick={() => setDeleteId(null)}>取消</button></>
                : <button type="button" disabled={busy} onClick={() => setDeleteId(task.id)}>删除</button>}
            </div>
            {expanded ? <div className="scheduled-tasks__detail">
              <p className="scheduled-tasks__full-prompt">{task.prompt}</p>
              <dl><dt>绑定对话</dt><dd>{task.owner.platformId} · {task.owner.conversationId}{ownerKey(task.owner) === ownerKey(owner) ? '（当前对话）' : ''}</dd>
                <dt>执行目标</dt><dd>{task.target.label} · {task.target.cwd}</dd><dt>任务编号</dt><dd>{task.id}</dd></dl>
              <h4>最近运行</h4>
              {!runs.length ? <p className="scheduled-tasks__hint">尚未触发。创建计划不会立即执行任务。</p> : null}
              {runs.filter((run, index) => index < 12 || ['pending', 'sending', 'needs-attention'].includes(run.status)).map(run => <div className="scheduled-tasks__history" key={run.id}>
                <span className="scheduled-tasks__run-state" data-status={run.status}>{run.kind === 'receipt' ? '创建确认' : formatTime(run.plannedAt)} · {STATUS[run.status]}</span>
                <p>{run.message}</p>
                {run.sentAt ? <p>投递时间：{formatTime(run.sentAt)}</p> : null}
                {run.missedSince !== null ? <p>从 {formatTime(run.missedSince)} 起错过的周期已合并。</p> : null}
                {run.status === 'needs-attention' ? <div className="scheduled-tasks__actions"><button type="button" disabled={busy} onClick={() => act(task, 'confirm-sent', run.id)}>确认已投递</button>
                  <button type="button" disabled={busy} onClick={() => act(task, 'skip', run.id)}>跳过本次</button></div> : null}
              </div>)}
            </div> : null}
          </article>
        })}
      </div>
    </div>
  </section>
}
