import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { LinuxAgentDownloadState } from '@shared/types'
import './LinuxAgentDownload.css'

/** Download the web2term Linux tool from inside the client. */
export default function LinuxAgentDownload({ compact = false }: { compact?: boolean }): ReactElement {
  const [state, setState] = useState<LinuxAgentDownloadState | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.getLinuxAgentDownload().then((value) => { if (alive && value) setState(value) })
    const off = window.api.onLinuxAgentDownloadChanged(setState)
    return () => {
      alive = false
      off()
    }
  }, [])

  const start = (): void => {
    void window.api.downloadLinuxAgent().then((value) => { if (value) setState(value) }).catch(() => {
      setState((current) => ({ phase: 'error', percent: 0, message: '无法开始下载，请重试。', path: current?.path ?? '' }))
    })
  }

  const phase = state?.phase ?? 'idle'
  return (
    <div className={compact ? 'linux-agent-download linux-agent-download--compact' : 'linux-agent-download'}>
      <div className="linux-agent-download__head">
        <div className="linux-agent-download__info">
          <strong>Linux 设备工具</strong>
        </div>
        <div className="linux-agent-download__actions">
          {phase === 'done' ? (
            <button type="button" className="settings-outline-btn" onClick={() => void window.api.revealLinuxAgentDownload()}>在文件夹中显示</button>
          ) : null}
          <button type="button" className="settings-outline-btn" disabled={phase === 'downloading'} onClick={start}>
            {phase === 'downloading' ? `下载中 ${state?.percent ?? 0}%` : phase === 'done' ? '重新下载' : phase === 'error' ? '重试' : '下载'}
          </button>
        </div>
      </div>
      {phase === 'downloading' ? (
        <div className="linux-agent-download__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state?.percent ?? 0}>
          <i style={{ width: `${state?.percent ?? 0}%` }} />
        </div>
      ) : null}
      {phase === 'downloading' && state?.message ? <p className="linux-agent-download__status" role="status">{state.message}</p> : null}
      {phase === 'done' ? <p className="linux-agent-download__status linux-agent-download__status--ok" role="status">已保存到 {state?.path}</p> : null}
      {phase === 'error' ? <p className="linux-agent-download__status linux-agent-download__status--error" role="alert">{state?.message}</p> : null}
    </div>
  )
}
