import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { readTrust, writeTrust, recordReview, evaluateTrust } from '../../../src/core/lessons/trust.js';
import type { TrustState } from '../../../src/core/lessons/trust.js';

let root: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-trust-'));
  storage = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const now = new Date('2026-02-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function state(partial: Partial<TrustState> = {}): TrustState {
  return {
    level: 0,
    accepted: 0,
    rejected: 0,
    since: new Date(now.getTime() - 20 * DAY).toISOString(),
    updatedAt: new Date(now.getTime() - 20 * DAY).toISOString(),
    ...partial,
  };
}

describe('trust ladder', () => {
  it('文件缺失 → 默认 L0', async () => {
    const s = await readTrust(storage, () => now);
    expect(s).toEqual({ level: 0, accepted: 0, rejected: 0, since: now.toISOString(), updatedAt: now.toISOString() });
  });

  it('损坏的 trust.json 回退默认 L0,不抛', async () => {
    await storage.write('.trove/trust.json', '{ not json');
    const s = await readTrust(storage, () => now);
    expect(s.level).toBe(0);
    expect(s.accepted).toBe(0);
  });

  it('writeTrust → readTrust round-trip', async () => {
    await writeTrust(storage, state({ level: 2, accepted: 40, rejected: 3, lastRejectedAt: 'x' }));
    const s = await readTrust(storage, () => now);
    expect(s.level).toBe(2);
    expect(s.accepted).toBe(40);
    expect(s.rejected).toBe(3);
    expect(s.lastRejectedAt).toBe('x');
  });

  it('L0→L1:accepted>=30 且接受率>=0.8 且距 since>=14 天', async () => {
    const s = evaluateTrust(state({ accepted: 30, rejected: 0 }), now);
    expect(s.level).toBe(1);
    expect(s.since).toBe(now.toISOString());
  });

  it('L0→L1 阈值边界:accepted=29 不升级;接受率 0.75 不升级;13 天不升级', async () => {
    expect(evaluateTrust(state({ accepted: 29, rejected: 0 }), now).level).toBe(0);
    expect(evaluateTrust(state({ accepted: 30, rejected: 10 }), now).level).toBe(0); // 30/40=0.75
    expect(evaluateTrust(state({ accepted: 30, rejected: 0, since: new Date(now.getTime() - 13 * DAY).toISOString() }), now).level).toBe(0);
  });

  it('L0→L1 接受率 0.8 精确达标升级', async () => {
    expect(evaluateTrust(state({ accepted: 32, rejected: 8 }), now).level).toBe(1); // 32/40 = 0.8
  });

  it('L1→L2:距 since>=14 天且最近 14 天无拒绝', async () => {
    const s = evaluateTrust(state({ level: 1, since: new Date(now.getTime() - 20 * DAY).toISOString() }), now);
    expect(s.level).toBe(2);
    expect(s.since).toBe(now.toISOString());
  });

  it('L1 最近 14 天有拒绝 → 不升级', async () => {
    const s = evaluateTrust(state({ level: 1, since: new Date(now.getTime() - 20 * DAY).toISOString(), lastRejectedAt: new Date(now.getTime() - 5 * DAY).toISOString() }), now);
    expect(s.level).toBe(1);
  });

  it('L1 拒绝发生在 14 天前 → 可升级', async () => {
    const s = evaluateTrust(state({ level: 1, since: new Date(now.getTime() - 20 * DAY).toISOString(), lastRejectedAt: new Date(now.getTime() - 20 * DAY).toISOString() }), now);
    expect(s.level).toBe(2);
  });

  it('L2 不自动升级到 L3(只能人工)', async () => {
    const s = evaluateTrust(state({ level: 2, since: new Date(now.getTime() - 40 * DAY).toISOString() }), now);
    expect(s.level).toBe(2);
  });

  it('recordReview accepted 递增并持久化;满 30 且够 14 天自动升级', async () => {
    await writeTrust(storage, state({ accepted: 29, rejected: 0 }));
    const s = await recordReview(storage, 'accepted', () => now);
    expect(s.accepted).toBe(30);
    expect(s.level).toBe(1);
    expect((await readTrust(storage, () => now)).accepted).toBe(30);
  });

  it('recordReview rejected 递增并记录 lastRejectedAt', async () => {
    await writeTrust(storage, state({ accepted: 0, rejected: 0 }));
    const s = await recordReview(storage, 'rejected', () => now);
    expect(s.rejected).toBe(1);
    expect(s.accepted).toBe(0);
    expect(s.lastRejectedAt).toBe(now.toISOString());
  });
});
