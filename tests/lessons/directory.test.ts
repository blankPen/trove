import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { ensureLessonsLayout } from '../../src/core/lessons/layout.js';

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string, rel: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) await rec(join(dir, e.name), r);
    }
  }
  await rec(root, '');
  return out.sort();
}

describe('lessons 目录骨架', () => {
  it('用例 1-1:空 vault 初始化出 0.2 全部目录 + INDEX.md + .overview.md,无多余文件', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-lessons-dir-'));
    await ensureLessonsLayout(vault);

    const root = join(vault, 'library/lessons');
    const entries = await walk(root);
    expect(entries).toEqual([
      '.overview.md',
      'INDEX.md',
      'archive',
      'archive/entities',
      'archive/events',
      'archive/experiences',
      'archive/preferences',
      'archive/resources',
      'entities',
      'entities/organizations',
      'entities/people',
      'entities/projects',
      'entities/tech',
      'entities/tools',
      'events',
      'experiences',
      'preferences',
      'resources',
      'resources/docs',
      'resources/links',
      'resources/repos',
    ]);

    const index = await readFile(join(root, 'INDEX.md'), 'utf8');
    for (const h of ['Preferences', 'Entities', 'Experiences', 'Events', 'Resources']) {
      expect(index).toContain(h);
    }
    const overview = await readFile(join(root, '.overview.md'), 'utf8');
    expect(overview.length).toBeLessThanOrEqual(4000);
  });

  it('用例 1-2:重复初始化幂等,不破坏已有文件', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-lessons-dir-'));
    await ensureLessonsLayout(vault);
    await ensureLessonsLayout(vault);
    const root = join(vault, 'library/lessons');
    expect(await walk(root)).toHaveLength(21);
  });
});