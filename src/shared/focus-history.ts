import { focusOwnerKey } from './focus-chat'
import type { FocusChatState, FocusChatUpdate, FocusTurn, FocusToolCall } from './focus-chat'
import type { ExecutionRecord } from './types'

/** Keep history references stable when only live page metadata changed. Never mix owners. */
export function mergeFocusChatUpdate(previous: FocusChatState | null, update: FocusChatUpdate): FocusChatState | null {
  const current = previous && focusOwnerKey(previous) === focusOwnerKey(update) ? previous : null
  if (!current && (!update.turns || !update.executions)) return null
  const sameTurns = !!current?.historyCursor && current.historyCursor.turns === update.historyCursor?.turns
  const sameExecutions = !!current?.historyCursor && current.historyCursor.executions === update.historyCursor?.executions
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
