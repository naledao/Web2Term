import type { ComputerUseActionDefinition } from './computer-use'

export const TYPE_TEXT_DEFINITION: ComputerUseActionDefinition = {
  action: 'type_text',
  description: '向最新窗口观察中的键盘目标输入字面文字。优先指定真实焦点编辑控件；自绘/UIA不可读时可省略 element_id，仅支持 insert，实时核对窗口键盘路由且不回读内容。mode=insert（默认）以分段 Unicode 文本事件替换当前选区／在光标插入，不清空全文；mode=replace 明确替换整个控件内容，仅使用可写 UIA Value，不模拟全选或自动回退。支持中文、非 BMP 字符、制表与逻辑换行，CRLF/CR/LF 在插入时统一为一个 Unicode CR 字符，不生成 Enter、Tab 或组合键；应用仍决定如何处理字符。文本按字面输入，不解释脚本或快捷键。每段复核窗口和实际焦点；取消、部分输入或未知结果不重输。操作后自动返回新观察；只有有界回读与预期全文一致才报告 content_verified=true，输入流接收不等于内容正确或业务完成。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '本任务最近一组业务窗口观察编号；指定 element_id 时需包含相应控件。' },
    { name: 'element_id', type: 'string', required: false, minLength: 35, maxLength: 35, description: '优先使用本组真实焦点编辑控件；自绘/UIA不可读时可省略，仅以 insert 向最近窗口的已核对键盘路由输入，不回读或声称内容已验证。' },
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
  return !valid || !validId(p.observation_id, 'obs_') || p.element_id !== undefined && !validId(p.element_id, 'el_') || p.element_id === undefined && p.mode === 'replace' || !['insert', 'replace'].includes((p.mode ?? 'insert') as string) ||
    Object.keys(p).some(k => !['observation_id', 'element_id', 'text', 'mode'].includes(k))
    ? 'type_text 需要最新业务窗口观察、有效 Unicode 文字（最多8192 UTF-16单元）及insert／replace；焦点控件可选，省略时只支持insert。空串只用于明确控件的replace，不接受坐标、按键或脚本字段。' : null
}

export interface TextInputBatch {
  offset: number; length: number; accepted: number | null
  release_attempted: boolean; release_accepted: number | null
}
export interface WindowsTypeTextReceipt {
  request_id: string; observation_id: string; source_step_id: string; window_id: string | null; element_id: string | null
  mode: 'insert' | 'replace'; method: 'none' | 'unicode' | 'uia_value'
  text_utf16_length: number; text_sha256: string
  input_attempted: boolean; input_completed: boolean; batches: TextInputBatch[]
  verification: 'matched' | 'mismatched' | 'unavailable'; content_verified: boolean
  before_at: string; completed_at: string; goal_verified: false; input_ready: false
}
