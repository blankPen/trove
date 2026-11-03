import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  restartDaemon,
  runDaemon,
  stopDaemon,
} from '../../src/daemon.js';
import { trovePaths, type TrovePaths } from '../../src/paths.js';
import type { SyncReport } from '../../src/core/sync.js';

async function base() {
  return trovePaths(await mkdtemp(join(tmpdir(), 'trove-daemon-')));
}

const report = (n: number): SyncReport => ({
  collected: { discovered: n, archived: 1, appended: 0, skipped: 0, outOfWindow: 0, bytesCopied: 10, sessions: 1, changedSessions: [] },
  pulled: { downloadedChunks: 0, downloadedBytes: 0, downloadedItems: 0, skippedItems: 0 },
  pushed: { uploadedChunks: 1, uploadedBytes: 10, uploadedItems: 1, skippedItems: 0 },
  library: { pulled: { downloaded: 0, bytes: 0, skipped: 0 }, pushed: { uploaded: 0, bytes: 0, skipped: 0 } },
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

  it('同步成功后触发 afterSync,其返回的日志行写入 daemon 日志(用例 9-3)', async () => {
    const paths = await base();
    const controller = new AbortController();
    let synced = false;
    await runDaemon(
      {
        paths,
        intervalSeconds: 3600,
        since: '7d',
        runOnce: async (_p, _s) => {
          controller.abort();
          return report(3);
        },
        afterSync: async () => {
          synced = true;
          return '经验提取:新增 2 · 跳过 0 · 失败 0';
        },
      },
      controller.signal,
    );
    expect(synced).toBe(true);
    const log = await readFile(paths.daemonLog, 'utf8');
    expect(log).toContain('经验提取:新增 2 · 跳过 0 · 失败 0');
  });

  it('afterSync 抛错只记日志,不污染 lastError 也不中断循环', async () => {
    const paths = await base();
    const controller = new AbortController();
    await runDaemon(
      {
        paths,
        intervalSeconds: 3600,
        since: '7d',
        runOnce: async (_p, _s) => {
          controller.abort();
          return report(1);
        },
        afterSync: async () => {
          throw new Error('LLM 配置缺失');
        },
      },
      controller.signal,
    );
    const status = await readDaemonStatus(paths);
    expect(status!.lastError).toBeUndefined();
    const log = await readFile(paths.daemonLog, 'utf8');
    expect(log).toContain('同步后处理失败: LLM 配置缺失');
  });

  it('learnTick 提供时启用独立 learn 循环,串行 tick,abort 后清理', async () => {
    const paths = await base();
    const controller = new AbortController();
    let syncs = 0;
    let ticks = 0;
    await runDaemon(
      {
        paths,
        intervalSeconds: 3600,
        since: '7d',
        runOnce: async (_p, _s) => {
          syncs++;
          return report(1);
        },
        learnTick: async () => {
          ticks++;
          if (ticks >= 2) controller.abort();
          return `经验提取 tick ${ticks}`;
        },
        learnIntervalSeconds: 1,
      },
      controller.signal,
    );
    expect(syncs).toBe(1);
    expect(ticks).toBe(2); // 串行:上一 tick 完成后才轮到下一 tick
    expect(existsSync(paths.daemonPid)).toBe(false);
    const log = await readFile(paths.daemonLog, 'utf8');
    expect(log).toContain('经验提取 tick 2');
  });
});

describe('daemon restart', () => {
  /** 假 daemon 入口:写 pid 文件后常驻,收到 SIGTERM 就退出。 */
  function fakeDaemonEntry(paths: TrovePaths): string {
    return `
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(paths.daemonPid)}, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;
  }

  it('停止旧进程后拉起新进程,pid 变化', async () => {
    const paths = await base();
    const entry = join(await mkdtemp(join(tmpdir(), 'trove-entry-')), 'daemon.mjs');
    await writeFile(entry, fakeDaemonEntry(paths));

    const first = await restartDaemon({ paths, intervalSeconds: 60, since: '7d', entry });
    expect(first.wasRunning).toBe(false);

    const second = await restartDaemon({ paths, intervalSeconds: 60, since: '7d', entry });
    expect(second.wasRunning).toBe(true);
    expect(second.pid).not.toBe(first.pid);
    expect(isAlive(second.pid)).toBe(true);

    await stopDaemon(paths);
  }, 20_000);

  it('旧进程未停干净时不会起第二个实例', async () => {
    const paths = await base();
    const entry = join(await mkdtemp(join(tmpdir(), 'trove-entry-')), 'daemon.mjs');
    await writeFile(entry, fakeDaemonEntry(paths));

    await restartDaemon({ paths, intervalSeconds: 60, since: '7d', entry });
    // stop 谎报成功但进程仍在 → start 应因 pid 锁报错
    await expect(
      restartDaemon({
        paths,
        intervalSeconds: 60,
        since: '7d',
        entry,
        stop: async () => true,
      }),
    ).rejects.toThrow(/已在运行/);

    await stopDaemon(paths);
  }, 20_000);
});
