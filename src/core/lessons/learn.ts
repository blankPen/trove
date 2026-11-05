/** 阶段 9:经验提取的编排入口。把「选会话 → 跑流水线 → 批量跳过已审计」接到 CLI 与 daemon。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Event } from '../events/schema.js';
import type { Config } from '../../config.js';
import { libraryDir, libraryLessonsDir } from '../layout.js';
import { trovePaths } from '../../paths.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from '../library/index-file.js';
import { ensureLessonsLayout } from './layout.js';
import { LocalStorageAdapter } from './storage.js';
import { readLlmConfig, readJevConfig, readLearnConfig } from './config.js';
import { DeepSeekLlm, LlmParseError } from './llm.js';
import type { LlmProvider } from './llm.js';
import { createUsageSink } from './usage.js';
import { TypeSafeJevScorer } from './jev.js';
import type { JevProvider } from './jev.js';
import { runLessonPipelineV2 } from './v2.js';
import type { MemoryDiff } from './audit.js';
import { readLearnQueue, removeLearn } from './queue.js';
import { autoMigrateLessons } from './migrate.js';

export interface LessonProviderDeps {
  llm?: LlmProvider;
  jev?: JevProvider;
  /** 可控时钟,测试注入;缺省系统时间。 */
  now?: () => Date;
  /** 覆盖环境变量;缺省读 process.env。 */
  env?: Record<string, string | undefined>;
  /** token 用量台账路径;缺省 ~/.trove/usage.jsonl。 */
  usagePath?: string;
  /** 模型端点配置(~/.trove/config.json 的 llm/jev 段)与 learn 段;缺省由调用方注入。 */
  config?: Pick<Config, 'llm' | 'jev' | 'learn'>;
}

export interface ExtractionOutcome {
  diff?: MemoryDiff;
  skipReason?: string;
  /** v2 shadow 模式:已跑流水线但只写审计/决策,未写记忆。 */
  shadow?: boolean;
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

function resolveProviders(deps: LessonProviderDeps): { llm: LlmProvider; jev: JevProvider } {
  // 懒构造:LLM/Jev 配置缺失时由调用方决定跳过还是报错,不拖垮无关命令与 daemon。
  const usagePath = deps.usagePath ?? trovePaths(deps.env?.TROVE_HOME).usageLog;
  const llm = deps.llm ?? new DeepSeekLlm(readLlmConfig(deps.config), { onUsage: createUsageSink(usagePath) });
  const jev = deps.jev ?? new TypeSafeJevScorer(readJevConfig(deps.config));
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
  return { diff: out.diff, skipReason: out.skipReason, shadow: out.shadow };
}

/**
 * 从队列取最多 batch 个候选,逐个跑流水线;处理完(成功/被过滤/失败)都出队,失败落 .failed 标记。
 * 只学队列里的「本轮新会话」,历史会话走 `trove learn <id>` 手动补。缺配置时不 drain 队列。
 */
export async function learnPendingBatch(
  vaultRoot: string,
  queuePath: string,
  deps: LessonProviderDeps = {},
  batch = 3,
  opts: { log?: (line: string) => void } = {},
): Promise<string | undefined> {
  const ids = await readLearnQueue(queuePath);
  if (ids.length === 0) return undefined;

  let providers: { llm: LlmProvider; jev: JevProvider };
  try {
    providers = resolveProviders(deps);
  } catch (e) {
    opts.log?.(`跳过经验提取:${(e as Error).message}`);
    return undefined;
  }

  const candidates = ids.slice(0, batch);
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  let extracted = 0;
  let skipped = 0;
  let failed = 0;
  for (const key of candidates) {
    try {
      const outcome = await runLessonExtraction(vaultRoot, key, { llm: providers.llm, jev: providers.jev, now: deps.now, config: deps.config });
      if (outcome.skipReason) {
        skipped++;
        opts.log?.(`会话 ${key} 未达阈值,跳过:${outcome.skipReason}`);
      } else if (outcome.shadow) {
        extracted++;
        opts.log?.(`会话 ${key} shadow 模式:未写记忆,${outcome.diff?.summary.skips ?? 0} 条候选记入审计`);
      } else {
        extracted++;
        const d = outcome.diff?.summary;
        opts.log?.(`会话 ${key} 提取完成:新增 ${d?.adds ?? 0}、更新 ${d?.updates ?? 0}、跳过 ${d?.skips ?? 0}`);
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      // 落失败标记,阻止同一坏会话被反复重跑完整 LLM 流水线;标记可删后重试。
      await storage.write(`audit/${key}.failed.json`, JSON.stringify({ session_id: key, error: msg, at: new Date().toISOString() }, null, 2)).catch(() => {});
      opts.log?.(`会话 ${key} 提取失败:${msg}`);
    }
  }

  await removeLearn(queuePath, candidates);
  const remaining = (await readLearnQueue(queuePath)).length;
  return `经验提取:新增 ${extracted} · 跳过 ${skipped} · 失败 ${failed} · 待办 ${remaining}`;
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
  const keys = await recentUnlearnedKeys(vaultRoot, limit, deps.config);
  if (keys.length === 0) return '没有可学习的会话(都已学习或索引为空)';

  // 缺配置在此抛出,与单条 `trove learn <id>` 一致,不静默吞掉手动触发的错误。
  const { llm, jev } = resolveProviders(deps);
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  let extracted = 0;
  let skipped = 0;
  let failed = 0;
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
        const d = outcome.diff?.summary;
        opts.log?.(`[${i + 1}/${keys.length}] ${key} 完成:新增 ${d?.adds ?? 0}、更新 ${d?.updates ?? 0}、跳过 ${d?.skips ?? 0}`);
      }
    } catch (e) {
      failed++;
      const msg = (e as Error).message;
      await storage.write(`audit/${key}.failed.json`, JSON.stringify({ session_id: key, error: msg, at: new Date().toISOString() }, null, 2)).catch(() => {});
      opts.log?.(`[${i + 1}/${keys.length}] ${key} 失败:${msg}`);
    }
  }
  return `经验提取完成:新增 ${extracted} · 跳过 ${skipped} · 失败 ${failed} · 共 ${keys.length} 个会话`;
}