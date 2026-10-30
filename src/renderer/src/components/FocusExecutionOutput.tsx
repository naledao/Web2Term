import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { FocusOwner } from '@shared/focus-chat'
import { focusOwnerKey } from '@shared/focus-chat'
import type { ExecutionRecord } from '@shared/types'
import OutputText from './OutputText'

/** Mounted only inside an expanded execution. Late responses cannot follow a switched owner. */
export default function FocusExecutionOutput({ owner, record }: { owner: FocusOwner; record: ExecutionRecord }): JSX.Element | null {
  const ownerKey = focusOwnerKey(owner)
  const version = JSON.stringify([ownerKey, record.messageId, record.status, record.finishedAt])
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<{ version: string; text: string | null } | null>(null)
  useEffect(() => {
    if (!record.outputDeferred) return
    let cancelled = false
    setLoaded(null)
    void window.api.readFocusExecutionOutput(owner, record.messageId).then(text => {
      if (!cancelled) setLoaded({ version, text })
    }).catch(() => { if (!cancelled) setLoaded({ version, text: null }) })
    return () => { cancelled = true }
  }, [version, record.outputDeferred, attempt])
  if (!record.outputDeferred) return record.output ? <OutputText className="focus-execution__output" text={record.output} /> : null
  if (!loaded || loaded.version !== version) return <p className="focus-chat__muted" role="status">正在读取输出…</p>
  if (loaded.text === null) return <div className="focus-chat__error" role="alert">暂时无法读取这条执行输出。
    <button type="button" onClick={() => setAttempt(value => value + 1)}>重试读取</button>
  </div>
  return loaded.text ? <OutputText className="focus-execution__output" text={loaded.text} /> : null
}
