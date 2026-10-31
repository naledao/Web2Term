import { randomUUID } from 'node:crypto'
import type { FocusSendOutcome } from '../shared/focus-chat'
import type { RemoteRipgrepState, RemoteRipgrepTarget, RemoteRipgrepTaskResult } from '../shared/remote-ripgrep'

/** Connection-scoped recommendation. This class never installs software or runs a shell. */
export class RemoteRipgrepSetup {
  private key: object | null = null
  private state: RemoteRipgrepState | null = null

  constructor(private readonly changed: (state: RemoteRipgrepState | null) => void) {}

  getState(): RemoteRipgrepState | null { return this.state ? { ...this.state } : null }

  observe(key: object | null, target?: RemoteRipgrepTarget): void {
    if (key === this.key) return
    this.key = key
    this.state = key && target ? { ...target, connectionId: randomUUID(), availability: 'unknown', prompt: 'pending', message: '' } : null
    this.changed(this.getState())
  }

  update(connectionId: string, availability: RemoteRipgrepState['availability']): void {
    if (!this.state || this.state.connectionId !== connectionId || this.state.availability === availability) return
    this.state = { ...this.state, availability }
    this.changed(this.getState())
  }

  dismiss(connectionId: string): boolean {
    if (!this.state || this.state.connectionId !== connectionId || this.state.prompt === 'sending') return false
    this.state = { ...this.state, prompt: 'dismissed' }
    this.changed(this.getState())
    return true
  }

  async request(connectionId: string, send: () => Promise<FocusSendOutcome>): Promise<RemoteRipgrepTaskResult> {
    const state = this.state
    if (!state || state.connectionId !== connectionId || state.availability !== 'missing' || state.prompt !== 'pending') {
      return { status: 'blocked', message: '安装提示已失效，请以当前远端连接的检查结果为准。' }
    }
    this.state = { ...state, prompt: 'sending', message: '' }
    this.changed(this.getState())
    let outcome: FocusSendOutcome
    try { outcome = await send() } catch { outcome = 'unknown' }
    // A late receipt must not dismiss, modify or authorize a different connection.
    if (this.state?.connectionId !== connectionId) return { status: 'uncertain', message: '远端连接已变化，请在原对话中确认发送结果。' }
    const uncertain = ['unknown', 'stuck', 'upload-failed'].includes(outcome)
    const status = outcome === 'ok' ? 'sent' : uncertain ? 'uncertain' : 'blocked'
    const messages: Partial<Record<FocusSendOutcome, string>> = {
      ok: '安装要求已发送给 AI，请在当前对话中查看安装过程和验证结果。',
      busy: '当前 AI 或终端正在处理任务，或对话中有未发送的草稿，请处理后再试。',
      'no-composer': '当前 AI 对话尚未就绪，请完成登录或等待页面加载后再试。',
      unavailable: '当前 AI 对话尚未就绪，请检查页面和终端模式后再试。',
      cancelled: '会话或远端连接已变化，安装要求未继续发送。',
      'helper-not-ready': '当前对话暂时不能发送，请等待所需工具就绪后再试。'
    }
    const message = uncertain ? '发送结果尚未确认，请先查看当前 AI 对话，避免重复发送安装要求。'
      : messages[outcome] ?? '安装要求未能发送，请检查当前 AI 对话后再试。'
    this.state = { ...this.state, prompt: status === 'sent' ? 'requested' : status === 'uncertain' ? 'uncertain' : 'pending', message }
    this.changed(this.getState())
    return { status, message }
  }
}
