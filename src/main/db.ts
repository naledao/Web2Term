import { DatabaseSync } from 'node:sqlite'
import { ScheduledTaskStore } from './scheduled-task-store'
import { ContextUsageStore } from './context-usage-store'
import { parseAutonomousTask, parseTaskToolContext } from '../shared/autonomous-task'
import type { AutonomousTask, TaskToolContext, TaskLease } from '../shared/autonomous-task'
import { validComputerActionClaim } from '../shared/computer-actions'
import type { ComputerActionClaim } from '../shared/computer-actions'
import type { ComputerActionUpdate, ComputerActionRecord } from '../shared/computer-actions'
import { insertComputerAction, writeComputerAction } from './computer-action-storage'
import { recoverInterruptedComputerActions } from './computer-recovery'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { nativeImage } from 'electron'
import { parseReadFilesRequest } from '../shared/file-requests'
import { parseBackgroundOptions } from '../shared/background-tasks'
import type { BackgroundCommandOptions } from '../shared/background-tasks'
import { normalizeTerminalNotesDirectory } from './terminal-notes'
import { interruptRunningCommands, recoverInterruptedExecutions } from './execution-recovery'
import type { StoredFileReadRequest, FileDeliveryStatus } from '../shared/file-requests'
import { isRecentCommandPayload } from '../shared/types'
import type { FocusTurn } from '../shared/focus-chat'
import type {
  Conversation,
  ConversationImageAttachmentInput,
  ExecutionRecord,
  ExecutionStatus,
  ScrapedConversation,
  SshHost,
  WorkspaceProject,
  WorkspaceProjectDraft
} from '../shared/types'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const MYSQL_CONNECTIONS_TABLE = `-- Saved MySQL connections for one machine -- a LIST, not a single row.
--
-- One row per machine could not describe the ordinary case of a local database next
-- to a staging one, and it made the connection form overwrite itself every time a
-- second connection was entered. Its id is the row own identity and is what the
-- dialog tabs are keyed by.
--
-- The password is never stored in the clear: secret holds base64 of Electron safeStorage
-- ciphertext (DPAPI-backed on Windows), or empty when none is set.
CREATE TABLE IF NOT EXISTS mysql_connections (
  id            TEXT NOT NULL,
  machine_scope TEXT NOT NULL,
  host_id       TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  host          TEXT NOT NULL DEFAULT '',
  port          INTEGER NOT NULL DEFAULT 3306,
  username      TEXT NOT NULL DEFAULT '',
  secret        TEXT NOT NULL DEFAULT '',
  database      TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_mysql_connections_machine ON mysql_connections (machine_scope, host_id, updated_at);`

const NACOS_CONNECTIONS_TABLE = `-- Saved Nacos consoles for one machine -- a LIST, like mysql_connections.
--
-- Same reasoning: one server per machine is the exception, not the rule (dev, test,
-- and production consoles are all reachable from one desk). The id is the row own
-- identity and is what the dialog tabs are keyed by.
--
-- There is no password column. A Nacos console authenticates in its OWN page, with its
-- own login form and its own cookies, kept in the view partition. The app never sees
-- those credentials, so there is nothing here to encrypt.
CREATE TABLE IF NOT EXISTS nacos_connections (
  id            TEXT NOT NULL,
  machine_scope TEXT NOT NULL,
  host_id       TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  namespace     TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_nacos_connections_machine ON nacos_connections (machine_scope, host_id, updated_at);`

const REDIS_CONNECTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS redis_connections (
  id TEXT PRIMARY KEY,
  machine_scope TEXT NOT NULL,
  host_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 6379,
  username TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL DEFAULT '',
  database_index INTEGER NOT NULL DEFAULT 0,
  tls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redis_connections_machine ON redis_connections (machine_scope, host_id, updated_at);`

interface StoredRedisConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  secret: string
  database: number
  tls: boolean
  updatedAt: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  machine_scope TEXT NOT NULL,
  host_id       TEXT NOT NULL DEFAULT '',
  machine_label TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(machine_scope, host_id, path)
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  goal       TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at DESC);

-- Clean user/assistant transcript. Internal system prompts, terminal command output, and
-- assistant command instructions never enter this table; those stay in the automation pipeline.
CREATE TABLE IF NOT EXISTS conversation_messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  role              TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  source_message_id TEXT,
  content           TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation
  ON conversation_messages (conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_source
  ON conversation_messages (conversation_id, role, source_message_id)
  WHERE source_message_id IS NOT NULL;

-- Goals submitted in autonomous mode; deliberately separate from executable commands.
CREATE TABLE IF NOT EXISTS autonomous_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  conversation_id TEXT,
  source_submission_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(session_id, generation),
  UNIQUE(session_id, platform_id, source_submission_id)
);
CREATE INDEX IF NOT EXISTS idx_autonomous_tasks_owner
  ON autonomous_tasks(session_id, platform_id, conversation_id, generation DESC);

-- Append-only admission journal, not an execution queue or restored authorization.
CREATE TABLE IF NOT EXISTS computer_action_claims (
  execution_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES autonomous_tasks(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  grant_token TEXT NOT NULL,
  received_token TEXT,
  action TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('action', 'feedback')),
  request_json TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, platform_id, conversation_id, task_id, generation, source_message_id),
  UNIQUE(session_id, platform_id, conversation_id, task_id, generation, grant_token)
);

CREATE TABLE IF NOT EXISTS computer_actions (
  execution_id TEXT PRIMARY KEY REFERENCES computer_action_claims(execution_id) ON DELETE CASCADE,
  execution_state TEXT NOT NULL CHECK(execution_state IN ('queued','dispatching','completed','failed','cancelled','unknown')),
  execution_fact TEXT NOT NULL CHECK(execution_fact IN ('not_executed','executed','unknown')),
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','uploading','sending','sent','failed','unknown','cancelled')),
  result_json TEXT,
  delivery_text TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  active_attempt_id TEXT,
  dispatched_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computer_observations (
  execution_id TEXT NOT NULL REFERENCES computer_actions(execution_id) ON DELETE CASCADE,
  image_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(mime_type = 'image/png'),
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','uploading','sending','sent','failed','unknown','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(execution_id, image_id)
);
-- Upgrade admission-only history conservatively; never reconstruct execution permission.
INSERT OR IGNORE INTO computer_actions (execution_id, execution_state, execution_fact, delivery_state, created_at, updated_at)
  SELECT execution_id, CASE WHEN kind = 'feedback' THEN 'failed' ELSE 'unknown' END,
    CASE WHEN kind = 'feedback' THEN 'not_executed' ELSE 'unknown' END, 'unknown', created_at, created_at FROM computer_action_claims;

CREATE TABLE IF NOT EXISTS focus_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_focus_turns_owner
  ON focus_turns(session_id, platform_id, conversation_id, created_at);

-- Background tasks of one workspace session, restored after a restart (see docs/background-tasks.md).
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  -- 1 while the task runs or a notification is still owed; such rows are never pruned.
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_background_tasks_session
  ON background_tasks(session_id, created_at);

CREATE TABLE IF NOT EXISTS message_attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('image')),
  mime_type    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  size_bytes   INTEGER NOT NULL,
  ordinal      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(message_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message
  ON message_attachments (message_id, ordinal ASC);
CREATE INDEX IF NOT EXISTS idx_message_attachments_sha256
  ON message_attachments (sha256);

-- One row per command the model asked for. The primary key is ChatGPT's own
-- assistant message id, which is what makes "运行过的命令不能运行了" survive a
-- restart: a message that already has a row is never executed again.
CREATE TABLE IF NOT EXISTS executions (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  command         TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'command',
  background      INTEGER NOT NULL DEFAULT 0,
  background_options TEXT,
  file_request    TEXT,
  task_context    TEXT,
  delivery_status TEXT,
  description     TEXT NOT NULL DEFAULT '',
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  status          TEXT NOT NULL,
  exit_code       INTEGER,
  output          TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_executions_conversation
  ON executions (conversation_id, created_at);

-- Keep the three newest complete command JSON objects per conversation.
-- Execution history remains intact for duplicate-execution protection.
CREATE TABLE IF NOT EXISTS recent_command_json (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_command_json_conversation
  ON recent_command_json (conversation_id, created_at DESC);
-- User-created sidebar projects. These never follow the terminal's current directory.
CREATE TABLE IF NOT EXISTS workspace_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  directory TEXT NOT NULL DEFAULT '',
  terminal_notes TEXT,
  created_at INTEGER NOT NULL
);
-- App-level chats and their terminal/connection state, restored after restart.
CREATE TABLE IF NOT EXISTS managed_sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  platform_id     TEXT NOT NULL DEFAULT 'chatgpt',
  workspace_project_id TEXT,
  paused          INTEGER NOT NULL DEFAULT 0,
  prompt_injection_enabled INTEGER NOT NULL DEFAULT 1,
  local_cwd       TEXT NOT NULL DEFAULT '',
  ssh_host_id     TEXT NOT NULL DEFAULT '',
  ssh_attached    INTEGER NOT NULL DEFAULT 0,
  ssh_reconnect   INTEGER NOT NULL DEFAULT 0,
  ssh_cwd         TEXT NOT NULL DEFAULT '',
  send_delay_seconds INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_sessions_created_at
  ON managed_sessions (created_at ASC);
-- Small key/value store for app settings that must survive a restart
-- (currently just the execution mode).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- SSH targets. The password never lands here in the clear: the secret column
-- holds base64 of Electron's safeStorage ciphertext (DPAPI-backed on Windows),
-- or an empty string when no password is stored.
--
-- 'note' retains the legacy machine-level description for explicit directory import.
CREATE TABLE IF NOT EXISTS ssh_hosts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL,
  username   TEXT NOT NULL,
  proxy      TEXT NOT NULL DEFAULT '',
  secret     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Directory conventions are shared by sessions using the same machine and exact cwd.
CREATE TABLE IF NOT EXISTS terminal_directory_notes (
  machine_scope TEXT NOT NULL CHECK(machine_scope IN ('local', 'ssh')),
  host_id       TEXT NOT NULL,
  directory_key TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (machine_scope, host_id, directory_key)
);

${MYSQL_CONNECTIONS_TABLE}
${NACOS_CONNECTIONS_TABLE}
${REDIS_CONNECTIONS_TABLE}
`

interface ConversationRow {
  id: string
  url: string
  title: string
  goal: string
  project_id: string | null
  project_machine_scope: string | null
  project_host_id: string | null
  project_machine_label: string | null
  project_name: string | null
  project_path: string | null
  updated_at: number
}

interface ConversationMessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  source_message_id: string | null
  content: string
  created_at: number
}
interface MessageAttachmentRow {
  id: string
  message_id: string
  kind: 'image'
  mime_type: string
  file_name: string
  storage_path: string
  sha256: string
  width: number | null
  height: number | null
  size_bytes: number
  ordinal: number
  created_at: number
}

/**
 * Command replies belong to the execution pipeline, not to the clean chat transcript.
 * DeepSeek does not keep the same message identity between the streamed command event and
 * the later rendered Markdown, so matching only `executions.message_id` is not sufficient.
 * The command protocol is deliberately narrow: a JSON object with a string `command` field.
 * DeepSeek's native DSML tool-call markup (`<｜DSML｜invoke name="…">`) is the same request.
 */
function isAssistantCommandReply(content: string): boolean {
  return /\{\s*["']command["']\s*:\s*["']/s.test(String(content || '')) || /"type"\s*:\s*"(?:read_files|scheduled_task|send_email|read_tool_prompt)"/.test(content) ||
    /<\s*[\s|｜]*DSML[\s|｜]*invoke\s+name\s*=/.test(content)
}

interface ExecutionRow {
  message_id: string
  conversation_id: string
  command: string
  background: number
  background_options: string | null
  kind: string
  file_request: string | null
  task_context?: string | null
  delivery_status: string | null
  description: string
  timeout_seconds: number
  status: string
  exit_code: number | null
  output: string
  output_deferred?: number
  created_at: number
  started_at: number | null
  finished_at: number | null
}
export interface ManagedSessionRecord {
  id: string
  projectId?: string | null
  title: string
  url: string
  conversationId: string | null
  /** Which chat site this session drives. See `ManagedSessionSummary.platformId`. */
  platformId: string
  paused: boolean
  promptInjectionEnabled: boolean
  localCwd: string
  sshHostId: string
  sshAttached: boolean
  sshReconnect: boolean
  sshCwd: string
  sendDelaySeconds: number
  createdAt: number
  updatedAt: number
}

/** Map a raw SQLite row onto the shared shape. */
function toExecutionRecord(row: ExecutionRow): ExecutionRecord {
  let taskContext: TaskToolContext | null = null
  try { taskContext = row.task_context ? parseTaskToolContext(JSON.parse(row.task_context)) : null } catch { /* Corrupt provenance blocks task-associated execution. */ }
  if (taskContext && (taskContext.conversationId !== row.conversation_id || taskContext.tool !== (row.kind === 'read_files' ? 'read_files' : 'command'))) taskContext = null
  let backgroundOptions: BackgroundCommandOptions | undefined
  try { backgroundOptions = row.background_options ? parseBackgroundOptions(JSON.parse(row.background_options)) ?? undefined : undefined } catch { /* Invalid metadata never becomes a readiness check. */ }
  let fileRequest: StoredFileReadRequest | null = null
  try {
    const raw = row.file_request ? JSON.parse(row.file_request) : null
    const parsed = parseReadFilesRequest(raw)
    if (parsed && raw.context && (raw.context.scope === 'local' || raw.context.scope === 'ssh') && typeof raw.context.cwd === 'string' && typeof raw.context.hostId === 'string') {
      fileRequest = { ...parsed, context: raw.context }
    }
  } catch { /* A malformed stored request must never become a shell command. */ }
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    command: row.command,
    background: row.background === 1,
    ...(backgroundOptions ? { backgroundOptions } : {}),
    kind: row.kind === 'read_files' || row.kind === 'command' ? row.kind : 'invalid',
    fileRequest,
    deliveryStatus: row.delivery_status as FileDeliveryStatus | null,
    description: row.description,
    timeoutSeconds: row.timeout_seconds,
    status: row.status as ExecutionStatus,
    exitCode: row.exit_code,
    output: row.output,
    ...(row.output_deferred ? { outputDeferred: true } : {}),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(row.task_context !== undefined && row.task_context !== null ? { taskContext } : {})
  }
}

/**
 * SQLite-backed store for ChatGPT conversations.
 *
 * Uses Node's built-in `node:sqlite` (available in Electron's main process),
 * so the project needs no native module and no Electron ABI rebuild.
 */
export class ConversationStore {
  private readonly db: DatabaseSync
  private executionsRevision = 0
  private executionsBaseline = 0
  private readonly executionRevisions = new Map<string, number>()
  readonly contextUsage: ContextUsageStore
  readonly scheduledTasks: ScheduledTaskStore
  private readonly attachmentsDir: string

  constructor(filePath: string) {
    // userData exists once Electron is ready, but be defensive on first run.
    mkdirSync(dirname(filePath), { recursive: true })
    this.attachmentsDir = join(dirname(filePath), 'attachments')
    mkdirSync(this.attachmentsDir, { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.contextUsage = new ContextUsageStore(this.db)
    this.scheduledTasks = new ScheduledTaskStore(this.db)
    this.migrate()
    const computerInterrupted = recoverInterruptedComputerActions(this.db)
    if (computerInterrupted > 0) console.info(`[db] recovered ${computerInterrupted} interrupted computer action(s) from the previous run`)
    const interrupted = recoverInterruptedExecutions(this.db)
    if (interrupted > 0) console.info(`[db] recovered ${interrupted} interrupted execution(s) from the previous run`)
    this.removeDuplicateMessageAttachments()
  }

  /**
   * Add columns that were introduced after a database was first created.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing at all to an existing table, so a
   * column added to SCHEMA reaches new databases only. Without this, an upgraded
   * install would be missing it and every query touching it would throw.
   */
  private migrate(): void {
    const sshColumns = this.db.prepare('PRAGMA table_info(ssh_hosts)').all() as unknown as Array<{
      name: string
    }>
    if (!sshColumns.some((column) => column.name === 'note')) {
      this.db.exec("ALTER TABLE ssh_hosts ADD COLUMN note TEXT NOT NULL DEFAULT ''")
    }
    /*
     * mysql_connections gained an `id` column, so the table is a LIST now rather than one
     * row per machine. CREATE TABLE IF NOT EXISTS leaves the old shape alone, and a primary
     * key cannot be altered in place, so the legacy rows are carried into the new table and
     * the old one is dropped. Those rows were one-connection-per-machine, which maps onto
     * exactly one row each; the connection gets an empty name and is labelled by its host.
     */
    const mysqlColumns = this.db
      .prepare('PRAGMA table_info(mysql_connections)')
      .all() as unknown as Array<{ name: string }>
    if (!mysqlColumns.some((column) => column.name === 'id')) {
      this.db.exec('ALTER TABLE mysql_connections RENAME TO mysql_connections_legacy')
      this.db.exec(MYSQL_CONNECTIONS_TABLE)
      const legacyRows = this.db
        .prepare('SELECT machine_scope, host_id, host, port, username, secret, database, updated_at FROM mysql_connections_legacy')
        .all() as unknown as Array<{
        machine_scope: string
        host_id: string
        host: string
        port: number
        username: string
        secret: string
        database: string
        updated_at: number
      }>
      const insertLegacy = this.db.prepare(
        'INSERT INTO mysql_connections (id, machine_scope, host_id, name, host, port, username, secret, database, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const row of legacyRows) {
        insertLegacy.run(randomUUID(), row.machine_scope, row.host_id, '', row.host, row.port, row.username, row.secret, row.database, row.updated_at)
      }
      this.db.exec('DROP TABLE mysql_connections_legacy')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_mysql_connections_machine ON mysql_connections (machine_scope, host_id, updated_at)')
    }
    const workspaceProjectColumns = this.db.prepare('PRAGMA table_info(workspace_projects)').all() as unknown as Array<{ name: string }>
    if (!workspaceProjectColumns.some(column => column.name === 'terminal_notes')) {
      this.db.exec('ALTER TABLE workspace_projects ADD COLUMN terminal_notes TEXT')
    }
    const managedSessionColumns = this.db
      .prepare('PRAGMA table_info(managed_sessions)')
      .all() as unknown as Array<{ name: string }>
    const managedSessionMigrations: Array<[string, string]> = [
      ['workspace_project_id', 'TEXT'],
      ['paused', 'INTEGER NOT NULL DEFAULT 0'],
      ['prompt_injection_enabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['local_cwd', "TEXT NOT NULL DEFAULT ''"],
      ['ssh_host_id', "TEXT NOT NULL DEFAULT ''"],
      ['ssh_attached', 'INTEGER NOT NULL DEFAULT 0'],
      ['ssh_reconnect', 'INTEGER NOT NULL DEFAULT 0'],
      ['ssh_cwd', "TEXT NOT NULL DEFAULT ''"],
      ['send_delay_seconds', 'INTEGER NOT NULL DEFAULT 0']
    ]
    for (const [name, definition] of managedSessionMigrations) {
      if (!managedSessionColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE managed_sessions ADD COLUMN ${name} ${definition}`)
      }
    }

    const executionColumns = this.db
      .prepare('PRAGMA table_info(executions)')
      .all() as unknown as Array<{ name: string }>
    if (!executionColumns.some((column) => column.name === 'started_at')) {
      this.db.exec('ALTER TABLE executions ADD COLUMN started_at INTEGER')
    }
    if (!executionColumns.some((column) => column.name === 'timeout_seconds')) {
      this.db.exec('ALTER TABLE executions ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 120')
    }
    for (const [name, definition] of [['kind', "TEXT NOT NULL DEFAULT 'command'"], ['file_request', 'TEXT'], ['delivery_status', 'TEXT'], ['background', 'INTEGER NOT NULL DEFAULT 0'], ['background_options', 'TEXT'], ['task_context', 'TEXT']]) {
      if (!executionColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE executions ADD COLUMN ${name} ${definition}`)
    }
    const conversationColumns = this.db
      .prepare('PRAGMA table_info(conversations)')
      .all() as unknown as Array<{ name: string }>
    if (!conversationColumns.some((column) => column.name === 'project_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT')
    }
    if (!conversationColumns.some((column) => column.name === 'goal')) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN goal TEXT NOT NULL DEFAULT ''")
    }
    /*
     * `managed_sessions.platform_id` — which chat site a session drives.
     *
     * Existing rows were all ChatGPT, so the default is not just a placeholder: it is the
     * correct value for every row written before this column existed.
     */
    const managedColumns = this.db
      .prepare('PRAGMA table_info(managed_sessions)')
      .all() as unknown as Array<{ name: string }>
    if (!managedColumns.some((column) => column.name === 'platform_id')) {
      this.db.exec("ALTER TABLE managed_sessions ADD COLUMN platform_id TEXT NOT NULL DEFAULT 'chatgpt'")
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id, updated_at DESC)'
    )
    // Older builds briefly stored assistant command JSON as chat. Remove both rows whose
    // source id matches an execution and DeepSeek rows whose streamed/rendered ids differ.
    this.db.exec(
      "DELETE FROM conversation_messages WHERE role = 'assistant' AND source_message_id IN (SELECT message_id FROM executions)"
    )
    const commandRows = this.db
      .prepare("SELECT id, content FROM conversation_messages WHERE role = 'assistant'")
      .all() as unknown as Array<{ id: string; content: string }>
    const removeCommandReply = this.db.prepare('DELETE FROM conversation_messages WHERE id = ?')
    let removedCommandReplies = 0
    for (const row of commandRows) {
      if (!isAssistantCommandReply(row.content)) continue
      removeCommandReply.run(row.id)
      removedCommandReplies += 1
    }
    if (removedCommandReplies > 0) {
      console.info(`[db] removed ${removedCommandReplies} assistant command reply record(s)`)
    }
  }

  /**
   * Return a stable identity for the decoded image pixels. Raw PNG/JPEG bytes can
   * differ after the browser's canvas fallback while displaying the same picture.
   */
  private attachmentContentHash(bytes: Buffer, rawHash = createHash('sha256').update(bytes).digest('hex')): string {
    try {
      const image = nativeImage.createFromBuffer(bytes)
      if (!image.isEmpty()) return createHash('sha256').update(image.toPNG()).digest('hex')
    } catch (_) {
      /* malformed or unsupported image: retain the raw-byte identity */
    }
    return rawHash
  }

  /** Remove duplicate decoded images left by older capture builds. */
  private removeDuplicateMessageAttachments(): void {
    const rows = this.db
      .prepare(
        `SELECT id, message_id, storage_path, sha256
           FROM message_attachments
          ORDER BY message_id ASC, ordinal ASC, rowid ASC`
      )
      .all() as unknown as Array<{ id: string; message_id: string; storage_path: string; sha256: string }>
    if (rows.length < 2) return

    const seen = new Set<string>()
    const duplicates: Array<{ id: string; storagePath: string }> = []
    for (const row of rows) {
      const absolutePath = join(this.attachmentsDir, row.storage_path)
      let contentHash = row.sha256
      try {
        if (existsSync(absolutePath)) contentHash = this.attachmentContentHash(readFileSync(absolutePath), row.sha256)
      } catch (_) {
        /* leave an unreadable attachment identifiable by its stored raw hash */
      }
      const key = `${row.message_id}:${contentHash}`
      if (seen.has(key)) duplicates.push({ id: row.id, storagePath: row.storage_path })
      else seen.add(key)
    }
    if (duplicates.length === 0) return

    const remove = this.db.prepare('DELETE FROM message_attachments WHERE id = ?')
    for (const duplicate of duplicates) remove.run(duplicate.id)
    const stillReferenced = this.db.prepare('SELECT 1 FROM message_attachments WHERE storage_path = ? LIMIT 1')
    for (const duplicate of duplicates) {
      if (stillReferenced.get(duplicate.storagePath)) continue
      const absolutePath = join(this.attachmentsDir, duplicate.storagePath)
      try {
        if (existsSync(absolutePath)) unlinkSync(absolutePath)
      } catch (_) {
        /* the row is gone; a later orphan sweep can remove an undeletable file */
      }
    }
    console.info(`[db] removed ${duplicates.length} duplicate image attachment(s)`)
  }

  /**
   * Insert a conversation, or refresh it if already known.
   *
   * A blank title never overwrites a known one: navigation events fire before
   * the page has a real title, and the sidebar occasionally renders an empty
   * label for a moment.
   */
  private ensureProject(
    project: {
      machineScope: 'local' | 'ssh'
      hostId: string
      machineLabel: string
      name: string
      path: string
    },
    now: number
  ): string {
    const existing = this.db
      .prepare('SELECT id FROM projects WHERE machine_scope = ? AND host_id = ? AND path = ?')
      .get(project.machineScope, project.hostId, project.path) as { id: string } | undefined

    if (existing) {
      this.db
        .prepare('UPDATE projects SET machine_label = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(project.machineLabel, project.name, now, existing.id)
      return existing.id
    }

    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO projects (id, machine_scope, host_id, machine_label, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, project.machineScope, project.hostId, project.machineLabel, project.name, project.path, now, now)
    return id
  }

  upsert(
    conversation: ScrapedConversation,
    project?: {
      machineScope: 'local' | 'ssh'
      hostId: string
      machineLabel: string
      name: string
      path: string
    } | null,
    now = Date.now()
  ): boolean {
    const existing = this.db
      .prepare('SELECT title, project_id FROM conversations WHERE id = ?')
      .get(conversation.id) as { title: string; project_id: string | null } | undefined

    if (!existing) {
      const projectId = project ? this.ensureProject(project, now) : null
      this.db
        .prepare(
          'INSERT INTO conversations (id, url, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(conversation.id, conversation.url, conversation.title, projectId, now, now)
      return true
    }

    const title = conversation.title.trim() === '' ? existing.title : conversation.title
    const projectId = existing.project_id ?? (project ? this.ensureProject(project, now) : null)
    this.db
      .prepare('UPDATE conversations SET url = ?, title = ?, project_id = ?, updated_at = ? WHERE id = ?')
      .run(conversation.url, title, projectId, now, conversation.id)
    return true
  }

  /**
   * Record what the user asked for in this conversation.
   *
   * A blank goal never overwrites a known one, for the same reason a blank title does
   * not: the capture happens on send, and a miss must not erase what is already known.
   * It does NOT touch `updated_at` — that orders the sidebar, and the goal arrives from
   * a send rather than from activity in the page.
   */
  setGoal(conversationId: string, goal: string): boolean {
    const text = goal.trim()
    if (text === '') return false
    const result = this.db
      .prepare('UPDATE conversations SET goal = ? WHERE id = ?')
      .run(text, conversationId)
    return result.changes > 0
  }

  /** Merge a batch scraped from the sidebar. Returns how many were new. */
  upsertMany(conversations: ScrapedConversation[]): number {
    let inserted = 0
    for (const conversation of conversations) {
      const existed = this.db
        .prepare('SELECT 1 AS ok FROM conversations WHERE id = ?')
        .get(conversation.id)
      if (!existed) inserted += 1
      this.upsert(conversation)
    }
    return inserted
  }

  list(machineScope?: 'local' | 'ssh', hostId?: string): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.url, c.title, c.goal, c.project_id, c.updated_at,
                p.machine_scope AS project_machine_scope,
                p.host_id AS project_host_id,
                p.machine_label AS project_machine_label,
                p.name AS project_name,
                p.path AS project_path
           FROM conversations c
           LEFT JOIN projects p ON p.id = c.project_id
          WHERE (? IS NULL OR (p.machine_scope = ? AND p.host_id = ?))
          ORDER BY c.updated_at DESC`
      )
      .all(machineScope ?? null, machineScope ?? null, hostId ?? '') as unknown as ConversationRow[]

    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      goal: row.goal ?? '',
      project:
        row.project_id && row.project_machine_scope && row.project_name && row.project_path
          ? {
              id: row.project_id,
              machineScope: row.project_machine_scope as 'local' | 'ssh',
              hostId: row.project_host_id ?? '',
              machineLabel: row.project_machine_label ?? '',
              name: row.project_name,
              path: row.project_path
            }
          : null,
      updatedAt: row.updated_at
    }))
  }

  moveToProject(
    conversationId: string,
    projectId: string,
    machineScope: 'local' | 'ssh',
    hostId: string,
    now = Date.now()
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE conversations
            SET project_id = ?, updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM projects source
               WHERE source.id = conversations.project_id
                 AND source.machine_scope = ?
                 AND source.host_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM projects target
               WHERE target.id = ?
                 AND target.machine_scope = ?
                 AND target.host_id = ?
            )`
      )
      .run(projectId, now, conversationId, machineScope, hostId, projectId, machineScope, hostId)
    return Number(result.changes) > 0
  }
  remove(id: string): void {
    const paths = this.db
      .prepare(
        `SELECT DISTINCT storage_path
           FROM message_attachments
          WHERE message_id IN (
            SELECT id FROM conversation_messages WHERE conversation_id = ?
          )`
      )
      .all(id) as unknown as Array<{ storage_path: string }>

    this.db
      .prepare(
        `DELETE FROM message_attachments
          WHERE message_id IN (
            SELECT id FROM conversation_messages WHERE conversation_id = ?
          )`
      )
      .run(id)
    this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM focus_turns WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM context_usage WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    this.touchExecutions(id)
    this.contextUsage.invalidate(id)

    for (const row of paths) {
      const stillReferenced = this.db
        .prepare('SELECT 1 AS ok FROM message_attachments WHERE storage_path = ? LIMIT 1')
        .get(row.storage_path)
      if (stillReferenced) continue
      const absolutePath = join(this.attachmentsDir, row.storage_path)
      try {
        if (existsSync(absolutePath)) unlinkSync(absolutePath)
      } catch (error) {
        console.warn('[db] failed to remove orphaned attachment:', (error as Error).message)
      }
    }
  }

  /**
   * Drop rows whose id is not a real conversation id.
   *
   * Guards against rows written before the id-shape check existed, and against
   * placeholder routes like `/c/WEB`. Returns how many rows were removed.
   */
  purgeInvalidIds(isValid: (id: string) => boolean): number {
    const rows = this.db.prepare('SELECT id FROM conversations').all() as unknown as { id: string }[]
    const invalid = rows.filter((row) => !isValid(row.id))
    if (invalid.length === 0) return 0

    for (const row of invalid) this.remove(row.id)
    return invalid.length
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }
    return row.n
  }

  /* ---------------- executions ---------------- */

  /** Persist shutdown synchronously, before shell callbacks or the database are gone. */
  interruptRunningCommands(messageIds: Iterable<string>): void {
    interruptRunningCommands(this.db, messageIds)
    this.touchExecutions()
  }

  /**
   * Record a command the model asked for.
   *
   * Returns false when this message id is already known — that is the guard
   * behind "运行过的命令不能运行了", and it is durable across restarts.
   */
  createExecution(record: {
    messageId: string
    conversationId: string
    command: string
    background?: boolean
    backgroundOptions?: BackgroundCommandOptions
    fileRequest?: StoredFileReadRequest
    taskContext?: TaskToolContext
    description: string
    timeoutSeconds: number
    status: ExecutionStatus
    createdAt: number
  }): boolean {
    const discriminator = record as unknown as { kind?: unknown; type?: unknown }
    if (discriminator.kind !== undefined && discriminator.kind !== (record.fileRequest ? 'read_files' : 'command') ||
      discriminator.type !== undefined && (discriminator.type !== 'read_files' || !record.fileRequest)) throw new Error('invalid-execution-kind')
    if (record.taskContext && (!parseTaskToolContext(record.taskContext) || record.taskContext.conversationId !== record.conversationId || record.taskContext.tool !== (record.fileRequest ? 'read_files' : 'command'))) throw new Error('Invalid task execution context')
    const existing = this.db
      .prepare('SELECT 1 AS ok FROM executions WHERE message_id = ?')
      .get(record.messageId)
    if (existing) return false

    this.db
      .prepare(
        `INSERT INTO executions
           (message_id, conversation_id, command, description, timeout_seconds, status, output, created_at, kind, file_request, delivery_status, background, background_options, task_context)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.messageId,
        record.conversationId,
        record.command,
        record.description,
        record.timeoutSeconds,
        record.status,
        record.createdAt,
        record.fileRequest ? 'read_files' : 'command',
        record.fileRequest ? JSON.stringify(record.fileRequest) : null,
        record.fileRequest ? 'pending' : null,
        record.background === true ? 1 : 0,
        record.backgroundOptions ? JSON.stringify(record.backgroundOptions) : null,
        record.taskContext ? JSON.stringify(record.taskContext) : null
      )
    this.touchExecutions(record.conversationId)
    return true
  }

  /** Persist a complete command or question JSON object; keep only the latest three per conversation. */
  saveRecentCommandJson(conversationId: string, messageId: string, payloadJson: string): void {
    if (!isRecentCommandPayload(JSON.parse(payloadJson))) throw new Error('Invalid command JSON payload')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT OR IGNORE INTO recent_command_json (conversation_id, message_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(conversationId, messageId, payloadJson, Date.now())
      this.db.prepare(`DELETE FROM recent_command_json WHERE conversation_id = ? AND message_id NOT IN (
        SELECT message_id FROM recent_command_json WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 3
      )`).run(conversationId, conversationId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  /** Read the three newest command JSON payloads for one conversation. */
  listRecentCommandJson(conversationId: string): Array<{ messageId: string; payloadJson: string; createdAt: number }> {
    const rows = this.db.prepare(`SELECT message_id, payload_json, created_at FROM recent_command_json
      WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 3`)
      .all(conversationId) as unknown as Array<{ message_id: string; payload_json: string; created_at: number }>
    return rows.map((row) => ({ messageId: row.message_id, payloadJson: row.payload_json, createdAt: row.created_at }))
  }
  autonomousTaskGeneration(sessionId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM autonomous_tasks WHERE session_id = ?')
      .get(sessionId) as { generation: number }
    return row.generation
  }

  latestAutonomousTask(sessionId: string, platformId: string, conversationId: string): AutonomousTask | null {
    const row = this.db.prepare('SELECT payload FROM autonomous_tasks WHERE session_id = ? AND platform_id = ? AND conversation_id = ? ORDER BY generation DESC LIMIT 1')
      .get(sessionId, platformId, conversationId) as { payload: string } | undefined
    const task = row ? parseAutonomousTask(row.payload) : null
    return task?.sessionId === sessionId && task.platformId === platformId && task.conversationId === conversationId ? task : null
  }

  autonomousTaskBySubmission(sessionId: string, platformId: string, submissionId: string): AutonomousTask | null {
    const row = this.db.prepare('SELECT payload FROM autonomous_tasks WHERE session_id = ? AND platform_id = ? AND source_submission_id = ?')
      .get(sessionId, platformId, submissionId) as { payload: string } | undefined
    const task = row ? parseAutonomousTask(row.payload) : null
    return task?.sessionId === sessionId && task.platformId === platformId && task.sourceSubmissionId === submissionId ? task : null
  }

  /** Superseding the previous goal and creating its replacement must commit together. */
  saveAutonomousTasks(tasks: AutonomousTask[], claim?: ComputerActionClaim, update?: ComputerActionUpdate): void {
    const rows = tasks.map(task => {
      const encoded = JSON.stringify(task)
      if (encoded.length > 4_000_000) throw new Error('invalid-autonomous-task')
      const normalized = parseAutonomousTask(encoded)
      if (!normalized) throw new Error('invalid-autonomous-task')
      return { task: normalized, payload: JSON.stringify(normalized) }
    })
    if (claim) {
      const task = rows.find(row => row.task.id === claim.taskId)?.task, step = task?.progress?.currentStep
      if (!validComputerActionClaim(claim) || createHash('sha256').update(claim.requestJson).digest('hex') !== claim.requestHash ||
        !task || task.status !== 'recorded' || task.sessionId !== claim.sessionId || task.platformId !== claim.platformId || task.conversationId !== claim.conversationId ||
        task.generation !== claim.generation || task.machine.id !== claim.machineId || step?.machine?.id !== claim.machineId ||
        step?.id !== claim.executionId || step.sourceMessageId !== claim.sourceMessageId || step.action !== claim.action || step.tool !== 'computer' ||
        step.status !== 'queued' || step.execution !== 'not_executed' || step.delivery !== 'pending' || step.stepToken !== claim.receivedToken)
        throw new Error('invalid-computer-action-claim')
    }
    if (update && rows.length && !rows.some(({ task }) => task.id === update.taskId && task.sessionId === update.sessionId &&
      task.platformId === update.platformId && task.conversationId === update.conversationId && task.generation === update.generation &&
      task.progress?.currentStep?.id === update.executionId)) throw new Error('computer-action-progress-mismatch')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const statement = this.db.prepare(
        'INSERT INTO autonomous_tasks (id, session_id, platform_id, conversation_id, source_submission_id, generation, payload) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, payload = excluded.payload ' +
        'WHERE autonomous_tasks.session_id = excluded.session_id AND autonomous_tasks.platform_id = excluded.platform_id ' +
        'AND autonomous_tasks.source_submission_id = excluded.source_submission_id AND autonomous_tasks.generation = excluded.generation ' +
        'AND (autonomous_tasks.conversation_id IS NULL OR autonomous_tasks.conversation_id = excluded.conversation_id)'
      )
      for (const { task, payload } of rows) {
        const result = statement.run(task.id, task.sessionId, task.platformId, task.conversationId, task.sourceSubmissionId, task.generation, payload)
        if (!result.changes) throw new Error('autonomous-task-owner-mismatch')
      }
      if (claim) {
        const inserted = this.db.prepare(`INSERT INTO computer_action_claims
          (execution_id, session_id, platform_id, conversation_id, task_id, generation, machine_id, source_message_id,
           grant_token, received_token, action, kind, request_json, request_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(claim.executionId, claim.sessionId, claim.platformId, claim.conversationId, claim.taskId, claim.generation, claim.machineId,
            claim.sourceMessageId, claim.grantToken, claim.receivedToken, claim.action, claim.kind, claim.requestJson, claim.requestHash, claim.createdAt)
        if (!inserted.changes) throw new Error('computer-action-already-claimed')
        insertComputerAction(this.db, claim)
      }
      if (update) writeComputerAction(this.db, update)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  hasComputerAction(lease: TaskLease, sourceMessageId: string, receivedToken: string | null): boolean {
    const scope = [lease.sessionId, lease.platformId, lease.conversationId, lease.taskId, lease.generation]
    // Separate indexed queries keep an old replay cheap even after many steps.
    return !!this.db.prepare(`SELECT 1 FROM computer_action_claims WHERE session_id = ? AND platform_id = ? AND conversation_id = ?
      AND task_id = ? AND generation = ? AND source_message_id = ? LIMIT 1`).get(...scope, sourceMessageId) ||
      !!receivedToken && !!this.db.prepare(`SELECT 1 FROM computer_action_claims WHERE session_id = ? AND platform_id = ? AND conversation_id = ?
      AND task_id = ? AND generation = ? AND grant_token = ? LIMIT 1`).get(...scope, receivedToken)
  }

  /** History only: reading these rows never recreates an executor or a step grant. */
  listComputerActions(lease: TaskLease, limit = 50): ComputerActionRecord[] {
    const rows = this.db.prepare(`SELECT a.*, c.session_id, c.platform_id, c.conversation_id, c.task_id, c.generation,
      c.action, c.kind, c.machine_id, c.source_message_id FROM computer_actions a JOIN computer_action_claims c ON c.execution_id = a.execution_id
      WHERE c.session_id = ? AND c.platform_id = ? AND c.conversation_id = ? AND c.task_id = ? AND c.generation = ?
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`)
      .all(lease.sessionId, lease.platformId, lease.conversationId, lease.taskId, lease.generation,
        Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 50) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({ sessionId: row.session_id, platformId: row.platform_id, conversationId: row.conversation_id,
      taskId: row.task_id, generation: row.generation, executionId: row.execution_id, action: row.action, kind: row.kind, machineId: row.machine_id,
      sourceMessageId: row.source_message_id, executionState: row.execution_state, execution: row.execution_fact, deliveryState: row.delivery_state,
      resultJson: row.result_json, deliveryText: row.delivery_text, deliveryAttempts: row.delivery_attempts, createdAt: row.created_at, updatedAt: row.updated_at })) as ComputerActionRecord[]
  }

  listFocusTurns(sessionId: string, platformId: string, conversationId: string): FocusTurn[] {
    const rows = this.db.prepare(
      'SELECT payload FROM focus_turns WHERE session_id = ? AND platform_id = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 80'
    ).all(sessionId, platformId, conversationId) as unknown as Array<{ payload: string }>
    return rows.reverse().flatMap(row => {
      try {
        if (row.payload.length > 20_000_000) return []
        const turn = JSON.parse(row.payload) as FocusTurn
        if (!turn || typeof turn.id !== 'string' || typeof turn.userText !== 'string' ||
          !Number.isFinite(turn.createdAt) || !Array.isArray(turn.segments) || !Array.isArray(turn.executionIds) ||
          !turn.deliveries || !['working', 'answered', 'stopped', 'blocked'].includes(turn.status)) return []
        if (turn.userMessageId !== null && typeof turn.userMessageId !== 'string') return []
        if (turn.supersededBy !== undefined && (typeof turn.supersededBy !== 'string' || turn.supersededBy.length > 512)) return []
        if (turn.hiddenMessageIds !== undefined && (!Array.isArray(turn.hiddenMessageIds) || turn.hiddenMessageIds.length > 100000 ||
          turn.hiddenMessageIds.some(id => typeof id !== 'string' || id.length > 512))) return []
        if (turn.parseFailures !== undefined && (!Array.isArray(turn.parseFailures) || turn.parseFailures.length > 10 ||
          turn.parseFailures.some(item => !item || typeof item.messageId !== 'string' || typeof item.text !== 'string' ||
            item.text.length > 20000 || typeof item.code !== 'string' || !Number.isFinite(item.createdAt)))) return []
        if (turn.commandRecovery && (typeof turn.commandRecovery.messageId !== 'string' || typeof turn.commandRecovery.message !== 'string' ||
          !Number.isSafeInteger(turn.commandRecovery.token) || !Number.isSafeInteger(turn.commandRecovery.generation) ||
          !['pending', 'sent', 'blocked', 'failed', 'uncertain'].includes(turn.commandRecovery.status))) return []
        if (turn.userAttachments !== undefined && (!Array.isArray(turn.userAttachments) || turn.userAttachments.length > 3 ||
          turn.userAttachments.some(file => !file || typeof file.fileName !== 'string' || typeof file.mimeType !== 'string' ||
            !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1))) return []
        if (turn.executionIds.some(id => typeof id !== 'string') ||
          turn.segments.some(segment => !segment || !Number.isInteger(segment.cycle) || segment.cycle < 0 ||
            (segment.sourceMessageId !== null && typeof segment.sourceMessageId !== 'string') ||
            typeof segment.answer !== 'string' || typeof segment.settled !== 'boolean' || !Array.isArray(segment.parts) ||
            segment.parts.some(part => !part || !['reasoning', 'search'].includes(part.kind) || typeof part.text !== 'string' ||
              (part.url !== undefined && (typeof part.url !== 'string' || !/^https?:\/\//.test(part.url)))))) return []
        turn.executionCycles ??= {}
        return [turn]
      } catch { return [] }
    })
  }

  saveFocusTurn(sessionId: string, platformId: string, conversationId: string, turn: FocusTurn): void {
    const payload = JSON.stringify(turn)
    if (payload.length > 20_000_000) throw new Error('focus-turn-too-large')
    if (!this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) throw new Error('focus-conversation-pending')
    this.db.prepare(
      'INSERT INTO focus_turns (id, session_id, platform_id, conversation_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE focus_turns.session_id = excluded.session_id AND focus_turns.platform_id = excluded.platform_id AND focus_turns.conversation_id = excluded.conversation_id'
    ).run(turn.id, sessionId, platformId, conversationId, payload, turn.createdAt)
    // Statistics exclude superseded turns; ordinary streaming saves leave them unchanged.
    if (turn.supersededBy) this.contextUsage.invalidate(conversationId)
  }

  /** Raw payloads, oldest first; the runtime parses and validates them. */
  listBackgroundTaskPayloads(sessionId: string): string[] {
    const rows = this.db.prepare(
      'SELECT payload FROM background_tasks WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100'
    ).all(sessionId) as unknown as Array<{ payload: string }>
    return rows.reverse().map(row => row.payload)
  }

  /**
   * Upsert one task, then keep the newest 50 per session. An older row goes only when it is
   * no longer `active`: the task has ended and no notification for it is still pending.
   */
  saveBackgroundTask(sessionId: string, id: string, createdAt: number, payload: string, active: boolean): void {
    if (payload.length > 1_000_000) throw new Error('background-task-too-large')
    this.db.prepare(
      'INSERT INTO background_tasks (id, session_id, payload, active, created_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, active = excluded.active WHERE background_tasks.session_id = excluded.session_id'
    ).run(id, sessionId, payload, active ? 1 : 0, createdAt)
    this.db.prepare(
      `DELETE FROM background_tasks WHERE session_id = ? AND active = 0 AND id IN (
        SELECT id FROM background_tasks WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 50)`
    ).run(sessionId, sessionId)
  }

  /** Persist one clean chat turn plus any user image attachments. */
  appendConversationMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    sourceMessageId: string | null = null,
    now = Date.now(),
    attachments: ConversationImageAttachmentInput[] = []
  ): string | null {
    if (content.trim() === '' && attachments.length === 0) return null
    // A command is already represented by an execution record. Keep it out of the
    // user-facing transcript even if a page adapter reports it as a normal assistant turn.
    if (role === 'assistant' && isAssistantCommandReply(content)) return null
    const id = randomUUID()
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_messages
           (id, conversation_id, role, source_message_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, conversationId, role, sourceMessageId, content, now)
    if (Number(result.changes) === 0) return null
    if (role === 'user' && attachments.length > 0) this.persistMessageAttachments(id, attachments, now)
    return id
  }

  countMessageAttachments(messageId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM message_attachments WHERE message_id = ?').get(messageId) as { count: number }
    return Number(row.count)
  }

  /** Restore Markdown for a message already captured from this exact page turn. */
  refreshAssistantMessageMarkdown(conversationId: string, sourceMessageId: string, content: string): boolean {
    if (!sourceMessageId || !content.trim() || isAssistantCommandReply(content)) return false
    const result = this.db.prepare(
      `UPDATE conversation_messages
          SET content = ?
        WHERE conversation_id = ? AND role = 'assistant' AND source_message_id = ?
          AND content <> ?
          AND NOT EXISTS (SELECT 1 FROM executions WHERE message_id = ?)`
    ).run(content, conversationId, sourceMessageId, content, sourceMessageId)
    return Number(result.changes) > 0
  }

  private persistMessageAttachments(
    messageId: string,
    attachments: ConversationImageAttachmentInput[],
    now: number
  ): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO message_attachments
         (id, message_id, kind, mime_type, file_name, storage_path, sha256, width, height, size_bytes, ordinal, created_at)
       VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const seenContent = new Set<string>()
    let ordinal = 0
    for (const attachment of attachments) {
      if (!attachment.mimeType.startsWith('image/') || attachment.dataBase64 === '') continue
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const contentHash = this.attachmentContentHash(bytes, sha256)
      if (seenContent.has(contentHash)) continue
      seenContent.add(contentHash)
      const sourceExt = extname(attachment.fileName).toLowerCase()
      const mimeExt: Record<string, string> = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
        'image/avif': '.avif', 'image/bmp': '.bmp', 'image/svg+xml': '.svg'
      }
      const extension = /^\.[a-z0-9]{1,8}$/.test(sourceExt) ? sourceExt : (mimeExt[attachment.mimeType] ?? '.img')
      const storagePath = `${sha256}${extension}`
      const absolutePath = join(this.attachmentsDir, storagePath)
      if (!existsSync(absolutePath)) writeFileSync(absolutePath, bytes)
      insert.run(randomUUID(), messageId, attachment.mimeType, attachment.fileName || storagePath, storagePath, sha256, attachment.width, attachment.height, bytes.length, ordinal, now)
      ordinal += 1
    }
  }
  listConversationMessages(conversationId: string): Array<{
    id: string
    conversationId: string
    role: 'user' | 'assistant'
    sourceMessageId: string | null
    content: string
    attachments: Array<{
      id: string
      messageId: string
      kind: 'image'
      mimeType: string
      fileName: string
      sha256: string
      width: number | null
      height: number | null
      sizeBytes: number
      ordinal: number
    }>
    createdAt: number
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, source_message_id, content, created_at
           FROM conversation_messages
          WHERE conversation_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM executions
               WHERE executions.message_id = conversation_messages.source_message_id
            )
          ORDER BY created_at ASC, rowid ASC`
      )
      .all(conversationId) as unknown as ConversationMessageRow[]
    // Also filter at read time so a long-lived process cannot expose a legacy command row
    // that was written before the startup migration (or by an older running session).
    const visibleRows = rows.filter(
      (row) => row.role !== 'assistant' || !isAssistantCommandReply(row.content)
    )
    const attachmentsForMessage = this.db.prepare(
      `SELECT id, message_id, kind, mime_type, file_name, storage_path, sha256, width, height, size_bytes, ordinal, created_at
         FROM message_attachments
        WHERE message_id = ?
        ORDER BY ordinal ASC`
    )
    return visibleRows.map((row) => {
      const attachmentRows = attachmentsForMessage.all(row.id) as unknown as MessageAttachmentRow[]
      return {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        sourceMessageId: row.source_message_id,
        content: row.content,
        attachments: attachmentRows.map((attachment) => ({
          id: attachment.id,
          messageId: attachment.message_id,
          kind: attachment.kind,
          mimeType: attachment.mime_type,
          fileName: attachment.file_name,
          sha256: attachment.sha256,
          width: attachment.width,
          height: attachment.height,
          sizeBytes: attachment.size_bytes,
          ordinal: attachment.ordinal
        })),
        createdAt: row.created_at
      }
    })
  }

  readConversationAttachment(attachmentId: string): string | null {
    const row = this.db
      .prepare('SELECT * FROM message_attachments WHERE id = ?')
      .get(attachmentId) as unknown as MessageAttachmentRow | undefined
    if (!row || row.kind !== 'image') return null
    const absolutePath = join(this.attachmentsDir, row.storage_path)
    if (!existsSync(absolutePath)) return null
    const data = readFileSync(absolutePath).toString('base64')
    return `data:${row.mime_type};base64,${data}`
  }
  /** Mark a stored command as finished (or as skipped/blocked). */
  finishExecution(
    messageId: string,
    update: {
      status: ExecutionStatus
      exitCode: number | null
      output: string
      finishedAt: number
    }
  ): void {
    const row = this.db
      .prepare(
        `UPDATE executions
            SET status = ?, exit_code = ?, output = ?, finished_at = ?
          WHERE message_id = ? RETURNING conversation_id`
      )
      .get(update.status, update.exitCode, update.output, update.finishedAt, messageId) as { conversation_id: string } | undefined
    if (row) this.touchExecutions(row.conversation_id)
  }

  setExecutionStatus(messageId: string, status: ExecutionStatus): void {
    const row = (status === 'running'
      ? this.db
        .prepare('UPDATE executions SET status = ?, started_at = COALESCE(started_at, ?) WHERE message_id = ? RETURNING conversation_id')
        .get(status, Date.now(), messageId)
      : this.db.prepare('UPDATE executions SET status = ? WHERE message_id = ? RETURNING conversation_id').get(status, messageId)
    ) as { conversation_id: string } | undefined
    if (row) this.touchExecutions(row.conversation_id)
  }

  setFileDeliveryStatus(messageId: string, status: FileDeliveryStatus): void {
    const row = this.db.prepare('UPDATE executions SET delivery_status = ? WHERE message_id = ? AND kind = ? RETURNING conversation_id')
      .get(status, messageId, 'read_files') as { conversation_id: string } | undefined
    if (row) this.touchExecutions(row.conversation_id)
  }

  getExecution(messageId: string): ExecutionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM executions WHERE message_id = ?')
      .get(messageId) as unknown as ExecutionRow | undefined
    return row ? toExecutionRecord(row) : null
  }

  /** Changes only with this conversation's execution writes, so focus polling need not reload old output. */
  getExecutionRevision(conversationId: string): number {
    return this.executionRevisions.get(conversationId) ?? this.executionsBaseline
  }

  /** Without a conversation, the write may touch any of them: invalidate every cursor. */
  private touchExecutions(conversationId?: string): void {
    const revision = ++this.executionsRevision
    if (conversationId) {
      this.executionRevisions.set(conversationId, revision)
      return
    }
    this.executionsBaseline = revision
    this.executionRevisions.clear()
  }

  listExecutions(conversationId: string, includeOutput = true): ExecutionRecord[] {
    // A UI snapshot needs lifecycle metadata, not every historical command's output.
    const columns = includeOutput ? '*' : `message_id, conversation_id, command, background, background_options,
      kind, file_request, task_context, delivery_status, description, timeout_seconds, status, exit_code,
      '' AS output, 1 AS output_deferred, created_at, started_at, finished_at`
    const rows = this.db
      .prepare(`SELECT ${columns} FROM executions WHERE conversation_id = ? ORDER BY created_at ASC`)
      .all(conversationId) as unknown as ExecutionRow[]
    return rows.map(toExecutionRecord)
  }

  /** Every conversation id that has at least one execution row. */
  countExecutions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }
    return row.n
  }

  /* ---------------- ssh hosts ---------------- */

  /** The stored ciphertext, or '' when none. Never sent to the renderer. */
  getSshSecret(id: string): string {
    const row = this.db.prepare('SELECT secret FROM ssh_hosts WHERE id = ?').get(id) as
      | { secret: string }
      | undefined
    return row ? row.secret : ''
  }

  upsertSshHost(host: {
    id: string
    name: string
    host: string
    port: number
    username: string
    proxy: string
    secret: string
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO ssh_hosts (id, name, host, port, username, proxy, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           username = excluded.username,
           proxy = excluded.proxy,
           -- An empty incoming secret means "keep what is already stored", so
           -- reconnecting without retyping the password does not erase it.
           secret = CASE WHEN excluded.secret = '' THEN ssh_hosts.secret ELSE excluded.secret END,
           updated_at = excluded.updated_at`
      )
      .run(
        host.id,
        host.name,
        host.host,
        host.port,
        host.username,
        host.proxy,
        host.secret,
        now,
        now
      )
  }

  listSshHosts(): SshHost[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, host, port, username, proxy, secret, updated_at
           FROM ssh_hosts ORDER BY updated_at DESC`
      )
      .all() as unknown as Array<{
      id: string
      name: string
      host: string
      port: number
      username: string
      proxy: string
      secret: string
      updated_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      proxy: row.proxy,
      hasPassword: row.secret !== '',
      updatedAt: row.updated_at
    }))
  }

  removeSshHost(id: string): void {
    this.db.prepare("DELETE FROM terminal_directory_notes WHERE machine_scope = 'ssh' AND host_id = ?").run(id)
    this.db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id)
  }

  /** Null identifies an unset directory; an explicitly cleared note remains an empty row. */
  getDirectoryNote(scope: 'local' | 'ssh', hostId: string, directory: string): string | null {
    const key = normalizeTerminalNotesDirectory(scope, directory)
    if (!hostId || !key) return null
    const row = this.db.prepare('SELECT note FROM terminal_directory_notes WHERE machine_scope = ? AND host_id = ? AND directory_key = ?')
      .get(scope, hostId, key) as { note: string } | undefined
    return row?.note ?? null
  }

  setDirectoryNote(scope: 'local' | 'ssh', hostId: string, directory: string, note: string): void {
    const key = normalizeTerminalNotesDirectory(scope, directory)
    if (!hostId || !key) throw new Error('当前机器或工作目录尚未确定，无法保存说明。')
    this.db.prepare(`INSERT INTO terminal_directory_notes (machine_scope, host_id, directory_key, note, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(machine_scope, host_id, directory_key)
      DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`)
      .run(scope, hostId, key, note, Date.now())
  }

  /**
   * The user's note for one host, or '' when there is none.
   *
   * Read and written on its own rather than through `upsertSshHost`: reconnecting
   * must never disturb it, and the connect path has no business touching text the
   * user wrote.
   */
  getSshNote(id: string): string {
    const row = this.db.prepare('SELECT note FROM ssh_hosts WHERE id = ?').get(id) as
      | { note: string }
      | undefined
    return row ? row.note : ''
  }

  setSshNote(id: string, note: string): void {
    this.db.prepare('UPDATE ssh_hosts SET note = ? WHERE id = ?').run(note, id)
  }

  /* ---------------- mysql connections ---------------- */

  /**
   * Every stored connection for one machine, oldest first.
   *
   * `secret` is the ciphertext only. It is decrypted in the session runtime, so the
   * raw value never travels further than it has to.
   */
  listMysqlConnections(scope: string, hostId: string): Array<{
    id: string
    name: string
    host: string
    port: number
    username: string
    secret: string
    database: string
    updatedAt: number
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, name, host, port, username, secret, database, updated_at FROM mysql_connections WHERE machine_scope = ? AND host_id = ? ORDER BY updated_at ASC, id ASC'
      )
      .all(scope, hostId) as unknown as Array<{
      id: string
      name: string
      host: string
      port: number
      username: string
      secret: string
      database: string
      updated_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      secret: row.secret,
      database: row.database,
      updatedAt: row.updated_at
    }))
  }

  /**
   * Insert or update one connection.
   *
   * An empty incoming secret means: keep what is already stored, exactly like
   * ssh_hosts. Reopening the form without retyping the password must not erase it.
   * The incoming id is always honoured, so a new row is one the caller already knows
   * the id of and can therefore open a tab on.
   */
  upsertMysqlConnection(record: {
    id: string
    scope: string
    hostId: string
    name: string
    host: string
    port: number
    username: string
    secret: string
    database: string
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO mysql_connections (id, machine_scope, host_id, name, host, port, username, secret, database, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           username = excluded.username,
           secret = CASE WHEN excluded.secret = '' THEN mysql_connections.secret ELSE excluded.secret END,
           database = excluded.database,
           updated_at = excluded.updated_at`
      )
      .run(record.id, record.scope, record.hostId, record.name, record.host, record.port, record.username, record.secret, record.database, now)
  }

  removeMysqlConnection(id: string): void {
    this.db.prepare('DELETE FROM mysql_connections WHERE id = ?').run(id)
  }

  listRedisConnections(scope: string, hostId: string): StoredRedisConnection[] {
    const rows = this.db.prepare(
      'SELECT id, name, host, port, username, secret, database_index, tls, updated_at FROM redis_connections WHERE machine_scope = ? AND host_id = ? ORDER BY updated_at ASC, id ASC'
    ).all(scope, hostId) as unknown as Array<Omit<StoredRedisConnection, 'database' | 'tls' | 'updatedAt'> & {
      database_index: number
      tls: number
      updated_at: number
    }>
    return rows.map(({ database_index, tls, updated_at, ...row }) => ({
      ...row, database: database_index, tls: Boolean(tls), updatedAt: updated_at
    }))
  }

  upsertRedisConnection(record: Omit<StoredRedisConnection, 'updatedAt'> & { scope: string; hostId: string }): void {
    this.db.prepare(
      `INSERT INTO redis_connections (id, machine_scope, host_id, name, host, port, username, secret, database_index, tls, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port,
         username = excluded.username, secret = excluded.secret, database_index = excluded.database_index,
         tls = excluded.tls, updated_at = excluded.updated_at`
    ).run(record.id, record.scope, record.hostId, record.name, record.host, record.port, record.username,
      record.secret, record.database, record.tls ? 1 : 0, Date.now())
  }

  removeRedisConnection(id: string, scope: string, hostId: string): void {
    this.db.prepare('DELETE FROM redis_connections WHERE id = ? AND machine_scope = ? AND host_id = ?').run(id, scope, hostId)
  }

  /* ---------------- nacos connections ---------------- */

  /** Every stored Nacos console for one machine, oldest first. */
  listNacosConnections(scope: string, hostId: string): Array<{
    id: string
    name: string
    url: string
    namespace: string
    updatedAt: number
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, name, url, namespace, updated_at FROM nacos_connections WHERE machine_scope = ? AND host_id = ? ORDER BY updated_at ASC, id ASC'
      )
      .all(scope, hostId) as unknown as Array<{
      id: string
      name: string
      url: string
      namespace: string
      updated_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      namespace: row.namespace,
      updatedAt: row.updated_at
    }))
  }

  /** Insert or update one Nacos console. The caller always supplies the id. */
  upsertNacosConnection(record: {
    id: string
    scope: string
    hostId: string
    name: string
    url: string
    namespace: string
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO nacos_connections (id, machine_scope, host_id, name, url, namespace, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           url = excluded.url,
           namespace = excluded.namespace,
           updated_at = excluded.updated_at`
      )
      .run(record.id, record.scope, record.hostId, record.name, record.url, record.namespace, now)
  }

  removeNacosConnection(id: string): void {
    this.db.prepare('DELETE FROM nacos_connections WHERE id = ?').run(id)
  }

  listWorkspaceProjects(): WorkspaceProject[] {
    return (this.db.prepare('SELECT id, name, directory, created_at FROM workspace_projects ORDER BY created_at ASC, rowid ASC').all() as unknown as Array<{
      id: string; name: string; directory: string; created_at: number
    }>).map(row => ({ id: row.id, name: row.name, directory: row.directory, createdAt: row.created_at }))
  }

  saveWorkspaceProject(draft: WorkspaceProjectDraft): WorkspaceProject {
    const name = draft.name.trim()
    if (!name || name.length > 120) throw new Error('请输入 1–120 个字符的项目名称。')
    const previous = draft.id ? this.listWorkspaceProjects().find(item => item.id === draft.id) : null
    if (draft.id && !previous) throw new Error('项目不存在，请重新选择。')
    const project: WorkspaceProject = {
      id: previous?.id ?? randomUUID(), name, directory: draft.directory.trim(), createdAt: previous?.createdAt ?? Date.now()
    }
    this.db.prepare(`INSERT INTO workspace_projects (id, name, directory, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, directory = excluded.directory`)
      .run(project.id, project.name, project.directory, project.createdAt)
    return project
  }

  /** Null means never saved; an explicitly cleared project note stays empty. */
  getWorkspaceProjectNote(id: string): string | null {
    const row = this.db.prepare('SELECT terminal_notes FROM workspace_projects WHERE id = ?').get(id) as
      { terminal_notes: string | null } | undefined
    return row?.terminal_notes ?? null
  }

  setWorkspaceProjectNote(id: string, text: string): void {
    const result = this.db.prepare('UPDATE workspace_projects SET terminal_notes = ? WHERE id = ?').run(text, id)
    if (Number(result.changes) === 0) throw new Error('项目不存在，请重新选择。')
  }

  /** Seed an old project from its most recently saved directory note, retaining the originals. */
  inheritWorkspaceProjectNote(id: string, targets: Array<{ scope: 'local' | 'ssh'; hostId: string; directory: string }>): boolean {
    if (this.getWorkspaceProjectNote(id) !== null) return false
    let latest: { note: string; updated_at: number } | undefined
    const lookup = this.db.prepare('SELECT note, updated_at FROM terminal_directory_notes WHERE machine_scope = ? AND host_id = ? AND directory_key = ?')
    for (const target of targets) {
      const key = normalizeTerminalNotesDirectory(target.scope, target.directory)
      if (!target.hostId || !key) continue
      const row = lookup.get(target.scope, target.hostId, key) as { note: string; updated_at: number } | undefined
      if (row && (!latest || row.updated_at > latest.updated_at)) latest = row
    }
    if (!latest) return false
    this.setWorkspaceProjectNote(id, latest.note)
    return true
  }

  removeWorkspaceProject(id: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE managed_sessions SET workspace_project_id = NULL WHERE workspace_project_id = ?').run(id)
      const result = this.db.prepare('DELETE FROM workspace_projects WHERE id = ?').run(id)
      this.db.exec('COMMIT')
      return Number(result.changes) > 0
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listManagedSessions(): ManagedSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, url, conversation_id, platform_id, workspace_project_id, paused, prompt_injection_enabled, local_cwd, ssh_host_id, ssh_attached, ssh_reconnect, ssh_cwd, send_delay_seconds, created_at, updated_at
           FROM managed_sessions ORDER BY created_at ASC`
      )
      .all() as unknown as Array<{
      id: string
      title: string
      url: string
      conversation_id: string | null
      platform_id: string
      workspace_project_id: string | null
      paused: number
      prompt_injection_enabled: number
      local_cwd: string
      ssh_host_id: string
      ssh_attached: number
      ssh_reconnect: number
      ssh_cwd: string
      send_delay_seconds: number
      created_at: number
      updated_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      conversationId: row.conversation_id,
      platformId: row.platform_id,
      projectId: row.workspace_project_id,
      paused: row.paused !== 0,
      promptInjectionEnabled: row.prompt_injection_enabled !== 0,
      localCwd: row.local_cwd,
      sshHostId: row.ssh_host_id,
      sshAttached: row.ssh_attached !== 0,
      sshReconnect: row.ssh_reconnect !== 0,
      sshCwd: row.ssh_cwd,
      sendDelaySeconds: row.send_delay_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  upsertManagedSession(record: Omit<ManagedSessionRecord, 'updatedAt'>): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO managed_sessions (id, title, url, conversation_id, platform_id, workspace_project_id, paused, prompt_injection_enabled, local_cwd, ssh_host_id, ssh_attached, ssh_reconnect, ssh_cwd, send_delay_seconds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           conversation_id = excluded.conversation_id,
           platform_id = excluded.platform_id,
           workspace_project_id = excluded.workspace_project_id,
           paused = excluded.paused,
           prompt_injection_enabled = excluded.prompt_injection_enabled,
           local_cwd = excluded.local_cwd,
           ssh_host_id = excluded.ssh_host_id,
           ssh_attached = excluded.ssh_attached,
           ssh_reconnect = excluded.ssh_reconnect,
           ssh_cwd = excluded.ssh_cwd,
           send_delay_seconds = excluded.send_delay_seconds,
           updated_at = excluded.updated_at`
      )
      .run(
        record.id,
        record.title,
        record.url,
        record.conversationId,
        record.platformId,
        record.projectId ?? null,
        record.paused ? 1 : 0,
        record.promptInjectionEnabled ? 1 : 0,
        record.localCwd,
        record.sshHostId,
        record.sshAttached ? 1 : 0,
        record.sshReconnect ? 1 : 0,
        record.sshCwd,
        record.sendDelaySeconds,
        record.createdAt,
        now
      )
  }

  removeManagedSession(id: string): void {
    this.scheduledTasks.removeSession(id)
    this.db.prepare('DELETE FROM focus_turns WHERE session_id = ?').run(id)
    // Removing superseded turns re-includes their statistics in any conversation.
    this.contextUsage.invalidate()
    this.db.prepare('DELETE FROM background_tasks WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM managed_sessions WHERE id = ?').run(id)
  }
  /* ---------------- settings ---------------- */

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? row.value : null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  /** Keep a backend address and its encrypted login in the same commit. */
  setSettings(values: Record<string, string>): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [key, value] of Object.entries(values)) this.setSetting(key, value)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}
