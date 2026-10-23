import type { FocusSendOutcome } from '../shared/focus-chat'
import { githubLoginTask } from '../shared/github'
import type { GithubCliState, GithubLoginTaskResult } from '../shared/github'

interface LoginTaskDependencies {
  blockedReason(): string | null
  inspect(): Promise<GithubCliState>
  send(text: string): Promise<FocusSendOutcome>
}

/** Check again after the asynchronous CLI lookup so a switched chat/host never receives the task. */
export async function dispatchGithubLoginTask(deps: LoginTaskDependencies): Promise<GithubLoginTaskResult> {
  try {
    let reason = deps.blockedReason()
    if (reason) return { status: 'blocked', message: reason }
    const cli = await deps.inspect()
    reason = deps.blockedReason()
    if (reason) return { status: 'blocked', message: reason }
    if (cli.status === 'signed-in') return { status: 'already-signed-in', message: 'GitHub 已登录，正在刷新仓库。' }
    if (cli.status !== 'signed-out') return { status: 'blocked', message: cli.message }
  } catch {
    return { status: 'blocked', message: '暂时无法检查 GitHub 登录状态，请重新检测后重试。' }
  }

  try {
    const outcome = await deps.send(githubLoginTask())
    if (outcome === 'ok') return { status: 'sent', message: '登录任务已发送给当前 AI。' }
    if (outcome === 'stuck' || outcome === 'unknown') {
      return { status: 'uncertain', message: '任务是否发送成功尚未确认，请先查看当前对话，避免重复发送。' }
    }
    const messages: Partial<Record<FocusSendOutcome, string>> = {
      busy: '当前 AI 正在处理任务，或网页输入框保留着草稿，请处理后再试。',
      'no-composer': '尚未找到 AI 输入框，请先在原始视图完成页面登录或验证。',
      'insert-failed': '网页未接受登录任务，请查看原始视图后再试。',
      unavailable: '当前 AI 页面不可用或会话已切换，请稍后再试。',
      cancelled: '登录任务发送已取消。'
    }
    return { status: 'blocked', message: messages[outcome] ?? '登录任务未能发送，请检查当前对话后再试。' }
  } catch {
    // A transport error after submission is not proof that it failed; never retry automatically.
    return { status: 'uncertain', message: '发送结果尚未确认，请先查看当前对话，避免重复发送。' }
  }
}
