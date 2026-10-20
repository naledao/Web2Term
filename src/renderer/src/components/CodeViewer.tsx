import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import CodeMirror, { EditorState, EditorView, oneDarkTheme } from '@uiw/react-codemirror'
import type { BasicSetupOptions, ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { foldAll, HighlightStyle, syntaxHighlighting, unfoldAll } from '@codemirror/language'
import { openSearchPanel } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import type { AppTheme } from '../../../shared/types'
import { CHINESE_PHRASES, MYSQL_LANGUAGE, SQL_HIGHLIGHTING } from './sql-codemirror'
import './SqlViewer.css'

interface CodeViewerProps {
  value: string
  theme: AppTheme
  label: string
  compact?: boolean
  language: 'sql' | 'json'
}

const JSON_LANGUAGE = json()

function jsonHighlighting(dark: boolean) {
  return syntaxHighlighting(HighlightStyle.define([
    { tag: tags.propertyName, color: dark ? '#80c9ff' : '#075c94' },
    { tag: tags.string, color: dark ? '#add990' : '#32691a' },
    { tag: tags.number, color: dark ? '#f0bd81' : '#9c451b' },
    { tag: [tags.bool, tags.null], color: dark ? '#c7a4ff' : '#6b3aad', fontWeight: '600' },
    { tag: tags.punctuation, color: dark ? '#b5c7d7' : '#55617a' }
  ]))
}
const JSON_HIGHLIGHTING = { light: jsonHighlighting(false), dark: jsonHighlighting(true) }

const VIEWER_SETUP: BasicSetupOptions = {
  lineNumbers: true,
  foldGutter: true,
  bracketMatching: true,
  highlightSelectionMatches: true,
  searchKeymap: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  history: false,
  historyKeymap: false,
  autocompletion: false,
  completionKeymap: false,
  closeBrackets: false,
  closeBracketsKeymap: false,
  indentOnInput: false,
  dropCursor: false
}

const COMPACT_SETUP: BasicSetupOptions = {
  ...VIEWER_SETUP,
  lineNumbers: false,
  foldGutter: false,
  searchKeymap: false,
  highlightSelectionMatches: false
}

export default function CodeViewer({ value, theme, label, compact = false, language }: CodeViewerProps): ReactElement {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const [wrapLines, setWrapLines] = useState(language === 'json')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => { setCopyState('idle') }, [value])
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])
  const extensions = useMemo(() => [
    language === 'json' ? JSON_LANGUAGE : MYSQL_LANGUAGE,
    language === 'json' ? JSON_HIGHLIGHTING[theme] : SQL_HIGHLIGHTING[theme],
    CHINESE_PHRASES,
    EditorState.tabSize.of(2),
    // Non-editable content still needs keyboard focus for selection and search.
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': label, 'aria-readonly': 'true' }),
    ...(wrapLines ? [EditorView.lineWrapping] : [])
  ], [label, language, theme, wrapLines])

  return (
    <div className={compact ? 'sql-viewer sql-viewer--compact' : 'sql-viewer'} data-theme={theme}>
      {!compact ? (
        <div className="sql-viewer__toolbar">
          <span className="sql-viewer__mode">{language === 'json' ? 'JSON' : 'MySQL'} · 只读</span>
          <span className="panel__spacer" />
          {language === 'json' ? <>
            <button type="button" className="sql-viewer__button" onClick={() => {
              const view = editorRef.current?.view
              if (view) foldAll(view)
            }}>全部折叠</button>
            <button type="button" className="sql-viewer__button" onClick={() => {
              const view = editorRef.current?.view
              if (view) unfoldAll(view)
            }}>全部展开</button>
            <button type="button" className="sql-viewer__button" onClick={async () => {
              try {
                await navigator.clipboard.writeText(value)
                setCopyState('copied')
              } catch { setCopyState('failed') }
            }}>{copyState === 'copied' ? '已复制' : '复制 JSON'}</button>
            {copyState === 'failed' ? <span className="sql-viewer__copy-error" role="alert">复制失败，请重试。</span> : null}
          </> : null}
          <button
            type="button"
            className="sql-viewer__button"
            title="查找（Ctrl+F）"
            onClick={() => {
              const view = editorRef.current?.view
              if (view) openSearchPanel(view)
            }}
          >
            查找
          </button>
          <button
            type="button"
            className="sql-viewer__button"
            aria-pressed={wrapLines}
            onClick={() => setWrapLines((current) => !current)}
          >
            自动换行
          </button>
        </div>
      ) : null}
      <CodeMirror
        ref={editorRef}
        value={value}
        theme={theme === 'dark' ? oneDarkTheme : 'light'}
        extensions={extensions}
        basicSetup={compact ? COMPACT_SETUP : VIEWER_SETUP}
        readOnly
        editable={false}
        indentWithTab={false}
        minHeight={compact ? undefined : '200px'}
        maxHeight={compact ? '88px' : language === 'json' ? '520px' : 'max(200px, calc(100vh - 280px))'}
      />
    </div>
  )
}
