import type { BackgroundTask } from '@shared/background-tasks'
import type { CommandRecoveryState } from '@shared/types'

export function isGithubLoginTask(task: BackgroundTask, conversationId: string | null, since: number): boolean {
  return task.transport === 'local' && task.conversationId === conversationId && task.createdAt >= since &&
    /\bgh(?:\.exe)?['"]?\s+auth\s+login\b/i.test(task.command)
}

/** Pure presentation of one bound login attempt; never infers success from AI prose. */
export function githubLoginProgress(task: BackgroundTask | undefined, recovery: CommandRecoveryState | null | undefined,
  taskRunning: boolean): { label: string; message: string; error: boolean } {
  if (recovery) return { label: recovery.status === 'pending' || recovery.status === 'sent' ? '正在修正登录指令…' : '登录指令需要处理',
    message: recovery.message, error: !['pending', 'sent'].includes(recovery.status) }
  if (!task) return taskRunning ? { label: 'AI 正在准备登录…', message: '', error: false }
    : { label: '帮我登录', message: 'AI 任务已结束，尚未确认登录成功。', error: true }
  if (task.status === 'completed') return { label: '正在确认登录状态…', message: '', error: false }
  if (task.status === 'stopped') return { label: '登录已停止', message: '你已手动停止登录任务，可以重新发起登录。', error: true }
  if (task.status === 'failed' || task.status === 'exited') return { label: '登录进程已结束',
    message: task.exitCode === null ? '登录进程已结束，退出码未知。请查看后台任务日志。'
      : `登录进程退出，退出码 ${task.exitCode}。请查看 AI 回复或后台任务日志。`, error: true }
  if (task.status === 'unknown') return { label: '登录进程状态待确认', message: task.message, error: true }
  const output = task.output + '\n' + task.errorOutput
  const authorization = /github\.com\/login\/(?:device|oauth)|[A-Z\d]{4}-[A-Z\d]{4}/.test(output)
  return { label: authorization ? '等待你完成 GitHub 授权' : '正在发起授权…', message: '', error: false }
}
