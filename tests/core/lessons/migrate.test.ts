import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryLessonsDir } from '../../../src/core/layout.js';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { planMigration, applyMigration, migrateLessons, rollbackMigration } from '../../../src/core/lessons/migrate.js';
import { parseMemory, renderMemory } from '../../../src/core/lessons/memory.js';

let vault: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'lessons-migrate-'));
  storage = new LocalStorageAdapter(libraryLessonsDir(vault));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

const now = new Date('2026-02-01T00:00:00.000Z');

/** 一条 v1 记忆(无 id/kind/status/version)。 */
function v1File(type: string, title: string, body = '旧正文内容'): string {
  return [
    '---',
    `type: ${type}`,
    `title: ${JSON.stringify(title)}`,
    'tags: ["a", "b"]',
    'scope: global',
    'created_at: "2026-01-01T00:00:00.000Z"',
    'updated_at: "2026-01-01T00:00:00.000Z"',
    '---',
    '',
    body,
  ].join('\n');
}

/** 一条已 v2 的记忆(带 id)。 */
function v2File(type: string, title: string): string {
  return renderMemory({
    id: 'exp_00000000000000000000000000',
    kind: 'experience',
    type,
    title,
    tags: ['experiences'],
    scope: 'global',
    status: 'active',
    version: 1,
    evidence: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    useCount: 0,
    helpfulCount: 0,
    body: '已有正文',
  });
}

describe('planMigration', () => {
  it('只列出无 id 的旧记忆;已 v2 计数、非记忆跳过', async () => {
    await storage.write('experiences/old.md', v1File('experiences/debug_pattern', '旧标题'));
    await storage.write('preferences/style.md', v1File('preferences/coding_style', '风格'));
    await storage.write('experiences/v2.md', v2File('experiences/debug_pattern', '已有'));
    await storage.write('archive/x.md', v1File('experiences/gotcha', '归档'));
    await storage.write('audit/s.json', '{}');
    await storage.write('trajectories/t.md', v1File('trajectories/capture', '轨迹'));
    await storage.write('INDEX.md', 'x');
    await storage.write('README.md', 'x');
    await storage.write('memory_diff.json', '{}');

    const plan = await planMigration(storage, () => now);

    expect(plan.items.map((i) => i.path).sort()).toEqual(['experiences/old.md', 'preferences/style.md']);
    expect(plan.alreadyV2).toBe(1);
    expect(plan.skipped).toEqual(expect.arrayContaining(['archive/x.md', 'audit/s.json', 'trajectories/t.md', 'INDEX.md', 'README.md', 'memory_diff.json']));
  });
});

describe('applyMigration', () => {
  it('补 id/kind/status/version,保留正文与 created_at,落迁移标记', async () => {
    await storage.write('experiences/old.md', v1File('experiences/debug_pattern', '旧标题', '旧正文内容'));

    const r = await applyMigration(storage, await planMigration(storage, () => now), { vaultRoot: vault, now: () => now });

    expect(r.migrated).toBe(1);
    expect(r.dryRun).toBe(false);
    expect(r.backupDir).toBeTruthy();

    const mem = parseMemory((await storage.read('experiences/old.md'))!)!;
    expect(mem.id.startsWith('exp_')).toBe(true);
    expect(mem.kind).toBe('experience');
    expect(mem.status).toBe('active');
    expect(mem.version).toBe(1);
    expect(mem.evidence).toEqual([]);
    expect(mem.promptVersion).toBe('legacy');
    expect(mem.body).toBe('旧正文内容');
    expect(mem.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(mem.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(await storage.exists('.trove/migrated-v2.json')).toBe(true);
  });

  it('备份目录存在且 manifest 记录条数与文件清单', async () => {
    await storage.write('experiences/old.md', v1File('experiences/debug_pattern', '旧标题'));

    const r = await applyMigration(storage, await planMigration(storage, () => now), { vaultRoot: vault, now: () => now });

    const manifest = JSON.parse(await readFile(join(r.backupDir!, 'manifest.json'), 'utf8')) as { count: number; files: string[] };
    expect(manifest.count).toBe(1);
    expect(manifest.files).toEqual(['experiences/old.md']);
    // 备份目录里的原文件仍是迁移前内容
    expect(await readFile(join(r.backupDir!, 'experiences/old.md'), 'utf8')).not.toContain('id:');
  });
});

describe('migrateLessons / 幂等 / rollback', () => {
  it('dry-run 不写文件、不备份、不落标记', async () => {
    await storage.write('experiences/old.md', v1File('experiences/debug_pattern', '旧标题'));
    const before = await storage.read('experiences/old.md');

    const r = await migrateLessons(vault, { dryRun: true, now: () => now });

    expect(r.dryRun).toBe(true);
    expect(r.migrated).toBe(1);
    expect(await storage.read('experiences/old.md')).toBe(before);
    expect(await storage.exists('.trove/migrated-v2.json')).toBe(false);
  });

  it('幂等:重复 apply 不重复迁移,已 v2 文件跳过', async () => {
    await storage.write('experiences/old.md', v1File('experiences/debug_pattern', '旧标题'));

    expect((await migrateLessons(vault, { now: () => now })).migrated).toBe(1);
    const plan2 = await planMigration(storage);
    expect(plan2.items).toHaveLength(0);
    expect(plan2.alreadyV2).toBe(1);
    expect((await migrateLessons(vault, { now: () => now })).migrated).toBe(0);
  });

  it('rollback 从备份恢复原文并删除迁移标记;不存在的备份目录报中文错误', async () => {
    await storage.write('experiences/old.md', v1File('experiences/debug_pattern', '旧标题'));
    const before = await storage.read('experiences/old.md');

    const r = await migrateLessons(vault, { now: () => now });
    expect(await storage.read('experiences/old.md')).not.toBe(before);

    const n = await rollbackMigration(vault, r.backupDir!);
    expect(n).toBeGreaterThan(0);
    expect(await storage.read('experiences/old.md')).toBe(before);
    expect(await storage.exists('.trove/migrated-v2.json')).toBe(false);

    await expect(rollbackMigration(vault, join(vault, 'no-such-backup'))).rejects.toThrow(/备份目录不存在/);
  });
});
