import { describe, it, expect, vi } from 'vitest';
import { compactEvents } from '../../../src/core/lessons/compaction.js';
import type { JevProvider, JevScores } from '../../../src/core/lessons/jev.js';
import type { Event } from '../../../src/core/events/schema.js';

function ev(seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event {
  return { v: 1, ts: '2026-01-01T00:00:00.000Z', seq, harness: 'claude-code', session: 's1', kind, ...extra };
}

/** n 对 tool_call/result,每对夹 user/assistant 文字,共 4n 条事件。 */
function eventsWithCalls(n: number, out = (i: number) => `out ${i}`): Event[] {
  const events: Event[] = [];
  let seq = 0;
  for (let i = 0; i < n; i++) {
    events.push(ev(seq++, 'message', { role: 'user', text: `问 ${i}` }));
    events.push(ev(seq++, 'tool_call', { tool: { name: 'Bash', call_id: `c${i}` } }));
    events.push(ev(seq++, 'tool_result', { role: 'tool', result: { call_id: `c${i}`, status: 'ok', output: out(i) } }));
    events.push(ev(seq++, 'message', { role: 'assistant', text: `答 ${i}` }));
  }
  return events;
}

/** 只实现 keepCalls,score 恒通过。 */
function jevWithKeep(
  keep: (state: unknown, questions: Record<string, { instructions: string }>) => Promise<Record<string, number>>,
): JevProvider {
  return {
    score: async (): Promise<JevScores> => ({ taskSuccess: 1, meanScore: 1 }),
    keepCalls: keep,
  };
}

const allKeep = async (_s: unknown, q: Record<string, { instructions: string }>) =>
  Object.fromEntries(Object.keys(q).map((id) => [id, id.endsWith(':noise') ? 0 : 1]));

describe('Jev 快速压缩(LLM 分析前)', () => {
  it('noul 判定全 ≥0.5 → 保留全部事件', async () => {
    const events = eventsWithCalls(16);
    const keepCalls = vi.fn(allKeep);
    const out = await compactEvents(events, jevWithKeep(keepCalls));
    expect(keepCalls).toHaveBeenCalledOnce();
    expect(out.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
  });

  it('判定 <0.5 的调用对整对删除,user/assistant 文字永不删', async () => {
    const events = eventsWithCalls(16);
    const keepCalls = vi.fn(async (_s, q) => {
      const out: Record<string, number> = {};
      for (const id of Object.keys(q)) {
        if (id.startsWith('c0:')) out[id] = id.endsWith(':noise') ? 1 : 0;
        else out[id] = id.endsWith(':noise') ? 0 : 1;
      }
      return out;
    });
    const out = await compactEvents(events, jevWithKeep(keepCalls));
    const keptSeqs = out.map((e) => e.seq);
    // c0 的 tool_call(seq1) 与 tool_result(seq2) 被删;user(seq0)/assistant(seq3) 文字保留。
    expect(keptSeqs).not.toContain(1);
    expect(keptSeqs).not.toContain(2);
    expect(keptSeqs).toContain(0);
    expect(keptSeqs).toContain(3);
    expect(out.length).toBe(events.length - 2);
  });

  it('调用对 ≤15 → 不调 keepCalls,走确定性兜底', async () => {
    const events = eventsWithCalls(15);
    const keepCalls = vi.fn(allKeep);
    const out = await compactEvents(events, jevWithKeep(keepCalls));
    expect(keepCalls).not.toHaveBeenCalled();
    // 60 条 ≤80,兜底排序后原样保留。
    expect(out.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
  });

  it('jev 未实现 keepCalls → 降级为确定性截断', async () => {
    const events = eventsWithCalls(16);
    const jev: JevProvider = { score: async () => ({ taskSuccess: 1, meanScore: 1 }) };
    await expect(compactEvents(events, jev)).resolves.toHaveLength(events.length);
  });

  it('keepCalls 抛错 → 降级为确定性截断,不拖垮提取', async () => {
    const events = eventsWithCalls(16);
    const jev = jevWithKeep(async () => {
      throw new Error('boom');
    });
    await expect(compactEvents(events, jev)).resolves.toHaveLength(events.length);
  });

  it('jev 为 null(未配置)→ 走确定性截断兜底,不抛', async () => {
    const events = eventsWithCalls(16);
    const out = await compactEvents(events, null);
    // ≤80 条:兜底原样保留(仅排序)。
    expect(out.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
  });

  it('jev 为 null 且事件超 80 条 → 兜底截断为首尾各 40', async () => {
    const events = eventsWithCalls(30);
    const out = await compactEvents(events, null);
    expect(out).toHaveLength(80);
  });

  it('压缩后仍超预算 → 整体退回确定性截断(首尾各 40)', async () => {
    const events = eventsWithCalls(150, () => 'x'.repeat(1200));
    const out = await compactEvents(events, jevWithKeep(allKeep));
    expect(out.length).toBe(80);
  });
});

describe('确定性预过滤(不花 Jev)', () => {
  /** 带同/异入参的调用序列,便于测重试去重。 */
  function callEvents(specs: Array<{ input: string; output: string; assistant?: string; status?: 'ok' | 'error' }>): Event[] {
    const events: Event[] = [];
    let seq = 0;
    for (const s of specs) {
      events.push(ev(seq++, 'message', { role: 'user', text: `问 ${seq}` }));
      events.push(ev(seq++, 'tool_call', { tool: { name: 'Bash', call_id: `c${seq}`, input: s.input } }));
      events.push(ev(seq++, 'tool_result', { role: 'tool', result: { call_id: `c${seq - 1}`, status: s.status ?? 'ok', output: s.output } }));
      if (s.assistant !== undefined) events.push(ev(seq++, 'message', { role: 'assistant', text: s.assistant }));
    }
    return events;
  }

  it('无错误信号的大输出在送 Jev 前被截断,含 error 的保留', async () => {
    const big = 'x'.repeat(9000);
    const specs: Array<{ input: string; output: string }> = [];
    for (let i = 0; i < 14; i++) specs.push({ input: `s${i}`, output: `out ${i}` });
    specs.push({ input: 'a', output: big });
    specs.push({ input: 'b', output: `${big} error: boom` });
    const events = callEvents(specs);

    const keepCalls = vi.fn(allKeep);
    await compactEvents(events, jevWithKeep(keepCalls));
    const state = keepCalls.mock.calls[0]![0] as string;
    expect(state).toContain('…[已截断 9000 字符]');
    expect(state.split(big)).toHaveLength(2); // 完整大串只剩含 error 的那一份
    expect(state).toContain('error: boom');
  });

  it('同一命令失败后重试只保留最后一次', async () => {
    const events = callEvents([
      { input: 'npm test', output: 'fail 1', status: 'error' },
      { input: 'npm test', output: 'fail 2', status: 'error' },
      { input: 'npm test', output: 'pass' },
    ]);
    const out = await compactEvents(events, null);
    const results = out.filter((e) => e.kind === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.result?.output).toBe('pass');
  });

  it('成功后的重复调用不算重试,全部保留', async () => {
    const events = callEvents([
      { input: 'npm test', output: 'first' },
      { input: 'npm test', output: 'second' },
    ]);
    const out = await compactEvents(events, null);
    expect(out.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
  });

  it('中间有 assistant 回复的相同命令不算重试', async () => {
    const events = callEvents([
      { input: 'npm test', output: 'first', assistant: '先看失败原因' },
      { input: 'npm test', output: 'second', assistant: '再试一次' },
    ]);
    const out = await compactEvents(events, null);
    expect(out.filter((e) => e.kind === 'tool_result')).toHaveLength(2);
  });

  it('空输出与纯进度输出被丢弃', async () => {
    const events = callEvents([
      { input: 'a', output: '' },
      { input: 'b', output: '[progress] 1/10' },
      { input: 'c', output: '   \n  \n' },
      { input: 'd', output: '有用的输出' },
    ]);
    const out = await compactEvents(events, null);
    const results = out.filter((e) => e.kind === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.result?.output).toBe('有用的输出');
  });

  it('noise 分 ≥0.5 的调用对被删,即使 reusable 达标', async () => {
    const events = eventsWithCalls(16);
    const jev = jevWithKeep(async (_s, q) => {
      const out: Record<string, number> = {};
      for (const id of Object.keys(q)) {
        if (id.startsWith('c0:')) out[id] = id.endsWith(':noise') ? 0.9 : 0.9;
        else out[id] = id.endsWith(':noise') ? 0 : 1;
      }
      return out;
    });
    const out = await compactEvents(events, jev);
    expect(out.map((e) => e.seq)).not.toContain(1);
    expect(out.map((e) => e.seq)).not.toContain(2);
  });
});