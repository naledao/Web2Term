import type { TerminalLine } from '@shared/types'

const MAX_ENTRIES = 200
const MAX_CHARACTERS = 200_000
const MAX_SCOPES = 100

/** In memory only: terminal input may contain credentials, so never persist it to disk. */
export class TerminalCommandHistory {
  private entries: string[] = []
  private observed: string[] = []

  remember(text: string): void {
    const command = text.replace(/\r\n?/g, '\n')
    if (!command.trim() || command.length > MAX_CHARACTERS || this.entries.at(-1) === command) return
    this.entries.push(command)
    let characters = this.entries.reduce((total, entry) => total + entry.length, 0)
    while (this.entries.length > MAX_ENTRIES || characters > MAX_CHARACTERS) {
      characters -= this.entries.shift()!.length
    }
  }

  /** Only ingest appended commands; output updates and trimmed transcripts must not reorder history. */
  observe(lines: readonly TerminalLine[]): void {
    // SSH echoes include user@host:path$; manual input was remembered at submit.
    // Ignore these display lines rather than stripping prompt-like text from commands.
    const commands = lines.filter((line) => line.kind === 'command' && !line.inputEcho)
      .map((line) => line.text.replace(/\r\n?/g, '\n'))
    let overlap = Math.min(this.observed.length, commands.length)
    while (overlap > 0 && !this.observed.slice(-overlap).every((text, index) => text === commands[index])) overlap--
    for (const command of commands.slice(overlap)) this.remember(command)
    this.observed = commands
  }

  snapshot(): string[] { return [...this.entries] }
}

const histories = new Map<string, TerminalCommandHistory>()
export function terminalCommandHistory(sessionId: string, target: string): TerminalCommandHistory {
  const key = JSON.stringify([sessionId, target])
  let history = histories.get(key)
  if (!history) history = new TerminalCommandHistory()
  histories.delete(key)
  histories.set(key, history)
  if (histories.size > MAX_SCOPES) histories.delete(histories.keys().next().value!)
  return history
}

export interface CommandHistoryCursor {
  entries: string[]
  index: number
  draft: string
}

/** Freeze the entries during browsing so a new AI command cannot move the current selection. */
export function navigateCommandHistory(
  cursor: CommandHistoryCursor | null, entries: string[], draft: string, direction: 'up' | 'down'
): { cursor: CommandHistoryCursor | null; value: string } | null {
  if (!cursor && (direction === 'down' || entries.length === 0)) return null
  const current = cursor ?? { entries: [...entries], index: entries.length, draft }
  const index = Math.max(0, Math.min(current.entries.length, current.index + (direction === 'up' ? -1 : 1)))
  if (index === current.entries.length) return { cursor: null, value: current.draft }
  return { cursor: { ...current, index }, value: current.entries[index] }
}

export function canNavigateCommandHistory(value: string, start: number, end: number, direction: 'up' | 'down'): boolean {
  if (start !== end) return false
  return direction === 'up' ? !value.slice(0, start).includes('\n') : !value.slice(end).includes('\n')
}
