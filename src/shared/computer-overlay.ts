import type { AutonomousTask } from './autonomous-task'
import type { TaskActivity } from './task-presentation'

export const COMPUTER_OVERLAY_GET = 'computer-overlay:get'
export const COMPUTER_OVERLAY_CHANGED = 'computer-overlay:changed'
export const COMPUTER_OVERLAY_FIT = 'computer-overlay:fit'
export const COMPUTER_OVERLAY_COMPLETION_MS = 6_000

export interface ComputerOverlaySnapshot {
  taskKey: string
  goal: string
  status: string
  tone: 'idle' | 'running' | 'waiting' | 'success' | 'error'
  completed: boolean
  action: string
  actionStatus: string
  steps: number
  target: string
  targetAt: number | null
  result: string
  resultTone: 'idle' | 'success' | 'error'
  updatedAt: number
}

export interface ComputerOverlayApi {
  getSnapshot(): Promise<ComputerOverlaySnapshot | null>
  onChanged(listener: (snapshot: ComputerOverlaySnapshot | null) => void): () => void
  fitContent(size: { width: number; height: number }): void
}

const actionLabels: Record<string, string> = {
  list_apps: '查找应用', launch_app: '启动应用', open: '打开资源', list_windows: '查找窗口',
  focus_window: '激活窗口', observe: '观察界面', validate_observation: '复核观察', click: '点击目标',
  type_text: '输入文字', press_key: '发送按键', scroll: '滚动页面', drag: '拖拽目标',
  inspect_interactions: '查找弹窗或菜单', wait_for: '等待条件满足', complete_task: '核对任务结果',
  command: '执行终端命令', read_files: '读取文件'
}
const phases = {
  'waiting-model': '等待模型回复', 'waiting-tool': '等待执行', 'executing-tool': '执行中',
  'waiting-delivery': '等待结果回传', 'waiting-user': '等待你的回答', responded: '模型已回复',
  blocked: '需要处理', interrupted: '已中断', completed: '已完成'
}
const short = (text: string, length: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > length ? line.slice(0, length - 1) + '…' : line
}

const taskKey = (task: AutonomousTask): string => JSON.stringify([task.sessionId, task.platformId, task.conversationId, task.id, task.generation])

/** Display lifetime only. Historical completions never open a new native window. */
export class ComputerOverlayLifetime {
  private readonly scopes = new Map<string, { taskKey: string; expiresAt: number | null }>()

  update(task: AutonomousTask, now = Date.now()): void {
    const scope = JSON.stringify([task.sessionId, task.platformId]), key = taskKey(task), previous = this.scopes.get(scope)
    if (task.status === 'recorded') this.scopes.set(scope, { taskKey: key, expiresAt: null })
    else if (previous?.taskKey === key) {
      if (task.status !== 'completed') this.scopes.delete(scope)
      else if (previous.expiresAt === null) previous.expiresAt = now + COMPUTER_OVERLAY_COMPLETION_MS
    }
  }

  visible(task: AutonomousTask, now = Date.now()): boolean {
    if (task.status === 'recorded') return true
    const lifetime = this.scopes.get(JSON.stringify([task.sessionId, task.platformId]))
    return task.status === 'completed' && lifetime?.taskKey === taskKey(task) && lifetime.expiresAt !== null && now < lifetime.expiresAt
  }
}

/** Project saved task state. A step description is intent, not an execution receipt or target identity. */
export function computerOverlaySnapshot(task: AutonomousTask, activity: TaskActivity | null, paused = false): ComputerOverlaySnapshot {
  const step = task.progress?.currentStep
  const phase = task.progress?.phase
  const active = task.status === 'recorded'
  const status = task.status === 'completed' ? '任务已完成'
    : task.status === 'stopped' ? task.stop?.reason === 'human-takeover' ? '人工接管，已暂停' : '任务已停止'
      : task.status === 'interrupted' ? '任务已中断' : task.status === 'superseded' ? '任务已替换'
        : task.control?.halted ? '自动操作已停止' : paused ? '自动执行已暂停' : phase ? phases[phase] : '等待模型指令'
  const tone: ComputerOverlaySnapshot['tone'] = task.status === 'completed' ? 'success'
    : task.control?.halted || phase === 'blocked' || task.status === 'interrupted' ? 'error'
      : !active ? 'idle' : paused || phase !== 'executing-tool' ? 'waiting' : 'running'
  const currentRecord = activity?.actions.find(record => record.id === step?.id)
  const actionStatus = !step ? '尚未开始' : !active || paused || task.control?.halted ? status
    : currentRecord?.state === 'failed' ? '执行失败' : step.status === 'executing' ? '执行中'
      : step.status === 'queued' ? '待执行' : step.status === 'interrupted' ? '已中断'
        : step.execution === 'unknown' ? '结果未确认' : step.execution === 'not_executed' ? '未执行'
          : step.delivery === 'failed' || step.delivery === 'uncertain' ? '回传未确认'
            : step.delivery === 'sent' ? '结果已回传' : '等待回传'
  const observed = activity?.observation
  const target = observed?.windowTitle || observed?.application || activity?.application?.title ||
    activity?.application?.executable?.split(/[\\/]/).pop() || ''
  const observedAt = observed && (observed.windowTitle || observed.application) ? Date.parse(observed.observedAt) : activity?.application?.confirmedAt
  // Do not expose raw resultText (JSON, screenshots, internal ids) to the overlay renderer.
  const report = task.completion?.report
  const finishedStep = step && ['result-ready', 'delivered'].includes(step.status)
  const result = task.status === 'completed' && task.modelCompletion ? '模型已输出“任务完成”，本轮自动操作已结束。'
    : task.status === 'completed' && report ? short(report.summary, 220)
    : finishedStep && step.message ? short(step.message, 220) : '暂无执行结果'
  return {
    taskKey: taskKey(task),
    goal: short(task.originalRequest, 180), status, tone, completed: task.status === 'completed',
    action: step ? step.description || actionLabels[step.action] || '处理当前步骤' : '等待模型提供下一步操作',
    actionStatus, steps: task.progress?.stepCount ?? 0,
    target: short(target || '尚无已确认的目标窗口', 100),
    targetAt: observedAt !== undefined && Number.isFinite(observedAt) ? observedAt : null,
    result, resultTone: task.status === 'completed' ? 'success'
      : currentRecord?.state === 'failed' || finishedStep && step.execution === 'unknown' ? 'error' : 'idle',
    updatedAt: task.status === 'completed' ? task.updatedAt : step?.updatedAt ?? task.updatedAt
  }
}
