import { describe, it, expect, vi } from 'vitest';
import { extractMemoriesV2, hasSensitiveSecret } from '../../../src/core/lessons/extract.js';
import { MockLlm } from '../../../src/core/lessons/llm.js';
import type { SessionSummary, Classification } from '../../../src/core/lessons/analyze.js';
import type { Event } from '../../../src/core/events/schema.js';

function ev(seq: number, extra: Partial<Event> = {}): Event {
  return { v: 1, ts: '2026-01-01T00:00:00.000Z', seq, harness: 'claude-code', session: 's1', kind: 'message', role: 'user', text: '这里的报错是 ECONNRESET 需要重试', ...extra };
}

const summary: SessionSummary = {
  topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: true, hasCorrection: false, hasWorkflow: false,
};

function cls(partial: Partial<Classification>): Classification {
  return { preferences: false, entities: false, experiences: false, events: false, resources: false, ...partial };
}

const events = [ev(1), ev(2, { text: '命令失败:找不到模块 foo-bar' })];

describe('extractMemoriesV2(五段式 + evidence quote)', () => {
  it('正常五段式候选带 quote,evidence 补 session', async () => {
    const llm = new MockLlm(() => ({ memories: [{ type: 'experiences/gotcha', title: 'ECONNRESET 需要重试', content: '## 适用场景\n网络失败时\n\n## 做法\n运行 `curl` 重试\n\n## 验证\n成功\n\n## 边界与反例\n不适用于 POST', evidence: [{ seq: 1, quote: '这里的报错是 ECONNRESET' }] }] }));
    const r = await extractMemoriesV2(summary, cls({ experiences: true }), events, { llm });
    expect(r).toHaveLength(1);
    expect(r[0]!.type).toBe('experiences/gotcha');
    expect(r[0]!.evidence).toEqual([{ session: 's1', seq: 1, quote: '这里的报错是 ECONNRESET' }]);
  });

  it('经验提示词含五段式与四类验收关键词', async () => {
    const respond = vi.fn((_p: string, _s: Record<string, unknown>) => ({ memories: [] }));
    await extractMemoriesV2(summary, cls({ experiences: true }), events, { llm: new MockLlm(respond) });
    const prompt = String(respond.mock.calls[0]![0]);
    expect(prompt).toContain('五段式');
    expect(prompt).toContain('## 适用场景');
    expect(prompt).toContain('## 做法');
    expect(prompt).toContain('## 验证');
    expect(prompt).toContain('## 边界与反例');
    expect(prompt).toContain('错误现象');
    expect(prompt).toContain('根因');
    expect(prompt).toContain('修复');
    expect(prompt).toContain('边界');
    expect(prompt).toContain('前置条件');
    expect(prompt).toContain('失败分支');
    expect(prompt).toContain('触发条件');
    expect(prompt).toContain("DON'T");
    expect(prompt).toContain('DO(该做什么)');
    expect(prompt).toContain('纠正');
    expect(prompt).toContain('用户纠正了什么');
    expect(prompt).toContain('原来错在哪');
    expect(prompt).toContain('正确做法');
    expect(prompt).toContain('何时应用');
    expect(prompt).toContain('证据须含错误原文');
    expect(prompt).toContain('成功命令');
    expect(prompt).toContain('踩坑错误原文');
    expect(prompt).toContain('用户纠正原话');
  });

  it('四类经验提示词注入各自验收点(单类提取)', async () => {
    const respond = vi.fn((_p: string, _s: Record<string, unknown>) => ({ memories: [] }));
    await extractMemoriesV2(summary, cls({ experiences: true }), events, { llm: new MockLlm(respond) });
    const prompt = String(respond.mock.calls[0]![0]);
    expect(prompt).toContain('现象');
    expect(prompt).toContain('验证');
    expect(prompt).toContain('机制');
    expect(prompt).toContain('修正验证');
  });

  it('非经验提示词不含五段式', async () => {
    const respond = vi.fn((_p: string, _s: Record<string, unknown>) => ({ memories: [] }));
    await extractMemoriesV2(summary, cls({ preferences: true }), events, { llm: new MockLlm(respond) });
    const prompt = String(respond.mock.calls[0]![0]);
    expect(prompt).not.toContain('## 适用场景');
    expect(prompt).not.toContain('五段式');
  });

  it('非法 type / 越界 seq / 空 quote 丢弃', async () => {
    const llm = new MockLlm(() => ({ memories: [
      { type: 'bogus/type', title: 'x', content: 'y', evidence: [{ seq: 1, quote: 'q'.repeat(20) }] },
      { type: 'experiences/gotcha', title: '越界', content: 'y', evidence: [{ seq: 99, quote: 'q'.repeat(20) }] },
      { type: 'experiences/gotcha', title: '空 quote', content: 'y', evidence: [{ seq: 1, quote: '' }] },
      { type: 'experiences/gotcha', title: '没证据', content: 'y', evidence: [] },
    ] }));
    const r = await extractMemoriesV2(summary, cls({ experiences: true }), events, { llm });
    expect(r).toHaveLength(0);
  });

  it('失败且无纠正的 workflow 候选直接丢弃', async () => {
    const failSummary: SessionSummary = { ...summary, outcome: 'failure', hasCorrection: false };
    const llm = new MockLlm(() => ({ memories: [{ type: 'experiences/workflow', title: '失败流程标题', content: '## 适用场景\nx\n\n## 做法\n运行 `pnpm build`\n\n## 验证\ny\n\n## 边界与反例\nz', evidence: [{ seq: 1, quote: '这里的报错是 ECONNRESET' }] }] }));
    const r = await extractMemoriesV2(failSummary, cls({ experiences: true }), events, { llm });
    expect(r).toHaveLength(0);
  });

  it('secrets 抹除', async () => {
    const llm = new MockLlm(() => ({ memories: [{ type: 'experiences/gotcha', title: '密钥标题', content: '## 适用场景\nx\n\n## 做法\nAWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP\n\n## 验证\ny\n\n## 边界与反例\nz', evidence: [{ seq: 1, quote: '这里的报错是 ECONNRESET' }] }] }));
    const r = await extractMemoriesV2(summary, cls({ experiences: true }), events, { llm });
    expect(r[0]!.content).not.toContain('AKIA');
    expect(r[0]!.content).toContain('REDACTED');
  });
});

describe('hasSensitiveSecret(高置信密钥形态)', () => {
  it('token: string / password: xxx 不算高置信', () => {
    expect(hasSensitiveSecret('const token: string = "x"')).toBe(false);
    expect(hasSensitiveSecret('password: xxx')).toBe(false);
  });

  it('AKIA 密钥与 PEM 私钥块算高置信', () => {
    expect(hasSensitiveSecret('AKIAABCDEFGHIJKLMNOP')).toBe(true);
    expect(hasSensitiveSecret('-----BEGIN RSA PRIVATE KEY-----\nxxx\n-----END RSA PRIVATE KEY-----')).toBe(true);
  });
});
