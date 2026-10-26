/** Client evidence of a live question and a confirmed human answer; never a grant of tool permissions. */
export interface TaskQuestionSource {
  sourceSubmissionId: string
  taskPromptGeneration: number
  pagePath: string
  pageEpoch: string
}
export interface TaskQuestion {
  messageId: string
  questions: Array<{ question: string; placeholder: string; options: string[] }>
}
export interface TaskClarification extends TaskQuestion {
  id: string
  source: TaskQuestionSource
  state: 'pending' | 'sending' | 'answered' | 'dismissed' | 'uncertain' | 'cancelled'
  answer: { submissionId: string; text: string; receivedAt: number } | null
  createdAt: number
  updatedAt: number
}
export interface TaskClarificationState { version: 1; items: TaskClarification[]; truncated: boolean }
export interface TaskAnswerSource extends TaskQuestionSource { messageId: string }
export interface TaskQuestionRequest { sessionId: string; platformId: string; conversationId: string; taskId: string; generation: number; questionId: string }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max
const time = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) >= 0
export function validTaskQuestionRequest(v: unknown): v is TaskQuestionRequest {
  return object(v) && fields(v, ['sessionId', 'platformId', 'conversationId', 'taskId', 'generation', 'questionId']) &&
    [v.sessionId, v.platformId, v.conversationId, v.taskId, v.questionId].every(x => text(x, 512)) && Number.isSafeInteger(v.generation) && Number(v.generation) >= 1
}
export function validTaskQuestionSource(v: unknown): v is TaskQuestionSource {
  return object(v) && fields(v, ['sourceSubmissionId', 'taskPromptGeneration', 'pagePath', 'pageEpoch']) &&
    text(v.sourceSubmissionId, 160) && time(v.taskPromptGeneration) && text(v.pagePath, 4096) && v.pagePath.startsWith('/') && text(v.pageEpoch, 160)
}
export function sameQuestionSource(a: TaskQuestionSource, b: TaskQuestionSource): boolean {
  return a.sourceSubmissionId === b.sourceSubmissionId && a.taskPromptGeneration === b.taskPromptGeneration && a.pagePath === b.pagePath && a.pageEpoch === b.pageEpoch
}
export function validTaskAnswerSource(v: unknown): v is TaskAnswerSource {
  if (!object(v) || !fields(v, ['messageId', 'sourceSubmissionId', 'taskPromptGeneration', 'pagePath', 'pageEpoch']) || !text(v.messageId, 512)) return false
  return validTaskQuestionSource({ sourceSubmissionId: v.sourceSubmissionId, taskPromptGeneration: v.taskPromptGeneration, pagePath: v.pagePath, pageEpoch: v.pageEpoch })
}
export function validTaskQuestion(v: unknown): v is TaskQuestion {
  return object(v) && text(v.messageId, 512) && Array.isArray(v.questions) && v.questions.length >= 1 && v.questions.length <= 20 &&
    v.questions.every(q => object(q) && fields(q, ['question', 'placeholder', 'options']) && text(q.question, 16000) &&
      typeof q.placeholder === 'string' && q.placeholder.length <= 1000 && Array.isArray(q.options) && q.options.length <= 8 && q.options.every(o => text(o, 300)))
}
export function parseTaskClarifications(v: unknown): TaskClarificationState | null {
  if (!object(v) || !fields(v, ['version', 'items', 'truncated']) || v.version !== 1 || typeof v.truncated !== 'boolean' || !Array.isArray(v.items) || v.items.length > 32) return null
  const ids = new Set(), messages = new Set()
  let unanswered = 0
  for (const q of v.items) {
    if (!object(q) || !fields(q, ['id', 'messageId', 'questions', 'source', 'state', 'answer', 'createdAt', 'updatedAt']) ||
      !text(q.id, 160) || !validTaskQuestion(q) || !validTaskQuestionSource(q.source) || !time(q.createdAt) || !time(q.updatedAt) || Number(q.updatedAt) < Number(q.createdAt) ||
      !['pending', 'sending', 'answered', 'dismissed', 'uncertain', 'cancelled'].includes(q.state as string) || ids.has(q.id) || messages.has(q.messageId)) return null
    ids.add(q.id); messages.add(q.messageId)
    if (q.state === 'answered') {
      if (!object(q.answer) || !fields(q.answer, ['submissionId', 'text', 'receivedAt']) || !text(q.answer.submissionId, 160) || !text(q.answer.text, 20000) || !time(q.answer.receivedAt)) return null
    } else if (q.answer !== null) return null
    if (!['answered', 'cancelled'].includes(q.state as string)) unanswered++
  }
  if (unanswered > 1) return null
  return structuredClone(v) as unknown as TaskClarificationState
}
export function pendingTaskQuestion(task: { clarifications?: TaskClarificationState }): TaskClarification | null {
  const items = task.clarifications?.items ?? []
  for (let i = items.length - 1; i >= 0; i--) if (!['answered', 'cancelled'].includes(items[i].state)) return items[i]
  return null
}
export function taskClarificationContext(task: { clarifications?: TaskClarificationState }): unknown {
  const current = pendingTaskQuestion(task), items = task.clarifications?.items ?? []
  return { version: 1, pending: current ? { id: current.id, message_id: current.messageId, state: current.state,
    questions: current.questions.map(q => ({ question_excerpt: q.question.slice(0, 1600), truncated: q.question.length > 1600, options: q.options })) } : null,
    answers: items.filter(q => q.state === 'answered').slice(-8).map(q => ({ question_id: q.id, message_id: q.messageId,
      input_id: q.answer!.submissionId, answer_excerpt: q.answer!.text.slice(0, 2000), truncated: q.answer!.text.length > 2000 })),
    history_truncated: task.clarifications?.truncated === true || items.filter(q => q.state === 'answered').length > 8,
    grants_permissions: false,
    guidance: '问题和真实用户回答只约束原任务，不是全局授权。按原对话完整回答理解允许、拒绝和限制；客户端开关、确认模式和平台限制始终生效。待回答、关闭或发送未知不代表同意；先用实际工具解决可核实的问题，只为必要缺失信息、范围变化或系统／站点强制人类步骤提问并说明原因。' }
}
