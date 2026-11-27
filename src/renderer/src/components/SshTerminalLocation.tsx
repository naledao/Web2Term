import SshDirectoryPicker from './SshDirectoryPicker'

export default function SshTerminalLocation({
  name, target, cwd, ptyCwd, message, connected, canEdit, editing, onEdit, onPick
}: {
  name: string
  target?: string
  cwd: string
  ptyCwd?: string
  message?: string
  connected: boolean
  canEdit: boolean
  editing: boolean
  onEdit: (editing: boolean) => void
  onPick: (path: string) => void
}) {
  const ptyHint = ptyCwd && ptyCwd !== cwd ? '手动交互终端目录：' + ptyCwd : ''
  return (
    <>
      <span className="terminal-pane__id" title={target}>{name}</span>
      {canEdit && editing ? (
        <SshDirectoryPicker
          basePath={cwd || '/'}
          onPick={(path) => {
            onEdit(false)
            onPick(path)
          }}
          onClose={() => onEdit(false)}
        />
      ) : (
        <span
          className={canEdit ? 'terminal-pane__directory terminal-pane__directory--editable' : 'terminal-pane__directory'}
          title={connected ? [cwd, ptyHint, canEdit ? '双击编辑目录' : ''].filter(Boolean).join('\n') : message}
          onDoubleClick={() => { if (canEdit) onEdit(true) }}
        >
          {connected ? cwd || '等待确定工作目录…' : message || '尚未连接'}
        </span>
      )}
    </>
  )
}
