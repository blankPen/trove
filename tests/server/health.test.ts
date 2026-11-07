import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { libraryLessonsDir } from '../../src/core/layout.js';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import {
  renderMemory,
  type EvidenceRef,
  type MemoryV2,
  type QualityScore,
} from '../../src/core/lessons/memory.js';
import { buildMemoryHealth } from '../../src/core/lessons/health.js';
import { trovePaths } from '../../src/paths.js';
import { tmpVault, vaultRoot } from '../helpers/vault.js';

/** Memory Health 的计算:总数/分类/stale/缺证据/低质量/重复对数/usage 汇总。 */
describe('buildMemoryHealth', () => {
  let base: string;
  let storage: LocalStorageAdapter;

  const NOW = Date.parse('2026-03-01T00:00:00.000Z');
  const q = (v: number): QualityScore => ({ specific: v, actionable: v, transferable: v, evidence: v, non_duplicate: v });
  const EVID: EvidenceRef[] = [{ session: 'sess-1', seq: 1, quote: 'Permission denied' }];

  let seq = 0;
  function mem(partial: Partial<MemoryV2> & { type: string; title: string }): MemoryV2 {
    return {
      id: partial.id ?? `exp_${(seq++).toString(36)}`,
      kind: partial.kind ?? 'experience',
      type: partial.type,
      title: partial.title,
      tags: partial.tags ?? ['experiences'],
      scope: partial.scope ?? 'global',
      status: partial.status ?? 'active',
      version: 1,
      quality: partial.quality,
      evidence: partial.evidence ?? [],
      sourceTrajectories: partial.sourceTrajectories,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      useCount: 0,
      helpfulCount: 0,
      body: partial.body ?? '正文',
    };
  }

  async function seed(rel: string, m: MemoryV2): Promise<void> {
    await storage.write(rel, renderMemory(m));
  }

  beforeEach(async () => {
    base = await tmpVault();
    storage = new LocalStorageAdapter(libraryLessonsDir(vaultRoot(base)));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('总数/分类/stale/archived/缺证据/低质量/重复对数', async () => {
    await seed('experiences/good.md', mem({ type: 'experiences/gotcha', title: 'git push 权限排查', quality: q(0.9), evidence: EVID }));
    await seed('experiences/missing.md', mem({ type: 'experiences/gotcha', title: '缺证据的经验标题很独特', quality: q(0.9) }));
    await seed('experiences/low.md', mem({ type: 'experiences/gotcha', title: '低质量经验标题也独特', quality: q(0.5), evidence: EVID }));
    await seed('experiences/stale.md', mem({ type: 'experiences/gotcha', title: '过期经验标题', status: 'stale' }));
    await seed('experiences/dup-a.md', mem({ type: 'experiences/gotcha', title: '重复的路径穿越经验', quality: q(0.9), evidence: EVID }));
    await seed('experiences/dup-b.md', mem({ type: 'experiences/gotcha', title: '重复的路径穿越经验', quality: q(0.9), evidence: EVID }));
    await seed('preferences/profile.md', mem({ kind: 'preference', type: 'preferences/profile', title: '用户偏好', tags: ['preferences'] }));
    await seed('archive/experiences/old.md', mem({ type: 'experiences/gotcha', title: '已归档经验', status: 'archived' }));

    const h = await buildMemoryHealth(trovePaths(base), () => NOW);

    expect(h.total).toBe(7);
    expect(h.byCategory).toEqual({ experiences: 6, preferences: 1 });
    expect(h.stale).toBe(1);
    expect(h.archived).toBe(1);
    expect(h.pinned).toBe(0);
    expect(h.missingEvidence).toBe(1);
    expect(h.lowQuality).toBe(1);
    expect(h.duplicates).toBe(1);
  });

  it('覆盖缺口:未被任何经验引用的活跃轨迹', async () => {
    await seed(
      'experiences/ref.md',
      mem({ type: 'experiences/gotcha', title: '引用了轨迹的经验', evidence: EVID, sourceTrajectories: ['traj_a'] }),
    );
    await seed(
      'trajectories/2026-01-01-ses-1-task.md',
      mem({ id: 'traj_a', kind: 'trajectory', type: 'trajectories/capture', title: '被引用的轨迹', tags: ['trajectory'] }),
    );
    await seed(
      'trajectories/2026-01-02-ses-2-other.md',
      mem({ id: 'traj_b', kind: 'trajectory', type: 'trajectories/capture', title: '没人引用的轨迹', tags: ['trajectory'] }),
    );

    const h = await buildMemoryHealth(trovePaths(base), () => NOW);

    expect(h.unreferencedTrajectories).toBe(1);
  });

  it('usage 汇总:各动作计数与近 7 天', async () => {
    await storage.write(
      '.trove/usage.jsonl',
      [
        JSON.stringify({ at: '2026-01-01T00:00:00.000Z', memory_id: 'm1', action: 'retrieved' }),
        JSON.stringify({ at: '2026-01-02T00:00:00.000Z', memory_id: 'm1', action: 'retrieved' }),
        JSON.stringify({ at: '2026-01-03T00:00:00.000Z', memory_id: 'm1', action: 'viewed' }),
        JSON.stringify({ at: '2026-01-04T00:00:00.000Z', memory_id: 'm1', action: 'helpful' }),
        JSON.stringify({ at: '2026-01-05T00:00:00.000Z', memory_id: 'm1', action: 'harmful' }),
        JSON.stringify({ at: '2026-02-28T00:00:00.000Z', memory_id: 'm1', action: 'retrieved' }),
      ].join('\n') + '\n',
    );

    const h = await buildMemoryHealth(trovePaths(base), () => NOW);

    expect(h.usage).toEqual({ retrieved: 3, viewed: 1, helpful: 1, harmful: 1, last7d: 1 });
  });

  it('审核下线后 inbox/trust 指标恒为 0', async () => {
    const h = await buildMemoryHealth(trovePaths(base), () => NOW);

    expect(h.inboxPending).toBe(0);
    expect(h.trustLevel).toBe(0);
  });

  it('无 jobs/检索索引 缓存时不报错,返回 null', async () => {
    const h = await buildMemoryHealth(trovePaths(base), () => NOW);
    expect(h.jobs).toBeNull();
    expect(h.searchIndex).toBeNull();
  });
});
