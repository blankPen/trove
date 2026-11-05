/** 阶段 9:经验提取的编排入口。把「选会话 → 跑流水线 → 批量跳过已审计」接到 CLI 与 daemon。 */
import { readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Event } from '../events/schema.js';
import type { Config } from '../../config.js';
import { libraryDir, libraryLessonsDir } from '../layout.js';
import { trovePaths } from '../../paths.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from '../library/index-file.js';
import { hashBytes } from '../chunker.js';
import { ensureLessonsLayout } from './layout.js';
import { LocalStorageAdapter } from './storage.js';
import { readLlmConfig, readJevConfigOrNull, readLearnConfig } from './config.js';
import { DeepSeekLlm, LlmParseError } from './llm.js';
import type { LlmProvider } from './llm.js';
import { createUsageSink } from './usage.js';
import { TypeSafeJevScorer } from './jev.js';
import type { JevProvider } from './jev.js';
import { runLessonPipelineV2 } from './v2.js';
import type { MemoryDiff } from './audit.js';
import { readLearnQueue } from './queue.js';
import { autoMigrateLessons } from './migrate.js';
import { JobQueue, type JobInput } from './jobs.js';
import { runQueuedJobs, BLOCKED_MESSAGE } from './runner.js';

export interface LessonProviderDeps {
  llm?: LlmProvider;
  /** Jev 提供方;null/undefined 表示未配置,下游走启发式降级。 */
  jev?: JevProvider | null;
  /** 可控时钟,测试注入;缺省系统时间。 */
  now?: () => Date;
  /** 覆盖环境变量;缺省读 process.env。 */
  env?: Record<string, string | undefined>;
  /** token 用量台账路径;缺省 ~/.trove/usage.jsonl。 */
  usagePath?: string;
  /** 模型端点配置(~/.trove/config.json 的 llm/jev 段)与 learn 段;缺省由调用方注入。 */
  config?: Pick<Config, 'llm' | 'jev' | 'learn'>;
  /** 记忆落盘后、审计写盘前的回调(runner 用来写崩溃恢复 checkpoint)。 */
  onWritten?: (diff: MemoryDiff) => Promise<void> | void;
  /** 记忆落盘后的向量增量同步(生产由 CLI 注入;测试不注入以免联网)。 */
  syncVectors?: () => Promise<void> | void;
}

export interface ExtractionOutcome {
  diff?: MemoryDiff;
  skipReason?: string;
  /** v2 shadow 模式:已跑流水线但只写审计/决策,未写记忆。 */
  shadow?: boolean;
  /** review 模式本次新写入 inbox 的候选数(待审)。 */
  pending?: number;
}

/** 从统一索引解析单会话的 canonical 事件;裸 session 错配多个 harness 时报歧义。 */
export async function loadSessionEvents(vaultRoot: string, sessionId: string): Promise<Event[]> {
  const index = (await loadLibraryIndex(vaultRoot)) ?? (await rebuildUnifiedIndex(vaultRoot));
  const matches = Object.values(index.sessions).filter(
    (s) => s.session === sessionId || `${s.harness}:${s.session}` === sessionId,
  );
  if (matches.length === 0) throw new Error(`没有找到会话:${sessionId}`);
  if (matches.length > 1) {
    const keys = matches.map((s) => `${s.harness}:${s.session}`).join('、');
    throw new Error(`会话 ${sessionId} 存在歧义:命中多个 harness(${keys}),请用 harness:session 指定`);
  }
  const s = matches[0]!;
  const path = join(libraryDir(vaultRoot), ...s.canonical.path.split('/'));
  const text = await readFile(path, 'utf8');
  const events: Event[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      // 跳过无法解析的行,镜像 index-file 的容错口径
    }
  }
  return events;
}

export function resolveProviders(deps: LessonProviderDeps): { llm: LlmProvider; jev: JevProvider | null } {
  // 懒构造:LLM 配置缺失时照旧抛错(必须配);Jev 是外部增强,未配置返回 null,下游降级为启发式 + LLM 裁决。
  const usagePath = deps.usagePath ?? trovePaths(deps.env?.TROVE_HOME).usageLog;
  const llm = deps.llm ?? new DeepSeekLlm(readLlmConfig(deps.config), { onUsage: createUsageSink(usagePath) });
  let jev: JevProvider | null;
  if (deps.jev === undefined) {
    // 未注入:按配置解析;未配置 Jev 则为 null(外部增强缺失不阻断学习)。
    const jevConfig = readJevConfigOrNull(deps.config);
    jev = jevConfig ? new TypeSafeJevScorer(jevConfig) : null;
  } else {
    jev = deps.jev; // 显式 null = 不用 Jev
  }
  return { llm, jev };
}

/** 对单会话跑全链路;被过滤(阶段 4)时不落任何记忆文件,通过 skipReason 区分。 */
export async function runLessonExtraction(
  vaultRoot: string,
  sessionId: string,
  deps: LessonProviderDeps = {},
  opts: { force?: boolean } = {},
): Promise<ExtractionOutcome> {
  await ensureLessonsLayout(vaultRoot);
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const learn = readLearnConfig(deps.config);
  if (learn.mode === 'off') return { skipReason: 'disabled' };
  await autoMigrateLessons(vaultRoot, storage, learn, (m) => console.warn(m));
  // 幂等键 = audit/<sessionId>.json:已提取过默认跳过,force 强制重跑(配合 merge 层幂等不翻倍)。
  if (!opts.force && (await storage.exists(`audit/${sessionId}.json`))) {
    return { skipReason: 'already_learned' };
  }
  const { llm, jev } = resolveProviders(deps);
  const out = await runLessonPipelineV2(sessionId, {
    llm,
    jev,
    storage,
    learn,
    loadEvents: (id) => loadSessionEvents(vaultRoot, id),
    now: deps.now,
    onWritten: deps.onWritten,
    syncVectors: deps.syncVectors,
  }).catch((e) => {
    // 模型重试后仍输出非 JSON → 当跳过忽略,不记失败。
    if (e instanceof LlmParseError) return null;
    throw e;
  });
  if (out === null) {
    await storage
      .write(
        `audit/${sessionId}.skipped.json`,
        JSON.stringify({ session_id: sessionId, reason: 'llm_parse_failed', at: new Date().toISOString() }, null, 2),
      )
      .catch(() => {});
    return { skipReason: 'llm_parse_failed' };
  }
  // 非「进行中」的跳过落标记,避免反复重跑。
  if (out.skipReason && out.skipReason !== 'in_progress') {
    await storage
      .write(
        `audit/${sessionId}.skipped.json`,
        JSON.stringify({ session_id: sessionId, reason: out.skipReason, at: new Date().toISOString() }, null, 2),
      )
      .catch(() => {});
  }
  return { diff: out.diff, skipReason: out.skipReason, shadow: out.shadow, pending: out.pending };
}

/**
 * 从 learn.db 队列取最多 batch 个作业跑流水线;处理完(成功/被过滤/失败)按各自终态落库。
 * 只学队列里的「本轮新会话」,历史会话走 `trove learn <id>` 手动补。
 */
export async function learnPendingBatch(
  vaultRoot: string,
  queue: JobQueue,
  deps: LessonProviderDeps = {},
  batch = 3,
  opts: { log?: (line: string) => void } = {},
): Promise<string | undefined> {
  const learn = readLearnConfig(deps.config);
  const res = await runQueuedJobs(vaultRoot, queue, deps, {
    owner: 'learn',
    batch,
    leaseTtlMs: learn.leaseTtlMs,
    usagePath: deps.usagePath ?? trovePaths(deps.env?.TROVE_HOME).usageLog,
    dailyTokenBudget: learn.dailyTokenBudget,
    log: opts.log,
  });
  if (res.blocked) {
    const msg = BLOCKED_MESSAGE[res.blocked];
    opts.log?.(msg);
    return msg;
  }
  if (res.processed === 0) return undefined;
  const s = queue.stats();
  return `经验提取:新增 ${res.done} · 跳过 ${res.skipped} · 失败 ${res.failed} · 待办 ${s.queued + s.retryWait}`;
}

/** 会话内容哈希:统一索引 canonical jsonl 字节 SHA-256;索引缺失时回退 sha256(sessionKey)。 */
export async function hashSessionContent(vaultRoot: string, sessionKey: string): Promise<string> {
  try {
    const index = (await loadLibraryIndex(vaultRoot)) ?? (await rebuildUnifiedIndex(vaultRoot));
    const s = Object.values(index.sessions).find(
      (it) => it.session === sessionKey || `${it.harness}:${it.session}` === sessionKey,
    );
    if (s) {
      const path = join(libraryDir(vaultRoot), ...s.canonical.path.split('/'));
      try {
        return hashBytes(await readFile(path));
      } catch {
        // 文件缺失 → 回退
      }
    }
  } catch {
    // 索引缺失/损坏 → 回退
  }
  return hashBytes(Buffer.from(sessionKey, 'utf8'));
}

/** 把 sync 报告里的 changedSessions(harness:session)入队,返回新入队条数(唯一键忽略重复)。 */
export async function enqueueLearnSessions(vaultRoot: string, queue: JobQueue, sessionKeys: string[]): Promise<number> {
  const inputs: JobInput[] = [];
  for (const key of sessionKeys) {
    inputs.push({ sessionKey: key, contentHash: await hashSessionContent(vaultRoot, key) });
  }
  return queue.enqueue(inputs);
}

/** 旧 JSON 队列平滑迁移:读 learn-queue.json 的 ids 逐个入队,成功后改名 .migrated;文件不存在返回 0。 */
export async function migrateJsonQueue(jsonPath: string, queue: JobQueue, vaultRoot: string): Promise<number> {
  try {
    await stat(jsonPath);
  } catch {
    return 0;
  }
  const ids = await readLearnQueue(jsonPath);
  const n = await enqueueLearnSessions(vaultRoot, queue, ids);
  await rename(jsonPath, `${jsonPath}.migrated`);
  return n;
}

/** 从统一索引按 startedAt 降序取最多 limit 个「未学习」会话 key(harness:session)。 */
export async function recentUnlearnedKeys(
  vaultRoot: string,
  limit: number,
  config?: Pick<Config, 'learn'>,
): Promise<string[]> {
  const index = (await loadLibraryIndex(vaultRoot)) ?? (await rebuildUnifiedIndex(vaultRoot));
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const shadow = readLearnConfig(config).mode === 'shadow';
  const entries = Object.values(index.sessions).sort((a, b) =>
    (b.startedAt ?? '') > (a.startedAt ?? '') ? 1 : -1,
  );
  const keys: string[] = [];
  for (const s of entries) {
    const key = `${s.harness}:${s.session}`;
    // 已成功(.json)或已失败(.failed.json)都算已处理;双形式兜底历史裸 session 落盘。
    // .shadow.json 是 shadow 观察轮的审计:仅 shadow 模式算已处理,auto 忽略以真正补学。
    const handled =
      (await storage.exists(`audit/${key}.json`)) ||
      (await storage.exists(`audit/${s.session}.json`)) ||
      (await storage.exists(`audit/${key}.failed.json`)) ||
      (await storage.exists(`audit/${s.session}.failed.json`)) ||
      (await storage.exists(`audit/${key}.skipped.json`)) ||
      (await storage.exists(`audit/${s.session}.skipped.json`)) ||
      (shadow && (await storage.exists(`audit/${key}.shadow.json`))) ||
      (shadow && (await storage.exists(`audit/${s.session}.shadow.json`)));
    if (!handled) keys.push(key);
    if (keys.length >= limit) break;
  }
  return keys;
}

/** 手动批量学习:取最近 limit 个未学习会话逐条跑提取,与 daemon 队列学习互不影响。 */
export async function learnRecentBatch(
  vaultRoot: string,
  limit: number,
  deps: LessonProviderDeps = {},
  opts: { log?: (line: string) => void } = {},
): Promise<string> {
  if (readLearnConfig(deps.config).mode === 'off') {
    opts.log?.('learn 已关闭（learn.mode=off）');
    return 'learn 已关闭（learn.mode=off）';
  }

  const keys = await recentUnlearnedKeys(vaultRoot, limit, deps.config);
  if (keys.length === 0) return '没有可学习的会话(都已学习或索引为空)';

  // 缺配置在此抛出,与单条 `trove learn <id>` 一致,不静默吞掉手动触发的错误。
  const { llm, jev } = resolveProviders(deps);
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  let extracted = 0;
  let skipped = 0;
  let failed = 0;
  let pendingTotal = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    try {
      const outcome = await runLessonExtraction(vaultRoot, key, { llm, jev, now: deps.now, config: deps.config });
      if (outcome.skipReason) {
        skipped++;
        opts.log?.(`[${i + 1}/${keys.length}] ${key} 未达阈值,跳过:${outcome.skipReason}`);
      } else if (outcome.shadow) {
        extracted++;
        opts.log?.(`[${i + 1}/${keys.length}] ${key} shadow 模式:未写记忆,${outcome.diff?.summary.skips ?? 0} 条候选记入审计`);
      } else {
        extracted++;
        pendingTotal += outcome.pending ?? 0;
        const d = outcome.diff?.summary;
        const pending = outcome.pending ? ` · 待审 ${outcome.pending}` : '';
        opts.log?.(`[${i + 1}/${keys.length}] ${key} 完成:新增 ${d?.adds ?? 0}、更新 ${d?.updates ?? 0}、跳过 ${d?.skips ?? 0}${pending}`);
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      await storage.write(`audit/${key}.failed.json`, JSON.stringify({ session_id: key, error: msg, at: new Date().toISOString() }, null, 2)).catch(() => {});
      opts.log?.(`[${i + 1}/${keys.length}] ${key} 失败:${msg}`);
    }
  }
  const pendingPart = pendingTotal > 0 ? ` · 待审 ${pendingTotal}` : '';
  return `经验提取完成:新增 ${extracted} · 跳过 ${skipped} · 失败 ${failed} · 共 ${keys.length} 个会话${pendingPart}`;
}