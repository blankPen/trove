import { describe, it, expect } from 'vitest';
import { selectSession, truncateText, truncateEvents } from '../../src/core/lessons/select.js';
import type { Event, EventKind } from '../../src/core/events/schema.js';

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

describe('会话选择(Stage 3)', () => {
  it('用例 3-1:只有 3 个事件 → 太短,不进入提取', () => {
    const events = [ev(0, 'session'), ev(1, 'message', { role: 'user', text: 'hi' }), ev(2, 'message', { role: 'assistant', text: 'hi' })];
    const r = selectSession(events);
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('too_short');
  });

  it('用例 3-2:最后事件 2 分钟前 → 进行中,不进入提取', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const twoMinAgo = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '开始' }),
      ev(2, 'message', { role: 'assistant', text: '在' }),
      ev(3, 'message', { role: 'user', text: '继续' }),
      ev(4, 'message', { role: 'assistant', text: '好的', ts: twoMinAgo }),
    ];
    const r = selectSession(events, now);
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('in_progress');
  });

  it('用例 3-3:仅 2 条 user_message、无 error/tool_call → 简单问答', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '你好' }),
      ev(2, 'message', { role: 'assistant', text: '你好' }),
      ev(3, 'message', { role: 'user', text: '再见' }),
      ev(4, 'message', { role: 'assistant', text: '再见' }),
    ];
    const r = selectSession(events, now);
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('simple_qa');
  });

  it('有 tool_call 但无 error 且无纠正 → 无学习信号,跳过', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '帮我看看' }),
      ev(2, 'tool_call', { tool: { name: 'Bash' } }),
      ev(3, 'tool_result', { result: { status: 'ok', output: 'done' } }),
      ev(4, 'message', { role: 'user', text: '谢谢' }),
    ];
    const r = selectSession(events, now);
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toBe('no_learning_signal');
  });

  it('含 http URL 的会话(无 error/纠正)→ 资源信号放行', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '调研下 https://github.com/foo/bar 这个仓库' }),
      ev(2, 'tool_call', { tool: { name: 'Bash' } }),
      ev(3, 'tool_result', { result: { status: 'ok', output: 'ok' } }),
      ev(4, 'message', { role: 'user', text: '总结下它的用法' }),
      ev(5, 'message', { role: 'assistant', text: '好的' }),
    ];
    expect(selectSession(events, now).status).toBe('selected');
  });

  it('含 skill:// 引用的会话 → 资源信号放行', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '[Find Skills](skill://find-skills?type=4) 看下' }),
      ev(2, 'tool_call', { tool: { name: 'Bash' } }),
      ev(3, 'tool_result', { result: { status: 'ok', output: 'ok' } }),
      ev(4, 'message', { role: 'user', text: '这个 skill 有什么用' }),
    ];
    expect(selectSession(events, now).status).toBe('selected');
  });

  it('含 URL 的短会话(≤2 user、无 tool_call)→ 资源信号放行,不被 simple_qa 过滤', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '查看 https://www.doubao.com/thread/xVWVHfc' }),
      ev(2, 'message', { role: 'assistant', text: '这是内容摘要' }),
      ev(3, 'message', { role: 'assistant', text: '继续说明' }),
      ev(4, 'message', { role: 'user', text: '好的' }),
    ];
    expect(selectSession(events, now).status).toBe('selected');
  });

  it('有 error → 保留(不因无学习信号被跳过)', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '跑一下' }),
      ev(2, 'tool_call', { tool: { name: 'Bash' } }),
      ev(3, 'tool_result', { result: { status: 'error', output: 'boom' } }),
      ev(4, 'message', { role: 'assistant', text: '失败了' }),
    ];
    expect(selectSession(events, now).status).toBe('selected');
  });

  it('有纠正信号(无 error)→ 保留', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events = [
      ev(0, 'session'),
      ev(1, 'message', { role: 'user', text: '帮我' }),
      ev(2, 'tool_call', { tool: { name: 'Bash' } }),
      ev(3, 'tool_result', { result: { status: 'ok', output: 'ok' } }),
      ev(4, 'message', { role: 'user', text: '这里不对,应该用 set -e' }),
      ev(5, 'message', { role: 'assistant', text: '已改' }),
    ];
    expect(selectSession(events, now).status).toBe('selected');
  });

  it('用例 3-5:5000 字符超长文本 → 前 600 + 省略标记 + 后 600', () => {
    const head = 'A'.repeat(600);
    const tail = 'Z'.repeat(600);
    const long = `${head}${'中'.repeat(5000 - 1200)}${tail}`;
    const out = truncateText(long);
    expect(out).toBe(`${head}...${tail}`);
    expect(out.length).toBe(600 + 3 + 600);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain('...');
  });

  it('短文本原样返回', () => {
    expect(truncateText('hello')).toBe('hello');
  });

  it('用例 3-4:200 条事件过滤后只保留有内容事件', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const events: Event[] = [];
    let seq = 0;
    const push = (kind: EventKind, extra: Partial<Event> = {}) => events.push(ev(seq++, kind, extra));
    for (let i = 0; i < 150; i++) push('meta', { usage: { input: 1 } });
    for (let i = 0; i < 30; i++) push('tool_result', { result: { status: 'ok', output: 'ok' } });
    for (let i = 0; i < 7; i++) push('message', { role: 'user', text: `用户消息 ${i}` });
    for (let i = 0; i < 7; i++) push('tool_call', { tool: { name: 'Bash' } });
    for (let i = 0; i < 6; i++) push('tool_result', { result: { status: 'error', output: 'boom' } });
    const r = selectSession(events, now);
    expect(r.status).toBe('selected');
    if (r.status !== 'selected') return;
    expect(r.events.length).toBeLessThanOrEqual(80);
    for (const e of r.events) {
      const contentful =
        (e.kind === 'message' && e.role === 'user') ||
        e.kind === 'tool_call' ||
        (e.kind === 'tool_result' && e.result?.status === 'error');
      expect(contentful).toBe(true);
    }
  });

  it('截断:>80 条取首尾各 40(首 40 最早、尾 40 最晚)', () => {
    const events = Array.from({ length: 100 }, (_, i) => ev(i, 'tool_call', { tool: { name: 'Bash' } }));
    const out = truncateEvents(events);
    expect(out.length).toBe(80);
    expect(out[0]!.seq).toBe(0);
    expect(out[39]!.seq).toBe(39);
    expect(out[40]!.seq).toBe(60);
    expect(out[79]!.seq).toBe(99);
  });
});
