import { cleanFocusAnswer, focusOwnerKey, focusReplyParts } from './focus-chat'
import type { FocusChatState, FocusChatUpdate, FocusPart, FocusTurn, FocusToolCall } from './focus-chat'
import type { ExecutionRecord } from './types'

/** Keep history references stable when only live page metadata changed. Never mix owners. */
export function mergeFocusChatUpdate(previous: FocusChatState | null, update: FocusChatUpdate): FocusChatState | null {
  const current = previous && focusOwnerKey(previous) === focusOwnerKey(update) ? previous : null
  if (!current && (!update.turns || !update.executions)) return null
  const samePresentation = current?.historyCursor?.presentation === update.historyCursor?.presentation
  const sameTurns = samePresentation && !!current?.historyCursor && current.historyCursor.turns === update.historyCursor?.turns
  const sameExecutions = samePresentation && !!current?.historyCursor && current.historyCursor.executions === update.historyCursor?.executions
  const { turns, executions, hiddenMessageIds, ...metadata } = update
  const next: FocusChatState = { ...metadata,
    turns: sameTurns ? current!.turns : turns ?? current!.turns,
    executions: sameExecutions ? current!.executions : executions ?? current!.executions,
    hiddenMessageIds: sameTurns ? current!.hiddenMessageIds : hiddenMessageIds ?? current?.hiddenMessageIds }
  if (!current) return next
  let unchanged = next.turns === current.turns && next.executions === current.executions && next.hiddenMessageIds === current.hiddenMessageIds
  // Histories are compared by cursor above; serialize each metadata object at most once per poll.
  const reused = next as unknown as Record<string, unknown>, earlier = current as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (key === 'turns' || key === 'executions' || key === 'hiddenMessageIds') continue
    const before = earlier[key], after = reused[key]
    if (before === after) continue
    if (before && after && typeof before === 'object' && typeof after === 'object' && JSON.stringify(before) === JSON.stringify(after)) {
      reused[key] = before
      continue
    }
    unchanged = false
  }
  return unchanged ? current : next
}

/** One pass instead of scanning every execution once for every process segment. */
export function groupFocusExecutions(turn: FocusTurn, records: ReadonlyMap<string, ExecutionRecord>): {
  executions: ExecutionRecord[]
  byCycle: Map<number, ExecutionRecord[]>
  unassigned: ExecutionRecord[]
  toolsByCycle: Map<number, FocusToolCall[]>
  unassignedTools: FocusToolCall[]
} {
  const executions: ExecutionRecord[] = [], unassigned: ExecutionRecord[] = []
  const byCycle = new Map<number, ExecutionRecord[]>()
  const cycles = new Set(turn.segments.map(segment => segment.cycle))
  const toolsByCycle = new Map<number, FocusToolCall[]>(), unassignedTools: FocusToolCall[] = []
  for (const call of turn.toolCalls ?? []) {
    if (!cycles.has(call.cycle)) { unassignedTools.push(call); continue }
    const group = toolsByCycle.get(call.cycle)
    if (group) group.push(call)
    else toolsByCycle.set(call.cycle, [call])
  }
  for (const id of turn.executionIds) {
    const record = records.get(id)
    if (!record) continue
    executions.push(record)
    const cycle = turn.executionCycles?.[id]
    if (!cycles.has(cycle)) { unassigned.push(record); continue }
    const group = byCycle.get(cycle)
    if (group) group.push(record)
    else byCycle.set(cycle, [record])
  }
  return { executions, byCycle, unassigned, toolsByCycle, unassignedTools }
}

type FocusParseFailure = NonNullable<FocusTurn['parseFailures']>[number]
export interface FocusTimelineCycle {
  cycle: number
  parts: FocusPart[]
  executions: ExecutionRecord[]
  toolCalls: FocusToolCall[]
  parseFailures: FocusParseFailure[]
}
export interface FocusTimelineProcess {
  cycles: FocusTimelineCycle[]
  executions: ExecutionRecord[]
  toolCalls: FocusToolCall[]
  parseFailures: FocusParseFailure[]
  unassignedExecutions: ExecutionRecord[]
  unassignedTools: FocusToolCall[]
  unassignedFailures: FocusParseFailure[]
  hasProcess: boolean
}
export interface FocusTimelineAnswer {
  cycle: number
  sourceMessageId: string | null
  text: string
  settled: boolean
}
export interface FocusTimelineBlock {
  process: FocusTimelineProcess
  answer: FocusTimelineAnswer | null
}

function emptyTimelineProcess(): FocusTimelineProcess {
  return {
    cycles: [],
    executions: [],
    toolCalls: [],
    parseFailures: [],
    unassignedExecutions: [],
    unassignedTools: [],
    unassignedFailures: [],
    hasProcess: false
  }
}

function pushByCycle<T>(map: Map<number, T[]>, cycle: number | undefined, item: T, unassigned: T[]): void {
  if (cycle === undefined || !Number.isInteger(cycle) || cycle < 0) {
    unassigned.push(item)
    return
  }
  const list = map.get(cycle)
  if (list) list.push(item)
  else map.set(cycle, [item])
}

/**
 * Partition one turn into alternating [process, answer] blocks so any subsequent
 * round after prose starts a new process box below that prose instead of appending
 * back into an earlier process box.
 */
export function buildFocusTurnTimeline(
  turn: FocusTurn,
  recordsById: ReadonlyMap<string, ExecutionRecord>,
  platformId: string,
  richAnswers: ReadonlyMap<string, string>,
  options?: { sendBlocked?: boolean }
): FocusTimelineBlock[] {
  const executionIds = new Set(turn.executionIds)
  const toolSources = new Set((turn.toolCalls ?? []).map(call => call.sourceMessageId))
  const segmentsByCycle = new Map<number, { sourceMessageId: string | null; parts: FocusPart[]; answerText: string; settled: boolean }>()
  for (const segment of turn.segments) {
    const rawAnswer = (!turn.archived && segment.sourceMessageId ? richAnswers.get(segment.sourceMessageId) : '') || segment.answer
    const baseParts = focusReplyParts(segment.answer, platformId, segment.parts)
    const parts = rawAnswer === segment.answer ? baseParts : focusReplyParts(rawAnswer, platformId, baseParts)
    const protocolOwned = !!segment.sourceMessageId && (executionIds.has(segment.sourceMessageId) || toolSources.has(segment.sourceMessageId))
    const cleaned = !segment.answer.trim() || protocolOwned ? '' : cleanFocusAnswer(rawAnswer, platformId)
    segmentsByCycle.set(segment.cycle, {
      sourceMessageId: segment.sourceMessageId,
      parts,
      answerText: cleaned.trim() ? cleaned : '',
      settled: segment.settled
    })
  }
  const executionsByCycle = new Map<number, ExecutionRecord[]>(), unassignedExecutions: ExecutionRecord[] = []
  for (const id of turn.executionIds) {
    const record = recordsById.get(id)
    if (record) pushByCycle(executionsByCycle, turn.executionCycles?.[id], record, unassignedExecutions)
  }
  const toolsByCycle = new Map<number, FocusToolCall[]>(), unassignedTools: FocusToolCall[] = []
  for (const call of turn.toolCalls ?? []) pushByCycle(toolsByCycle, call.cycle, call, unassignedTools)
  const failuresByCycle = new Map<number, FocusParseFailure[]>(), unassignedFailures: FocusParseFailure[] = []
  for (const failure of turn.parseFailures ?? []) pushByCycle(failuresByCycle, failure.cycle, failure, unassignedFailures)

  const allCycles = [...new Set([
    ...segmentsByCycle.keys(),
    ...executionsByCycle.keys(),
    ...toolsByCycle.keys(),
    ...failuresByCycle.keys()
  ])].sort((a, b) => a - b)

  const blocks: FocusTimelineBlock[] = []
  let current = emptyTimelineProcess()
  for (const cycle of allCycles) {
    const segment = segmentsByCycle.get(cycle)
    const parts = segment?.parts ?? []
    const executions = executionsByCycle.get(cycle) ?? []
    const toolCalls = toolsByCycle.get(cycle) ?? []
    const parseFailures = failuresByCycle.get(cycle) ?? []
    if (parts.length || executions.length || toolCalls.length || parseFailures.length) {
      current.cycles.push({ cycle, parts, executions, toolCalls, parseFailures })
      current.executions.push(...executions)
      current.toolCalls.push(...toolCalls)
      current.parseFailures.push(...parseFailures)
      current.hasProcess = true
    }
    if (segment?.answerText) {
      blocks.push({
        process: current,
        answer: { cycle, sourceMessageId: segment.sourceMessageId, text: segment.answerText, settled: segment.settled }
      })
      current = emptyTimelineProcess()
    }
  }
  const turnWorking = !turn.archived && turn.status === 'working'
  const hasActiveNotice = !turn.archived && (options?.sendBlocked === true || !!turn.commandRecovery || turn.notice === 'parse-failed')
  const lastAnswer = blocks.at(-1)?.answer
  if (!blocks.length || current.hasProcess || (turnWorking && !!lastAnswer?.settled) || hasActiveNotice) {
    blocks.push({ process: current, answer: null })
  }
  if (unassignedExecutions.length || unassignedTools.length) {
    const first = blocks[0].process
    first.unassignedExecutions.push(...unassignedExecutions)
    first.unassignedTools.push(...unassignedTools)
    first.executions.push(...unassignedExecutions)
    first.toolCalls.push(...unassignedTools)
    first.hasProcess = true
  }
  if (unassignedFailures.length) {
    const last = blocks[blocks.length - 1].process
    last.unassignedFailures.push(...unassignedFailures)
    last.parseFailures.push(...unassignedFailures)
    last.hasProcess = true
  }
  return blocks
}
