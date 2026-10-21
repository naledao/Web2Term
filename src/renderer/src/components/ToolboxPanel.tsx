import type { JSX } from 'react'
import { TOOL_LABELS } from '../tool-window-state'
import type { ToolKind } from '../tool-window-state'
import { ToolIcon } from './ToolWindows'
import './ToolboxPanel.css'

const TOOL_ORDER: ToolKind[] = ['git', 'mysql', 'redis', 'nacos']

interface ToolboxPanelProps {
  gitDisabled: boolean
  gitCwd: string
  onOpen: (kind: ToolKind) => void
}

/** The right sidebar's toolbox tab; each entry opens its tool window. */
export default function ToolboxPanel({ gitDisabled, gitCwd, onOpen }: ToolboxPanelProps): JSX.Element {
  return <div className="toolbox-panel">
    {TOOL_ORDER.map((kind) => {
      const disabled = kind === 'git' && gitDisabled
      const hint = kind === 'git' && !disabled ? gitCwd || '等待确定工作目录…' : ''
      return <button key={kind} type="button" className="toolbox-panel__item" disabled={disabled}
        data-tool-open={kind} title={hint || undefined} onClick={() => onOpen(kind)}>
        <span className="toolbox-panel__icon"><ToolIcon kind={kind} /></span>
        <span className="toolbox-panel__text">
          <span className="toolbox-panel__label">{TOOL_LABELS[kind]}</span>
          {hint ? <span className="toolbox-panel__hint">{hint}</span> : null}
        </span>
      </button>
    })}
    {gitDisabled ? <p className="toolbox-panel__note">web2term 可在终端运行 Git 命令。</p> : null}
  </div>
}
