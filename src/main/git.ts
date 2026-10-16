import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createGitDiagnostic, writeGitDiagnostic } from './git-diagnostic'
import type { GitDiagnosticContext } from './git-diagnostic'
import type {
  GitChangeKind, GitDiffHunk, GitFileChange, GitFileDiff, GitFileStat,
  GitIndexStatus, GitLogEntry, GitLogResult, GitReadMode
} from '../shared/types'

/**
 * Read-only Git inspection for the toolbox -> Git panel.
 *
 * Everything here shells out to the system `git`. Nothing is ever written to the
 * repository: the panel only visualises history, the index and diffs.
 */

const FIELD = String.fromCharCode(31)
const RECORD = String.fromCharCode(30)
const MAX_COMMITS = 300
/** Diffs larger than this are truncated; the viewer is not a pager. */
const MAX_DIFF_BYTES = 512 * 1024

const EMPTY_INDEX: GitIndexStatus = { modified: 0, added: 0, deleted: 0 }

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 60000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' }
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })
}

export interface GitBackend {
  kind?: 'local' | 'ssh'
  runGit(cwd: string, args: string[], diagnostic?: GitDiagnosticContext): Promise<string>
  readWorkingFile(cwd: string, path: string, diagnostic?: GitDiagnosticContext): Promise<string>
}

const LOCAL_GIT_BACKEND: GitBackend = {
  kind: 'local',
  runGit,
  readWorkingFile: (cwd, path) => readFile(join(cwd, path.split('/').join(sep)), 'utf8')
}

/** One request ID follows an operation through Git, SFTP and SSH channel timings. */
function traceGitRequest(cwd: string, backend: GitBackend, operation: GitDiagnosticContext['operation']) {
  const context = createGitDiagnostic(backend.kind ?? 'local', operation)
  const started = performance.now()
  writeGitDiagnostic(context, { event: 'request-start' })
  const stage = async (name: NonNullable<GitDiagnosticContext['stage']>, read: (details: GitDiagnosticContext) => Promise<string>): Promise<string> => {
    const details = { ...context, stage: name }
    const start = performance.now()
    writeGitDiagnostic(details, { event: 'stage-start' })
    try {
      const output = await read(details)
      writeGitDiagnostic(details, { event: 'stage-finish', status: 'ok', elapsedMs: performance.now() - start, bytes: Buffer.byteLength(output) })
      return output
    } catch (error) {
      writeGitDiagnostic(details, { event: 'stage-finish', status: 'error', elapsedMs: performance.now() - start })
      throw error
    }
  }
  return {
    runGit: (name: NonNullable<GitDiagnosticContext['stage']>, args: string[]) => stage(name, (details) => backend.runGit(cwd, args, details)),
    readWorkingFile: (path: string) => stage('working-file', (details) => backend.readWorkingFile(cwd, path, details)),
    finish: (status: 'ok' | 'error', files?: number, commits?: number): void => {
      writeGitDiagnostic(context, { event: 'request-finish', status, elapsedMs: performance.now() - started, files, commits })
    }
  }
}
/**
 * Git on Windows emits CRLF. Every consumer below splits on LF alone, so a
 * stray carriage return would end up glued to the end of each line and stop
 * `@@` headers from matching. Normalise once, at the edge.
 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Prefer the first real branch name in `%D`; fall back to the checked-out branch. */
function pickBranch(refNames: string, fallback: string): string {
  if (!refNames) return fallback
  for (const raw of refNames.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const name = part.startsWith('HEAD -> ') ? part.slice(8).trim() : part
    if (name.startsWith('tag: ') || name === 'HEAD') continue
    return name.replace(/^origin\//, '')
  }
  return fallback
}

function parseLog(output: string, fallbackBranch: string): GitLogEntry[] {
  const entries: GitLogEntry[] = []
  for (const chunk of output.split(RECORD)) {
    const record = chunk.replace(/^\s+/, '').replace(/\s+$/, '')
    if (!record) continue
    const parts = record.split(FIELD)
    if (parts.length < 8) continue
    const parents = parts[1].trim()
    entries.push({
      hash: parts[0],
      branch: pickBranch(parts[7], fallbackBranch),
      parents: parents ? parents.split(' ') : [],
      author: { name: parts[2], email: parts[3] },
      authorDate: parts[4] || undefined,
      committerDate: parts[5],
      message: parts[6]
    })
  }
  return entries
}

/** NUL-delimited paths keep Chinese names, tabs, newlines and renames intact. */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>()
  const records = output.split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const match = records[i].match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/)
    if (!match) continue
    const additions = match[1] === '-' ? 0 : Number(match[1])
    const deletions = match[2] === '-' ? 0 : Number(match[2])
    let path = match[3]
    if (!path) {
      // A rename is followed by the original and destination paths.
      path = records[i + 2]
      i += 2
    }
    if (!path) continue
    counts.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0
    })
  }
  return counts
}

function kindFromCode(code: string): GitChangeKind {
  if (code === '??') return 'untracked'
  if (code.includes('R')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

function parseStatus(porcelain: string, counts?: Map<string, { additions: number; deletions: number }>): GitFileChange[] {
  const files: GitFileChange[] = []
  const records = porcelain.split('\0')
  for (let i = 0; i < records.length; i += 1) {
    const raw = records[i]
    if (raw.length < 3) continue
    const code = raw.slice(0, 2)
    const path = raw.slice(3)
    let oldPath: string | undefined
    if (code.includes('R') || code.includes('C')) oldPath = records[++i]

    const kind = kindFromCode(code)
    const count = counts?.get(path)
    const additions = count ? count.additions : 0
    const deletions = count ? count.deletions : 0

    files.push({ path, oldPath, kind, code: code.trim(), additions, deletions, statsLoaded: counts !== undefined && kind !== 'untracked' })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

function summarise(files: GitFileChange[]): GitIndexStatus {
  const status: GitIndexStatus = { ...EMPTY_INDEX }
  for (const file of files) {
    if (file.kind === 'added' || file.kind === 'untracked') status.added += 1
    else if (file.kind === 'deleted') status.deleted += 1
    else status.modified += 1
  }
  return status
}

/** Split a unified diff into hunks, tracking the two line counters. */
function parseDiff(output: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = []
  let current: GitDiffHunk | null = null
  let oldNumber = 0
  let newNumber = 0

  for (const line of toLf(output).split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldNumber = match ? Number(match[1]) : 0
      newNumber = match ? Number(match[2]) : 0
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', newNumber, text: line.slice(1) })
      newNumber += 1
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', oldNumber, text: line.slice(1) })
      oldNumber += 1
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldNumber, newNumber, text: line.slice(1) })
      oldNumber += 1
      newNumber += 1
    }
  }
  return hunks
}

/**
 * Split raw `git diff` output into the `@@` hunks the viewer wants.
 *
 * The viewer takes hunks as strings and parses them itself, so the file header
 * (index line, ---/+++ markers) is dropped and each hunk keeps only its body.
 */
function splitHunks(output: string): string[] {
  const hunks: string[] = []
  const headerLines: string[] = []
  let current: string[] = []
  let seenHunk = false
  for (const line of toLf(output).split('\n')) {
    if (line.startsWith('@@')) {
      if (current.length > 0) hunks.push(headerLines.concat(current).join('\n'))
      current = [line]
      seenHunk = true
      continue
    }
    if (seenHunk) {
      current.push(line)
    } else if (line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      headerLines.push(line)
    }
  }
  if (current.length > 0) hunks.push(headerLines.concat(current).join('\n'))
  return hunks
}

/** Map a file extension to the language name the highlighter expects. */
function languageOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return ext
  if (ext === 'json') return 'json'
  if (ext === 'css') return 'css'
  if (ext === 'scss') return 'scss'
  if (ext === 'html') return 'html'
  if (ext === 'md') return 'markdown'
  if (ext === 'yml' || ext === 'yaml') return 'yaml'
  if (ext === 'sh' || ext === 'ps1') return 'bash'
  return ''
}

/** Independent queries share SSH latency; the file overview never waits for history or file contents. */
export async function readGitLog(cwd: string, backend: GitBackend = LOCAL_GIT_BACKEND, mode: GitReadMode = 'all'): Promise<GitLogResult> {
  const result: GitLogResult = {
    isRepo: false,
    currentBranch: '',
    entries: [],
    indexStatus: { ...EMPTY_INDEX },
    files: [],
    statusLoaded: false
  }
  if (!cwd) return { ...result, error: '未设置 Git 工作目录。' }
  const trace = traceGitRequest(cwd, backend, mode)
  try {
    if (mode === 'stats') {
      const counts = parseNumstat(await trace.runGit('numstat', ['diff', 'HEAD', '--numstat', '-z']))
      result.isRepo = true
      result.fileStats = Array.from(counts, ([path, count]): GitFileStat => ({ path, ...count }))
      return result
    }
    const withFiles = mode === 'all' || mode === 'files'
    const withHistory = mode === 'all' || mode === 'history'
    const format = ['%H', '%P', '%an', '%ae', '%aI', '%cI', '%s', '%D'].join(FIELD) + RECORD
    const [inside, branch, status, history, stats] = await Promise.allSettled([
      trace.runGit('repo', ['rev-parse', '--is-inside-work-tree']),
      trace.runGit('branch', ['branch', '--show-current']),
      withFiles ? trace.runGit('status', ['status', '--porcelain=v1', '-z']) : Promise.resolve(null),
      withHistory ? trace.runGit('history', ['log', '--all', '--date=iso-strict', '-n', String(MAX_COMMITS), '--pretty=format:' + format]) : Promise.resolve(null),
      mode === 'all' ? trace.runGit('numstat', ['diff', 'HEAD', '--numstat', '-z']) : Promise.resolve(null)
    ])
    if (inside.status === 'rejected') {
      const message = inside.reason instanceof Error ? inside.reason.message : String(inside.reason)
      if (!/not a git repository/i.test(message)) result.error = '无法读取 Git 仓库：' + message
      return result
    }
    if (inside.value?.trim() !== 'true') return result
    result.isRepo = true
    if (branch.status === 'fulfilled') result.currentBranch = branch.value?.trim() || 'HEAD (detached)'
    if (history.status === 'fulfilled' && history.value !== null) result.entries = parseLog(history.value, result.currentBranch)
    if (stats.status === 'fulfilled' && stats.value !== null) {
      result.fileStats = Array.from(parseNumstat(stats.value), ([path, count]) => ({ path, ...count }))
    }
    if (status.status === 'fulfilled' && status.value !== null) {
      const counts = result.fileStats ? new Map(result.fileStats.map(({ path, ...count }) => [path, count])) : undefined
      result.files = parseStatus(status.value, counts)
      result.indexStatus = summarise(result.files)
      result.statusLoaded = true
    }
    const errors: string[] = []
    if (withFiles && status.status === 'rejected') errors.push('文件改动读取失败：' + errorMessage(status.reason))
    if (withHistory && history.status === 'rejected') errors.push('提交记录读取失败：' + errorMessage(history.reason))
    if (errors.length > 0) result.error = errors.join('\n')
    return result
  } catch (error) {
    result.error = errorMessage(error)
    return result
  } finally {
    trace.finish(result.error ? 'error' : 'ok', result.statusLoaded ? result.files.length : undefined, mode === 'history' || mode === 'all' ? result.entries.length : undefined)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read everything the diff viewer needs for one changed path.
 *
 * Both file revisions come back in full because the highlighter tokenises whole
 * files; the hunks then say which parts actually changed.
 */
export async function readGitDiff(cwd: string, path: string, backend: GitBackend = LOCAL_GIT_BACKEND): Promise<GitFileDiff> {
  const trace = traceGitRequest(cwd, backend, 'diff')
  try {
    const result = await readGitDiffContents(cwd, path, trace)
    trace.finish('ok')
    return result
  } catch (error) {
    trace.finish('error')
    throw error
  }
}

async function readGitDiffContents(cwd: string, path: string, trace: ReturnType<typeof traceGitRequest>): Promise<GitFileDiff> {
  const empty: GitFileDiff = {
    path,
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    rawHunks: [],
    oldContent: '',
    newContent: '',
    lang: ''
  }
  if (!cwd || !path) return empty

  const lang = languageOf(path)
  const [working, changes, previous] = await Promise.allSettled([
    trace.readWorkingFile(path),
    trace.runGit('diff', ['diff', 'HEAD', '--', path]),
    trace.runGit('old-file', ['show', 'HEAD:' + path])
  ])
  const newContent = working.status === 'fulfilled' ? working.value : ''
  if (changes.status === 'rejected') throw changes.reason
  let output = changes.value

  // An untracked file has nothing to diff against, so the whole file is new.
  if (!output.trim()) {
    if (!newContent) return { ...empty, lang }
    const lines = toLf(newContent).split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const fileHeader = '--- /dev/null\n+++ b/' + path
    const header = '@@ -0,0 +1,' + String(lines.length) + ' @@'
    const body = lines.map((line) => '+' + line).join('\n')
    return {
      path,
      binary: false,
      hunks: [],
      additions: lines.length,
      deletions: 0,
      rawHunks: [fileHeader + '\n' + header + '\n' + body],
      oldContent: '',
      newContent,
      lang
    }
  }

  if (output.length > MAX_DIFF_BYTES) output = output.slice(0, MAX_DIFF_BYTES)
  const normalised = toLf(output)
  const isBinary = normalised.split('\n').some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
  if (isBinary) return { ...empty, binary: true, lang, newContent }

  let additions = 0
  let deletions = 0
  for (const line of normalised.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }

  // Recover the previous revision so the left pane can be tokenised too.
  const oldContent = previous.status === 'fulfilled' ? previous.value : ''

  return {
    path,
    binary: false,
    hunks: parseDiff(output),
    additions,
    deletions,
    rawHunks: splitHunks(output),
    oldContent,
    newContent,
    lang
  }
}
