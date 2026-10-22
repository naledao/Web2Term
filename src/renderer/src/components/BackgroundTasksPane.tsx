import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { BackgroundTask, BackgroundTasksState, BackgroundTaskStatus } from '@shared/background-tasks'
import './BackgroundTasksPane.css'

const STATUS_LABELS: Record<BackgroundTaskStatus, string> = {
  checking: '读取中', running: '运行中', completed: '已完成', failed: '失败', exited: '已结束', unknown: '状态未知'
}

const finished = (task: BackgroundTask): boolean => ['completed', 'failed', 'exited'].includes(task.status)
const timeLabel = (time: number): string => new Date(time).toLocaleString()

export default function BackgroundTasksPane({ sessionId, visible }: { sessionId: string; visible: boolean }): JSX.Element {
  const [state, setState] = useState<BackgroundTasksState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showFinished, setShowFinished] = useState(false)
  const [selectedLog, setSelectedLog] = useState<'stdout' | 'stderr'>('stdout')
  const [followOutput, setFollowOutput] = useState(true)
  const outputRef = useRef<HTMLDivElement>(null)

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

  return <section className="background-tasks panel__view" hidden={!visible} aria-label="后台任务">
    <div className="background-tasks__heading">
      {selected ? <button type="button" className="background-tasks__button" onClick={() => setSelectedId(null)}>‹ 任务列表</button> : <strong>后台任务</strong>}
      <span className="background-tasks__count">{running.length} 个待完成 · {ended.length} 个已结束</span>
    </div>
    {loadError ? <div className="background-tasks__notice" role="alert">{loadError} <button type="button" className="background-tasks__button" onClick={() => setReload(value => value + 1)}>重试</button></div> : null}
    {selected ? <>
      <div className="background-tasks__detail">
        <div className="background-tasks__title"><strong>{selected.name}</strong><span className="background-tasks__status" data-status={selected.status}>{STATUS_LABELS[selected.status]}</span></div>
        <div className="background-tasks__meta">PID {selected.pid} · {selected.targetLabel}{selected.exitCode !== null ? ` · 退出码 ${selected.exitCode}` : ''}</div>
        <details className="background-tasks__info">
          <summary>任务信息与日志路径</summary>
          <dl>
            <dt>启动时间</dt><dd>{timeLabel(selected.createdAt)}</dd>
            <dt>最近读取</dt><dd>{selected.checkedAt === null ? '尚未读取' : timeLabel(selected.checkedAt)}</dd>
            <dt>{selected.stderrPath ? '标准输出' : '输出日志'}</dt><dd>{selected.logPath}</dd>
            {selected.stderrPath ? <><dt>错误输出</dt><dd>{selected.stderrPath}</dd></> : null}
            {selected.exitCodePath ? <><dt>退出码文件</dt><dd>{selected.exitCodePath}</dd></> : null}
            <dt>启动命令</dt><dd><pre>{selected.command}</pre></dd>
          </dl>
        </details>
      </div>
      {selected.message ? <p className="background-tasks__notice" role="status">{selected.message}</p> : null}
      {selected.creationDeliveryMessage ? <p className="background-tasks__notice" role="status">{selected.creationDeliveryMessage}</p> : null}
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
      {running.map(task => <TaskRow key={task.id} task={task} onOpen={openTask} />)}
      {ended.length > 0 ? <>
        <button type="button" className="background-tasks__history" aria-expanded={showFinished} onClick={() => setShowFinished(value => !value)}>{showFinished ? '收起' : '查看'}已结束任务（{ended.length}）</button>
        {showFinished ? ended.map(task => <TaskRow key={task.id} task={task} onOpen={openTask} />) : null}
      </> : null}
    </div>}
  </section>
}

function TaskRow({ task, onOpen }: { task: BackgroundTask; onOpen: (task: BackgroundTask) => void }): JSX.Element {
  return <button type="button" className="background-tasks__task" onClick={() => onOpen(task)} aria-label={`查看${task.name}的输出，PID ${task.pid}`}>
    <span className="background-tasks__title"><strong>{task.name}</strong><span className="background-tasks__status" data-status={task.status}>{STATUS_LABELS[task.status]}</span></span>
    <span className="background-tasks__meta">PID {task.pid} · {task.targetLabel}</span>
    <span className="background-tasks__meta">{timeLabel(task.createdAt)}</span>
    {task.message ? <span className="background-tasks__row-message">{task.message}</span> : null}
    {task.creationDeliveryMessage ? <span className="background-tasks__row-message">{task.creationDeliveryMessage}</span> : null}
    {task.deliveryMessage ? <span className="background-tasks__row-message">{task.deliveryMessage}</span> : null}
  </button>
}
