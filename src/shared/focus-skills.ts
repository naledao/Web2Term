import type { ConversationToolsState, ConversationToolId } from './conversation-tools'

export type FocusToolSkill = 'scheduled_task' | 'send_email' | 'computer'
export type FocusSkillId = 'compact' | FocusToolSkill
export function focusSkillToolId(id: FocusToolSkill): ConversationToolId {
  return id === 'scheduled_task' ? 'scheduled' : id === 'send_email' ? 'mail' : 'computer'
}
export const FOCUS_SKILLS: readonly { id: FocusSkillId; name: string; description: string; keywords: string }[] = [
  { id: 'compact', name: '压缩会话', description: '精简当前上下文，继续原对话', keywords: '压缩 compress compact conversation' },
  { id: 'scheduled_task', name: '定时任务', description: '按指定周期创建或管理当前对话的计划', keywords: '定时 计划 schedule scheduled task' },
  { id: 'send_email', name: '邮件通知', description: '向已配置的收件邮箱发送任务通知', keywords: '邮件 通知 email mail notification' },
  { id: 'computer', name: '电脑操作', description: '使用本机桌面应用完成本次任务', keywords: '电脑 桌面 computer desktop' }
]
export function validFocusToolSkills(value: unknown): value is FocusToolSkill[] {
  return Array.isArray(value) && value.length <= 3 && new Set(value).size === value.length &&
    value.every(id => id === 'scheduled_task' || id === 'send_email' || id === 'computer')
}
export function focusSkillQuery(text: string, caret: number): { start: number; end: number; query: string; ids: FocusSkillId[] } | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null
  const start = text.lastIndexOf('\n', caret - 1) + 1
  const match = /^[ \t]*\/\/([^/\n]*)$/.exec(text.slice(start, caret))
  if (!match) return null
  const query = match[1].trim().toLowerCase()
  return { start, end: caret, query, ids: FOCUS_SKILLS.filter(skill => !query || query.split(/\s+/).every(word =>
    (skill.name + ' ' + skill.keywords).includes(word))).map(skill => skill.id) }
}
export function focusSkillUnavailable(id: FocusToolSkill, state: ConversationToolsState | null): string {
  if (!state) return '正在读取工具状态…'
  const entry = state.tools.find(tool => tool.id === focusSkillToolId(id))
  if (!entry || !entry.available) return entry?.message || '当前环境暂不支持此技能。'
  if (!entry.enabled) return '请先在该技能的设置中启用' + (id === 'scheduled_task' ? '定时任务。' : id === 'send_email' ? '邮件通知。' : '电脑操作。')
  return ''
}
/** Only selected tool names travel with this human task. Fresh definitions and desktop
 * step tokens are obtained through the existing, task-bound tool-description receipt. */
export function focusSkillPrefix(skills: readonly FocusToolSkill[]): string {
  if (!skills.length) return ''
  return ['【本次按需技能】',
    '用户为本次任务选择：' + skills.map(id => FOCUS_SKILLS.find(skill => skill.id === id)!.name).join('、') + '。',
    '先单独输出以下 JSON 代码块，读取本次技能的最新完整说明；收到软件回传后再处理用户任务，不凭历史猜测格式或桌面步骤令牌：',
    '```json', JSON.stringify({ type: 'read_tool_prompt', tools: skills }), '```',
    '选择技能仅提供本次可用能力，不等于要求执行其中全部动作；不修改技能设置，不扩大授权。任务范围以用户正文为准；缺少周期、邮件内容或操作目标等关键信息时先澄清，不自行补造。',
    '【用户任务】', ''].join('\n')
}
export function focusSkillMessage(text: string, skills: readonly FocusToolSkill[]): string {
  const prefix = focusSkillPrefix(skills)
  // Reuse the existing user-text boundary, so software instructions stay out of
  // native capture, editable user bubbles and user-goal summaries.
  return prefix ? prefix + '\u2063\u2063' + text : text
}
