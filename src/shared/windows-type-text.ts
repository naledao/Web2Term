import type { ComputerUseActionDefinition } from './computer-use'

export const TYPE_TEXT_DEFINITION: ComputerUseActionDefinition = {
  action: 'type_text',
  description: '向最新观察中已获得键盘焦点的真实控件输入文字。先由 AI 点击目标，再 observe(include_controls=true 或 target=controls) 取得当前焦点 element_id；不要求用户选窗。mode=insert（默认）以分段 Unicode 文本事件替换当前选区／在光标插入，不清空全文；mode=replace 明确替换整个控件内容，仅使用可写 UIA Value，不模拟全选或自动回退。支持中文、非 BMP 字符、制表与逻辑换行，CRLF/CR/LF 在插入时统一为一个 Unicode CR 字符，不生成 Enter、Tab 或组合键；应用仍决定如何处理字符。文本按字面输入，不解释脚本或快捷键。每段复核窗口和实际焦点；取消、部分输入或未知结果不重输。操作后自动返回新观察；只有有界回读与预期全文一致才报告 content_verified=true，输入流接收不等于内容正确或业务完成。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '本任务最近一组包含控件的观察编号。' },
    { name: 'element_id', type: 'string', required: true, minLength: 35, maxLength: 35, description: '本组已返回且实际获得键盘焦点的控件，不能传坐标或原生句柄。' },
    { name: 'text', type: 'string', required: true, minLength: 0, maxLength: 8192, description: '最多 8192 个 UTF-16 单元；保留空格，支持中文、emoji、换行和制表；拒绝无效代理项及其他控制字符。仅 replace 允许空串清空。' },
    { name: 'mode', type: 'string', required: false, enum: ['insert', 'replace'], description: '默认 insert，输入到当前光标／选区；replace 替换整个控件值，不得用于只想插入一段文字的情况。' }
  ],
  example: { observation_id: 'obs_' + '0'.repeat(32), element_id: 'el_' + '0'.repeat(32), text: '你好，世界。', mode: 'insert' }
}

export const canonicalText = (text: string): string => text.replace(/\r\n|\r/g, '\n')
export const unicodeInputText = (text: string): string => canonicalText(text).replace(/\n/g, '\r')
export function unicodeTextChunks(text: string): string[] {
  const chunks: string[] = [], input = unicodeInputText(text)
  for (let offset = 0; offset < input.length;) {
    let end = Math.min(input.length, offset + 32)
    if (end < input.length && /[\uD800-\uDBFF]/.test(input[end - 1])) end--
    chunks.push(input.slice(offset, end)); offset = end
  }
  return chunks
}
export function validateTypeTextParameters(p: Record<string, unknown>): string | null {
  const validId = (v: unknown, prefix: string): boolean => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
  let valid = typeof p.text === 'string' && p.text.length <= 8192 && (p.text.length > 0 || p.mode === 'replace')
  if (valid) {
    const text = p.text as string
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c < 32 && c !== 9 && c !== 10 && c !== 13 || c >= 0x7f && c <= 0x9f) { valid = false; break }
      if (c >= 0xd800 && c <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) { valid = false; break } }
      else if (c >= 0xdc00 && c <= 0xdfff) { valid = false; break }
    }
  }
  return !valid || !validId(p.observation_id, 'obs_') || !validId(p.element_id, 'el_') || !['insert', 'replace'].includes((p.mode ?? 'insert') as string) ||
    Object.keys(p).some(k => !['observation_id', 'element_id', 'text', 'mode'].includes(k))
    ? 'type_text 只接受最新观察中的焦点控件、有效 Unicode 文字（最多 8192 UTF-16 单元）及 insert／replace；空串只用于 replace，不接受坐标、按键或脚本字段。' : null
}

export interface TextInputBatch {
  offset: number; length: number; accepted: number | null
  release_attempted: boolean; release_accepted: number | null
}
export interface WindowsTypeTextReceipt {
  request_id: string; observation_id: string; source_step_id: string; window_id: string | null; element_id: string
  mode: 'insert' | 'replace'; method: 'none' | 'unicode' | 'uia_value'
  text_utf16_length: number; text_sha256: string
  input_attempted: boolean; input_completed: boolean; batches: TextInputBatch[]
  verification: 'matched' | 'mismatched' | 'unavailable'; content_verified: boolean
  before_at: string; completed_at: string; goal_verified: false; input_ready: false
}
