/** 学习作业队列:用 ~/.trove/cache/learn.db(node:sqlite)承载,支持幂等、租约、退避、崩溃恢复。 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSqlite, type DatabaseSync } from '../../sqlite.js';

export const LEARN_PIPELINE_VERSION = 'exp-v3';

export type JobState = 'queued' | 'running' | 'retry_wait' | 'done' | 'skipped' | 'dead';
export type ErrorClass = 'network' | 'rate_limit' | 'server' | 'config' | 'parse' | 'disk' | 'budget' | 'unknown';

export interface Job {
  id: string;
  /** harness:session */
  sessionKey: string;
  contentHash: string;
  pipelineVersion: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  nextRunAt: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  errorClass: ErrorClass | null;
  /** JSON;当前只需 { stage:'written', diff } */
  checkpoint: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobInput {
  sessionKey: string;
  contentHash: string;
  priority?: number;
}

export interface JobStats {
  queued: number;
  running: number;
  retryWait: number;
  done: number;
  skipped: number;
  dead: number;
  oldestQueuedAt: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** 默认最大尝试次数,与 LearnConfig.maxAttempts 默认值一致;调用方可用 learn.maxAttempts 覆盖。 */
export const DEFAULT_MAX_ATTEMPTS = 5;

const BACKOFF_CAP_MS = 5 * 60 * 1000; // 5min
const BACKOFF_BASE_MS = 30 * 1000; // 30s

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
  priority INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  last_error TEXT,
  error_class TEXT,
  checkpoint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique ON jobs (session_key, content_hash, pipeline_version);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs (state, next_run_at);
`;

interface JobRow {
  id: string;
  session_key: string;
  content_hash: string;
  pipeline_version: string;
  state: JobState;
  attempts: number;
  max_attempts: number;
  priority: number;
  next_run_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  error_class: ErrorClass | null;
  checkpoint: string | null;
  created_at: number;
  updated_at: number;
}

function jobId(sessionKey: string, contentHash: string): string {
  return `job_${createHash('sha256').update(`${sessionKey}${contentHash}${LEARN_PIPELINE_VERSION}`).digest('hex').slice(0, 32)}`;
}

/** 确定性的 0..999ms 抖动,让退避时间可复现。 */
function jitterMs(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 1000;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    sessionKey: r.session_key,
    contentHash: r.content_hash,
    pipelineVersion: r.pipeline_version,
    state: r.state,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextRunAt: r.next_run_at,
    leaseOwner: r.lease_owner,
    leaseExpiresAt: r.lease_expires_at,
    lastError: r.last_error,
    errorClass: r.error_class,
    checkpoint: r.checkpoint,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class JobQueue {
  private db: DatabaseSync;

  constructor(dbPath: string, private maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = openSqlite(dbPath, false);
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec(SCHEMA);
    } catch (e) {
      throw new Error(`无法打开学习队列数据库 ${dbPath}: ${(e as Error).message}`);
    }
  }

  static open(dbPath: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): JobQueue {
    return new JobQueue(dbPath, maxAttempts);
  }

  close(): void {
    this.db.close();
  }

  enqueue(inputs: JobInput[], now = Date.now()): number {
    if (inputs.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO jobs
        (id, session_key, content_hash, pipeline_version, state, attempts, max_attempts, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const inp of inputs) {
      const r = stmt.run(
        jobId(inp.sessionKey, inp.contentHash),
        inp.sessionKey,
        inp.contentHash,
        LEARN_PIPELINE_VERSION,
        this.maxAttempts,
        inp.priority ?? 0,
        now,
        now,
      );
      added += Number(r.changes);
    }
    return added;
  }

  lease(owner: string, ttlMs: number, now = Date.now()): Job | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT id FROM jobs
            WHERE state IN ('queued', 'retry_wait') AND (next_run_at IS NULL OR next_run_at <= ?)
            ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1`,
        )
        .get(now) as { id: string } | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db
        .prepare(
          `UPDATE jobs SET state='running', attempts=attempts+1, started_at=?, lease_owner=?, lease_expires_at=?, next_run_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(now, owner, now + ttlMs, now, row.id);
      this.db.exec('COMMIT');
      return this.get(row.id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  heartbeat(id: string, owner: string, ttlMs: number, now = Date.now()): void {
    this.db
      .prepare(`UPDATE jobs SET lease_expires_at=?, updated_at=? WHERE id=? AND lease_owner=? AND state='running'`)
      .run(now + ttlMs, now, id, owner);
  }

  complete(id: string, now = Date.now()): void {
    this.db
      .prepare(`UPDATE jobs SET state='done', finished_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`)
      .run(now, now, id);
  }

  skip(id: string, reason: string, now = Date.now()): void {
    this.db
      .prepare(`UPDATE jobs SET state='skipped', last_error=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`)
      .run(reason, now, now, id);
  }

  fail(id: string, err: { class: ErrorClass; message: string }, now = Date.now()): Job {
    const job = this.get(id);
    if (!job) throw new Error(`没有找到作业: ${id}`);
    const dead = err.class === 'config' || err.class === 'disk' || job.attempts >= job.maxAttempts;
    if (dead) {
      this.db
        .prepare(
          `UPDATE jobs SET state='dead', last_error=?, error_class=?, finished_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(err.message, err.class, now, now, id);
    } else {
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (job.attempts - 1));
      this.db
        .prepare(
          `UPDATE jobs SET state='retry_wait', last_error=?, error_class=?, next_run_at=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
        )
        .run(err.message, err.class, now + backoff + jitterMs(id), now, id);
    }
    return this.get(id)!;
  }

  setCheckpoint(id: string, checkpoint: string): void {
    this.db.prepare(`UPDATE jobs SET checkpoint=?, updated_at=? WHERE id=?`).run(checkpoint, Date.now(), id);
  }

  requeueExpired(now = Date.now()): number {
    const r = this.db
      .prepare(
        `UPDATE jobs SET state='queued', lease_owner=NULL, lease_expires_at=NULL, next_run_at=NULL, updated_at=? WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(now, now);
    return Number(r.changes);
  }

  retry(id: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET state='queued', attempts=0, last_error=NULL, error_class=NULL, next_run_at=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND state='dead'`,
      )
      .run(Date.now(), id);
    return Number(r.changes) > 0;
  }

  stats(_now = Date.now()): JobStats {
    const counts: Record<string, number> = { queued: 0, running: 0, retry_wait: 0, done: 0, skipped: 0, dead: 0 };
    for (const row of this.db.prepare(`SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`).all() as Array<{ state: string; n: number }>) {
      counts[row.state] = row.n;
    }
    const oldest = this.db.prepare(`SELECT MIN(created_at) AS m FROM jobs WHERE state='queued'`).get() as { m: number | null };
    const durations = (
      this.db.prepare(`SELECT (finished_at - started_at) AS d FROM jobs WHERE state='done' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY d`).all() as Array<{ d: number }>
    ).map((r) => r.d);
    return {
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      retryWait: counts.retry_wait ?? 0,
      done: counts.done ?? 0,
      skipped: counts.skipped ?? 0,
      dead: counts.dead ?? 0,
      oldestQueuedAt: oldest?.m ?? null,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    };
  }

  get(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /** 最近 dead 作业(按更新时间倒序),供 learn status 展示失败原因。 */
  listDead(limit = 5): Job[] {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE state='dead' ORDER BY updated_at DESC LIMIT ?`).all(limit) as unknown as JobRow[];
    return rows.map(rowToJob);
  }
}

/** 最近秩百分位;空样本返回 null。 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
