import { EditorState } from '@uiw/react-codemirror'
import { MySQL, sql } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/** Shared by the read-only SQL viewer and the editable SQL editor so both color SQL alike. */
export const MYSQL_LANGUAGE = sql({ dialect: MySQL })

function sqlHighlighting(dark: boolean) {
  return syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.bool, tags.null], color: dark ? '#c7a4ff' : '#6b3aad', fontWeight: '600' },
    { tag: [tags.name, tags.special(tags.string)], color: dark ? '#80c9ff' : '#075c94' },
    { tag: tags.typeName, color: dark ? '#f0bd81' : '#994b00' },
    { tag: tags.number, color: dark ? '#f0bd81' : '#9c451b' },
    { tag: tags.string, color: dark ? '#add990' : '#32691a' },
    { tag: tags.comment, color: dark ? '#9cadc2' : '#5c6778', fontStyle: 'italic' },
    { tag: tags.operator, color: dark ? '#b5c7d7' : '#42516a' }
  ]))
}
export const SQL_HIGHLIGHTING = { light: sqlHighlighting(false), dark: sqlHighlighting(true) }

export const CHINESE_PHRASES = EditorState.phrases.of({
  Find: '查找',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  'match case': '区分大小写',
  regexp: '正则表达式',
  'by word': '全词匹配',
  close: '关闭',
  'Go to line': '跳转到行',
  go: '跳转',
  'current match': '当前匹配',
  'on line': '所在行',
  'Fold line': '折叠行',
  'Unfold line': '展开行',
  'folded code': '已折叠的代码',
  unfold: '展开',
  'Folded lines': '已折叠行',
  'Unfolded lines': '已展开行',
  to: '至'
})
