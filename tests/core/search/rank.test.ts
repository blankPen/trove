import { describe, it, expect } from 'vitest';
import { applyUsageRanking } from '../../../src/core/search/rank.js';
import type { LessonHit } from '../../../src/core/search/lessons-index.js';
import type { MemoryUsageSummary } from '../../../src/core/lessons/memory-usage.js';

function hit(over: Partial<LessonHit> = {}): LessonHit {
  return {
    path: over.path ?? 'p.md',
    title: over.title ?? '标题',
    type: 'experiences/gotcha',
    tags: [],
    snippet: '',
    score: over.score ?? 1,
    scoreParts: { bm25: 1, recency: 0, exact: 0, project: 0 },
    ...over,
  };
}

describe('applyUsageRanking(使用反馈排序)', () => {
  it('无 usage 且 cwd 未命中 → 原样返回(不调整)', () => {
    const hits = [hit({ path: 'a.md' }), hit({ path: 'b.md' })];
    expect(applyUsageRanking(hits, new Map(), {})).toBe(hits);
  });

  it('usage 提升:retrieved/helpful 高的排前', () => {
    const hits = [hit({ path: 'low.md', id: 'exp_low' }), hit({ path: 'high.md', id: 'exp_high' })];
    const usage = new Map<string, MemoryUsageSummary>([
      ['exp_high', { retrieved: 10, viewed: 2, applied: 0, helpful: 5, harmful: 0, lastUsedAt: '2026-01-02T00:00:00.000Z' }],
      ['exp_low', { retrieved: 0, viewed: 0, applied: 0, helpful: 0, harmful: 0 }],
    ]);
    const r = applyUsageRanking(hits, usage, { now: new Date('2026-01-03T00:00:00.000Z') });
    expect(r.map((h) => h.path)).toEqual(['high.md', 'low.md']);
    expect(r[0]!.score).toBeGreaterThan(1);
  });

  it('项目命中提升:scope 匹配 cwd 的排前', () => {
    const hits = [hit({ path: 'other.md', scope: 'project:other' }), hit({ path: 'mine.md', scope: 'project:trove' })];
    const r = applyUsageRanking(hits, new Map(), { cwd: '/Users/x/trove' });
    expect(r.map((h) => h.path)).toEqual(['mine.md', 'other.md']);
  });

  it('usage 空且 cwd 未命中任何 scope → 原样返回', () => {
    const hits = [hit({ path: 'a.md', scope: 'project:other' })];
    expect(applyUsageRanking(hits, new Map(), { cwd: '/Users/x/trove' })).toBe(hits);
  });
});
