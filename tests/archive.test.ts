import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { archiveFile } from '../src/core/archive.js';

async function paths() {
  const dir = await mkdtemp(join(tmpdir(), 'trove-archive-'));
  return { source: join(dir, 'src.jsonl'), target: join(dir, 'vault', 'deep', 'dst.jsonl') };
}

const gen = () => 'g-test';

describe('archiveFile(raw 无损副本)', () => {
  it('无游标 → 全量复制,目标字节与源一致', async () => {
    const { source, target } = await paths();
    await writeFile(source, 'hello');

    const r = await archiveFile({
      sourcePath: source,
      targetPath: target,
      srcStat: { size: 5, mtimeMs: 1000 },
      newGeneration: gen,
    });

    expect(r.action).toBe('new');
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(r.cursor).toMatchObject({ size: 5, mtimeMs: 1000, generation: 'g-test' });
    expect(r.bytesCopied).toBe(5);
  });

  it('size/mtime 未变 → skip,不碰目标文件', async () => {
    const { source, target } = await paths();
    await writeFile(source, 'hello');
    const first = await archiveFile({
      sourcePath: source,
      targetPath: target,
      srcStat: { size: 5, mtimeMs: 1000 },
      newGeneration: gen,
    });
    const before = await stat(target);

    const r = await archiveFile({
      sourcePath: source,
      targetPath: target,
      cursor: first.cursor,
      srcStat: { size: 5, mtimeMs: 1000 },
      newGeneration: gen,
    });

    expect(r.action).toBe('skip');
    expect(r.bytesCopied).toBe(0);
    const after = await stat(target);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('append-only 增长 → 只追加新增字节,世代不变', async () => {
    const { source, target } = await paths();
    await writeFile(source, 'hello');
    const first = await archiveFile({
      sourcePath: source,
      targetPath: target,
      srcStat: { size: 5, mtimeMs: 1000 },
      newGeneration: gen,
    });

    await writeFile(source, 'hello world');
    const r = await archiveFile({
      sourcePath: source,
      targetPath: target,
      cursor: first.cursor,
      srcStat: { size: 11, mtimeMs: 2000 },
      newGeneration: () => 'g-new',
    });

    expect(r.action).toBe('append');
    expect(r.bytesCopied).toBe(6);
    expect(await readFile(target, 'utf8')).toBe('hello world');
    expect(r.cursor.generation).toBe('g-test');
  });

  it('文件被截断重写 → 重置世代并全量覆盖', async () => {
    const { source, target } = await paths();
    await writeFile(source, 'first version');
    const first = await archiveFile({
      sourcePath: source,
      targetPath: target,
      srcStat: { size: 13, mtimeMs: 1000 },
      newGeneration: gen,
    });

    await writeFile(source, 'v2');
    const r = await archiveFile({
      sourcePath: source,
      targetPath: target,
      cursor: first.cursor,
      srcStat: { size: 2, mtimeMs: 2000 },
      newGeneration: () => 'g-v2',
    });

    expect(r.action).toBe('reset');
    expect(await readFile(target, 'utf8')).toBe('v2');
    expect(r.cursor.generation).toBe('g-v2');
  });

  it('size 不变但 mtime 变化(就地改写) → 重置,不混入旧内容', async () => {
    const { source, target } = await paths();
    await writeFile(source, 'aaaa');
    const first = await archiveFile({
      sourcePath: source,
      targetPath: target,
      srcStat: { size: 4, mtimeMs: 1000 },
      newGeneration: gen,
    });

    await writeFile(source, 'bbbb');
    const r = await archiveFile({
      sourcePath: source,
      targetPath: target,
      cursor: first.cursor,
      srcStat: { size: 4, mtimeMs: 2000 },
      newGeneration: () => 'g-b',
    });

    expect(r.action).toBe('reset');
    expect(await readFile(target, 'utf8')).toBe('bbbb');
  });

  it('源文件前缀被改写后又增长 → 必须重置,不能把新尾部接到旧前缀上', async () => {
    const { source, target } = await paths();
    await writeFile(source, 'aaaa');
    const first = await archiveFile({
      sourcePath: source,
      targetPath: target,
      srcStat: { size: 4, mtimeMs: 1000 },
      newGeneration: gen,
    });

    await writeFile(source, 'bbbbcc'); // 前 4 字节变了,size 还增长了
    const r = await archiveFile({
      sourcePath: source,
      targetPath: target,
      cursor: first.cursor,
      srcStat: { size: 6, mtimeMs: 2000 },
      newGeneration: () => 'g-fix',
    });

    expect(r.action).toBe('reset');
    expect(await readFile(target, 'utf8')).toBe('bbbbcc');
  });

  it('本地归档被外部改写 → 前缀哈希不匹配,重置', async () => {
    const { source, target } = await paths();
    await writeFile(source, 'hello');
    const first = await archiveFile({
      sourcePath: source,
      targetPath: target,
      srcStat: { size: 5, mtimeMs: 1000 },
      newGeneration: gen,
    });

    await writeFile(target, 'HELLO');
    await writeFile(source, 'hello world');
    const r = await archiveFile({
      sourcePath: source,
      targetPath: target,
      cursor: first.cursor,
      srcStat: { size: 11, mtimeMs: 2000 },
      newGeneration: () => 'g-fix',
    });

    expect(r.action).toBe('reset');
    expect(await readFile(target, 'utf8')).toBe('hello world');
  });
});
