import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  acquireDaemonPid,
  daemonState,
  isAlive,
  readDaemonStatus,
  releaseDaemonPid,
  runDaemon,
} from '../src/daemon.js';
import { trovePaths } from '../src/paths.js';
import type { SyncReport } from '../src/core/sync.js';

async function base() {
  return trovePaths(await mkdtemp(join(tmpdir(), 'trove-daemon-')));
}

const report = (n: number): SyncReport => ({
  collected: { discovered: n, archived: 1, appended: 0, skipped: 0, outOfWindow: 0, bytesCopied: 10, sessions: 1 },
  pulled: { downloadedChunks: 0, downloadedBytes: 0, downloadedItems: 0, skippedItems: 0 },
  pushed: { uploadedChunks: 1, uploadedBytes: 10, uploadedItems: 1, skippedItems: 0 },
  durationMs: 5,
});

describe('daemon 生命周期', () => {
  it('pid 文件是单实例锁:第二次获取被拒绝,陈旧 pid 可接管', async () => {
    const paths = await base();
    await acquireDaemonPid(paths);
    await expect(acquireDaemonPid(paths)).rejects.toThrow(/已在运行/);
    await releaseDaemonPid(paths);
    expect(existsSync(paths.daemonPid)).toBe(false);

    // 陈旧 pid(不存在的进程)→ 可接管
    const { writeFile } = await import('node:fs/promises');
    await writeFile(paths.daemonPid, JSON.stringify({ pid: 999_999_999, startedAt: 0 }));
    await expect(acquireDaemonPid(paths)).resolves.toBeUndefined();
    await releaseDaemonPid(paths);
  });

  it('isAlive 认得当前进程与不存在的 pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(999_999_999)).toBe(false);
  });

  it('运行一轮后写入状态;abort 后清理 pid,状态标记 running=false', async () => {
    const paths = await base();
    const controller = new AbortController();
    let runs = 0;
    const done = runDaemon(
      {
        paths,
        intervalSeconds: 3600,
        since: '7d',
        runOnce: async (_p, _s) => {
          runs++;
          controller.abort(); // 一轮后立即停
          return report(3);
        },
      },
      controller.signal,
    );
    await done;

    expect(runs).toBe(1);
    expect(existsSync(paths.daemonPid)).toBe(false);
    const status = await readDaemonStatus(paths);
    expect(status).toMatchObject({ running: false, intervalSeconds: 3600, since: '7d' });
    expect(status!.lastResult!.collected.archived).toBe(1);
    const log = await readFile(paths.daemonLog, 'utf8');
    expect(log).toContain('daemon 启动');
    expect(log).toContain('同步完成');
  });

  it('单轮抛错不影响循环:记录 lastError 后继续', async () => {
    const paths = await base();
    const controller = new AbortController();
    let runs = 0;
    await runDaemon(
      {
        paths,
        intervalSeconds: 1,
        since: 'all',
        runOnce: async (_p, _s) => {
          runs++;
          if (runs === 1) throw new Error('远端 502');
          controller.abort();
          return report(1);
        },
      },
      controller.signal,
    );
    const status = await readDaemonStatus(paths);
    expect(runs).toBe(2);
    expect(status!.lastError).toBeUndefined();
    const log = await readFile(paths.daemonLog, 'utf8');
    expect(log).toContain('同步失败: 远端 502');
  });

  it('daemonState 报告未运行', async () => {
    const paths = await base();
    expect(await daemonState(paths)).toEqual({ running: false, status: null });
  });
});
