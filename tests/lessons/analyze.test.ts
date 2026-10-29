import { describe, it, expect } from 'vitest';
import { summarizeSession, classifySession, anyCategory, analyzeSession, renderEvents } from '../../src/core/lessons/analyze.js';
import { MockLlm } from '../../src/core/lessons/llm.js';
import { MockJev } from '../../src/core/lessons/jev.js';
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

/** 「修 WebDAV ECONNRESET」会话事件。 */
const webdavEvents: Event[] = [
  ev(0, 'session'),
  ev(1, 'message', { role: 'user', text: '同步一直报 ECONNRESET,帮我看看' }),
  ev(2, 'tool_call', { tool: { name: 'Bash' } }),
  ev(3, 'tool_result', { result: { status: 'error', output: 'ECONNRESET' } }),
  ev(4, 'message', { role: 'user', text: '改成指数退避重试' }),
  ev(5, 'message', { role: 'assistant', text: '已修复' }),
];

describe('会话摘要与分类打分(Stage 4)', () => {
  it('用例 4-1:mock LLM 返回固定摘要 JSON → 正确解析且 hasError=true', async () => {
    const llm = new MockLlm(() => ({
      topic: '修 WebDAV ECONNRESET',
      intent: '解决同步失败',
      outcome: 'failure',
      keySteps: ['指数退避重试', '限速'],
      hasError: true,
      hasCorrection: false,
      hasWorkflow: false,
    }));
    const summary = await summarizeSession(webdavEvents, llm);
    expect(summary.topic).toBe('修 WebDAV ECONNRESET');
    expect(summary.outcome).toBe('failure');
    expect(summary.hasError).toBe(true);
    expect(summary.keySteps).toEqual(['指数退避重试', '限速']);
  });

  it('用例 4-2:outcome=trivial → 跳过,不进入后续提取', async () => {
    const llm = new MockLlm(() => ({
      topic: '简单问答',
      intent: '闲聊',
      outcome: 'trivial',
      keySteps: [],
      hasError: false,
      hasCorrection: false,
      hasWorkflow: false,
    }));
    const r = await analyzeSession(webdavEvents, { llm, jev: new MockJev(() => ({ taskSuccess: 1, meanScore: 1 })) });
    expect(r).toEqual({ status: 'skip', reason: 'trivial' });
  });

  it('用例 4-3:分类五类全 false → 结束,不产生候选', async () => {
    const responses = [
      { topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: true, hasCorrection: false, hasWorkflow: false },
      { preferences: false, entities: false, experiences: false, events: false, resources: false },
    ];
    const llm = new MockLlm(() => responses.shift());
    const r = await analyzeSession(webdavEvents, { llm, jev: new MockJev(() => ({ taskSuccess: 1, meanScore: 1 })) });
    expect(r).toEqual({ status: 'skip', reason: 'no_category' });
  });

  it('用例 4-4:Jev task_success=0.3 → 跳过并带分数记录', async () => {
    const responses = [
      { topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: true, hasCorrection: false, hasWorkflow: false },
      { preferences: false, entities: false, experiences: true, events: false, resources: false },
    ];
    const llm = new MockLlm(() => responses.shift());
    const r = await analyzeSession(webdavEvents, { llm, jev: new MockJev(() => ({ taskSuccess: 0.3, meanScore: 0.7 })) });
    expect(r).toEqual({ status: 'skip', reason: 'low_score', scores: { taskSuccess: 0.3, meanScore: 0.7 } });
  });

  it('用例 4-5:Jev task_success=0.8 mean_score=0.7 → 继续进入提取', async () => {
    const responses = [
      { topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: true, hasCorrection: false, hasWorkflow: false },
      { preferences: false, entities: false, experiences: true, events: false, resources: false },
    ];
    const llm = new MockLlm(() => responses.shift());
    const r = await analyzeSession(webdavEvents, { llm, jev: new MockJev(() => ({ taskSuccess: 0.8, meanScore: 0.7 })) });
    expect(r.status).toBe('continue');
    if (r.status === 'continue') {
      expect(r.summary.outcome).toBe('success');
      expect(r.classification.experiences).toBe(true);
    }
  });

  it('非法 outcome 被拒绝', async () => {
    const llm = new MockLlm(() => ({ topic: 't', intent: 'i', outcome: 'oops', keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false }));
    await expect(summarizeSession(webdavEvents, llm)).rejects.toThrow(/outcome/);
  });

  it('anyCategory:任一为真即真,全假为假', () => {
    expect(anyCategory({ preferences: false, entities: false, experiences: true, events: false, resources: false })).toBe(true);
    expect(anyCategory({ preferences: false, entities: false, experiences: false, events: false, resources: false })).toBe(false);
  });

  it('classifySession 解析五类布尔值', async () => {
    const llm = new MockLlm(() => ({ preferences: true, entities: false, experiences: false, events: true, resources: false }));
    const c = await classifySession({ topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false }, llm);
    expect(c).toEqual({ preferences: true, entities: false, experiences: false, events: true, resources: false });
  });

  it('renderEvents 输出 raw.path:line 与 tool.input 里的 URL,保证可溯源', () => {
    const events: Event[] = [
      ev(1, 'message', { role: 'user', text: '查看这个链接', raw: { path: 'doubao/sessions/1.jsonl', line: 42 } }),
      ev(2, 'tool_call', { tool: { name: 'Bash', input: { url: 'https://github.com/foo/bar' } } }),
    ];
    const out = renderEvents(events);
    expect(out).toContain('doubao/sessions/1.jsonl:42');
    expect(out).toContain('https://github.com/foo/bar');
  });
});
