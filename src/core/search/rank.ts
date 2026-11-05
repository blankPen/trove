/** 检索后的统一加分项：时间衰减、精确子串、项目亲和。 */
import { projectSlug } from '../lessons/scope.js';
import type { LessonHit } from './lessons-index.js';
import type { MemoryUsageSummary } from '../lessons/memory-usage.js';

const DAY_MS = 86_400_000;

export interface ScoreParts {
  bm25: number;
  recency: number;
  exact: number;
  project: number;
}

/** 0.5^(ageDays/halfLife) × weight；时间缺失记 0，不因此排到最后。 */
export function recencyBoost(
  iso: string | undefined,
  halfLifeDays: number,
  weight: number,
  now: number,
): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (now - t) / DAY_MS);
  return weight * Math.pow(0.5, ageDays / halfLifeDays);
}

/** 原始查询作为子串出现在标题/摘要时加分。 */
export function exactBonus(haystack: string | undefined, query: string, weight = 2): number {
  if (!haystack || !query.trim()) return 0;
  return haystack.toLowerCase().includes(query.trim().toLowerCase()) ? weight : 0;
}

/** query 命中当前项目名（cwd 末段）时加分。 */
export function projectAffinity(cwd: string | undefined, query: string, weight = 1): number {
  if (!cwd || !query.trim()) return 0;
  const project = cwd.split('/').filter(Boolean).pop();
  if (!project) return 0;
  return query.toLowerCase().includes(project.toLowerCase()) ? weight : 0;
}

export function scoreParts(parts: ScoreParts): number {
  return parts.bm25 + parts.recency + parts.exact + parts.project;
}

/** 截断到 max 个码点，避免切断 emoji 代理对。 */
export function clip(text: string, max: number): string {
  const chars = [...text.trim().replace(/\s+/g, ' ')];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}
/** 取命中词附近的一段文本作为片段。 */
export function snippetAround(text: string, needle: string, radius = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lower = flat.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  if (idx < 0) return clip(flat, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + needle.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** 使用反馈排序：仅当 usage 非空或 cwd 命中某 hit 的 project scope 时调整，否则原样返回。 */
export function applyUsageRanking(
  hits: LessonHit[],
  usage: Map<string, MemoryUsageSummary>,
  opts: { now?: Date; cwd?: string } = {},
): LessonHit[] {
  const cwdScope = opts.cwd ? `project:${projectSlug(opts.cwd)}` : undefined;
  if (usage.size === 0 && (!cwdScope || !hits.some((h) => h.scope === cwdScope))) return hits;

  const now = opts.now ? opts.now.getTime() : Date.now();
  return hits
    .map((h) => {
      const u = h.id ? usage.get(h.id) : undefined;
      let boost = 0;
      if (u) {
        boost += 0.2 * Math.log1p(u.retrieved);
        boost += 0.25 * usageHelpfulRatio(u);
        const rec = u.lastUsedAt ?? h.updatedAt;
        if (rec) boost += 0.1 * usageRecency(rec, now);
      }
      if (cwdScope && h.scope === cwdScope) boost += 0.1;
      return boost > 0 ? { ...h, score: h.score + boost } : h;
    })
    .sort((a, b) => b.score - a.score);
}

/** helpful/(retrieved+viewed)，分母为 0 记 0，上限 1。 */
function usageHelpfulRatio(u: MemoryUsageSummary): number {
  const denom = u.retrieved + u.viewed;
  if (!denom) return 0;
  return Math.min(1, u.helpful / denom);
}

/** exp(-days/30)；时间缺失或非法记 0。 */
function usageRecency(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.exp(-Math.max(0, now - t) / DAY_MS / 30);
}
