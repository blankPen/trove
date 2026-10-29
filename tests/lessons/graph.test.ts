import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { buildLessonGraph } from '../../src/core/lessons/graph.js';
import type { LessonDeps } from '../../src/core/lessons/graph.js';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import { MockLlm } from '../../src/core/lessons/llm.js';
import { MockJev } from '../../src/core/lessons/jev.js';
import type { Event } from '../../src/core/events/schema.js';

let root: string;
let store: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-graph-'));
  store = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 6 条事件:含 session 头、`改成` 纠正信号、tool_call、失败的 tool_result。ts 距今 10+ 分钟,已结束。 */
function sampleEvents(): Event[] {
  const t0 = Date.now() - 11 * 60 * 1000;
  const mk = (seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event => ({
    v: 1,
    ts: new Date(t0 + seq * 1000).toISOString(),
    seq,
    harness: 'claude-code',
    session: 's-1',
    kind,
    ...extra,
  });
  return [
    mk(0, 'session', { cwd: '/Users/admin/orca/trove' }),
    mk(1, 'message', { role: 'user', text: '这里不对,脚本退出应该用 set -e,改成 set -e' }),
    mk(2, 'tool_call', { tool: { name: 'Bash', call_id: 'c1' } }),
    mk(3, 'tool_result', { role: 'tool', result: { call_id: 'c1', status: 'ok', output: 'ok' } }),
    mk(4, 'tool_result', { role: 'tool', result: { call_id: 'c2', status: 'error', output: 'command not found' } }),
    mk(5, 'message', { role: 'assistant', text: '好的,已修正' }),
  ];
}

/** 按 schema 的 properties 键区分要返回的 stage 结果,走通完整 happy path。 */
function happyLlm(): MockLlm {
  return new MockLlm((_prompt, schema) => {
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    if ('keySteps' in props) {
      return { topic: '调试脚本', intent: '修复脚本退出码', outcome: 'success', keySteps: ['改用 set -e'], hasError: true, hasCorrection: true, hasWorkflow: false };
    }
    if ('experiences' in props) return { preferences: false, entities: false, experiences: true, events: false, resources: false };
    if ('memories' in props) {
      return { memories: [{ type: 'experiences/debug_pattern', title: '脚本退出应该用 set -e', content: 'shell 脚本退出时应使用 set -e 让错误立即中断', slug: 'set-e', evidence: [1] }] };
    }
    if ('conflict' in props) return { conflict: false };
    if ('content' in props) return { content: 'merged' };
    return {};
  });
}

/** 摘要 outcome=trivial → 阶段 4 过滤,不产生任何文件。 */
function trivialLlm(): MockLlm {
  return new MockLlm(() => ({ topic: '闲聊', intent: '聊天', outcome: 'trivial', keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false }));
}

function deps(llm: MockLlm): LessonDeps {
  return { llm, jev: new MockJev(() => ({ taskSuccess: 1, meanScore: 1 })), storage: store, loadEvents: async () => sampleEvents() };
}

describe('阶段 9:langgraph 编排提取流水线', () => {
  it('用例 9-1:单会话跑通全链路 → 记忆文件 + INDEX + overview + memory_diff + audit', async () => {
    const graph = buildLessonGraph(deps(happyLlm()));
    const out = await graph.invoke({ sessionId: 's-1' });
    expect(out.skip).toBeUndefined();
    expect(out.diff?.summary.adds).toBe(1);
    const files = (await store.list()).sort();
    expect(files).toContain('experiences/debug-set-e.md');
    expect(await store.read('experiences/debug-set-e.md')).toContain('source: "s-1"');
    expect(files).toContain('INDEX.md');
    expect(files).toContain('.overview.md');
    expect(files).toContain('memory_diff.json');
    expect(files).toContain('audit/s-1.json');
  });

  it('用例 9-2:同一会话重复 learn → 0 新增,文件集不变', async () => {
    const d = deps(happyLlm());
    const graph = buildLessonGraph(d);
    await graph.invoke({ sessionId: 's-1' });
    const before = (await store.list()).sort();
    const out2 = await graph.invoke({ sessionId: 's-1' });
    expect(out2.diff?.summary.adds).toBe(0);
    expect(out2.result?.added).toHaveLength(0);
    expect((await store.list()).sort()).toEqual(before);
  });

  it('用例 9-4:合并前中断 → 续跑等价一次性,已写文件不重复 add', async () => {
    const graph = buildLessonGraph(deps(happyLlm()), { checkpointer: new MemorySaver(), interruptBefore: ['merge'] });
    const thread = { configurable: { thread_id: 't1' } };
    const p1 = await graph.invoke({ sessionId: 's-1' }, thread);
    expect(p1.candidates).toBeDefined();
    expect(p1.diff).toBeUndefined(); // 中断于 merge 之前
    expect(p1.ops).toBeUndefined();
    const p2 = await graph.invoke(null, thread);
    expect(p2.diff?.summary.adds).toBe(1);
    expect(await store.read('experiences/debug-set-e.md')).not.toBeNull();
    // 续跑后文件只写一次:同一会话语义不翻倍
    expect(p2.result?.added).toEqual(['experiences/debug-set-e.md']);
  });

  it('未达阈值(trivial)的会话 → 不产生任何文件与索引变更', async () => {
    const graph = buildLessonGraph(deps(trivialLlm()));
    const out = await graph.invoke({ sessionId: 's-1' });
    expect(out.skip?.reason).toBe('trivial');
    expect(out.diff).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});