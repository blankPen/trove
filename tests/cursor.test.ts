import { describe, it, expect } from 'vitest';
import { decideFileAction, type FileCursor } from '../src/core/cursor.js';

/** 构造一个游标;默认代表"已归档 100 字节,前缀哈希 h100"。 */
const cursor = (o: Partial<FileCursor> = {}): FileCursor => ({
  size: 100,
  mtimeMs: 1000,
  prefixHash: 'h100',
  generation: 'g1',
  ...o,
});

const stat = (size: number, mtimeMs: number) => ({ size, mtimeMs });

describe('decideFileAction(size/mtime + 前缀哈希)', () => {
  it('size 与 mtime 都未变 → skip', () => {
    expect(decideFileAction(cursor(), stat(100, 1000), 'h100')).toBe('skip');
  });

  it('本地归档缺失(哈希为 null)即使 size/mtime 未变也 → reset', () => {
    expect(decideFileAction(cursor(), stat(100, 1000), null)).toBe('reset');
  });

  it('无游标 → new', () => {
    expect(decideFileAction(undefined, stat(100, 1000), null)).toBe('new');
  });

  it('size 增长且本地归档前缀哈希一致 → append', () => {
    expect(decideFileAction(cursor(), stat(180, 2000), 'h100')).toBe('append');
  });

  it('size 回退(文件被截断/重建) → reset', () => {
    expect(decideFileAction(cursor(), stat(40, 2000), 'h40')).toBe('reset');
  });

  it('size 相同但 mtime 变化(就地改写) → reset', () => {
    expect(decideFileAction(cursor(), stat(100, 2000), 'h100')).toBe('reset');
  });

  it('size 增长但本地归档前缀哈希不一致(归档缺失或被改写) → reset', () => {
    expect(decideFileAction(cursor(), stat(180, 2000), 'other')).toBe('reset');
  });

  it('本地归档缺失(哈希为 null)且 size 增长 → reset', () => {
    expect(decideFileAction(cursor(), stat(180, 2000), null)).toBe('reset');
  });
});
