import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { BackgroundTask, BackgroundTasksState, BackgroundTaskStatus } from '@shared/background-tasks'
import './BackgroundTasksPane.css'

const STATUS_LABELS: Record<BackgroundTaskStatus, string> = {
  checking: '读取中', running: '运行中', completed: '已完成', failed: '失败', exited: '已结束', stopped: '已停止', unknown: '状态未知'
}

const finished = (task: BackgroundTask): boolean => ['completed', 'failed', 'exited', 'stopped'].includes(task.status)
const timeLabel = (time: number): string => new Date(time).toLocaleString()
function taskStatusLabel(task: BackgroundTask): string {
  if (task.backgroundOptions?.kind === 'service' && task.status === 'completed') return '已结束'
  if (finished(task) || task.status !== 'running' || task.backgroundOptions?.kind !== 'service') return STATUS_LABELS[task.status]
  return task.startup?.state === 'ready' ? '已就绪 · 运行中' : task.startup?.state === 'timeout' ? '就绪未确认' : '启动中'
}

export default function BackgroundTasksPane({ sessionId, visible }: { sessionId: string; visible: boolean }): JSX.Element {
  const [state, setState] = useState<BackgroundTasksState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showFinished, setShowFinished] = useState(false)
  const [selectedLog, setSelectedLog] = useState<'stdout' | 'stderr'>('stdout')
  const [followOutput, setFollowOutput] = useState(true)
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set())
  const [stopErrors, setStopErrors] = useState<Record<string, string>>({})
  const stopLocks = useRef(new Set<string>())
  const stopScope = useRef({ active: true })
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scope = { active: true }
    stopScope.current = scope
    setState(null)
    setSelectedId(null)
    setStoppingIds(new Set())
    setStopErrors({})
    return () => { scope.active = false }
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    let revision = 0
    setLoadError('')
    const off = window.api.onBackgroundTasksChanged((next, ownerId) => {
      if (ownerId !== sessionId || cancelled) return
      revision += 1
      setState(next)
      setLoadError('')
    })
    void window.api.getBackgroundTasks(sessionId).then(next => {
      if (!cancelled && revision === 0) setState(next)
    }).catch(() => {
      if (!cancelled && revision === 0) setLoadError('后台任务读取失败，请重试。')
    })
    return () => { cancelled = true; off() }
  }, [sessionId, reload])

  const tasks = useMemo(() => [...(state?.tasks ?? [])].sort((a, b) => b.createdAt - a.createdAt), [state])
  const selected = tasks.find(task => task.id === selectedId)
  const running = tasks.filter(task => !finished(task))
  const ended = tasks.filter(finished)
  const starting = running.filter(task => task.backgroundOptions?.kind === 'service' && task.startup?.state === 'starting')
  const output = selectedLog === 'stderr' ? selected?.errorOutput : selected?.output
  const truncated = selectedLog === 'stderr' ? selected?.errorOutputTruncated : selected?.outputTruncated

  useEffect(() => {
    if (visible && followOutput && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [visible, followOutput, selectedId, selectedLog, output])

  const openTask = (task: BackgroundTask): void => {
    setSelectedId(task.id)
    setSelectedLog('stdout')
    setFollowOutput(true)
  }

  const stopTask = async (task: BackgroundTask): Promise<void> => {
    if (finished(task) || task.stopRequestedAt !== undefined || stopLocks.current.has(task.id)) return
    const scope = stopScope.current
    stopLocks.current.add(task.id)
    setStoppingIds(ids => new Set(ids).add(task.id))
    setStopErrors(errors => { const next = { ...errors }; delete next[task.id]; return next })
    try {
      const result = await window.api.stopBackgroundTask(sessionId, task.id)
      if (scope.active && !result.ok) setStopErrors(errors => ({ ...errors, [task.id]: result.message }))
    } catch {
      if (scope.active) setStopErrors(errors => ({ ...errors, [task.id]: '停止结果尚未确认，请查看任务状态后重试。' }))
    } finally {
      stopLocks.current.delete(task.id)
      if (scope.active) setStoppingIds(ids => { const next = new Set(ids); next.delete(task.id); return next })
    }
  }

  return <section className="background-tasks panel__view" hidden={!visible} aria-label="后台任务">
    <div className="background-tasks__heading">
      {selected ? <button type="button" className="background-tasks__button" onClick={() => setSelectedId(null)}>‹ 任务列表</button> : <strong>后台任务</strong>}
      <span className="background-tasks__count">{starting.length > 0 ? `${starting.length} 个启动中 · ` : ''}{running.length - starting.length} 个运行中 · {ended.length} 个已结束</span>
    </div>
    {loadError ? <div className="background-tasks__notice" role="alert">{loadError} <button type="button" className="background-tasks__button" onClick={() => setReload(value => value + 1)}>重试</button></div> : null}
    {selected ? <>
      <div className="background-tasks__detail">
        <div className="background-tasks__title"><strong>{selected.name}</strong><span className="background-tasks__status" data-status={selected.status} data-startup={selected.startup?.state}>{taskStatusLabel(selected)}</span></div>
        <div className="background-tasks__meta">PID {selected.pid} · {selected.targetLabel}{selected.exitCode !== null ? ` · 退出码 ${selected.exitCode}` : ''}</div>
        {!finished(selected) ? <div className="background-tasks__detail-actions"><StopTaskButton task={selected} pending={stoppingIds.has(selected.id)} onStop={stopTask} /></div> : null}
        <details className="background-tasks__info">
          <summary>任务信息与日志路径</summary>
          <dl>
            <dt>启动时间</dt><dd>{timeLabel(selected.createdAt)}</dd>
            <dt>最近读取</dt><dd>{selected.checkedAt === null ? '尚未读取' : timeLabel(selected.checkedAt)}</dd>
            {selected.backgroundOptions?.kind === 'service' ? <><dt>就绪等待上限</dt><dd>{selected.backgroundOptions.readiness?.timeout_seconds ?? 120} 秒，仅用于启动确认；服务运行不限时。</dd></> : null}
            {selected.startup?.url ? <><dt>服务地址</dt><dd>{selected.startup.url}</dd></> : null}
            {selected.startup?.evidence ? <><dt>启动确认依据</dt><dd>{selected.startup.evidence}</dd></> : null}
            <dt>{selected.stderrPath ? '标准输出' : '输出日志'}</dt><dd>{selected.logPath}</dd>
            {selected.stderrPath ? <><dt>错误输出</dt><dd>{selected.stderrPath}</dd></> : null}
            {selected.exitCodePath ? <><dt>退出码文件</dt><dd>{selected.exitCodePath}</dd></> : null}
            <dt>启动命令</dt><dd><pre>{selected.command}</pre></dd>
          </dl>
        </details>
      </div>
      {stopErrors[selected.id] ? <p className="background-tasks__stop-error" role="alert">{stopErrors[selected.id]}</p> : null}
      {selected.message ? <p className="background-tasks__notice" role="status">{selected.message}</p> : null}
      {selected.creationDeliveryMessage ? <p className="background-tasks__notice" role="status">{selected.creationDeliveryMessage}</p> : null}
      {selected.readinessDeliveryMessage ? <p className="background-tasks__notice" role="status">{selected.readinessDeliveryMessage}</p> : null}
      {selected.timeoutDeliveryMessage && selected.startup?.state !== 'ready' ? <p className="background-tasks__notice" role="status">{selected.timeoutDeliveryMessage}</p> : null}
      {selected.deliveryMessage ? <p className="background-tasks__notice" role="status">{selected.deliveryMessage}</p> : null}
      <div className="background-tasks__log-tools" role="group" aria-label="日志视图">
        <button type="button" className="background-tasks__button" aria-pressed={selectedLog === 'stdout'} onClick={() => { setSelectedLog('stdout'); setFollowOutput(true) }}>{selected.stderrPath ? '标准输出' : '输出'}</button>
        {selected.stderrPath ? <button type="button" className="background-tasks__button" aria-pressed={selectedLog === 'stderr'} onClick={() => { setSelectedLog('stderr'); setFollowOutput(true) }}>错误输出</button> : null}
        <button type="button" className="background-tasks__button background-tasks__follow" aria-pressed={followOutput} onClick={() => setFollowOutput(value => !value)}>跟随输出</button>
      </div>
      {truncated ? <p className="background-tasks__notice">当前显示日志末尾 64 KiB，完整输出保留在上方日志文件中。</p> : null}
      <div ref={outputRef} className="background-tasks__output" tabIndex={0} aria-label={selectedLog === 'stderr' ? '后台错误输出' : '后台任务输出'} onScroll={event => {
        const element = event.currentTarget
        if (element.scrollHeight - element.clientHeight - element.scrollTop > 48) setFollowOutput(false)
      }}>
        {output ? <pre className="line">{output}</pre> : <p className="background-tasks__empty">{selected.status === 'checking' ? '正在读取输出…' : '暂时没有输出。'}</p>}
      </div>
    </> : <div className="background-tasks__list">
      {state === null && !loadError ? <p className="background-tasks__empty">正在读取后台任务…</p> : null}
      {running.map(task => <TaskRow key={task.id} task={task} onOpen={openTask} onStop={stopTask} pending={stoppingIds.has(task.id)} error={stopErrors[task.id]} />)}
      {ended.length > 0 ? <>
        <button type="button" className="background-tasks__history" aria-expanded={showFinished} onClick={() => setShowFinished(value => !value)}>{showFinished ? '收起' : '查看'}已结束任务（{ended.length}）</button>
        {showFinished ? ended.map(task => <TaskRow key={task.id} task={task} onOpen={openTask} onStop={stopTask} pending={false} />) : null}
      </> : null}
    </div>}
  </section>
}

function TaskRow({ task, onOpen, onStop, pending, error }: {
  task: BackgroundTask; onOpen: (task: BackgroundTask) => void; onStop: (task: BackgroundTask) => void; pending: boolean; error?: string
}): JSX.Element {
  return <article className="background-tasks__task">
    <button type="button" className="background-tasks__task-open" onClick={() => onOpen(task)} aria-label={`查看${task.name}的输出，PID ${task.pid}`}>
    <span className="background-tasks__title"><strong>{task.name}</strong></span>
    <span className="background-tasks__meta">PID {task.pid} · {task.targetLabel}</span>
    <span className="background-tasks__meta">{timeLabel(task.createdAt)}</span>
    {task.message ? <span className="background-tasks__row-message">{task.message}</span> : null}
    {task.creationDeliveryMessage ? <span className="background-tasks__row-message">{task.creationDeliveryMessage}</span> : null}
    {task.readinessDeliveryMessage ? <span className="background-tasks__row-message">{task.readinessDeliveryMessage}</span> : null}
    {task.timeoutDeliveryMessage && task.startup?.state !== 'ready' ? <span className="background-tasks__row-message">{task.timeoutDeliveryMessage}</span> : null}
    {task.deliveryMessage ? <span className="background-tasks__row-message">{task.deliveryMessage}</span> : null}
    </button>
    <div className="background-tasks__task-actions">
      <span className="background-tasks__status" data-status={task.status} data-startup={task.startup?.state}>{taskStatusLabel(task)}</span>
      <StopTaskButton task={task} pending={pending} onStop={onStop} />
    </div>
    {error ? <p className="background-tasks__stop-error" role="alert">{error}</p> : null}
  </article>
}

function StopTaskButton({ task, pending, onStop }: {
  task: BackgroundTask; pending: boolean; onStop: (task: BackgroundTask) => void
}): JSX.Element | null {
  if (finished(task)) return null
  const stopping = pending || task.stopInProgress || task.stopRequestedAt !== undefined
  return <button type="button" className="background-tasks__button background-tasks__stop" disabled={stopping}
    aria-label={`停止${task.name}，PID ${task.pid}`} onClick={() => onStop(task)}>{stopping ? '停止中…' : '停止'}</button>
}
