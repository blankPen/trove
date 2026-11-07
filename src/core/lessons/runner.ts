/** 作业执行器:从 learn.db 取作业,跑提取流水线,处理租约/心跳/退避/预算/暂停与崩溃恢复。 */
import { libraryLessonsDir } from '../layout.js';
import { readLearnConfig } from './config.js';
import { runLessonExtraction, type LessonProviderDeps } from './learn.js';
import type { ExtractionOutcome } from './learn.js';
import { writeMemoryDiff, type MemoryDiff } from './audit.js';
import { LlmParseError } from './llm.js';
import { readUsageRecords } from './usage.js';
import { LocalStorageAdapter } from './storage.js';
import { JobQueue, type ErrorClass, type Job } from './jobs.js';

export interface RunJobsOptions {
  owner: string;
  batch: number;
  leaseTtlMs?: number;
  usagePath: string;
  dailyTokenBudget: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RunJobsResult {
  processed: number;
  done: number;
  skipped: number;
  failed: number;
  retryWait: number;
  blocked?: 'budget' | 'disk' | 'paused' | 'off';
}

export const BLOCKED_MESSAGE: Record<NonNullable<RunJobsResult['blocked']>, string> = {
  off: 'learn 已关闭（learn.mode=off）',
  paused: 'learn 已暂停（learn.paused=true）',
  budget: 'learn 已暂停:当天 token 预算用尽',
  disk: 'learn 已暂停:磁盘写入失败',
};

interface Checkpoint {
  stage?: unknown;
  diff?: MemoryDiff;
}

/** 分类运行期异常:网络/限流/服务/配置/解析/磁盘,其余 unknown。 */
export function classifyError(e: unknown): ErrorClass {
  if (e instanceof LlmParseError) return 'parse';
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EROFS' || code === 'EDQUOT') return 'disk';
  const msg = e instanceof Error ? e.message : String(e);
  if (/429/.test(msg)) return 'rate_limit';
  if (/\b(5\d\d)\b/.test(msg)) return 'server';
  if (/401|403|缺少.*配置|配置缺失|api[ -]?key|unauthorized/i.test(msg)) return 'config';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENETUNREACH' || /超时|timeout|timed out|ECONN/i.test(msg)) return 'network';
  return 'unknown';
}

/** 汇总当天(本地自然日)totalTokens。 */
async function todayTokens(usagePath: string, nowFn?: () => Date): Promise<number> {
  const records = await readUsageRecords(usagePath);
  const now = nowFn?.() ?? new Date();
  const key = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = key(now);
  let total = 0;
  for (const r of records) {
    const at = new Date(r.at);
    if (!Number.isNaN(at.getTime()) && key(at) === today) total += r.totalTokens;
  }
  return total;
}

export async function runQueuedJobs(
  vaultRoot: string,
  queue: JobQueue,
  deps: LessonProviderDeps,
  opts: RunJobsOptions,
): Promise<RunJobsResult> {
  const now = () => (deps.now?.() ?? new Date()).getTime();
  const learn = readLearnConfig(deps.config);
  const result: RunJobsResult = { processed: 0, done: 0, skipped: 0, failed: 0, retryWait: 0 };

  queue.requeueExpired(now());

  if (learn.mode === 'off') {
    result.blocked = 'off';
    return result;
  }
  if (learn.paused) {
    result.blocked = 'paused';
    return result;
  }
  if ((await todayTokens(opts.usagePath, deps.now)) >= opts.dailyTokenBudget) {
    result.blocked = 'budget';
    return result;
  }

  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const ttl = opts.leaseTtlMs ?? learn.leaseTtlMs;

  for (let i = 0; i < opts.batch; i++) {
    if (opts.signal?.aborted) break;
    const job = queue.lease(opts.owner, ttl, now());
    if (!job) break;
    result.processed++;

    const timer = setInterval(() => queue.heartbeat(job.id, opts.owner, ttl, now()), Math.max(1000, Math.floor(ttl / 3)));
    try {
      const checkpoint = parseCheckpoint(job);
      if (checkpoint?.diff) {
        // 崩溃恢复:记忆已写、审计未写全时,补写审计即可,不再重跑 LLM。
        await writeMemoryDiff(checkpoint.diff, storage);
        queue.complete(job.id, now());
        result.done++;
        opts.log?.(`会话 ${job.sessionKey} 从检查点恢复完成`);
        continue;
      }
      const outcome = await runLessonExtraction(vaultRoot, job.sessionKey, {
        ...deps,
        onWritten: (diff) => queue.setCheckpoint(job.id, JSON.stringify({ stage: 'written', diff })),
      });
      if (outcome.skipReason) {
        queue.skip(job.id, outcome.skipReason, now());
        result.skipped++;
        opts.log?.(`会话 ${job.sessionKey} 未达阈值,跳过:${outcome.skipReason}`);
      } else {
        queue.complete(job.id, now());
        result.done++;
        opts.log?.(`会话 ${job.sessionKey} 完成:${describeDiff(outcome)}`);
      }
    } catch (e) {
      const cls = classifyError(e);
      const after = queue.fail(job.id, { class: cls, message: (e as Error).message }, now());
      result.failed++;
      if (after.state === 'retry_wait') result.retryWait++;
      opts.log?.(`会话 ${job.sessionKey} 提取失败:${(e as Error).message}`);
      if (cls === 'disk') {
        result.blocked = 'disk';
        break;
      }
    } finally {
      clearInterval(timer);
    }
  }
  return result;
}

function parseCheckpoint(job: Job): Checkpoint | null {
  if (!job.checkpoint) return null;
  try {
    const cp = JSON.parse(job.checkpoint) as Checkpoint;
    return cp?.stage === 'written' && cp.diff ? cp : null;
  } catch {
    return null;
  }
}

function describeDiff(outcome: ExtractionOutcome): string {
  const d = outcome.diff?.summary;
  return `新增 ${d?.adds ?? 0}、更新 ${d?.updates ?? 0}、跳过 ${d?.skips ?? 0}`;
}
