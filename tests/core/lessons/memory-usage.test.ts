import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import {
  readMemoryUsage,
  recordMemoryUsage,
  summarizeMemoryUsage,
} from '../../../src/core/lessons/memory-usage.js';

let dir: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trove-usage-'));
  storage = new LocalStorageAdapter(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('记忆使用事件(.trove/usage.jsonl)', () => {
  it('追加写:每次调用多一行 JSON,读取按原序返回', async () => {
    await recordMemoryUsage(storage, { at: '2026-01-01T00:00:00.000Z', memory_id: 'exp_1', action: 'retrieved', query: '签名' });
    await recordMemoryUsage(storage, { at: '2026-01-02T00:00:00.000Z', memory_id: 'exp_1', action: 'viewed' });

    const raw = await storage.read('.trove/usage.jsonl');
    expect(raw!.trim().split('\n')).toHaveLength(2);

    const events = await readMemoryUsage(storage);
    expect(events.map((e) => e.action)).toEqual(['retrieved', 'viewed']);
    expect(events[0]!.query).toBe('签名');
    expect(events[1]!.memory_id).toBe('exp_1');
  });

  it('按 memoryId 过滤', async () => {
    await recordMemoryUsage(storage, { at: '2026-01-01T00:00:00.000Z', memory_id: 'exp_1', action: 'retrieved' });
    await recordMemoryUsage(storage, { at: '2026-01-01T00:00:00.000Z', memory_id: 'exp_2', action: 'retrieved' });

    const events = await readMemoryUsage(storage, { memoryId: 'exp_2' });
    expect(events).toHaveLength(1);
    expect(events[0]!.memory_id).toBe('exp_2');
  });

  it('损坏行与非法记录跳过,不抛错', async () => {
    await storage.write('.trove/usage.jsonl', [
      '{"at":"2026-01-01T00:00:00.000Z","memory_id":"exp_1","action":"retrieved"}',
      '这一行不是 JSON',
      '{"at":"2026-01-01T00:00:00.000Z","memory_id":"exp_2","action":"unknown_action"}',
      '{"at":"2026-01-01T00:00:00.000Z","action":"retrieved"}',
      '',
    ].join('\n'));

    const events = await readMemoryUsage(storage);
    expect(events).toHaveLength(1);
    expect(events[0]!.memory_id).toBe('exp_1');
  });

  it('文件不存在时返回空数组', async () => {
    expect(await readMemoryUsage(storage)).toEqual([]);
  });

  it('汇总:按动作计数,lastUsedAt 取最新', () => {
    const map = summarizeMemoryUsage([
      { at: '2026-01-01T00:00:00.000Z', memory_id: 'exp_1', action: 'retrieved' },
      { at: '2026-01-03T00:00:00.000Z', memory_id: 'exp_1', action: 'viewed' },
      { at: '2026-01-02T00:00:00.000Z', memory_id: 'exp_1', action: 'helpful' },
      { at: '2026-01-04T00:00:00.000Z', memory_id: 'exp_2', action: 'harmful' },
    ]);

    expect(map.get('exp_1')).toEqual({
      retrieved: 1,
      viewed: 1,
      applied: 0,
      helpful: 1,
      harmful: 0,
      lastUsedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(map.get('exp_2')!.harmful).toBe(1);
    expect(map.get('exp_2')!.lastUsedAt).toBe('2026-01-04T00:00:00.000Z');
  });
});
