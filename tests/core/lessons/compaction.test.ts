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
  Object.fromEntries(Object.keys(q).map((id) => [id, 1]));

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
      for (const id of Object.keys(q)) out[id] = id === 'c0' ? 0 : 1;
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