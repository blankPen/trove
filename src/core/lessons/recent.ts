/** 「近期方向」跨会话聚合:从统一索引取最近 N 个会话的时间/项目(cwd)/主题(firstText),
 * 渲染成清单交给 merge 层用 recent_matters 的 mergePrompt 重写全文,落盘 preferences/recent_matters.md。
 * 与单会话 extract(recent_matters 已从中移除)互补:后者抽「当下这个会话」,这里总结「最近整体方向」。 */
import { createHash } from 'node:crypto';
import { libraryLessonsDir } from '../layout.js';
import { loadLibraryIndex, rebuildUnifiedIndex } from '../library/index-file.js';
import type { LibraryIndex, MergedSession } from '../library/schema.js';
import { ensureLessonsLayout } from './layout.js';
import { LocalStorageAdapter } from './storage.js';
import { readLlmConfig } from './config.js';
import { DeepSeekLlm } from './llm.js';
import type { LlmProvider } from './llm.js';
import { loadExistingMemories } from './existing.js';
import { mergeMemories } from './merge.js';
import { applyOperations } from './write.js';
import { buildMemoryDiff, readSessionDiff, writeMemoryDiff } from './audit.js';
import type { LessonProviderDeps, ExtractionOutcome } from './learn.js';

/** 聚合窗口:最近多少个会话参与「近期方向」总结。shortcut: 要调再抽配置。 */
const RECENT_SESSION_LIMIT = 30;

/** 按 startedAt 降序取最近 limit 个会话;缺 startedAt 的排到末尾(视为最旧)。 */
export function pickRecentSessions(index: LibraryIndex, limit = RECENT_SESSION_LIMIT): MergedSession[] {
  return Object.values(index.sessions)
    .sort((a, b) => ((b.startedAt ?? '') > (a.startedAt ?? '') ? 1 : -1))
    .slice(0, limit);
}

/** 项目标识:cwd 取最后两段(如 orca/trove、du/teamwork-repos),去掉 /Users/admin 等前缀噪音;无 cwd 返回空串。 */
function projectOf(cwd?: string): string {
  if (!cwd) return '';
  return cwd.split('/').filter(Boolean).slice(-2).join('/');
}

/** 主题:firstText 优先,按码点截断到 100 字(不切断 emoji 代理对);空则回退 title。 */
function topicOf(s: MergedSession): string {
  const t = (s.firstText ?? s.title ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 100 ? `${[...t].slice(0, 100).join('')}…` : t;
}

/** 会话事件总数:variants 求和,作为「投入规模」信号(讨论深浅)。 */
function totalEvents(s: MergedSession): number {
  return s.variants.reduce((n, v) => n + v.events, 0);
}

/** 项目聚类统计:同类(cwd 尾两段)会话的频繁度与规模,供「近期方向」区分一次性 vs 常驻。 */
export interface ProjectStat {
  count: number;
  first?: string;
  last?: string;
  events: number;
}

/** 全量索引按项目聚类:会话数、首次/最近时间、累计事件数。无 cwd 不聚类(视为一次性)。 */
export function buildProjectStats(index: LibraryIndex): Map<string, ProjectStat> {
  const map = new Map<string, ProjectStat>();
  for (const s of Object.values(index.sessions)) {
    const project = projectOf(s.cwd);
    if (!project) continue;
    const st = map.get(project) ?? { count: 0, events: 0 };
    st.count += 1;
    st.events += totalEvents(s);
    const t = s.startedAt;
    if (t) {
      if (!st.first || t < st.first) st.first = t;
      if (!st.last || t > st.last) st.last = t;
    }
    map.set(project, st);
  }
  return map;
}

/** 单行第 4 段:频繁度(同类次数·首末时间)与事件规模;无 stats 时只标事件数。 */
function freqLabel(s: MergedSession, stats?: Map<string, ProjectStat>): string {
  const project = projectOf(s.cwd);
  const st = project ? stats?.get(project) : undefined;
  const parts: string[] = [];
  if (st && st.count > 1) {
    parts.push(`同类 ${st.count} 次`);
    if (st.first && st.last && st.first !== st.last) parts.push(`${st.first.slice(0, 10)}~${st.last.slice(0, 10)}`);
  }
  parts.push(`事件 ${totalEvents(s)} 条`);
  return parts.join(' · ');
}

/** 渲染最近会话清单:每行 日期 | 项目 | 主题 | 频繁度,交给 mergePrompt 让 LLM 分档总结方向。 */
export function renderRecentList(sessions: MergedSession[], stats?: Map<string, ProjectStat>): string {
  const lines = sessions.map((s) => {
    const date = (s.startedAt ?? '').slice(0, 10) || '(无时间)';
    const project = projectOf(s.cwd) || '(项目未知)';
    const topic = topicOf(s) || '(无主题)';
    return `- ${date} | ${project} | ${topic} | ${freqLabel(s, stats)}`;
  });
  return ['以下为最近会话清单(按时间倒序):', ...lines].join('\n');
}

/** 输入指纹:最近会话的身份+时间+事件规模,新会话、排序或规模变化即变;用于滚动幂等,输入不变不重跑 LLM。 */
export function recentInputHash(sessions: MergedSession[]): string {
  const body = sessions.map((s) => `${s.harness}:${s.session}@${s.startedAt ?? ''}#${totalEvents(s)}`).join('\n');
  return createHash('sha256').update(body).digest('hex');
}

/** recent 渠道编排:幂等键 audit/recent-matters.json 的 inputHash 字段,hash 不变则 skip(滚动不无谓烧 token)。 */
export async function learnRecentMatters(
  vaultRoot: string,
  deps: LessonProviderDeps = {},
  opts: { force?: boolean } = {},
): Promise<ExtractionOutcome> {
  await ensureLessonsLayout(vaultRoot);
  const storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot));
  const index = (await loadLibraryIndex(vaultRoot)) ?? (await rebuildUnifiedIndex(vaultRoot));
  const sessions = pickRecentSessions(index);
  if (sessions.length === 0) return { skipReason: 'no_sessions' };
  const hash = recentInputHash(sessions);
  const prev = await readSessionDiff(storage, 'recent-matters');
  if (!opts.force && prev?.inputHash === hash) return { skipReason: 'unchanged' };
  const llm: LlmProvider = deps.llm ?? new DeepSeekLlm(readLlmConfig(deps.config));
  const candidates = [
    { type: 'preferences/recent_matters', title: '用户近期工作方向聚合', content: renderRecentList(sessions, buildProjectStats(index)), evidence: [] },
  ];
  const existing = await loadExistingMemories(storage);
  const ops = await mergeMemories(candidates, existing, { llm });
  await applyOperations(ops, { storage, now: deps.now, source: 'recent-matters' });
  const diff = buildMemoryDiff(ops, { sessionId: 'recent-matters', project: 'cross-session' });
  const withHash = { ...diff, inputHash: hash };
  await writeMemoryDiff(withHash, storage);
  return { diff: withHash };
}
