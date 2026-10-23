import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  libraryDir,
  libraryIndexDir,
  libraryLessonsDir,
  librarySessionsDir,
  librarySkillsDir,
  migrateLegacyLayout,
  rawDeviceDir,
  rawFilePath,
} from '../src/core/layout.js';

async function tmp(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('vault 布局', () => {
  it('raw 与 library 的路径约定', async () => {
    const vault = await tmp('trove-layout-');
    expect(rawDeviceDir(vault, 'dev1')).toBe(join(vault, 'raw/dev1'));
    expect(rawFilePath(vault, 'dev1', 'claude-code', 'projects/a.jsonl')).toBe(
      join(vault, 'raw/dev1/claude-code/projects/a.jsonl'),
    );
    expect(libraryDir(vault)).toBe(join(vault, 'library'));
    expect(librarySessionsDir(vault)).toBe(join(vault, 'library/sessions'));
    expect(libraryIndexDir(vault)).toBe(join(vault, 'library/index'));
    expect(librarySkillsDir(vault)).toBe(join(vault, 'library/skills'));
    expect(libraryLessonsDir(vault)).toBe(join(vault, 'library/lessons'));
  });

  it('旧的 devices/ 会迁移成 raw/,已迁移则不动', async () => {
    const vault = await tmp('trove-layout-');
    await mkdir(join(vault, 'devices/dev1/claude-code/projects'), { recursive: true });
    await writeFile(join(vault, 'devices/dev1/claude-code/projects/a.jsonl'), 'aaa');

    expect(await migrateLegacyLayout(vault)).toBe('renamed');
    expect(await readFile(join(vault, 'raw/dev1/claude-code/projects/a.jsonl'), 'utf8')).toBe('aaa');
    expect(await migrateLegacyLayout(vault)).toBe('none');
  });

  it('devices/ 与 raw/ 同时存在时拒绝迁移,避免静默合并', async () => {
    const vault = await tmp('trove-layout-');
    await mkdir(join(vault, 'devices/dev1'), { recursive: true });
    await mkdir(join(vault, 'raw/dev1'), { recursive: true });
    await expect(migrateLegacyLayout(vault)).rejects.toThrow(/同时存在/);
  });
});
