import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import CodeMirror, { EditorState, EditorView, oneDarkTheme } from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import type { AppTheme } from '@shared/types'
import type { SshTextFile, SshTextFileTarget } from '@shared/ssh-file-edit'
import { CHINESE_PHRASES, MYSQL_LANGUAGE } from './sql-codemirror'
import './SshFileEditor.css'

interface Props {
  target: SshTextFileTarget
  connected: boolean
  theme: AppTheme
  container: HTMLElement
  onSaved(): void
  onClose(): void
}

export default function SshFileEditor({ target, connected, theme, container, onSaved, onClose }: Props) {
  const [file, setFile] = useState<SshTextFile | null>(null)
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirmation, setConfirmation] = useState<'close' | 'reload' | null>(null)
  const [wrap, setWrap] = useState(false)
  const alive = useRef(true)
  const revision = useRef(0)
  const operation = useRef<'read' | 'save' | null>(null)
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const closeButton = useRef<HTMLButtonElement>(null)
  const dirty = file !== null && value !== file.content
  const name = target.path.slice(target.path.lastIndexOf('/') + 1)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = useCallback(async (): Promise<void> => {
    if (operation.current) return
    if (!connectedRef.current) { setLoading(false); setError('原 SSH 主机未连接，请恢复连接后重新载入。'); return }
    const epoch = ++revision.current
    operation.current = 'read'; setLoading(true); setError(''); setMessage(''); setConfirmation(null)
    try {
      const next = await window.api.readSshTextFile(target)
      if (!alive.current || revision.current !== epoch) return
      if (next.hostId !== target.hostId || next.sessionId !== target.sessionId || next.path !== target.path) throw new Error('文件来源已变化，请重新打开。')
      setFile(next); setValue(next.content)
    } catch (failure) {
      if (alive.current && revision.current === epoch) setError(failure instanceof Error ? failure.message : '读取远程文件失败。')
    } finally {
      operation.current = null
      if (alive.current && revision.current === epoch) setLoading(false)
    }
  }, [target.sessionId, target.hostId, target.path])
  useEffect(() => { void load() }, [load])

  const save = async (): Promise<void> => {
    if (!file || !dirty || !connectedRef.current || operation.current) return
    operation.current = 'save'; setSaving(true); setError(''); setMessage(''); setConfirmation(null)
    try {
      const result = await window.api.saveSshTextFile({ ...target, revision: file.revision, content: value })
      if (!alive.current) return
      if (result.status === 'conflict') {
        setError('远程文件已被其他程序修改，本次未保存。可先复制当前内容，再重新载入远程版本。')
        return
      }
      setFile(result.file); setValue(result.file.content); setMessage('已保存到远程文件。')
      onSaved()
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : '保存未完成，请核对远程文件后重试；编辑内容仍保留。')
    } finally { operation.current = null; if (alive.current) setSaving(false) }
  }
  const close = (): void => {
    if (operation.current === 'save') return
    if (dirty) setConfirmation('close')
    else onClose()
  }
  const reload = (): void => { if (dirty) setConfirmation('reload'); else void load() }
  const extensions = useMemo(() => [CHINESE_PHRASES, EditorState.tabSize.of(2),
    EditorView.contentAttributes.of({ 'aria-label': `编辑远程文件 ${name}` }),
    ...(/\.json$/i.test(name) ? [json()] : /\.sql$/i.test(name) ? [MYSQL_LANGUAGE] : []),
    ...(wrap ? [EditorView.lineWrapping] : [])
  ], [name, wrap])

  return <Dialog.Root open modal onOpenChange={(open, details) => { if (!open) { details.cancel(); close() } }}>
    <Dialog.Portal container={container}>
      <Dialog.Backdrop className="ssh-text-editor__backdrop" />
      <Dialog.Popup className="ssh-text-editor" data-theme={theme} initialFocus={closeButton}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault(); event.stopPropagation(); void save()
          }
        }}>
        <header className="ssh-text-editor__head">
          <div className="ssh-text-editor__heading">
            <Dialog.Title>编辑文件 <span>{name}</span></Dialog.Title>
            <Dialog.Description title={target.path}>{target.path}</Dialog.Description>
          </div>
          <span className={`ssh-text-editor__status${dirty ? ' is-dirty' : ''}`} role="status">{saving ? '保存中…' : loading ? '读取中…' : dirty ? '未保存' : file ? '已载入' : '读取失败'}</span>
          <button ref={closeButton} type="button" className="ssh-text-editor__close" aria-label="关闭文件编辑器" disabled={saving} onClick={close}>×</button>
        </header>
        <div className="ssh-text-editor__toolbar">
          <button type="button" onClick={() => void save()} disabled={!file || !dirty || loading || saving || !connected} className="ssh-text-editor__save">{saving ? '正在保存…' : '保存'} <kbd>Ctrl+S</kbd></button>
          <button type="button" onClick={reload} disabled={loading || saving || !connected}>重新载入</button>
          <button type="button" disabled={!file || loading} onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setMessage('当前内容已复制。'), () => setError('复制失败，请在编辑器中全选后复制。'))
          }}>复制内容</button>
          <button type="button" aria-pressed={wrap} onClick={() => setWrap(current => !current)}>自动换行</button>
          <span className="ssh-text-editor__format">{file ? `UTF-8${file.bom ? ' BOM' : ''} · ${file.lineEnding}` : 'UTF-8 文本 · 最大 1 MB'}</span>
        </div>
        {!connected ? <p className="ssh-text-editor__notice" role="status">原 SSH 连接已断开或工作区已切换，暂时无法保存。当前编辑内容仍保留，可复制后关闭。</p> : null}
        {error ? <p className="ssh-text-editor__error" role="alert">{error}</p> : message ? <p className="ssh-text-editor__message" role="status">{message}</p> : null}
        <div className="ssh-text-editor__body">
          {loading ? <p className="ssh-text-editor__loading" role="status">正在读取远程文件…</p> : file ? <CodeMirror
            value={value} onChange={next => { setValue(next); setMessage('') }} theme={theme === 'dark' ? oneDarkTheme : 'light'}
            extensions={extensions} height="100%" editable={!saving} readOnly={saving} autoFocus
            basicSetup={{ lineNumbers: true, foldGutter: false, history: true, searchKeymap: true, closeBrackets: false,
              autocompletion: false, completionKeymap: false, highlightActiveLine: true }}
          /> : <p className="ssh-text-editor__loading">无法打开此文件，可关闭后下载文件查看。</p>}
        </div>
        {confirmation ? <div className="ssh-text-editor__confirmation" role="alert">
          <span>{confirmation === 'close' ? '有尚未保存的修改，确定放弃并关闭？' : '重新载入将丢弃当前未保存的修改，是否继续？'}</span>
          <button type="button" onClick={() => setConfirmation(null)}>继续编辑</button>
          <button type="button" className="ssh-text-editor__discard" onClick={() => { if (confirmation === 'close') onClose(); else void load() }}>{confirmation === 'close' ? '放弃修改并关闭' : '放弃修改并重新载入'}</button>
        </div> : null}
        <footer className="ssh-text-editor__foot"><span>修改只在点击“保存”或按 Ctrl+S 后写入远程文件。</span><button type="button" disabled={saving} onClick={close}>关闭</button></footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
