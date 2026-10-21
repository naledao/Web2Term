import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import MDEditor from '@uiw/react-md-editor'
import * as mdCommands from '@uiw/react-md-editor/commands'
import { terminalNotesOwnerKey } from '@shared/types'
import type { AppTheme, TerminalNotes } from '@shared/types'
import '../assets/terminal-notes.css'

const NOTE_COMMANDS = [
  mdCommands.title, mdCommands.divider,
  mdCommands.bold, mdCommands.italic, mdCommands.strikethrough, mdCommands.divider,
  mdCommands.link, mdCommands.code, mdCommands.quote, mdCommands.divider,
  mdCommands.unorderedListCommand, mdCommands.orderedListCommand, mdCommands.divider,
  mdCommands.image
]

interface Props {
  theme: AppTheme
  notes: TerminalNotes | null
  value: string
  saving: boolean
  error: string
  onChange(value: string): void
  onSave(): void
}

export default function TerminalNotesPanel({ theme, notes, value, saving, error, onChange, onSave }: Props): JSX.Element {
  const [preview, setPreview] = useState(false)
  const dirty = value !== (notes?.text ?? '')
  const locked = saving || !notes?.directoryKey || !notes.hostId
  const commands = useMemo(() => locked
    ? NOTE_COMMANDS.map(command => ({ ...command, buttonProps: { ...command.buttonProps, disabled: true } }))
    : NOTE_COMMANDS, [locked])
  const status = saving ? '保存中…' : !notes ? error ? '读取失败' : '读取中…'
    : !notes.directoryKey ? '等待目录' : dirty ? '未保存' : '已保存'

  return <section className="terminal-notes" aria-label="发送给 AI 的补充说明" data-color-mode={theme}
    onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        if (!locked && dirty) onSave()
      }
    }}>
    <div className="terminal-notes__head">
      <h2>补充说明</h2>
      <span className={'terminal-notes__status' + (dirty ? ' terminal-notes__status--dirty' : '')} role="status">{status}</span>
    </div>
    {error ? <p className="terminal-notes__error" role="alert">{error}</p> : null}
    <div className="terminal-notes__modes">
      <p className="terminal-notes__context">随提示词提供给AI</p>
      <div role="group" aria-label="补充说明显示方式">
        <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
      </div>
    </div>
    <div className="terminal-notes__editor">
      <MDEditor
        key={notes ? terminalNotesOwnerKey(notes) : 'loading'}
        value={value}
        height="100%"
        minHeight={0}
        preview={preview ? 'preview' : 'edit'}
        visibleDragbar={false}
        commands={commands}
        extraCommands={[]}
        textareaProps={{
          placeholder: notes?.directoryKey ? '输入要提供给 AI 的补充说明…' : '工作目录确定后即可编辑补充说明…',
          disabled: locked,
          'aria-label': '补充说明 Markdown 编辑器'
        }}
        onChange={text => { if (!locked) onChange(text ?? '') }}
      />
    </div>
    <div className="terminal-notes__foot">
      <button type="button" disabled={locked || value === ''} onClick={() => onChange('')}>清空</button>
      {notes?.legacyText ? <button type="button" disabled={locked || value !== ''}
        title="将原机器说明放入编辑区；保存后仅用于当前目录" onClick={() => onChange(notes.legacyText)}>导入原机器说明</button> : null}
      <span className="terminal-notes__spacer" />
      <button type="button" disabled={locked || !dirty} onClick={() => onChange(notes?.text ?? '')}>还原</button>
      <button type="button" className="terminal-notes__save" disabled={locked || !dirty}
        title="保存补充说明（Ctrl/Cmd+S）" onClick={onSave}>{saving ? '保存中…' : '保存'}</button>
    </div>
  </section>
}
