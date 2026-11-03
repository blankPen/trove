import { describe, it, expect } from 'vitest';
import { compareVersions, pickLatestHash, sessionKeyOf } from '../../../src/core/library/schema.js';

describe('sessionKeyOf', () => {
  it('harness 与 session 用冒号连接', () => {
    expect(sessionKeyOf('claude-code', 'abc')).toBe('claude-code:abc');
  });
});

describe('compareVersions(semver → 更可解析者优先 → 平局 0)', () => {
  it('按数值比较,不是字符串:1.10 > 1.9', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('v 前缀等价于无前缀', () => {
    expect(compareVersions('v2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
  });

  it('相同版本返回 0,后缀(如 -alpha)不影响三节比较', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.2.3-alpha', '1.2.3')).toBe(0);
  });

  it('只有一侧能解析 semver 时,可解析的那侧更大', () => {
    expect(compareVersions('1.0.0', undefined)).toBeGreaterThan(0);
    expect(compareVersions(undefined, '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', 'release')).toBeGreaterThan(0);
  });

  it('两侧都不能解析时返回 0(交给上层别的字段定序)', () => {
    expect(compareVersions(undefined, undefined)).toBe(0);
    expect(compareVersions('main', 'dev')).toBe(0);
  });
});

describe('pickLatestHash(semver → updatedAt → hash,确定性)', () => {
  const v = (hash: string, version?: string, updatedAt?: string) => ({ hash, version, updatedAt });

  it('semver 最大者胜出', () => {
    expect(pickLatestHash([v('a', '1.0.0'), v('b', '2.0.0'), v('c', '1.5.0')])).toBe('b');
  });

  it('semver 相同时按 updatedAt 取最新', () => {
    expect(
      pickLatestHash([
        v('old', '1.0.0', '2026-10-20T00:00:00.000Z'),
        v('new', '1.0.0', '2026-10-25T00:00:00.000Z'),
      ]),
    ).toBe('new');
  });

  it('version 与 updatedAt 都相同时按 hash 字典序兜底,结果稳定', () => {
    expect(
      pickLatestHash([
        v('c', undefined, undefined),
        v('a', undefined, undefined),
        v('b', undefined, undefined),
      ]),
    ).toBe('a');
  });
});
