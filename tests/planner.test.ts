import { describe, it, expect } from 'vitest';
import { plan } from '../src/core/planner.js';
import type { Fingerprint, Manifest } from '../src/core/types.js';

function fp(over: Partial<Fingerprint> = {}): Fingerprint {
  return { size: 1000, mtime: 1_000_000, headHash: 'abc', ...over };
}

describe('planner(纯函数,阶段 1:skip/full)', () => {
  it('manifest 无记录 → full,新文件', () => {
    const items = plan([{ path: 'a.jsonl', fingerprint: fp() }], {});
    expect(items).toEqual([{ path: 'a.jsonl', action: 'full', reason: 'new' }]);
  });

  it('size 与 headHash 都一致 → skip', () => {
    const manifest: Manifest = {
      'a.jsonl': { path: 'a.jsonl', fingerprint: fp(), syncedSize: 1000, syncedAt: 1 },
    };
    const items = plan([{ path: 'a.jsonl', fingerprint: fp() }], manifest);
    expect(items).toEqual([{ path: 'a.jsonl', action: 'skip', reason: 'unchanged' }]);
  });

  it('mtime 变化但 size/headHash 不变 → 仍 skip(不重传)', () => {
    const manifest: Manifest = {
      'a.jsonl': { path: 'a.jsonl', fingerprint: fp({ mtime: 999 }), syncedSize: 1000, syncedAt: 1 },
    };
    const items = plan([{ path: 'a.jsonl', fingerprint: fp({ mtime: 2_000_000 }) }], manifest);
    expect(items[0]!.action).toBe('skip');
  });

  it('headHash 变化 → full(指纹失效)', () => {
    const manifest: Manifest = {
      'a.jsonl': { path: 'a.jsonl', fingerprint: fp({ headHash: 'old' }), syncedSize: 1000, syncedAt: 1 },
    };
    const items = plan([{ path: 'a.jsonl', fingerprint: fp({ headHash: 'new' }) }], manifest);
    expect(items).toEqual([{ path: 'a.jsonl', action: 'full', reason: 'changed' }]);
  });

  it('size 变化(增长)但 headHash 未变 → 阶段 1 退化为 full', () => {
    const manifest: Manifest = {
      'a.jsonl': { path: 'a.jsonl', fingerprint: fp({ size: 1000 }), syncedSize: 1000, syncedAt: 1 },
    };
    const items = plan([{ path: 'a.jsonl', fingerprint: fp({ size: 1500 }) }], manifest);
    expect(items).toEqual([{ path: 'a.jsonl', action: 'full', reason: 'changed' }]);
  });

  it('size 变小 → full', () => {
    const manifest: Manifest = {
      'a.jsonl': { path: 'a.jsonl', fingerprint: fp({ size: 1500 }), syncedSize: 1500, syncedAt: 1 },
    };
    const items = plan([{ path: 'a.jsonl', fingerprint: fp({ size: 500 }) }], manifest);
    expect(items).toEqual([{ path: 'a.jsonl', action: 'full', reason: 'changed' }]);
  });

  it('多文件混合决策,每个文件独立判定', () => {
    const manifest: Manifest = {
      'same.jsonl': { path: 'same.jsonl', fingerprint: fp({ size: 100 }), syncedSize: 100, syncedAt: 1 },
      'changed.jsonl': { path: 'changed.jsonl', fingerprint: fp({ size: 100 }), syncedSize: 100, syncedAt: 1 },
    };
    const items = plan(
      [
        { path: 'same.jsonl', fingerprint: fp({ size: 100 }) },
        { path: 'changed.jsonl', fingerprint: fp({ size: 200 }) },
        { path: 'brand-new.jsonl', fingerprint: fp() },
      ],
      manifest,
    );
    expect(items).toEqual([
      { path: 'same.jsonl', action: 'skip', reason: 'unchanged' },
      { path: 'changed.jsonl', action: 'full', reason: 'changed' },
      { path: 'brand-new.jsonl', action: 'full', reason: 'new' },
    ]);
  });

  it('manifest 里已不在扫描列表的文件不产生任何操作(只增不删)', () => {
    const manifest: Manifest = {
      'gone.jsonl': { path: 'gone.jsonl', fingerprint: fp(), syncedSize: 1000, syncedAt: 1 },
    };
    const items = plan([], manifest);
    expect(items).toEqual([]);
  });
});
