import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { acquireLock, isProcessAlive } from '../src/core/lock.js';

describe('跨进程同步锁', () => {
  it('同一把锁只能被一个进程持有;释放后可再次获取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trove-lock-'));
    const path = join(dir, 'sync.lock');
    const release = await acquireLock(path);
    await expect(acquireLock(path)).rejects.toThrow(/已有同步/);
    await release();
    const again = await acquireLock(path);
    await again();
  });

  it('陈旧 pid 自动接管', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trove-lock-'));
    const path = join(dir, 'sync.lock');
    await writeFile(path, JSON.stringify({ pid: 999_999_999, startedAt: 0 }));
    const release = await acquireLock(path);
    const content = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
    expect(content.pid).toBe(process.pid);
    await release();
  });

  it('isProcessAlive 识别当前进程', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999_999_999)).toBe(false);
  });
});
