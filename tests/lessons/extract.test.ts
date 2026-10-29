import { describe, it, expect, vi } from 'vitest';
import { extractMemories, scrubSecrets } from '../../src/core/lessons/extract.js';
import { MockLlm } from '../../src/core/lessons/llm.js';
import type { SessionSummary, Classification } from '../../src/core/lessons/analyze.js';
import type { Event, EventKind } from '../../src/core/events/schema.js';

function ev(seq: number, kind: EventKind, extra: Partial<Event> = {}): Event {
  return { v: 1, ts: '2026-01-01T00:00:00.000Z', seq, harness: 'claude-code', session: 's1', kind, ...extra };
}

const summary: SessionSummary = {
  topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: true, hasCorrection: true, hasWorkflow: false,
};

function cls(partial: Partial<Classification>): Classification {
  return { preferences: false, entities: false, experiences: false, events: false, resources: false, ...partial };
}

const events = [
  ev(0, 'session'),
  ev(1, 'message', { role: 'user', text: '以后回复都用简体中文' }),
  ev(2, 'tool_result', { result: { status: 'error', output: 'ECONNRESET' } }),
];

describe('记忆提取(Stage 5)', () => {
  it('用例 5-1:分类只开 preferences → 产出 writing_style 候选带 evidence', async () => {
    const llm = new MockLlm(() => ({ memories: [{ type: 'preferences/writing_style', title: '回复用简体中文', content: '用户希望回复用简体中文', evidence: [1] }] }));
    const r = await extractMemories(summary, cls({ preferences: true }), events, { llm });
    expect(r).toHaveLength(1);
    expect(r[0]!.type).toBe('preferences/writing_style');
    expect(r[0]!.evidence).toEqual([1]);
  });

  it('用例 5-2:entities=false → 不执行实体提取', async () => {
    const respond = vi.fn((_prompt: string, _schema: Record<string, unknown>) => ({ memories: [] }));
    await extractMemories(summary, cls({ preferences: true }), events, { llm: new MockLlm(respond) });
    expect(respond).toHaveBeenCalledOnce();
    expect(String(respond.mock.calls[0]![0])).not.toContain('实体');
  });

  it('用例 5-3:敏感值被抹除,不含密钥', async () => {
    const llm = new MockLlm(() => ({ memories: [{ type: 'experiences/gotcha', title: '密钥', content: 'AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP', evidence: [1] }] }));
    const r = await extractMemories(summary, cls({ experiences: true }), events, { llm });
    expect(r[0]!.content).not.toContain('AKIA');
    expect(r[0]!.content).toContain('REDACTED');
  });

  it('用例 5-4:纠正 → correction 类型,evidence 指向纠正事件', async () => {
    const llm = new MockLlm(() => ({ memories: [{ type: 'experiences/correction', title: '应该用 set -e', content: '脚本里应该用 set -e', evidence: [1] }] }));
    const r = await extractMemories(summary, cls({ experiences: true }), events, { llm });
    expect(r[0]!.type).toBe('experiences/correction');
    expect(r[0]!.evidence).toEqual([1]);
  });

  it('已有记忆作为上下文传入提取提示词', async () => {
    const respond = vi.fn((_prompt: string, _schema: Record<string, unknown>) => ({ memories: [] }));
    await extractMemories(summary, cls({ preferences: true }), events, { llm: new MockLlm(respond), existing: '已有:回复用简体中文' });
    expect(String(respond.mock.calls[0]![0])).toContain('已有:回复用简体中文');
  });

  it('提取提示词与 schema 要求 content 输出结构化 Markdown 而非整段纯文本', async () => {
    const respond = vi.fn((_prompt: string, _schema: Record<string, unknown>) => ({ memories: [] }));
    await extractMemories(summary, cls({ preferences: true }), events, { llm: new MockLlm(respond) });

    expect(String(respond.mock.calls[0]![0])).toContain('结构化 Markdown');

    const schema = respond.mock.calls[0]![1] as { properties: { memories: { items: { properties: { content: { description?: string } } } } } };
    expect(schema.properties.memories.items.properties.content.description).toContain('结构化');
  });

  it('evidence 越界或非法类型被丢弃', async () => {
    const llm = new MockLlm(() => ({ memories: [
      { type: 'experiences/gotcha', title: 'evidence 越界', content: 'x', evidence: [99] },
      { type: 'bogus/type', title: '非法类型', content: 'y', evidence: [1] },
    ] }));
    const r = await extractMemories(summary, cls({ experiences: true }), events, { llm });
    expect(r).toHaveLength(0);
  });

  it('scrubSecrets 抹除密码/token/密钥形态', () => {
    expect(scrubSecrets('password=abc123 token=xyz')).not.toContain('abc123');
    expect(scrubSecrets('password=abc123 token=xyz')).toContain('REDACTED');
  });

  it('resources 类别提示词强制 content 含来源 URL/文件路径,可完全溯源', async () => {
    const respond = vi.fn((_prompt: string, _schema: Record<string, unknown>) => ({ memories: [] }));
    await extractMemories(summary, cls({ resources: true }), events, { llm: new MockLlm(respond) });
    expect(String(respond.mock.calls[0]![0])).toContain('来源');
  });
});
