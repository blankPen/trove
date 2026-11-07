import { describe, it, expect } from 'vitest';
import { renderEvents } from '../../../src/core/lessons/analyze.js';
import type { Event, EventKind } from '../../../src/core/events/schema.js';

/** 构造一条对话层事件;ts 缺省为固定过去时间,seq 递增。 */
function ev(seq: number, kind: EventKind, extra: Partial<Event> = {}): Event {
  return {
    v: 1,
    ts: '2026-01-01T00:00:00.000Z',
    seq,
    harness: 'claude-code',
    session: 's1',
    kind,
    ...extra,
  };
}

describe('renderEvents', () => {
  it('输出 raw.path:line 与 tool.input 里的 URL,保证可溯源', () => {
    const events: Event[] = [
      ev(1, 'message', { role: 'user', text: '查看这个链接', raw: { path: 'doubao/sessions/1.jsonl', line: 42 } }),
      ev(2, 'tool_call', { tool: { name: 'Bash', input: { url: 'https://github.com/foo/bar' } } }),
    ];
    const out = renderEvents(events);
    expect(out).toContain('doubao/sessions/1.jsonl:42');
    expect(out).toContain('https://github.com/foo/bar');
  });

  it('单行带 [seq] 前缀,错误结果标 error', () => {
    const events: Event[] = [
      ev(3, 'tool_result', { result: { call_id: 'c1', status: 'error', output: 'boom' } }),
    ];
    expect(renderEvents(events)).toBe('[3] error: boom');
  });

  it('超长 tool.input 被截断,不撑爆模型输入', () => {
    const events: Event[] = [
      ev(4, 'tool_call', { tool: { name: 'Write', input: { content: 'x'.repeat(5000) } } }),
    ];
    const out = renderEvents(events);
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain('...');
  });
});
