import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  emptyState,
  loadState,
  saveState,
  sourceBucket,
  pushedBucket,
  pulledBucket,
} from '../../src/core/state.js';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'trove-state-'));
}

describe('state(单文件、原子落盘)', () => {
  it('文件不存在 → 空状态', async () => {
    const dir = await tmp();
    await expect(loadState(join(dir, 'state.json'))).resolves.toEqual(emptyState());
  });

  it('保存后可完整读回', async () => {
    const dir = await tmp();
    const p = join(dir, 'nested', 'state.json');
    const state = emptyState();
    state.sources['claude-code'] = {
      'projects/a.jsonl': {
        size: 10,
        mtimeMs: 1000,
        prefixHash: 'h',
        generation: 'g1',
        sessionKey: 'projects/a.jsonl',
        sessionMtimeMs: 1000,
      },
    };
    state.pushed['claude-code'] = {
      'projects/a.jsonl': { generation: 'g1', size: 10, chunks: [], chunksHash: 'm' },
    };
    state.pulled['dev-b'] = {
      'codex:abc': { generation: 'g1', size: 10, chunksHash: 'm' },
    };
    await saveState(p, state);
    await expect(loadState(p)).resolves.toEqual(state);
    // 原子写:落盘后目录内无 .state.tmp- 残留
    expect((await readdir(dirname(p))).filter((n) => n.startsWith('.state.tmp-'))).toEqual([]);
  });

  it('JSON 损坏 → 抛带路径的错误', async () => {
    const dir = await tmp();
    const p = join(dir, 'state.json');
    await writeFile(p, '{oops');
    await expect(loadState(p)).rejects.toThrow(/state.*损坏|无法解析/);
  });

  it('旧版本状态也可读(向前兼容由调用方补字段)', async () => {
    const dir = await tmp();
    const p = join(dir, 'state.json');
    await writeFile(p, JSON.stringify({ v: 1 }));
    const s = await loadState(p);
    expect(s.sources).toEqual({});
    expect(s.pushed).toEqual({});
    expect(s.pulled).toEqual({});
    expect(existsSync(p)).toBe(true);
  });
});

describe('state 桶助手(??= 惰性创建、引用稳定、按 key 隔离)', () => {
  it('sourceBucket 首次取即创建,重复取返回同一引用', () => {
    const s = emptyState();
    const first = sourceBucket(s, 'claude-code');
    expect(first).toEqual({});
    expect(sourceBucket(s, 'claude-code')).toBe(first);
    expect(s.sources['claude-code']).toBe(first);
  });

  it('pushedBucket 按 harness 隔离', () => {
    const s = emptyState();
    const a = pushedBucket(s, 'codex');
    const b = pushedBucket(s, 'doubao');
    expect(a).not.toBe(b);
    expect(s.pushed['codex']).toBe(a);
  });

  it('pulledBucket 按 deviceId 隔离', () => {
    const s = emptyState();
    const a = pulledBucket(s, 'dev1');
    const b = pulledBucket(s, 'dev2');
    expect(a).not.toBe(b);
    expect(s.pulled['dev1']).toBe(a);
  });
});
