export type ToolKind = 'git' | 'mysql' | 'redis' | 'nacos'
export const TOOL_LABELS: Record<ToolKind, string> = {
  git: 'Git 管理', mysql: 'MySQL 连接', redis: 'Redis 连接', nacos: 'Nacos 连接'
}
export interface ToolWindowEntry {
  id: string
  sessionId: string
  kind: ToolKind
  cwd: string
  minimized: boolean
}
export type ToolWindowAction =
  | { type: 'open'; sessionId: string; kind: ToolKind; cwd?: string }
  | { type: 'minimize' | 'restore' | 'close'; id: string }
  | { type: 'retain'; sessionIds: string[] }

/** Keep contents mounted; only closing a tool or deleting its session removes it. */
export function toolWindowReducer(state: ToolWindowEntry[], action: ToolWindowAction): ToolWindowEntry[] {
  if (action.type === 'retain') return state.filter((item) => action.sessionIds.includes(item.sessionId))
  if (action.type === 'close') return state.filter((item) => item.id !== action.id)
  if (action.type === 'minimize') return state.map((item) => item.id === action.id ? { ...item, minimized: true } : item)
  const existing = action.type === 'open'
    ? state.find((item) => item.sessionId === action.sessionId && item.kind === action.kind)
    : state.find((item) => item.id === action.id)
  if (action.type === 'restore' && !existing) return state
  const sessionId = action.type === 'open' ? action.sessionId : existing!.sessionId
  const next = state.map((item) => item.sessionId !== sessionId ? item : {
    ...item, minimized: item.id !== existing?.id
  })
  if (!existing && action.type === 'open') next.push({
    id: `${sessionId}:${action.kind}`, sessionId, kind: action.kind,
    cwd: action.cwd ?? '', minimized: false
  })
  return next
}
