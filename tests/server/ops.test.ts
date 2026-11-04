import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { trovePaths } from '../../src/paths.js';
import { defaultConfig } from '../../src/config.js';
import { tmpVault } from '../helpers/vault.js';
import type { Progress } from '../../src/progress.js';

/** 运维动作(同步、daemon)的 HTTP 缝。 */
describe('trove web API · 运维', () => {
  let server: RunningServer;
  let base: string;
  let calls: number;
  let daemonRestarts: number;

  beforeEach(async () => {
    base = await tmpVault();
    calls = 0;
    daemonRestarts = 0;
    server = await startServer({
      paths: trovePaths(base),
      config: defaultConfig({ deviceId: 'dev1', deviceName: 'pzdeMac-mini' }),
      remote: null,
      adapters: [],
      port: 0,
      retryDelayMs: 10,
      maxWaitMs: 500,
      runSync: async (progress: Progress) => {
        calls++;
        progress.phase('collect', '正在收集');
        progress.item('a.jsonl', 1, 2, 10);
        if (calls === 1) throw new Error('已有同步在运行 (pid 6012),请等待其结束');
        return {
          collected: { discovered: 1 },
          pulled: { downloadedItems: 0 },
          pushed: { uploadedItems: 0 },
          library: { pulled: { downloaded: 0, bytes: 0, skipped: 0 }, pushed: { uploaded: 0, bytes: 0, skipped: 0 } },
          remoteChanged: false,
          durationMs: 12,
        };
      },
      daemonControl: {
        restart: async () => {
          daemonRestarts++;
          return { pid: 4242, wasRunning: true };
        },
      },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('daemon 状态接口给出运行状态', async () => {
    const res = await fetch(`${server.url}/api/daemon`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('running');
  });

  it('daemon 重启走注入的控制通道', async () => {
    const res = await fetch(`${server.url}/api/daemon/restart`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ pid: 4242, wasRunning: true });
    expect(daemonRestarts).toBe(1);
  });

  it('同步作业经 SSE 推出阶段与进度', async () => {
    const started = await fetch(`${server.url}/api/sync`, { method: 'POST' });
    // 202:已受理,同步在后台跑,进度走 SSE
    expect(started.status).toBe(202);
    const { jobId } = await started.json();

    const res = await fetch(`${server.url}/api/sync/${jobId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: phase');
    expect(text).toContain('event: item');
    expect(text).toContain('event: done');
    expect(text).toContain('正在收集');
  });

  it('撞到同步锁时先报 locked,等锁释放后自动重试一次', async () => {
    const { jobId } = await (await fetch(`${server.url}/api/sync`, { method: 'POST' })).json();
    const text = await (await fetch(`${server.url}/api/sync/${jobId}/events`)).text();
    expect(text).toContain('event: locked');
    expect(text).toContain('6012');
    expect(text).toContain('event: done');
    expect(calls).toBe(2);
  });

  it('同步失败时给出 error 事件', async () => {
    server = await startServer({
      paths: trovePaths(base),
      config: defaultConfig(),
      remote: null,
      adapters: [],
      port: 0,
      runSync: async () => {
        throw new Error('远端不可达');
      },
    });
    const { jobId } = await (await fetch(`${server.url}/api/sync`, { method: 'POST' })).json();
    const text = await (await fetch(`${server.url}/api/sync/${jobId}/events`)).text();
    expect(text).toContain('event: error');
    expect(text).toContain('远端不可达');
  });
});
