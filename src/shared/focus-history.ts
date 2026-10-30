import { focusOwnerKey } from './focus-chat'
import type { FocusChatState, FocusChatUpdate, FocusTurn } from './focus-chat'
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
  if (current && next.turns === current.turns && next.executions === current.executions && next.hiddenMessageIds === current.hiddenMessageIds) {
    const { turns: _turns, executions: _executions, hiddenMessageIds: _hidden, ...previousMetadata } = current
    // Only small live metadata is compared; historical answers and command output are excluded.
    if (JSON.stringify(previousMetadata) === JSON.stringify(metadata)) return current
  }
  if (current) for (const key of ['smartReplies', 'composerModes', 'modelSettings', 'promptInjection', 'contextUsage', 'historyCursor', 'sendFailure'] as const) {
    if (JSON.stringify(current[key]) === JSON.stringify(next[key])) Object.assign(next, { [key]: current[key] })
  }
  return next
}

/** One pass instead of scanning every execution once for every process segment. */
export function groupFocusExecutions(turn: FocusTurn, records: ReadonlyMap<string, ExecutionRecord>): {
  executions: ExecutionRecord[]
  byCycle: Map<number, ExecutionRecord[]>
  unassigned: ExecutionRecord[]
} {
  const executions: ExecutionRecord[] = [], unassigned: ExecutionRecord[] = []
  const byCycle = new Map<number, ExecutionRecord[]>()
  const cycles = new Set(turn.segments.map(segment => segment.cycle))
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
  return { executions, byCycle, unassigned }
}
