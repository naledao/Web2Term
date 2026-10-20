import { useMemo } from 'react'
import type { ReactElement } from 'react'
import CodeMirror, { EditorState, EditorView } from '@uiw/react-codemirror'
import type { BasicSetupOptions } from '@uiw/react-codemirror'
import type { AppTheme } from '../../../shared/types'
import { CHINESE_PHRASES, MYSQL_LANGUAGE, SQL_HIGHLIGHTING } from './sql-codemirror'

interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  theme: AppTheme
  label: string
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  minHeight?: string
  maxHeight?: string
}

const EDITOR_SETUP: BasicSetupOptions = {
  lineNumbers: true,
  foldGutter: false,
  bracketMatching: true,
  closeBrackets: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  highlightSelectionMatches: true,
  history: true,
  historyKeymap: true,
  indentOnInput: true,
  autocompletion: false,
  completionKeymap: false,
  searchKeymap: false
}

/*
 * Transparent background so the editor sits on the surrounding field's own surface and
 * border, which carry the focus ring the plain textarea used to have.
 */
function editorTheme(dark: boolean) {
  return EditorView.theme({
    '&': { backgroundColor: 'transparent', color: dark ? '#e3ecf7' : '#243246', fontSize: '13px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: "Consolas, 'Courier New', monospace", lineHeight: '1.7' },
    '.cm-content': { padding: '12px 0', caretColor: dark ? '#e3ecf7' : '#243246' },
    '.cm-line': { padding: '0 14px 0 10px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: dark ? '#e3ecf7' : '#243246' },
    '.cm-gutters': {
      backgroundColor: dark ? '#111822' : '#f3f6fa',
      color: dark ? '#6f7d92' : '#9aa5b5',
      border: 'none',
      borderRight: `1px solid ${dark ? '#2c3748' : '#e3e8f0'}`
    },
    '.cm-activeLine': { backgroundColor: dark ? 'rgba(101, 216, 237, 0.06)' : 'rgba(0, 134, 161, 0.05)' },
    '.cm-activeLineGutter': { backgroundColor: dark ? '#18212e' : '#e9eef5', color: dark ? '#a0afc5' : '#55617a' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: dark ? '#244c63' : '#c7e9f2'
    },
    '.cm-placeholder': { color: dark ? '#6f7d92' : '#9aa5b5' }
  }, { dark })
}
const EDITOR_THEME = { light: editorTheme(false), dark: editorTheme(true) }

/** An editable MySQL field with syntax highlighting, in place of a plain textarea. */
export default function SqlEditor({
  value,
  onChange,
  theme,
  label,
  placeholder,
  disabled = false,
  autoFocus = false,
  minHeight = '230px',
  maxHeight = '50vh'
}: SqlEditorProps): ReactElement {
  const extensions = useMemo(() => [
    MYSQL_LANGUAGE,
    SQL_HIGHLIGHTING[theme],
    CHINESE_PHRASES,
    EditorState.tabSize.of(2),
    // Long column comments wrap instead of pushing a horizontal scrollbar into the dialog.
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': label })
  ], [label, theme])

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={EDITOR_THEME[theme]}
      extensions={extensions}
      basicSetup={EDITOR_SETUP}
      placeholder={placeholder}
      editable={!disabled}
      readOnly={disabled}
      autoFocus={autoFocus}
      minHeight={minHeight}
      maxHeight={maxHeight}
    />
  )
}
