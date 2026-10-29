import { describe, it, expect, vi } from 'vitest';
import { getMemoryType, listMemoryTypes } from '../../src/core/lessons/schema.js';
import { extractMemories } from '../../src/core/lessons/extract.js';
import { MockLlm } from '../../src/core/lessons/llm.js';
import type { SessionSummary, Classification } from '../../src/core/lessons/analyze.js';
import type { Event } from '../../src/core/events/schema.js';

function cls(partial: Partial<Classification>): Classification {
  return { preferences: false, entities: false, experiences: false, events: false, resources: false, ...partial };
}

const summary: SessionSummary = {
  topic: 't', intent: 'i', outcome: 'success', keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false,
};

const events: Event[] = [
  { v: 1, ts: '2026-01-01T00:00:00.000Z', seq: 1, harness: 'claude-code', session: 's1', kind: 'message', role: 'user', text: '以后都用简体中文' },
];

describe('preferences 提取口径(任务 4)', () => {
  it('profile 提示词聚焦用户画像六个维度', () => {
    const p = getMemoryType('preferences/profile')!;
    expect(p).toBeDefined();
    for (const kw of ['我是谁', '年龄', '职责', '工作背景', '人际关系', '当前使用用户']) {
      expect(p.extractionPrompt).toContain(kw);
    }
  });

  it('其余偏好类型各司其职:编码/写作/对话风格与最近事项', () => {
    const map = {
      'preferences/coding_style': '编码风格',
      'preferences/writing_style': '写作风格',
      'preferences/dialogue_style': '对话风格',
      'preferences/recent_matters': '最近事项',
    } as const;
    for (const [key, kw] of Object.entries(map)) {
      const t = getMemoryType(key)!;
      expect(t, key).toBeDefined();
      expect(t.extractionPrompt).toContain(kw);
      expect(t.mergePrompt, key).toBeTruthy();
      expect(t.filename).toBe(`preferences/${key.split('/')[1]}.md`);
    }
  });

  it('preferences 只保留新五类,reply_format 已移除', () => {
    const keys = listMemoryTypes().filter((t) => t.category === 'preferences').map((t) => t.key).sort();
    expect(keys).toEqual([
      'preferences/coding_style',
      'preferences/dialogue_style',
      'preferences/profile',
      'preferences/recent_matters',
      'preferences/writing_style',
    ]);
  });

  it('recent_matters 合并提示词保留「近期」时效语义', () => {
    const t = getMemoryType('preferences/recent_matters')!;
    expect(t.mergePrompt).toContain('近期');
  });

  it('偏好类提取提示词注入各 type 的提取口径(画像维度进入 LLM)', async () => {
    const respond = vi.fn((_p: string, _s: Record<string, unknown>) => ({ memories: [] }));
    await extractMemories(summary, cls({ preferences: true }), events, { llm: new MockLlm(respond) });
    const prompt = String(respond.mock.calls[0]![0]);
    expect(prompt).toContain('我是谁');
    expect(prompt).toContain('编码风格');
    expect(prompt).toContain('对话风格');
    expect(prompt).toContain('最近事项');
  });
});