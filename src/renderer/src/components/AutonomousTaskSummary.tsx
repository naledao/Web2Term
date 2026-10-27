import type { AutonomousTaskState } from '@shared/autonomous-task'
import { useState } from 'react'
import { PROGRESS_STOP_MESSAGES } from '@shared/computer-progress'
import { supportsComputerUsePlatform } from '@shared/computer-use'
import { pendingTaskQuestion } from '@shared/task-clarification'
import TaskActivityPanel, { TaskArtifactEntry } from './TaskActivityPanel'
import './AutonomousTaskSummary.css'

export default function AutonomousTaskSummary({ state }: { state: AutonomousTaskState | null }) {
  if (!state) return null
  return <TaskDetails key={JSON.stringify([state.sessionId, state.platformId, state.conversationId, state.task?.id, state.task?.generation])} state={state} />
}

function TaskDetails({ state }: { state: AutonomousTaskState }) {
  const { task, error } = state
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState('')
  const [openingQuestion, setOpeningQuestion] = useState(false)
  const [activityVisible, setActivityVisible] = useState(false)
  const question = task ? pendingTaskQuestion(task) : null
  const uncertainAnswer = task?.status === 'recorded' && question?.state === 'uncertain'
  const canResume = supportsComputerUsePlatform(state.platformId) && !!state.conversationId && task && !task.control?.halted &&
    (task.status === 'interrupted' || task.status === 'stopped' || uncertainAnswer || task.status === 'recorded' && task.progress?.phase === 'blocked')
  const openQuestion = async () => {
    if (!task || !question || !state.conversationId || openingQuestion) return
    setOpeningQuestion(true); setResumeError('')
    try { setResumeError(await window.api.reopenTaskQuestion({ sessionId: state.sessionId, platformId: state.platformId,
      conversationId: state.conversationId, taskId: task.id, generation: task.generation, questionId: question.id })) }
    catch { setResumeError('未能打开原问题，请核对当前会话。') }
    finally { setOpeningQuestion(false) }
  }
  const resume = async () => {
    if (!task || !state.conversationId || resuming) return
    setResuming(true); setResumeError('')
    try { setResumeError(await window.api.resumeAutonomousTask({ sessionId: state.sessionId, platformId: state.platformId,
      conversationId: state.conversationId, taskId: task.id, generation: task.generation })) }
    catch { setResumeError('未能取得恢复请求的回执，请核对原对话后再操作。') }
    finally { setResuming(false) }
  }
  const phases = { 'waiting-model': '等待模型回复', 'waiting-tool': '等待工具执行', 'executing-tool': '正在执行工具步骤',
    'waiting-delivery': '等待结果回传', 'waiting-user': '等待问题回答', responded: '模型已回复', blocked: '自动推进受阻', interrupted: '推进已中断', completed: '任务已完成' }
  const takeover = task?.status === 'stopped' && task.stop?.reason === 'human-takeover'
  const label = takeover ? '人工接管 · 任务已暂停' : task?.status === 'completed' ? '任务已完成' : task?.status === 'recorded' ? (task.progress ? phases[task.progress.phase] : '目标已记录') : task?.status === 'stopped' ? '任务已停止'
    : task?.status === 'interrupted' ? '任务已中断' : '目标已替换'
  return <div className="autonomous-task-summary">
    {error ? <p className="autonomous-task-summary__error" role="alert">{error}</p> : null}
    {task ? <details key={task.id} open={takeover || task.status === 'recorded' && !!question || undefined} onToggle={event => setActivityVisible(event.currentTarget.open)}>
      <summary>
        <span role="status">{label}</span>
        <span className="autonomous-task-summary__meta">第 {task.generation} 代 · {task.machine.label}</span>
      </summary>
      <p className="autonomous-task-summary__goal">{task.originalRequest}</p>
      <dl>
        <div><dt>任务编号</dt><dd>{task.id}</dd></div>
        <div><dt>执行环境</dt><dd>{task.machine.platform === 'win32' ? 'Windows' : task.machine.platform} {task.machine.arch} · 本机</dd></div>
        <div><dt>工作目录</dt><dd>{task.machine.workingDirectory || '尚未取得'}</dd></div>
        <div><dt>条件与产物</dt><dd>随用户原始要求完整保存。</dd></div>
        {task.control ? <div><dt>运行预算</dt><dd>{task.control.steps}／{task.control.limits.maxSteps} 步 · 恢复 {task.control.recoverySteps}／{task.control.limits.maxRecoverySteps} 步</dd></div> : null}
        {task.progress ? <div><dt>工具步骤</dt><dd>已接收 {task.progress.stepCount} 步{task.progress.currentStep
          ? ` · 最近动作：${task.progress.currentStep.action}（${task.progress.currentStep.execution === 'not_executed' ? '未执行'
            : task.progress.currentStep.execution === 'executed' ? '执行器已返回' : '执行结果未确认'}）` : ''}</dd></div> : null}
      </dl>
      {task.inputs.filter(input => input.kind === 'clarification').map(input =>
        <p className="autonomous-task-summary__goal" key={input.id}>补充要求：{input.text}</p>)}
      <p className="autonomous-task-summary__meta">{task.control?.halted ? PROGRESS_STOP_MESSAGES[task.control.halted] : task.status === 'recorded'
        ? task.progress?.detail ?? '保留同一任务上下文；收到可用工具的实际结果后由模型决定下一步。'
        : '已保存任务要求；重新打开会话不会自动执行。'}</p>
      {task.stop ? <p className="autonomous-task-summary__meta">{takeover ? '人工接管后等待你明确继续；继续时会重新观察桌面' : task.stop.reason === 'global-emergency' ? '因全局急停结束' : '用户已结束任务'}；已发生的操作没有回滚，后台进程保持独立运行。</p> : null}
      {task.recovery?.requiresObservation ? <p className="autonomous-task-summary__meta">恢复检查：需要重新观察实际界面，再决定后续桌面操作。</p> : null}
      {task.recovery ? <p className="autonomous-task-summary__meta">恢复记录：来自第 {task.recovery.sourceGeneration} 代 · 检查点 {new Date(task.recovery.checkpointAt).toLocaleString('zh-CN', { hour12: false })}
        {!task.recovery.requiresObservation ? ' · 已取得本次恢复所需的新观察，后续步骤仍按实际结果推进。' : ''}</p> : null}
      {question && task.status === 'recorded' ? <section aria-label="必要澄清与任务内授权">
        <p>{question.state === 'uncertain' ? '回答发送尚未确认，请在原对话核对；未知不会视为同意，也不会重复提交。核对后可关闭问题并恢复原任务。'
          : question.state === 'sending' ? '正在提交回答，等待原会话确认。' : question.state === 'dismissed' ? '问题已关闭，原任务继续等待回答。' : '原任务等待必要信息或任务内授权。'}</p>
        <p>{question.questions[0]?.question.slice(0, 240)}{question.questions[0]?.question.length > 240 ? '…' : ''}{question.questions.length > 1 ? `（共 ${question.questions.length} 题）` : ''}</p>
        {['pending', 'dismissed'].includes(question.state) ? <button type="button" className="terminal__prompt-link" disabled={openingQuestion || !!error} onClick={() => void openQuestion()}>
          {openingQuestion ? '正在打开问题…' : '查看并回答原问题'}
        </button> : null}
        <p className="autonomous-task-summary__meta">回答只约束原任务；执行开关和原确认规则继续生效，关闭问题不代表授权。</p>
      </section> : null}
      {task.clarifications?.items.filter(q => q.state === 'answered').slice(-3).map(q => <p key={q.id} className="autonomous-task-summary__meta">
        已收到原任务回答：{q.answer!.text.slice(0, 400)}{q.answer!.text.length > 400 ? '…（完整回答保存在任务要求中）' : ''}
      </p>)}
      {task.completion?.report ? <section aria-label="结果核对与产物">
        <p>{task.completion.report.state === 'delivered' ? '结果报告已交付' : task.completion.report.state === 'ready' ? task.status === 'recorded' ? '核对报告等待确认交付' : '核对报告未确认交付' : '目标尚未完成'}：{task.completion.report.summary}</p>
        {task.completion.report.requirements.map(r => <div key={r.input_id}>{r.checks.map((check, index) => <p key={index}>
          {check.status === 'passed' ? '模型核对通过' : check.status === 'failed' ? '核对未通过' : '尚未确认'} · {check.criterion}：{check.assessment}
        </p>)}</div>)}
        {task.completion.report.backgroundResolutions.map(r => <p key={r.background_id}>已替代的后台作业：{r.background_id} · {r.reason}</p>)}
        {task.completion.report.artifacts.map(a => <p key={a.evidenceId}>产物：{a.label}<br /><code>{a.path}</code><br />
          <span className="autonomous-task-summary__meta">文件快照已复核 · {a.sizeBytes} 字节</span>
          <TaskArtifactEntry key={`${task.generation}:${a.evidenceId}`} task={task} evidenceId={a.evidenceId} /></p>)}
        {!task.completion.report.artifacts.length && task.completion.report.noArtifactReason ? <p>{task.completion.report.noArtifactReason}</p> : null}
        {task.completion.report.unconfirmed.map((item, index) => <p key={index} className="autonomous-task-summary__error">未确认：{item}</p>)}
        {task.completion.report.blockers.map((item, index) => <p key={index} className="autonomous-task-summary__error">待处理：{item}</p>)}
      </section> : null}
      <TaskActivityPanel task={task} visible={activityVisible} />
      {canResume ? <button type="button" className="terminal__prompt-link" disabled={resuming || !!error} onClick={() => void resume()}>
        {resuming ? '正在发送恢复请求…' : takeover ? '继续原任务' : uncertainAnswer ? '核对后恢复原任务' : '恢复原任务'}
      </button> : null}
      {resumeError ? <p className="autonomous-task-summary__error" role="alert">{resumeError}</p> : null}
    </details> : null}
  </div>
}
