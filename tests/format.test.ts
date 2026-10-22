import { describe, it, expect } from 'vitest';
import { humanSize } from '../src/format.js';

describe('humanSize(设计 §10.4 友好展示)', () => {
  it('字节级别不带单位', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(499)).toBe('499 B');
    expect(humanSize(1023)).toBe('1023 B');
  });

  it('KB/MB/GB 分级', () => {
    expect(humanSize(1024)).toBe('1 KB');
    expect(humanSize(45 * 1024)).toBe('45 KB');
    expect(humanSize(106 * 1024 * 1024)).toBe('106 MB');
    expect(humanSize(3 * 1024 * 1024 * 1024)).toBe('3 GB');
  });

  it('非整值保留一位小数', () => {
    expect(humanSize(Math.round(1.2 * 1024 * 1024))).toBe('1.2 MB');
  });
});
