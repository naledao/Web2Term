/**
 * When to re-send the terminal prompt within one conversation.
 *
 * The full prompt (several thousand characters) used to travel with the first human send of
 * every task, although the model still had the previous copy in context. Each conversation now
 * keeps a ledger of what it was last given, and every task start picks the cheapest prefix that
 * keeps the model on protocol:
 *
 *   full      no ledger, the context since the last full copy is large, or repeated violations
 *   reminder  one protocol violation since the last full copy: resend the core contract
 *   delta     some sections changed (machine, directory, notes, tools): resend only those
 *   none      nothing changed: a one-line anchor
 */

export type InjectionMode = 'full' | 'delta' | 'reminder' | 'none'

export type InjectionReason =
  | 'no-ledger' | 'budget' | 'violations' | 'mostly-changed'
  | 'violation' | 'changed' | 'unchanged' | 'empty'

/** What one conversation was last given. Persisted per conversation; holds no prompt text. */
export interface InjectionLedger {
  v: 1
  /** Section key → hash of the section text the model last received. */
  sections: Record<string, string>
  /** Conversation text since the last full copy, in characters. */
  charsSinceFull: number
  /** Unparseable command replies since the last full copy or reminder. */
  violations: number
  sendsSinceFull: number
  fullAt: number
}

export interface InjectionPlan {
  mode: InjectionMode
  reason: InjectionReason
  /** What the page prepends to the next task's first human send. */
  prefix: string
  fullLength: number
  /** Hashes of the current full prompt's sections, committed once the send is confirmed. */
  sections: Record<string, string>
  changed: string[]
  removed: string[]
  charsSinceFull: number
  violations: number
  budget: number
}

export interface PromptSection {
  key: string
  heading: string
  text: string
}

/** Blank line between the injected prefix and the user's text; matches TERMINAL_PROMPT_SEPARATOR. */
const SEPARATOR = '\n\n'

/** Sections that carry the reply contract the app parses. */
const REMINDER_HEADINGS = ['【角色】', '【任务路由】', '【工作协议】', '【需要执行时】']

const ANCHOR = '【终端助手】本对话此前注入的约定继续有效。'

/**
 * Re-send the full prompt once the conversation since the last copy reaches this many characters.
 * About half of what each site keeps in context, so the copy is refreshed before it is truncated.
 */
const BUDGETS: Record<string, number> = { chatgpt: 60_000, deepseek: 60_000, claude: 120_000, gemini: 200_000 }
const DEFAULT_BUDGET = 40_000

/** Two violations without a refresh mean the model lost the contract, not a slip. */
const VIOLATION_LIMIT = 2
/** A delta this large saves too little to be worth the risk of a partial picture. */
const MOSTLY_CHANGED = 0.6

export function injectionBudget(platformId: string): number {
  return BUDGETS[platformId] ?? DEFAULT_BUDGET
}

/** FNV-1a, 32 bit: a change detector, not a security boundary. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** A line that is only a 【heading】 starts a section; inline 【markers】 stay in their section. */
export function splitPromptSections(prompt: string): PromptSection[] {
  const sections: PromptSection[] = []
  const seen = new Map<string, number>()
  let current: { heading: string; lines: string[] } = { heading: '', lines: [] }
  const flush = () => {
    const text = current.lines.join('\n').trim()
    if (text === '') return
    const count = (seen.get(current.heading) ?? 0) + 1
    seen.set(current.heading, count)
    sections.push({ key: count === 1 ? current.heading : `${current.heading}#${count}`, heading: current.heading, text })
  }
  for (const line of prompt.split('\n')) {
    if (/^【[^】\n]{1,40}】$/.test(line.trim())) {
      flush()
      current = { heading: line.trim(), lines: [line] }
    } else current.lines.push(line)
  }
  flush()
  return sections
}

export function parseInjectionLedger(raw: string | null | undefined): InjectionLedger | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<InjectionLedger>
    if (value?.v !== 1 || !value.sections || typeof value.sections !== 'object' || Array.isArray(value.sections)) return null
    const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : 0
    const sections: Record<string, string> = {}
    for (const [key, hash] of Object.entries(value.sections)) if (typeof hash === 'string') sections[key] = hash
    return { v: 1, sections, charsSinceFull: count(value.charsSinceFull), violations: count(value.violations),
      sendsSinceFull: count(value.sendsSinceFull), fullAt: count(value.fullAt) }
  } catch { return null }
}

export function planInjection(ledger: InjectionLedger | null, fullPrefix: string, platformId: string): InjectionPlan {
  const budget = injectionBudget(platformId)
  const prompt = fullPrefix.endsWith(SEPARATOR) ? fullPrefix.slice(0, -SEPARATOR.length) : fullPrefix
  const sections = splitPromptSections(prompt)
  const hashes: Record<string, string> = {}
  for (const section of sections) hashes[section.key] = hashText(section.text)
  const base = { fullLength: fullPrefix.length, sections: hashes, budget,
    charsSinceFull: ledger?.charsSinceFull ?? 0, violations: ledger?.violations ?? 0 }
  const full = (reason: InjectionReason): InjectionPlan => ({ ...base, mode: 'full', reason, prefix: fullPrefix, changed: [], removed: [] })
  if (prompt.trim() === '') return { ...base, mode: 'none', reason: 'empty', prefix: '', changed: [], removed: [] }
  if (!ledger) return full('no-ledger')
  if (ledger.charsSinceFull >= budget) return full('budget')
  if (ledger.violations >= VIOLATION_LIMIT) return full('violations')

  const changed = sections.filter(section => ledger.sections[section.key] !== hashes[section.key])
  const removed = Object.keys(ledger.sections).filter(key => !(key in hashes))
  const changedLength = changed.reduce((sum, section) => sum + section.text.length, 0)
  if (changedLength >= prompt.length * MOSTLY_CHANGED) return full('mostly-changed')

  const removedLine = removed.length > 0 ? ['以下分段已不再适用：' + removed.map(key => key.replace(/#\d+$/, '')).join('、')] : []
  const result = (mode: InjectionMode, reason: InjectionReason, header: string[], body: PromptSection[]): InjectionPlan => ({
    ...base, mode, reason, changed: changed.map(section => section.key), removed,
    prefix: [...header, ...body.map(section => section.text), ...removedLine].join('\n\n') + SEPARATOR
  })

  if (ledger.violations > 0) {
    const core = sections.filter(section => REMINDER_HEADINGS.includes(section.heading))
    if (core.length === 0) return full('violations')
    return result('reminder', 'violation',
      ['【约定提醒】\n上一轮回复没有按约定格式输出。以下约定以此为准，未列出的约定继续有效：'],
      sections.filter(section => core.includes(section) || changed.includes(section)))
  }
  if (changed.length > 0 || removed.length > 0) {
    return result('delta', 'changed', ['【提示词更新】\n以下分段替换本对话此前注入的同名分段，未列出的约定继续有效：'], changed)
  }
  return result('none', 'unchanged', [ANCHOR], [])
}

/** The page confirmed a send that carried `plan.prefix`. */
export function commitInjection(ledger: InjectionLedger | null, plan: InjectionPlan, now: number): InjectionLedger {
  if (plan.mode === 'full' || !ledger) {
    return { v: 1, sections: { ...plan.sections }, charsSinceFull: 0, violations: 0, sendsSinceFull: 0, fullAt: now }
  }
  return {
    ...ledger,
    // Delta and reminder bring every section up to date; an anchor leaves them as they are.
    sections: plan.mode === 'none' ? ledger.sections : { ...plan.sections },
    charsSinceFull: ledger.charsSinceFull + plan.prefix.length,
    violations: plan.mode === 'reminder' ? 0 : ledger.violations,
    sendsSinceFull: ledger.sendsSinceFull + 1
  }
}

export function addInjectionTraffic(ledger: InjectionLedger, chars: number): InjectionLedger {
  return Number.isFinite(chars) && chars > 0 ? { ...ledger, charsSinceFull: ledger.charsSinceFull + Math.round(chars) } : ledger
}

export function noteInjectionViolation(ledger: InjectionLedger): InjectionLedger {
  return { ...ledger, violations: ledger.violations + 1 }
}
