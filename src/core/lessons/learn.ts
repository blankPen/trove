/** 阶段 9:经验提取的编排入口。把「选会话 → 跑流水线 → 批量跳过已审计」接到 CLI 与 daemon。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Event } from '../events/schema.js';
import { libraryDir, libraryLessonsDir } from '../layout.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from '../library/index-file.js';
import { listSessions } from '../sessions.js';
import { ensureLessonsLayout } from './layout.js';
import { LocalStorageAdapter } from './storage.js';
import { readLlmConfig, readJevConfig } from './config.js';
import { DeepSeekLlm } from './llm.js';
import type { LlmProvider } from './llm.js';
import { TypeSafeJevScorer } from './jev.js';
import type { JevProvider } from './jev.js';
import { buildLessonGraph } from './graph.js';
import type { MemoryDiff } from './audit.js';

export interface LessonProviderDeps {
  llm?: LlmProvider;
  jev?: JevProvider;
  /** 可控时钟,测试注入;缺省系统时间。 */
  now?: () => Date;
  /** 覆盖环境变量;缺省读 process.env。 */
  env?: Record<string, string | undefined>;
}

export interface ExtractionOutcome {
  diff?: MemoryDiff;
  skipReason?: string;
}

export interface LearnNewResult {
  attempted: number;
  extracted: number;
  skipped: number;
  errors: string[];
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
  const llm = deps.llm ?? new DeepSeekLlm(readLlmConfig(deps.env));
  const jev = deps.jev ?? new TypeSafeJevScorer(readJevConfig(deps.env));
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
  // 幂等键 = audit/<sessionId>.json:已提取过默认跳过,force 强制重跑(配合 merge 层幂等不翻倍)。
  if (!opts.force && (await storage.exists(`audit/${sessionId}.json`))) {
    return { skipReason: 'already_learned' };
  }
  const { llm, jev } = resolveProviders(deps);
  const graph = buildLessonGraph({
    llm,
    jev,
    storage,
    loadEvents: (id) => loadSessionEvents(vaultRoot, id),
    now: deps.now,
  });
  const out = await graph.invoke({ sessionId });
  if (out.skip) return { skipReason: out.skip.reason };
  return { diff: out.diff };
}

/** 批量提取未审计过的会话;缺配置时整批跳过并记录,绝不中断调用方(尤其 daemon)。 */
export async function learnNewSessions(
  vaultRoot: string,
  deps: LessonProviderDeps = {},
  opts: { log?: (line: string) => void } = {},
): Promise<LearnNewResult> {
  const sessions = await listSessions(vaultRoot);
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const result: LearnNewResult = { attempted: 0, extracted: 0, skipped: 0, errors: [] };
  if (sessions.length === 0) return result; // 无会话时不检查配置,避免误报缺配置

  let providers: { llm: LlmProvider; jev: JevProvider };
  try {
    providers = resolveProviders(deps);
  } catch (e) {
    opts.log?.(`跳过经验提取:${(e as Error).message}`);
    return result;
  }

  for (const s of sessions) {
    // 幂等键 = harness:session,避免裸 session 跨 harness 撞名;审计文件由 writeMemoryDiff 写为 audit/<键>.json。
    const key = `${s.harness}:${s.session}`;
    // 成功审计或已失败(避重试风暴)都跳过;失败标记可删后重试。
    if ((await storage.exists(`audit/${key}.json`)) || (await storage.exists(`audit/${key}.failed.json`))) {
      result.skipped++;
      continue;
    }
    result.attempted++;
    try {
      const outcome = await runLessonExtraction(vaultRoot, key, { llm: providers.llm, jev: providers.jev, now: deps.now });
      if (outcome.skipReason) {
        result.skipped++;
        opts.log?.(`会话 ${key} 未达阈值,跳过:${outcome.skipReason}`);
      } else {
        result.extracted++;
        const d = outcome.diff?.summary;
        opts.log?.(`会话 ${key} 提取完成:新增 ${d?.adds ?? 0}、更新 ${d?.updates ?? 0}、跳过 ${d?.skips ?? 0}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // 落失败标记,阻止 daemon 每轮对同一坏会话重复跑完整 LLM 流水线。
      await storage.write(`audit/${key}.failed.json`, JSON.stringify({ session_id: key, error: msg, at: new Date().toISOString() }, null, 2)).catch(() => {});
      result.errors.push(`${key}:${msg}`);
      opts.log?.(`会话 ${key} 提取失败:${msg}`);
    }
  }
  return result;
}