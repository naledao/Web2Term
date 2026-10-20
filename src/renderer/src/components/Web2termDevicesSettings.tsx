import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { BackendAuthState, Web2termDevice } from '@shared/types'
import './Web2termDevicesSettings.css'

interface Props {
  onOpenBackend(): void
  onBusyChange(busy: boolean): void
}

export default function Web2termDevicesSettings({ onOpenBackend, onBusyChange }: Props): ReactElement {
  const [auth, setAuth] = useState<BackendAuthState | null>(null)
  const [devices, setDevices] = useState<Web2termDevice[]>([])
  const [refreshing, setRefreshing] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [logPath, setLogPath] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ deviceId: string; deviceName: string } | null>(null)
  const alive = useRef(false)
  const generation = useRef(0)
  const identity = useRef('')
  const reading = useRef(false)
  const writing = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (reading.current || writing.current) return
    reading.current = true
    const revision = generation.current
    setRefreshing(true)
    try {
      const state = await window.api.getBackendAuthState()
      if (!alive.current || revision !== generation.current) return
      const key = JSON.stringify([state.backendUrl, state.user?.publicId, state.expiresAt, state.status])
      if (identity.current !== key) {
        identity.current = key
        setDevices([])
        setEditing(null)
        setNotice('')
      }
      setAuth(state)
      setError('')
      setLogPath(null)
      if (state.status !== 'signed-in') return
      const result = await window.api.listWeb2termDevices()
      if (!alive.current || revision !== generation.current) return
      setLogPath(result.logPath)
      if (result.ok) setDevices(result.value)
      else { setDevices([]); setError(result.message) }
    } catch {
      if (alive.current && revision === generation.current) {
        setDevices([])
        setError('读取设备列表失败，请刷新重试。')
      }
    } finally {
      if (revision === generation.current) {
        reading.current = false
        if (alive.current) setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    alive.current = true
    reading.current = false
    void refresh()
    const poll = (): void => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(poll, 10_000)
    const off = window.api.onWeb2termConnectionChanged(() => void refresh())
    document.addEventListener('visibilitychange', poll)
    return () => {
      alive.current = false
      generation.current++
      window.clearInterval(timer)
      off()
      document.removeEventListener('visibilitychange', poll)
    }
  }, [refresh])

  useEffect(() => {
    onBusyChange(saving)
    return () => onBusyChange(false)
  }, [saving, onBusyChange])

  const saveName = async (): Promise<void> => {
    if (!editing || reading.current || writing.current) return
    const draft = { ...editing, deviceName: editing.deviceName.trim() }
    if (!draft.deviceName || draft.deviceName.length > 100 || /\p{Cc}/u.test(draft.deviceName)) {
      setError('设备名称需为 1–100 个字符，不能包含换行或控制字符。')
      return
    }
    writing.current = true
    setSaving(true)
    setError('')
    setNotice('')
    const revision = generation.current
    try {
      const result = await window.api.renameWeb2termDevice(draft)
      if (!alive.current || revision !== generation.current) return
      setLogPath(result.logPath)
      if (!result.ok) { setError(result.message); return }
      setDevices((previous) => previous.map((device) => device.deviceId === result.value.deviceId ? { ...device, deviceName: result.value.deviceName } : device))
      setEditing(null)
      setNotice('设备名称已保存。')
    } catch {
      if (alive.current && revision === generation.current) setError('设备名称未保存，输入已保留，请重试。')
    } finally {
      writing.current = false
      if (alive.current && revision === generation.current) setSaving(false)
    }
  }

  return (
    <div className="settings-devices">
      <div className="settings-devices__toolbar">
        <p className="settings-devices__hint">当前账号的设备，每 10 秒更新状态。设备名称单独保存，立即生效。</p>
        <button type="button" className="settings-outline-btn" disabled={refreshing || saving} onClick={() => void refresh()}>{refreshing ? '刷新中…' : '刷新设备'}</button>
      </div>
      {error ? <p className="settings-feedback" role="alert">{error}</p> : null}
      {notice ? <p className="settings-devices__notice" role="status">{notice}</p> : null}
      {logPath && error ? <p className="settings-devices__log">诊断日志：{logPath}</p> : null}
      {!auth && refreshing ? <p role="status">正在读取设备列表…</p> : null}
      {auth && auth.status !== 'signed-in' ? (
        <div className="settings-devices__empty">
          <p>{auth.status === 'expired' ? '登录已过期，请重新登录后查看设备。' : '请先登录后查看当前账号的设备。'}</p>
          <button type="button" className="settings-outline-btn" onClick={onOpenBackend}>前往后端服务</button>
        </div>
      ) : null}
      {auth?.status === 'signed-in' ? (
        <div aria-busy={refreshing}>
          <p className="settings-devices__count">我的设备 · {devices.length}</p>
          {!devices.length && !error ? <p className="settings-devices__empty">{refreshing ? '正在读取设备列表…' : '当前账号还没有设备，请在设备上登录同一账号并运行 web2term run。'}</p> : null}
          <ul className="settings-devices__list" aria-label="我的 web2term 设备">
            {devices.map((device) => (
              <li className="settings-devices__device" key={device.deviceId}>
                <div className="settings-devices__info">
                  <strong>{device.deviceName}</strong>
                  <code>{device.deviceId}</code>
                </div>
                <div className="settings-devices__state">
                  <span className={`settings-devices__status${device.onlineStatus ? ' settings-devices__status--online' : ''}`}><i aria-hidden="true" />{device.onlineStatus ? '在线' : '离线'}</span>
                  {!device.enabled ? <span className="settings-devices__disabled">已禁用</span> : null}
                </div>
                {editing?.deviceId === device.deviceId ? (
                  <form className="settings-devices__rename" onSubmit={(event) => { event.preventDefault(); void saveName() }} onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) { if (event.key === 'Enter') event.preventDefault(); return }
                    if (event.key === 'Escape') { event.stopPropagation(); if (!saving) setEditing(null) }
                  }}>
                    <input className="settings-input" aria-label={`修改 ${device.deviceName} 的设备名称`} autoFocus maxLength={100} value={editing.deviceName} disabled={saving} onChange={(event) => { setEditing({ deviceId: device.deviceId, deviceName: event.target.value }); setError('') }} />
                    <div className="settings-devices__actions">
                      <button type="submit" className="settings-outline-btn" disabled={saving || refreshing || !editing.deviceName.trim()}>{saving ? '保存中…' : '保存名称'}</button>
                      <button type="button" className="settings-outline-btn" disabled={saving} onClick={() => { setEditing(null); setError('') }}>取消</button>
                    </div>
                  </form>
                ) : <button type="button" className="settings-outline-btn settings-devices__edit" disabled={saving || refreshing} onClick={() => { setEditing({ deviceId: device.deviceId, deviceName: device.deviceName }); setError(''); setNotice('') }}>修改名称</button>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
