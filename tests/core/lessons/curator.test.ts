import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { renderMemory, parseMemory } from '../../../src/core/lessons/memory.js';
import type { MemoryV2 } from '../../../src/core/lessons/memory.js';
import { recordMemoryUsage } from '../../../src/core/lessons/memory-usage.js';
import { runCurator, maybeRunCurator } from '../../../src/core/lessons/curator.js';

const NOW = new Date('2026-03-01T00:00:00.000Z');
const OLD = '2026-01-01T00:00:00.000Z';

let dir: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trove-curator-'));
  storage = new LocalStorageAdapter(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function memText(over: Partial<MemoryV2> = {}): string {
  return renderMemory({
    id: 'exp_1',
    kind: 'experience',
    type: 'experiences/debug_pattern',
    title: '脚本退出应该用 set -e',
    tags: ['experiences'],
    scope: 'global',
    status: 'active',
    version: 1,
    evidence: [],
    createdAt: OLD,
    updatedAt: OLD,
    useCount: 0,
    helpfulCount: 0,
    body: '正文内容',
    ...over,
  });
}

const OPTS = {
  now: () => NOW,
  staleDays: 14,
  archiveDays: 30,
  trajectoryDays: 90,
  trajectoryMax: 500,
};

describe('curator 生命周期', () => {
  it('active 超期未使用 → 标 stale(保留 updated_at 与 version)', async () => {
    await storage.write('experiences/a.md', memText());

    const report = await runCurator(storage, OPTS);

    expect(report.stale).toEqual(['experiences/a.md']);
    const mem = parseMemory((await storage.read('experiences/a.md'))!)!;
    expect(mem.status).toBe('stale');
    expect(mem.updatedAt).toBe(OLD);
    expect(mem.version).toBe(1);
  });

  it('stale 超期 → 移到 archive/,status=archived,原文件删除,INDEX 行清理', async () => {
    await storage.write('experiences/a.md', memText({ status: 'stale' }));
    await storage.write(
      'INDEX.md',
      '# INDEX\n\n## Experiences\n\n- 脚本退出应该用 set -e — 正文内容 (experiences/a.md) · tags: experiences\n',
    );

    const report = await runCurator(storage, OPTS);

    expect(report.archived).toEqual(['experiences/a.md']);
    expect(await storage.exists('experiences/a.md')).toBe(false);
    const archived = parseMemory((await storage.read('archive/experiences/a.md'))!)!;
    expect(archived.status).toBe('archived');
    expect(archived.body).toContain('正文内容');
    expect(await storage.read('INDEX.md')).not.toContain('(experiences/a.md)');
  });

  it('归档目标已存在时追加时间戳后缀,不覆盖旧归档', async () => {
    await storage.write('experiences/a.md', memText({ status: 'stale' }));
    await storage.write('archive/experiences/a.md', memText({ status: 'archived' }));

    await runCurator(storage, OPTS);

    const files = (await storage.list('archive')).filter((f) => f.includes('experiences/a.md'));
    expect(files).toHaveLength(2);
    expect(files).toContain('archive/experiences/a.md');
    expect(files.some((f) => f !== 'archive/experiences/a.md')).toBe(true);
  });

  it('pinned 记忆不参与 stale/archive', async () => {
    await storage.write('experiences/a.md', memText({ pinned: true }));

    const report = await runCurator(storage, OPTS);

    expect(report.stale).toEqual([]);
    expect(report.archived).toEqual([]);
    expect(parseMemory((await storage.read('experiences/a.md'))!)!.status).toBe('active');
  });

  it('stale 但最近有 usage(在 staleDays 内)→ 恢复 active', async () => {
    await storage.write('experiences/a.md', memText({ status: 'stale' }));
    await recordMemoryUsage(storage, {
      at: '2026-02-27T00:00:00.000Z',
      memory_id: 'exp_1',
      action: 'retrieved',
    });

    const report = await runCurator(storage, OPTS);

    expect(report.revived).toEqual(['experiences/a.md']);
    expect(parseMemory((await storage.read('experiences/a.md'))!)!.status).toBe('active');
  });

  it('usage 汇总回写 use_count/helpful_count/last_used_at(不改 version 与 updated_at)', async () => {
    await storage.write('experiences/a.md', memText());
    await recordMemoryUsage(storage, { at: '2026-02-28T00:00:00.000Z', memory_id: 'exp_1', action: 'retrieved' });
    await recordMemoryUsage(storage, { at: '2026-02-28T00:00:00.000Z', memory_id: 'exp_1', action: 'viewed' });
    await recordMemoryUsage(storage, { at: '2026-02-29T00:00:00.000Z', memory_id: 'exp_1', action: 'helpful' });

    const report = await runCurator(storage, OPTS);

    expect(report.usageUpdated).toEqual(['experiences/a.md']);
    const mem = parseMemory((await storage.read('experiences/a.md'))!)!;
    expect(mem.useCount).toBe(2);
    expect(mem.helpfulCount).toBe(1);
    expect(mem.lastUsedAt).toBe('2026-02-29T00:00:00.000Z');
    expect(mem.version).toBe(1);
    expect(mem.updatedAt).toBe(OLD);
  });

  it('dry-run 只计算不写盘', async () => {
    await storage.write('experiences/a.md', memText());

    const report = await runCurator(storage, { ...OPTS, dryRun: true });

    expect(report.stale).toEqual(['experiences/a.md']);
    expect(parseMemory((await storage.read('experiences/a.md'))!)!.status).toBe('active');
  });

  it('被记忆引用的轨迹保留;未被引用且超期的轨迹归档', async () => {
    await storage.write(
      'trajectories/kept.md',
      memText({ id: 'traj_kept', kind: 'trajectory', type: 'trajectories/capture', status: 'active' }),
    );
    await storage.write(
      'trajectories/old.md',
      memText({
        id: 'traj_old',
        kind: 'trajectory',
        type: 'trajectories/capture',
        status: 'active',
        updatedAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    await storage.write(
      'experiences/a.md',
      memText({ status: 'active', updatedAt: NOW.toISOString(), sourceTrajectories: ['traj_kept'] }),
    );

    const report = await runCurator(storage, OPTS);

    expect(await storage.exists('trajectories/kept.md')).toBe(true);
    expect(await storage.exists('trajectories/old.md')).toBe(false);
    expect(await storage.exists('archive/trajectories/old.md')).toBe(true);
    expect(report.archived).toContain('trajectories/old.md');
  });

  it('单项目轨迹数超上限时归档最旧的条目', async () => {
    for (let i = 0; i < 3; i++) {
      await storage.write(
        `trajectories/t${i}.md`,
        memText({
          id: `traj_${i}`,
          kind: 'trajectory',
          type: 'trajectories/capture',
          scope: 'project:trove',
          updatedAt: new Date(Date.parse(OLD) + i * 86400000).toISOString(),
        }),
      );
    }

    await runCurator(storage, { ...OPTS, trajectoryMax: 1 });

    expect(await storage.exists('trajectories/t2.md')).toBe(true);
    expect(await storage.exists('trajectories/t1.md')).toBe(false);
    expect(await storage.exists('trajectories/t0.md')).toBe(false);
  });
});

describe('curator 周期任务(daemon 每周一次)', () => {
  it('7 天内不重复跑,超过 7 天再跑并更新标记', async () => {
    await storage.write('experiences/a.md', memText());

    const first = await maybeRunCurator(storage, OPTS);
    expect(first).not.toBeNull();
    expect(await storage.read('.trove/curator.json')).toContain('lastRunAt');

    const within = await maybeRunCurator(storage, { ...OPTS, now: () => new Date(NOW.getTime() + 3 * 86400000) });
    expect(within).toBeNull();

    const after = await maybeRunCurator(storage, { ...OPTS, now: () => new Date(NOW.getTime() + 8 * 86400000) });
    expect(after).not.toBeNull();
  });
});
