import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { ScheduledTask, ScheduledTaskRun, ScheduledTasksState, ScheduledRunStatus } from '../shared/scheduled-tasks'

export const SCHEDULED_TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_tasks(enabled, deleted, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_session ON scheduled_tasks(session_id);
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, kind TEXT NOT NULL, occurrence_key TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL,
  UNIQUE(task_id, revision, occurrence_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_run_queue ON scheduled_task_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_run_task ON scheduled_task_runs(task_id, created_at);
`

export class ScheduledTaskStore {
  constructor(private readonly db: DatabaseSync) { db.exec(SCHEDULED_TASK_SCHEMA) }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private taskRows(sql: string, ...args: Array<string | number>): ScheduledTask[] {
    return (this.db.prepare(sql).all(...args) as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as ScheduledTask)
  }
  get(id: string): ScheduledTask | undefined { return this.taskRows('SELECT payload FROM scheduled_tasks WHERE id = ?', id)[0] }
  bySource(key: string): ScheduledTask | undefined { return this.taskRows('SELECT payload FROM scheduled_tasks WHERE source_key = ?', key)[0] }
  save(task: ScheduledTask): void {
    this.db.prepare(`INSERT INTO scheduled_tasks(id,session_id,source_key,enabled,deleted,next_run_at,payload) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,deleted=excluded.deleted,next_run_at=excluded.next_run_at,payload=excluded.payload`)
      .run(task.id, task.owner.sessionId, task.sourceKey, +task.enabled, +task.deleted, task.nextRunAt, JSON.stringify(task))
  }
  due(now: number): ScheduledTask[] {
    return this.taskRows('SELECT payload FROM scheduled_tasks WHERE enabled=1 AND deleted=0 AND next_run_at<=? ORDER BY next_run_at LIMIT 100', now)
  }
  nextTime(): number | null {
    const row = this.db.prepare('SELECT MIN(next_run_at) AS next FROM scheduled_tasks WHERE enabled=1 AND deleted=0').get() as { next: number | null }
    return row.next
  }
  runs(status?: ScheduledRunStatus): ScheduledTaskRun[] {
    const sql = status ? 'SELECT payload FROM scheduled_task_runs WHERE status=? ORDER BY created_at'
      : 'SELECT payload FROM scheduled_task_runs ORDER BY created_at'
    return (this.db.prepare(sql).all(...(status ? [status] : [])) as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as ScheduledTaskRun)
  }
  run(id: string): ScheduledTaskRun | undefined {
    const row = this.db.prepare('SELECT payload FROM scheduled_task_runs WHERE id=?').get(id) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) as ScheduledTaskRun : undefined
  }
  saveRun(run: ScheduledTaskRun): void {
    this.db.prepare(`INSERT INTO scheduled_task_runs(id,task_id,revision,kind,occurrence_key,status,created_at,payload) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload`)
      .run(run.id, run.taskId, run.revision, run.kind, run.occurrenceKey, run.status, run.createdAt, JSON.stringify(run))
  }
  hasOutstanding(taskId: string, kind: 'task' | 'receipt' = 'task'): boolean {
    return !!this.db.prepare("SELECT 1 FROM scheduled_task_runs WHERE task_id=? AND kind=? AND status IN ('pending','sending','needs-attention') LIMIT 1").get(taskId, kind)
  }
  insertRun(task: ScheduledTask, plannedAt: number, now: number, occurrenceKey = String(plannedAt), kind: 'task' | 'receipt' = 'task', text = '', missedSince: number | null = null): ScheduledTaskRun {
    const existing = this.db.prepare('SELECT payload FROM scheduled_task_runs WHERE task_id=? AND revision=? AND occurrence_key=?')
      .get(task.id, task.revision, occurrenceKey) as { payload: string } | undefined
    if (existing) return JSON.parse(existing.payload) as ScheduledTaskRun
    const run: ScheduledTaskRun = { id: randomUUID(), taskId: task.id, revision: task.revision, kind, occurrenceKey,
      plannedAt, missedSince, status: 'pending', message: '等待投递', text, createdAt: now, sentAt: null, autonomousTaskId: null }
    this.saveRun(run)
    return run
  }
  cancelPending(taskId: string, message: string): void {
    for (const run of this.taskRuns(taskId)) if (run.status === 'pending') this.saveRun({ ...run, status: 'cancelled', message })
  }
  taskRuns(id: string): ScheduledTaskRun[] {
    return (this.db.prepare('SELECT payload FROM scheduled_task_runs WHERE task_id=? ORDER BY created_at DESC').all(id) as Array<{ payload: string }>)
      .map(row => JSON.parse(row.payload) as ScheduledTaskRun)
  }
  snapshot(sessionId: string): ScheduledTasksState {
    const tasks = this.taskRows('SELECT payload FROM scheduled_tasks WHERE session_id=? AND deleted=0 ORDER BY next_run_at', sessionId)
    const runs = (this.db.prepare(`SELECT r.payload FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.task_id
      WHERE t.session_id=? AND t.deleted=0 AND (r.status IN ('pending','sending','needs-attention') OR r.id IN
        (SELECT recent.id FROM scheduled_task_runs recent WHERE recent.task_id=r.task_id ORDER BY recent.created_at DESC LIMIT 12))
      ORDER BY r.created_at DESC`).all(sessionId) as Array<{ payload: string }>)
      .map(row => JSON.parse(row.payload) as ScheduledTaskRun)
    return { tasks, runs }
  }
  removeSession(sessionId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM scheduled_task_runs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE session_id=?)').run(sessionId)
      this.db.prepare('DELETE FROM scheduled_tasks WHERE session_id=?').run(sessionId)
    })
  }
  prune(taskId: string): void {
    this.db.prepare(`DELETE FROM scheduled_task_runs WHERE task_id=? AND status IN ('sent','cancelled','skipped') AND id NOT IN
      (SELECT id FROM scheduled_task_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 50)`).run(taskId, taskId)
  }
}
