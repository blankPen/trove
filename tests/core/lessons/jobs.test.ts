import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue, LEARN_PIPELINE_VERSION } from '../../../src/core/lessons/jobs.js';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lessons-jobs-'));
  dbPath = join(dir, 'learn.db');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function open(maxAttempts?: number): JobQueue {
  return JobQueue.open(dbPath, maxAttempts);
}

describe('JobQueue 作业库', () => {
  it('enqueue 幂等:同一 (sessionKey, contentHash, pipelineVersion) 只入队一次', () => {
    const q = open();
    expect(q.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h1' }])).toBe(1);
    expect(q.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h1' }])).toBe(0);
    expect(q.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h1' }])).toBe(0);
    expect(q.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h2' }])).toBe(1);
    expect(q.enqueue([{ sessionKey: 'claude-code:s-2', contentHash: 'h1' }])).toBe(1);
    expect(q.stats().queued).toBe(3);
    q.close();
  });

  it('enqueue 生成的 id 形如 job_ + 32 位十六进制', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'b' }]);
    const job = q.lease('w', 1000, 0);
    expect(job!.id).toMatch(/^job_[0-9a-f]{32}$/);
    expect(job!.pipelineVersion).toBe(LEARN_PIPELINE_VERSION);
    q.close();
  });

  it('lease 按优先级再按创建时间,原子领取不重复', () => {
    const q = open();
    q.enqueue([
      { sessionKey: 'low-old', contentHash: 'h', priority: 0 },
      { sessionKey: 'high', contentHash: 'h2', priority: 1 },
    ], 1000);
    const first = q.lease('w1', 1000, 1000);
    expect(first!.sessionKey).toBe('high');
    const second = q.lease('w1', 1000, 1000);
    expect(second!.sessionKey).toBe('low-old');
    expect(second!.id).not.toBe(first!.id);
    expect(q.lease('w1', 1000, 1000)).toBeNull();
    q.close();
  });

  it('lease 置 running、attempts+1、租约到期时间;retry_wait 到期前不可领', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    const job = q.lease('w', 100, 1000);
    expect(job).toMatchObject({ state: 'running', attempts: 1, leaseOwner: 'w', leaseExpiresAt: 1100 });

    // 失败一次 → retry_wait,退避 30s(30s * 2^0)+jitter[0,1s)
    const failed = q.fail(job!.id, { class: 'network', message: '超时' }, 1100);
    expect(failed.state).toBe('retry_wait');
    expect(failed.attempts).toBe(1);
    expect(failed.nextRunAt!).toBeGreaterThanOrEqual(1100 + 30000);
    expect(failed.nextRunAt!).toBeLessThan(1100 + 30000 + 1000);

    // 未到 nextRunAt 不可领
    expect(q.lease('w', 1000, 1100 + 30000 - 1)).toBeNull();
    // 到期可领,attempts 再次 +1
    const again = q.lease('w', 1000, failed.nextRunAt!);
    expect(again).not.toBeNull();
    expect(again!.attempts).toBe(2);
    q.close();
  });

  it('心跳延长租约;过期租约被 requeueExpired 重领', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    const job = q.lease('w', 100, 1000)!;
    q.heartbeat(job.id, 'w', 100, 1050);
    expect(q.get(job.id)!.leaseExpiresAt).toBe(1150);

    // 到期未心跳 → requeue 回 queued,新租约可领
    expect(q.requeueExpired(1200)).toBe(1);
    expect(q.get(job.id)!.state).toBe('queued');
    const again = q.lease('w2', 100, 1200);
    expect(again!.id).toBe(job.id);
    expect(again!.attempts).toBe(2);
    q.close();
  });

  it('complete/skip 落终态并清租约', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }, { sessionKey: 'b', contentHash: 'h2' }], 1000);
    const j1 = q.lease('w', 1000, 1000)!;
    q.complete(j1.id, 1100);
    expect(q.get(j1.id)).toMatchObject({ state: 'done', leaseOwner: null, leaseExpiresAt: null });

    const j2 = q.lease('w', 1000, 1000)!;
    q.skip(j2.id, 'trivial', 1100);
    expect(q.get(j2.id)).toMatchObject({ state: 'skipped', lastError: 'trivial' });
    q.close();
  });

  it('fail:config/disk 直接 dead;其它错误超 maxAttempts 后 dead', () => {
    const q = open(2); // maxAttempts=2
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    const j = q.lease('w', 1000, 1000)!;

    const dead = q.fail(j.id, { class: 'config', message: '缺少 LLM 配置' }, 1100);
    expect(dead).toMatchObject({ state: 'dead', errorClass: 'config' });
    q.close();
  });

  it('fail:网络错误退避,attempts 达 maxAttempts 后 dead', () => {
    const q = open(2);
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    const j1 = q.lease('w', 1000, 1000)!;
    const f1 = q.fail(j1.id, { class: 'network', message: 'x' }, 1100);
    expect(f1.state).toBe('retry_wait');

    const j2 = q.lease('w', 1000, f1.nextRunAt!)!;
    expect(j2.attempts).toBe(2);
    const f2 = q.fail(j2.id, { class: 'network', message: 'x' }, f1.nextRunAt!);
    expect(f2.state).toBe('dead');
    expect(f2.errorClass).toBe('network');
    q.close();
  });

  it('retry 把 dead 重置为 queued,attempts=0;非 dead 返回 false', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    const j = q.lease('w', 1000, 1000)!;
    q.fail(j.id, { class: 'config', message: 'x' }, 1100);

    expect(q.retry('不存在的 id')).toBe(false);
    expect(q.retry(j.id)).toBe(true);
    const after = q.get(j.id)!;
    expect(after).toMatchObject({ state: 'queued', attempts: 0, lastError: null, errorClass: null, nextRunAt: null });
    expect(q.retry(j.id)).toBe(false); // 已是 queued,不是 dead
    q.close();
  });

  it('stats 统计各状态计数、最老排队与 p50/p95', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }, { sessionKey: 'b', contentHash: 'h2' }], 1000);
    const j1 = q.lease('w', 1000, 1000)!;
    q.lease('w', 1000, 1000);

    q.complete(j1.id, 2000); // 耗时 1000ms
    const s = q.stats();
    expect(s).toMatchObject({ queued: 0, running: 1, done: 1, skipped: 0, dead: 0, retryWait: 0 });
    expect(s.p50Ms).toBe(1000);
    expect(s.p95Ms).toBe(1000);
    expect(s.oldestQueuedAt).toBeNull();
    q.close();
  });

  it('setCheckpoint 保存并读回 checkpoint', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    const j = q.lease('w', 1000, 1000)!;
    q.setCheckpoint(j.id, JSON.stringify({ stage: 'written', diff: { x: 1 } }));
    expect(JSON.parse(q.get(j.id)!.checkpoint!)).toEqual({ stage: 'written', diff: { x: 1 } });
    q.close();
  });

  it('打开即启用 WAL(生成 -wal/-shm 文件)', () => {
    const q = open();
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }]);
    // WAL 模式下写操作产生 -wal 或 -shm 文件
    expect(existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)).toBe(true);
    q.close();
  });

  it('损坏 db 打开报中文错误', async () => {
    await writeFile(dbPath, '这不是一个 sqlite 数据库', 'utf8');
    expect(() => open()).toThrow(/无法打开|损坏/);
  });
});
