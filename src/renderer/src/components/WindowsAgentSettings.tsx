import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { WindowsAgentState } from '@shared/windows-agent'

interface Props { onBusyChange(busy: boolean): void }
const STATUS: Record<WindowsAgentState['status'], string> = {
  disabled: '未开启', 'waiting-login': '等待登录', connecting: '正在连接', online: '在线', reconnecting: '等待重连', error: '连接异常'
}

export default function WindowsAgentSettings({ onBusyChange }: Props): ReactElement | null {
  const [state, setState] = useState<WindowsAgentState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const writing = useRef(false)
  useEffect(() => {
    mounted.current = true
    const update = (next: WindowsAgentState): void => {
      if (mounted.current) setState(previous => !previous || next.revision >= previous.revision ? next : previous)
    }
    const off = window.api.onWindowsAgentChanged(update)
    void window.api.getWindowsAgent().then(update, () => { if (mounted.current) setError('无法读取本机设备状态，请重新打开设置。') })
    return () => { mounted.current = false; off() }
  }, [])
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])

  const toggle = async (): Promise<void> => {
    if (!state || writing.current) return
    writing.current = true; setBusy(true); setError('')
    try {
      const next = await window.api.setWindowsAgentEnabled(!state.enabled)
      if (mounted.current) setState(previous => !previous || next.revision >= previous.revision ? next : previous)
    } catch { if (mounted.current) setError('本机设备设置未保存，请重试。') }
    finally { writing.current = false; if (mounted.current) setBusy(false) }
  }

  if (state && !state.supported) return null
  return <section className="settings-devices__local" aria-label="Windows 本机远程终端">
    <div className="settings-devices__local-heading">
      <div><strong>将此 Windows 电脑作为远程设备</strong><p>开启后，同一账号的客户端可以连接本机 PowerShell。</p></div>
      <button type="button" className="settings-outline-btn" disabled={!state || busy} onClick={() => void toggle()}>{busy ? '保存中…' : state?.enabled ? '关闭本机远程终端' : '开启本机远程终端'}</button>
    </div>
    {state ? <>
      <div className="settings-devices__local-status" role="status">
        <span className={`settings-devices__status${state.status === 'online' ? ' settings-devices__status--online' : ''}`}><i aria-hidden="true" />{STATUS[state.status]}</span>
        <span>终端 {state.terminalCount}/{state.maxTerminals}</span>
      </div>
      {state.deviceId ? <div className="settings-devices__info"><strong>{state.deviceName}</strong><code>{state.deviceId}</code></div> : null}
      {state.message ? <p className={state.status === 'error' ? 'settings-feedback' : 'settings-devices__local-message'} role={state.status === 'error' ? 'alert' : undefined}>{state.message}</p> : null}
      {state.logPath ? <p className="settings-devices__log">运行日志：{state.logPath}</p> : null}
    </> : <p role="status">正在读取本机设备状态…</p>}
    {error ? <p className="settings-feedback" role="alert">{error}</p> : null}
  </section>
}
