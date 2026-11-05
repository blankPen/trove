import { describe, it, expect, vi } from 'vitest';
import { HeuristicGateway, JevDecisionGateway } from '../../../src/core/lessons/gateway.js';
import type { SessionDigest, CandidateForGate, ExistingForGate } from '../../../src/core/lessons/gateway.js';
import type { DecisionRecord } from '../../../src/core/lessons/decisions.js';
import type { JevProvider, JevKeepQuestion } from '../../../src/core/lessons/jev.js';
import type { LearnConfig } from '../../../src/config.js';
import type { SessionSummary } from '../../../src/core/lessons/analyze.js';

const learn = (over: Partial<LearnConfig> = {}): LearnConfig => ({
  v2: true,
  mode: 'auto',
  quality: { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 },
  jev: { maxCallsPerSession: 8, timeoutMs: 2000 },
  ...over,
});

const summary: SessionSummary = {
  topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false,
};

function digest(over: Partial<SessionDigest> = {}): SessionDigest {
  return { session: 's1', summary, eventCount: 5, toolCallCount: 2, hasError: false, hasCorrection: false, excerpt: 'excerpt', ...over };
}

function cand(over: Partial<CandidateForGate> = {}): CandidateForGate {
  return { type: 'experiences/gotcha', title: '标题', content: '正文', evidence: [{ session: 's1', seq: 1, quote: '足够长的引用内容' }], ...over };
}

function existing(over: Partial<ExistingForGate> = {}): ExistingForGate {
  return { path: 'experiences/gotcha-old.md', title: '旧标题', content: '旧正文', type: 'experiences/gotcha', ...over };
}

/** 记录 keepCalls 请求次数,按注入回调返回每个 key 的 0~1 概率。 */
function fakeJev(respond: (state: unknown, q: Record<string, JevKeepQuestion>) => Record<string, number>): JevProvider & { calls: number } {
  const jev = {
    calls: 0,
    async score(): Promise<{ taskSuccess: number; meanScore: number }> {
      return { taskSuccess: 1, meanScore: 1 };
    },
    async keepCalls(state: unknown, q: Record<string, JevKeepQuestion>): Promise<Record<string, number>> {
      jev.calls++;
      return respond(state, q);
    },
  };
  return jev;
}

function allHigh(_s: unknown, q: Record<string, JevKeepQuestion>): Record<string, number> {
  return Object.fromEntries(Object.keys(q).map((k) => [k, 0.95]));
}

const now = new Date('2026-01-01T00:00:00.000Z');

describe('HeuristicGateway(降级/测试)', () => {
  const g = new HeuristicGateway();

  it('triage:无事件或既无工具调用又无错误/纠正 → reject', async () => {
    expect((await g.triageSession(digest({ eventCount: 0 }))).decision).toBe('reject');
    expect((await g.triageSession(digest({ toolCallCount: 0, hasError: false, hasCorrection: false }))).decision).toBe('reject');
    expect((await g.triageSession(digest({ toolCallCount: 0, hasError: true }))).decision).toBe('accept');
  });

  it('screen:证据为空 reject,否则 escalate(交给 LLM)', async () => {
    expect((await g.screenCandidates([cand({ evidence: [] })])).map((r) => r.decision)).toEqual(['reject']);
    expect((await g.screenCandidates([cand()])).map((r) => r.decision)).toEqual(['escalate']);
  });

  it('identity:永远 add(非破坏性)', async () => {
    expect((await g.resolveIdentity(cand(), [existing()])).decision).toBe('add');
  });
});

describe('JevDecisionGateway · Gate A', () => {
  it('has_task/has_trace/has_lesson≥0.55 且 safe≥0.80 → accept,confidence=最小概率', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k === 'safe' ? 0.9 : 0.7])));
    const r = await new JevDecisionGateway({ jev, learn: learn(), now: () => now, session: 's1' }).triageSession(digest());
    expect(r.decision).toBe('accept');
    expect(r.source).toBe('jev');
    expect(r.confidence).toBe(0.7);
  });

  it('任一维度 <0.35 → 硬拒', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k === 'has_task' ? 0.2 : 0.9])));
    const r = await new JevDecisionGateway({ jev, learn: learn() }).triageSession(digest());
    expect(r.decision).toBe('reject');
  });

  it('safe 低分(<0.80 但在 [0.35,0.80)) → escalate 边界带', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k === 'safe' ? 0.5 : 0.9])));
    const r = await new JevDecisionGateway({ jev, learn: learn() }).triageSession(digest());
    expect(r.decision).toBe('escalate');
  });
});

describe('JevDecisionGateway · Gate B', () => {
  it('所有候选一次 batch:key 数量 = 候选数×5,请求一次', async () => {
    const jev = fakeJev(allHigh);
    const gw = new JevDecisionGateway({ jev, learn: learn() });
    const rs = await gw.screenCandidates([cand(), cand(), cand()]);
    expect(rs).toHaveLength(3);
    expect(rs.every((r) => r.decision === 'accept')).toBe(true);
    expect(jev.calls).toBe(1);
  });

  it('specific/actionable/transferable/non_duplicate≥0.60 且 safe≥0.80 → accept', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.includes('safe') ? 0.9 : 0.7])));
    const r = (await new JevDecisionGateway({ jev, learn: learn() }).screenCandidates([cand()]))[0]!;
    expect(r.decision).toBe('accept');
  });

  it('任一维度 <0.40 → reject', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.includes('specific') ? 0.2 : 0.9])));
    const r = (await new JevDecisionGateway({ jev, learn: learn() }).screenCandidates([cand()]))[0]!;
    expect(r.decision).toBe('reject');
  });

  it('边界 [0.40,0.60) → escalate', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.includes('actionable') ? 0.5 : 0.9])));
    const r = (await new JevDecisionGateway({ jev, learn: learn() }).screenCandidates([cand()]))[0]!;
    expect(r.decision).toBe('escalate');
  });

  it('证据为空直接拒绝,不调 Jev', async () => {
    const jev = fakeJev(allHigh);
    const r = (await new JevDecisionGateway({ jev, learn: learn() }).screenCandidates([cand({ evidence: [] })]))[0]!;
    expect(r.decision).toBe('reject');
    expect(jev.calls).toBe(0);
  });
});

describe('JevDecisionGateway · Gate C', () => {
  it('same_intent≥0.8 且 same_boundary≥0.8 → merge(取最高分旧记忆)', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.endsWith('same_intent') ? 0.9 : k.endsWith('same_boundary') ? 0.85 : 0.2])));
    const r = await new JevDecisionGateway({ jev, learn: learn() }).resolveIdentity(cand(), [existing({ path: 'a.md' }), existing({ path: 'b.md' })]);
    expect(r.decision).toBe('merge');
  });

  it('supersedes≥0.75 且未达合并 → supersede', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.endsWith('supersedes') ? 0.9 : 0.3])));
    const r = await new JevDecisionGateway({ jev, learn: learn() }).resolveIdentity(cand(), [existing()]);
    expect(r.decision).toBe('supersede');
    expect(r.targetPath).toBe('experiences/gotcha-old.md');
  });

  it('相关分落在 [0.5,0.8) 且未达合并 → escalate', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, k.endsWith('same_intent') ? 0.6 : 0.2])));
    const r = await new JevDecisionGateway({ jev, learn: learn() }).resolveIdentity(cand(), [existing()]);
    expect(r.decision).toBe('escalate');
  });

  it('都不满足 → add', async () => {
    const jev = fakeJev((_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, 0.2])));
    const r = await new JevDecisionGateway({ jev, learn: learn() }).resolveIdentity(cand(), [existing()]);
    expect(r.decision).toBe('add');
  });

  it('无同类旧记忆 → add,不调 Jev', async () => {
    const jev = fakeJev(allHigh);
    const r = await new JevDecisionGateway({ jev, learn: learn() }).resolveIdentity(cand(), [existing({ type: 'preferences/profile' })]);
    expect(r.decision).toBe('add');
    expect(jev.calls).toBe(0);
  });
});

describe('JevDecisionGateway · 降级与预算', () => {
  it('Jev 抛错 → 降级启发式,source=heuristic', async () => {
    const jev = fakeJev(() => { throw new Error('Jev 炸了'); });
    const gw = new JevDecisionGateway({ jev, learn: learn() });
    const a = await gw.triageSession(digest());
    expect(a.source).toBe('heuristic');
    expect(a.decision).toBe('accept'); // 启发式 triage:有工具调用 → accept
    const b = (await gw.screenCandidates([cand()]))[0]!;
    expect(b.source).toBe('heuristic');
    expect(b.decision).toBe('escalate'); // Gate B 降级 = escalate,不静默接受
  });

  it('keepCalls 未实现(jev 为 null)→ 降级', async () => {
    const gw = new JevDecisionGateway({ jev: null, learn: learn() });
    expect((await gw.triageSession(digest())).source).toBe('heuristic');
    expect((await gw.screenCandidates([cand()]))[0]!.source).toBe('heuristic');
    expect((await gw.resolveIdentity(cand(), [existing()])).source).toBe('heuristic');
  });

  it('超时(learn.jev.timeoutMs)→ 降级启发式', async () => {
    const jev = fakeJev((_s, _q) => new Promise<Record<string, number>>(() => {})); // 永不 resolve
    const gw = new JevDecisionGateway({ jev, learn: learn({ jev: { maxCallsPerSession: 8, timeoutMs: 10 } }) });
    const r = await gw.triageSession(digest());
    expect(r.source).toBe('heuristic');
  });

  it('预算用尽后不再调 Jev,直接走启发式', async () => {
    const jev = fakeJev(allHigh);
    const gw = new JevDecisionGateway({ jev, learn: learn({ jev: { maxCallsPerSession: 2, timeoutMs: 2000 } }) });
    await gw.triageSession(digest());
    await gw.screenCandidates([cand()]);
    expect(jev.calls).toBe(2);
    await gw.resolveIdentity(cand(), [existing()]);
    expect(jev.calls).toBe(2); // 第三次不再调用
  });
});

describe('JevDecisionGateway · 决策日志', () => {
  it('每次 gate 结果落一条 DecisionRecord,含问题 id 与概率', async () => {
    const jev = fakeJev(allHigh);
    const records: DecisionRecord[] = [];
    const log = vi.fn(async (r: DecisionRecord) => { records.push(r); });
    const gw = new JevDecisionGateway({ jev, learn: learn(), log, now: () => now, session: 's1' });

    await gw.triageSession(digest());
    await gw.screenCandidates([cand({ title: '候选标题' })]);
    await gw.resolveIdentity(cand(), [existing()]);

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ stage: 'triage', gate: 'A', session: 's1', at: '2026-01-01T00:00:00.000Z' });
    expect(records[0]!.reasons.map((r) => r.question)).toEqual(expect.arrayContaining(['has_task', 'has_trace', 'has_lesson', 'safe']));
    expect(records[1]).toMatchObject({ stage: 'screen', gate: 'B', candidate: { type: 'experiences/gotcha', title: '候选标题' } });
    expect(records[2]).toMatchObject({ stage: 'identity', gate: 'C' });
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('log 抛错不阻断 gate 结果返回', async () => {
    const jev = fakeJev(allHigh);
    const gw = new JevDecisionGateway({ jev, learn: learn(), log: async () => { throw new Error('日志炸了'); } });
    const r = await gw.triageSession(digest());
    expect(r.decision).toBe('accept');
  });
});
