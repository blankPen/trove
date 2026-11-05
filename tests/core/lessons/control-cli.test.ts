import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../../src/cli.js';
import { trovePaths } from '../../../src/paths.js';
import { libraryLessonsDir } from '../../../src/core/layout.js';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { renderMemory, parseMemory } from '../../../src/core/lessons/memory.js';
import type { MemoryV2 } from '../../../src/core/lessons/memory.js';

let base: string;
let storage: LocalStorageAdapter;
let lines: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'trove-control-'));
  storage = new LocalStorageAdapter(libraryLessonsDir(trovePaths(base).vault));
  lines = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<number> {
  return run(args, {
    base,
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
  });
}

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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    useCount: 0,
    helpfulCount: 0,
    body: '正文内容',
    ...over,
  });
}

describe('trove lessons pin/unpin', () => {
  it('pin 按 id 找到记忆并写入 pinned', async () => {
    await storage.write('experiences/a.md', memText());

    expect(await cli(['lessons', 'pin', 'exp_1'])).toBe(0);
    expect(lines.join('\n')).toContain('已固定');
    expect(lines.join('\n')).toContain('experiences/a.md');
    expect(parseMemory((await storage.read('experiences/a.md'))!)!.pinned).toBe(true);
  });

  it('unpin 清除 pinned', async () => {
    await storage.write('experiences/a.md', memText({ pinned: true }));

    expect(await cli(['lessons', 'unpin', 'exp_1'])).toBe(0);
    expect(lines.join('\n')).toContain('已取消固定');
    expect(parseMemory((await storage.read('experiences/a.md'))!)!.pinned).toBe(false);
  });

  it('找不到时给中文提示', async () => {
    expect(await cli(['lessons', 'pin', 'exp_missing'])).toBe(0);
    expect(lines.join('\n')).toContain('没有找到记忆');
  });
});

describe('trove lessons forget/restore', () => {
  it('forget 把文件移到 .trove/forgotten/<ISO>/,内容保留,INDEX 行删除', async () => {
    await storage.write('experiences/a.md', memText());
    await storage.write(
      'INDEX.md',
      '# INDEX\n\n## Experiences\n\n- 脚本退出应该用 set -e — 正文内容 (experiences/a.md) · tags: experiences\n',
    );

    expect(await cli(['lessons', 'forget', 'exp_1'])).toBe(0);
    expect(lines.join('\n')).toContain('已忘掉');
    expect(await storage.exists('experiences/a.md')).toBe(false);
    expect(await storage.read('INDEX.md')).not.toContain('(experiences/a.md)');

    const dirs = await storage.list('.trove/forgotten');
    expect(dirs).toHaveLength(1);
    const kept = await storage.read(dirs[0]!);
    expect(kept).toContain('正文内容');
  });

  it('restore 从 archive/ 恢复到原路径,status 变 active 并补 INDEX 行', async () => {
    await storage.write('archive/experiences/a.md', memText({ status: 'archived' }));
    await storage.write('INDEX.md', '# INDEX\n\n## Experiences\n\n');

    expect(await cli(['lessons', 'restore', 'experiences/a.md'])).toBe(0);
    expect(lines.join('\n')).toContain('已恢复');
    const mem = parseMemory((await storage.read('experiences/a.md'))!)!;
    expect(mem.status).toBe('active');
    expect(await storage.read('INDEX.md')).toContain('(experiences/a.md)');
  });

  it('restore --from 可从忘掉目录恢复', async () => {
    await storage.write('experiences/a.md', memText());
    await cli(['lessons', 'forget', 'exp_1']);
    lines.length = 0;

    const dirs = await storage.list('.trove/forgotten');
    const isoDir = dirs[0]!.split('/')[2]!; // .trove/forgotten/<ISO>/<path>
    expect(await cli(['lessons', 'restore', 'exp_1', '--from', `.trove/forgotten/${isoDir}`])).toBe(0);
    expect(lines.join('\n')).toContain('已恢复');
    expect(await storage.exists('experiences/a.md')).toBe(true);
  });
});

describe('trove learn curator 与 status', () => {
  it('curator --dry-run 打印统计且不写盘', async () => {
    await storage.write('experiences/a.md', memText({ updatedAt: '2020-01-01T00:00:00.000Z' }));

    expect(await cli(['learn', 'curator', '--dry-run'])).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('stale');
    expect(output).toContain('experiences/a.md');
    expect(parseMemory((await storage.read('experiences/a.md'))!)!.status).toBe('active');
  });

  it('curator 实跑把过期记忆标 stale', async () => {
    await storage.write('experiences/a.md', memText({ updatedAt: '2020-01-01T00:00:00.000Z' }));

    expect(await cli(['learn', 'curator'])).toBe(0);
    expect(parseMemory((await storage.read('experiences/a.md'))!)!.status).toBe('stale');
  });

  it('learn status 统计 stale 记忆数', async () => {
    await storage.write('experiences/a.md', memText({ status: 'stale' }));

    expect(await cli(['learn', 'status', '--json'])).toBe(0);
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.staleMemories).toBe(1);
  });
});
