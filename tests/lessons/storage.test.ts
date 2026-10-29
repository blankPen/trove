import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';

describe('StorageAdapter(本地)', () => {
  async function root() {
    return mkdtemp(join(tmpdir(), 'trove-lessons-'));
  }

  it('用例 0-2:写入字符串后读回一致,且磁盘上出现该文件', async () => {
    const r = await root();
    const store = new LocalStorageAdapter(r);
    await store.write('experiences/debug-test.md', 'hello');
    expect(await store.read('experiences/debug-test.md')).toBe('hello');
    expect(await readFile(join(r, 'experiences/debug-test.md'), 'utf8')).toBe('hello');
  });

  it('读取不存在的文件返回 null', async () => {
    const r = await root();
    const store = new LocalStorageAdapter(r);
    expect(await store.read('nope.md')).toBeNull();
    expect(await store.exists('nope.md')).toBe(false);
  });

  it('覆盖写幂等,不存在时 exists 为 false', async () => {
    const r = await root();
    const store = new LocalStorageAdapter(r);
    await store.write('a.md', '第一版');
    await store.write('a.md', '第二版');
    expect(await store.read('a.md')).toBe('第二版');
    expect(await store.exists('a.md')).toBe(true);
  });
});