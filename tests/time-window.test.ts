import { describe, it, expect } from 'vitest';
import { formatSince, parseSince } from '../src/core/time-window.js';

const NOW = Date.parse('2026-10-22T12:00:00+08:00');

describe('parseSince(同步时间窗)', () => {
  it('7d → 7 天前的毫秒时间戳', () => {
    expect(parseSince('7d', NOW)).toBe(NOW - 7 * 24 * 3600_000);
  });

  it('支持 h/m/w', () => {
    expect(parseSince('24h', NOW)).toBe(NOW - 24 * 3600_000);
    expect(parseSince('30m', NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince('2w', NOW)).toBe(NOW - 14 * 24 * 3600_000);
  });

  it('all → 0,表示不限制', () => {
    expect(parseSince('all', NOW)).toBe(0);
  });

  it('ISO 日期 → 当天本地零点', () => {
    expect(parseSince('2026-10-01', NOW)).toBe(new Date('2026-10-01T00:00:00').getTime());
  });

  it('非法输入抛错', () => {
    expect(() => parseSince('7x', NOW)).toThrow(/时间范围/);
  });

  it('formatSince 只用于展示,不改变判定', () => {
    expect(formatSince(0)).toBe('all');
    expect(formatSince(parseSince('7d', NOW))).toMatch(/^2026-/);
  });
});
