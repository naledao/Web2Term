import { useEffect, useState } from 'react'
import type { EmergencyStopState } from '@shared/emergency-stop'
import './EmergencyStopControls.css'

export default function EmergencyStopControls() {
  const [state, setState] = useState<EmergencyStopState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const receive = (value: EmergencyStopState) => setState(previous => previous && previous.revision > value.revision ? previous : value)
  useEffect(() => {
    let current = true, pushed = false
    const off = window.api.onEmergencyStopChanged(value => { pushed = true; if (current) receive(value) })
    void window.api.getEmergencyStop().then(value => { if (current && !pushed) receive(value) }).catch(() => { if (current) setError('急停状态读取失败；仍可点击全局急停。') })
    return () => { current = false; off() }
  }, [])
  const trigger = async () => {
    setError('')
    try { receive(await window.api.triggerEmergencyStop()) }
    catch { setError('未取得急停回执，请使用全局快捷键或再次点击。') }
  }
  const reset = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { const result = await window.api.resetEmergencyStop(); receive(result.state); setError(result.message) }
    catch { setError('解除急停未确认，保持停止状态，请核对后重试。') }
    finally { setBusy(false) }
  }
  return <div className={'emergency-stop' + (state?.active ? ' emergency-stop--active' : '')}>
    <button type="button" className="emergency-stop__trigger" onClick={() => void trigger()}
      title="停止所有会话的自动操作，释放本次 helper 按下的键鼠；后台进程保持独立运行。快捷键 Ctrl+Alt+Shift+F12">
      {state?.active ? '全局急停已触发' : '全局急停'}
    </button>
    {state?.active ? <>
      <span className="emergency-stop__status" role="status">{state.message}{state.failedSessions ? ` ${state.failedSessions} 项停止请求未确认，请查看实际状态。` : ''}</span>
      <button type="button" disabled={!state.canReset || busy} onClick={() => void reset()}>{busy ? '正在解除…' : state.canReset ? '解除急停' : '等待退场…'}</button>
    </> : <span className="emergency-stop__hint">{state?.shortcutRegistered ? 'Ctrl+Alt+Shift+F12' : state ? '快捷键注册失败，请使用此按钮' : '读取快捷键状态…'}</span>}
    {error ? <span className="emergency-stop__status" role="alert">{error}</span> : null}
  </div>
}
