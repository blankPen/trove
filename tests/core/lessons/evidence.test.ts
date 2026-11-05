import { describe, it, expect } from 'vitest';
import type { Event } from '../../../src/core/events/schema.js';
import { normalizeForMatch, verifyEvidence } from '../../../src/core/lessons/evidence.js';

function ev(
  seq: number,
  text?: string,
  result?: { output?: unknown },
  raw?: { path: string; line: number },
): Event {
  return {
    v: 1,
    ts: '',
    seq,
    harness: 'claude-code',
    session: 's',
    kind: 'message',
    text,
    ...(result ? { result } : {}),
    ...(raw ? { raw } : {}),
  };
}

describe('normalizeForMatch', () => {
  it('去首尾空白、连续空白折单空格、换行折空格', () => {
    expect(normalizeForMatch('  a\r\nb\n  c   d\t ')).toBe('a b c d');
  });
});

describe('verifyEvidence', () => {
  it('命中事件 text', () => {
    const r = verifyEvidence('s', [{ seq: 0, quote: '报错是 ECONNRESET' }], [
      ev(0, '这里的报错是 ECONNRESET 需要重试'),
    ]);
    expect(r.ok).toBe(true);
    expect(r.refs).toEqual([{ session: 's', seq: 0, quote: '报错是 ECONNRESET' }]);
    expect(r.missing).toEqual([]);
  });

  it('命中字符串 result.output', () => {
    const r = verifyEvidence('s', [{ seq: 1, quote: '找不到模块 foo-bar' }], [
      ev(1, undefined, { output: '命令失败:找不到模块 foo-bar' }),
    ]);
    expect(r.ok).toBe(true);
  });

  it('空白差异命中(规范化后子串匹配)', () => {
    const r = verifyEvidence('s', [{ seq: 0, quote: '执行 第二步 多空格 内容' }], [
      ev(0, '第一步\n执行 第二步    多空格\t内容结束'),
    ]);
    expect(r.ok).toBe(true);
  });

  it('quote 不足 12 码点拒绝', () => {
    const r = verifyEvidence('s', [{ seq: 0, quote: '太短' }], [ev(0, '这里有点内容')]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([0]);
  });

  it('seq 不存在拒绝', () => {
    const r = verifyEvidence('s', [{ seq: 99, quote: '足够长的引用内容十二字符' }], [ev(0, '正文')]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([99]);
  });

  it('quote 不匹配拒绝', () => {
    const r = verifyEvidence('s', [{ seq: 0, quote: '完全不存在的内容字符串' }], [ev(0, '正文内容')]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([0]);
  });

  it('跨事件多条各自命中,失败项进 missing 且不降级', () => {
    const events = [ev(0, '第一个报错是 timeout 超时'), ev(1, '第二个报错是 auth 失败')];
    const r = verifyEvidence(
      's',
      [
        { seq: 0, quote: '报错是 timeout 超时' },
        { seq: 1, quote: '第二个报错是 auth 失败' },
        { seq: 2, quote: '不存在的这条证据啊' },
      ],
      events,
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([2]);
    expect(r.refs).toHaveLength(2);
  });

  it('path:line 回填:传入值优先,否则取事件 raw', () => {
    const events = [ev(0, '这里的关键错误在这条消息里', undefined, { path: 'raw/a.jsonl', line: 42 })];
    const a = verifyEvidence('s', [{ seq: 0, quote: '这里的关键错误在这条消息里' }], events);
    expect(a.refs[0]).toMatchObject({ path: 'raw/a.jsonl', line: 42 });

    const b = verifyEvidence('s', [{ seq: 0, quote: '这里的关键错误在这条消息里', path: 'given.md', line: 7 }], events);
    expect(b.refs[0]).toMatchObject({ path: 'given.md', line: 7 });
  });

  it('空证据数组 → ok:false', () => {
    const r = verifyEvidence('s', [], [ev(0, '正文')]);
    expect(r.ok).toBe(false);
    expect(r.refs).toEqual([]);
    expect(r.missing).toEqual([]);
  });
});
