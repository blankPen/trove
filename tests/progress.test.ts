import { describe, it, expect } from 'vitest';
import { createConsoleProgress } from '../src/progress-console.js';

function capture(tty: boolean, times: number[]) {
  const lines: string[] = [];
  let i = 0;
  const p = createConsoleProgress({
    tty,
    write: (s) => lines.push(s),
    now: () => times[Math.min(i++, times.length - 1)]!,
    intervalMs: 1000,
  });
  return { p, lines };
}

describe('createConsoleProgress', () => {
  it('非 TTY:阶段切换立即输出,单项按间隔节流,最后一项必出', () => {
    // 时间序列:phase=0, item=100, item=200, item=1200, item=1300
    const { p, lines } = capture(false, [0, 100, 200, 1200, 1300]);
    p.phase('push', '3 个文件');
    p.item('a.jsonl', 1, 3, 4);
    p.item('b.jsonl', 2, 3, 4);
    p.item('c.jsonl', 3, 3, 4);
    const text = lines.join('');
    expect(text).toContain('push');
    expect(text.match(/a\.jsonl/g)).toBeNull(); // 被节流
    expect(text).toContain('c.jsonl'); // 最后一项
    expect(text).toContain('3/3');
  });

  it('TTY:用 \\r 原地刷新,不逐行刷屏', () => {
    const { p, lines } = capture(true, [0, 100, 200, 300]);
    p.phase('push');
    p.item('a.jsonl', 1, 2, 10);
    p.item('b.jsonl', 2, 2, 20);
    const text = lines.join('');
    expect(text).toContain('\r');
    expect(text).toContain('push');
    expect(text).toContain('2/2');
  });
});
