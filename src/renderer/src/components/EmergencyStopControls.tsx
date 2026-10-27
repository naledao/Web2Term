import { useEffect, useState } from 'react'
import type { DesktopInputWarning, EmergencyStopState } from '@shared/emergency-stop'
import './EmergencyStopControls.css'

const INPUT_LABEL = { keyboard: '键盘操作', click: '鼠标点击', wheel: '滚轮操作' } as const

export default function EmergencyStopControls() {
  const [state, setState] = useState<EmergencyStopState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState<DesktopInputWarning | null>(null)
  const receive = (value: EmergencyStopState) => setState(previous => previous && previous.revision > value.revision ? previous : value)
  // This strip is DOM below the embedded page, so the reminder stays visible while the AI works in other windows.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.api.onDesktopInputWarning(value => {
      setWarning(value)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setWarning(null), 15000)
    })
    return () => { off(); if (timer) clearTimeout(timer) }
  }, [])
  useEffect(() => {
    let current = true, pushed = false
    const off = window.api.onEmergencyStopChanged(value => { pushed = true; if (current) receive(value) })
    void window.api.getEmergencyStop().then(value => { if (current && !pushed) receive(value) }).catch(() => { if (current) setError('急停状态读取失败；仍可点击全局急停。') })
    return () => { current = false; off() }
  }, [])
  const trigger = async () => {
    setError('')
    try { receive(await window.api.triggerEmergencyStop()) }
    catch { setError('未取得急停回执；Computer Use 运行时可连续晃动鼠标，或再次点击全局急停。') }
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
      title="停止所有会话的自动操作，释放本次 helper 按下的键鼠；后台进程保持独立运行。Computer Use 运行时也可连续来回晃动鼠标急停。">
      {state?.active ? '全局急停已触发' : '全局急停'}
    </button>
    {state?.active ? <>
      <span className="emergency-stop__status" role="status">{state.message}{state.failedSessions ? ` ${state.failedSessions} 项停止请求未确认，请查看实际状态。` : ''}</span>
      <button type="button" disabled={!state.canReset || busy} onClick={() => void reset()}>{busy ? '正在解除…' : state.canReset ? '解除急停' : '等待退场…'}</button>
    </> : <span className="emergency-stop__hint">{state?.gestureAvailable ? '连续来回晃动鼠标，立即急停' : state ? 'Computer Use 控制期间可连续晃动鼠标急停；也可点击全局急停' : '读取急停状态…'}</span>}
    {warning && !state?.active ? <span className="emergency-stop__warning" role="status">
      检测到{warning.input ? INPUT_LABEL[warning.input] : '键鼠操作'}（{warning.strike}/{warning.limit}）：AI 正在操作电脑，请先别动鼠标和键盘。这一步已中断，AI 会重新观察后继续；连续 {warning.limit} 次将暂停 computer use，发送新消息即可继续。
    </span> : null}
    {error ? <span className="emergency-stop__status" role="alert">{error}</span> : null}
  </div>
}
