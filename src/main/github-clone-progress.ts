import { initialGithubCloneProgress } from '../shared/github'
import type { GithubCloneProgress } from '../shared/github'

const STAGES: Record<string, GithubCloneProgress['stage']> = {
  'Counting objects': 'counting',
  'Compressing objects': 'compressing',
  'Receiving objects': 'receiving',
  'Resolving deltas': 'resolving',
  'Updating files': 'checkout',
  'Checking out files': 'checkout',
  'Filtering content': 'filtering'
}

/** Only recognized numeric progress is exposed to the renderer; never raw remote diagnostics. */
export function parseGithubCloneProgress(line: string): GithubCloneProgress | null {
  const clean = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim().replace(/^remote:\s*/, '')
  const enumerating = /^Enumerating objects:\s*(\d+)(?:, done\.)?$/.exec(clean)
  if (enumerating) {
    const completed = Number(enumerating[1])
    return Number.isSafeInteger(completed) ? { ...initialGithubCloneProgress('enumerating'), completed } : null
  }
  const match = /^(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files|Filtering content):\s*(\d{1,3})%\s*\((\d+)\/(\d+)\)(?:,\s*(.*))?$/.exec(clean)
  if (!match) return null
  const percent = Number(match[2]), completed = Number(match[3]), total = Number(match[4])
  if (percent > 100 || !Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed > total) return null
  const transfer = /^(\d+(?:\.\d+)? (?:[KMGT]i?B|bytes|B))(?:\s*\|\s*(\d+(?:\.\d+)? (?:[KMGT]i?B|bytes|B)\/s))?(?:,|$)/.exec(match[5] ?? '')
  return { stage: STAGES[match[1]], percent, completed, total,
    transferred: transfer?.[1] ?? null, speed: transfer?.[2] ?? null }
}

/** Git overwrites progress with CR; pipe chunks may split a line anywhere. */
export function createGithubCloneProgressReader(onProgress: (progress: GithubCloneProgress) => void): { write(chunk: string): void; end(): void } {
  let pending = ''
  let previous = ''
  const accept = (line: string): void => {
    const progress = parseGithubCloneProgress(line)
    if (!progress) return
    const key = JSON.stringify(progress)
    if (key === previous) return
    previous = key
    onProgress(progress)
  }
  return {
    write(chunk) {
      const lines = (pending + chunk).split(/[\r\n]/)
      pending = lines.pop()!.slice(-8192)
      for (const line of lines) accept(line)
    },
    end() { accept(pending); pending = '' }
  }
}
