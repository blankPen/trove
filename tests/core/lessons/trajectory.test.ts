import { describe, it, expect } from 'vitest';
import { extractTrajectoryFacts, renderTrajectory } from '../../../src/core/lessons/trajectory.js';
import { parseMemory } from '../../../src/core/lessons/memory.js';
import { MockLlm } from '../../../src/core/lessons/llm.js';
import type { SessionSummary } from '../../../src/core/lessons/analyze.js';
import type { Event } from '../../../src/core/events/schema.js';

function ev(seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event {
  return { v: 1, ts: '2026-01-01T00:00:00.000Z', seq, harness: 'claude-code', session: 'sess-1', kind, ...extra };
}

const summary: SessionSummary = {
  topic: 't', intent: '修复脚本退出码', outcome: 'success', keySteps: ['改用 set -e', '验证退出码'], hasError: true, hasCorrection: true, hasWorkflow: false,
};

const events = [
  ev(0, 'session', { cwd: '/Users/x/trove' }),
  ev(1, 'message', { role: 'user', text: '脚本退出应该用 set -e,你这里不对', raw: { path: 'raw/a.jsonl', line: 1 } }),
  ev(2, 'tool_call', { tool: { name: 'Bash', call_id: 'c1' }, raw: { path: 'raw/a.jsonl', line: 2 } }),
  ev(3, 'tool_result', { role: 'tool', result: { call_id: 'c1', status: 'ok', output: 'ok' }, raw: { path: 'raw/a.jsonl', line: 3 } }),
  ev(4, 'tool_result', { role: 'tool', result: { call_id: 'c2', status: 'error', output: 'command not found: wrong-tool' }, raw: { path: 'raw/a.jsonl', line: 4 } }),
  ev(5, 'message', { role: 'assistant', text: '好的,已修正', raw: { path: 'raw/a.jsonl', line: 5 } }),
];

describe('extractTrajectoryFacts(LLM 只生成三字段)', () => {
  it('解析 task/outcome/reusableSignals,非法 outcome 回退 unknown', async () => {
    const llm = new MockLlm(() => ({ task: '调试 shell 脚本', outcome: 'success', reusableSignals: ['用 set -e'] }));
    const f = await extractTrajectoryFacts(summary, events, { llm });
    expect(f).toEqual({ task: '调试 shell 脚本', outcome: 'success', reusableSignals: ['用 set -e'] });
  });

  it('summary.outcome=failure 时不得写成 success/partial,覆盖为 failure', async () => {
    const failSummary: SessionSummary = { ...summary, outcome: 'failure' };
    for (const bad of ['success', 'partial']) {
      const llm = new MockLlm(() => ({ task: 't', outcome: bad, reusableSignals: [] }));
      expect((await extractTrajectoryFacts(failSummary, events, { llm })).outcome).toBe('failure');
    }
  });

  it('reusableSignals 非数组时回退空', async () => {
    const llm = new MockLlm(() => ({ task: 't', outcome: 'success', reusableSignals: 'nope' }));
    expect((await extractTrajectoryFacts(summary, events, { llm })).reusableSignals).toEqual([]);
  });
});

describe('renderTrajectory(确定性渲染)', () => {
  const facts = { task: '调试 shell 脚本', outcome: 'success' as const, reusableSignals: ['用 set -e 让错误立即中断'] };

  it('正文含 5 个章节与 seq/raw 回指', () => {
    const { text } = renderTrajectory({ id: 'traj_1', session: 'sess-1', project: 'trove', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    for (const h of ['## 任务', '## 执行步骤', '## 结果与验证', '## 失败/弯路（如有）', '## 可复用信号（候选，不直接当经验）']) {
      expect(text).toContain(h);
    }
    expect(text).toContain('- [1] message:user: 脚本退出应该用 set -e,你这里不对 @raw/a.jsonl:1');
    expect(text).toContain('outcome: success');
  });

  it('错误 tool_result 与用户纠正消息进入 evidence(quote 截断 200)', () => {
    const { evidence } = renderTrajectory({ id: 'traj_1', session: 'sess-1', project: 'trove', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(evidence.some((r) => r.seq === 4 && r.quote.includes('command not found'))).toBe(true);
    expect(evidence.some((r) => r.seq === 1 && r.quote.includes('你这里不对'))).toBe(true);
    for (const r of evidence) expect([...r.quote].length).toBeLessThanOrEqual(200);
  });

  it('无错误/纠正时失败章节写 - 无,evidence 为空', () => {
    const clean = [ev(1, 'message', { role: 'user', text: '你好世界' }), ev(2, 'tool_call', { tool: { name: 'Bash' } }), ev(3, 'tool_result', { result: { status: 'ok', output: 'done' } })];
    const { text, evidence } = renderTrajectory({ id: 'traj_1', session: 'sess-1', project: 'trove', summary, facts, events: clean, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(text).toContain('- 无');
    expect(evidence).toEqual([]);
  });

  it('路径只含 [A-Za-z0-9._-],长度 ≤120,同会话重跑覆盖同路径', () => {
    const a = renderTrajectory({ id: 'traj_1', session: 'sess/奇怪的 id?', project: 'trove', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(a.path.startsWith('trajectories/2026-01-02-')).toBe(true);
    expect(a.path).toMatch(/^[A-Za-z0-9._\-/]+\.md$/);
    expect(a.path.length).toBeLessThanOrEqual(120);
    const b = renderTrajectory({ id: 'traj_2', session: 'sess/奇怪的 id?', project: 'trove', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(a.path).toBe(b.path); // 幂等:同一会话/任务重跑覆盖同路径
  });

  it('渲染结果可被 parseMemory 解析,kind=trajectory', () => {
    const { text } = renderTrajectory({ id: 'traj_1', session: 'sess-1', project: 'trove', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    const mem = parseMemory(text);
    expect(mem).not.toBeNull();
    expect(mem!.kind).toBe('trajectory');
    expect(mem!.type).toBe('trajectories/capture');
    expect(mem!.id).toBe('traj_1');
    expect(mem!.evidence.length).toBeGreaterThan(0);
  });

  it('scope 取 cwd 最后一段:完整路径 → project:trove', () => {
    const { text } = renderTrajectory({ id: 'traj_1', session: 'sess-1', project: '/Users/x/trove', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(parseMemory(text)!.scope).toBe('project:trove');
  });

  it('scope 清洗非法字符,空 cwd 回退 project:unknown', () => {
    const { text } = renderTrajectory({ id: 'traj_1', session: 'sess-1', project: '/Users/x/tro ve', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(parseMemory(text)!.scope).toBe('project:tro_ve');
    const empty = renderTrajectory({ id: 'traj_1', session: 'sess-1', project: '', summary, facts, events, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(parseMemory(empty.text)!.scope).toBe('project:unknown');
  });
});
