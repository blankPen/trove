import { describe, it, expect } from 'vitest';
import { mergeMemories } from '../../src/core/lessons/merge.js';
import { MockLlm } from '../../src/core/lessons/llm.js';
import { buildFilename, getMemoryType } from '../../src/core/lessons/schema.js';
import type { MemoryCandidate } from '../../src/core/lessons/extract.js';
import type { ExistingMemory } from '../../src/core/lessons/merge.js';

function cand(partial: Partial<MemoryCandidate> & { type: string; title: string }): MemoryCandidate {
  return { content: '正文', evidence: [1], ...partial };
}

describe('合并与冲突处理(Stage 6)', () => {
  it('用例 6-1:新 debug_pattern,无同类 → add 指向正式目录新文件', async () => {
    const llm = new MockLlm(() => ({}));
    const ops = await mergeMemories([cand({ type: 'experiences/debug_pattern', title: 'ECONNRESET 时指数退避重试' })], [], { llm });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('add');
    expect(ops[0]!.path).toMatch(/^experiences\/debug-/);
  });

  it('用例 6-2:writing_style 有同类 → patch 合并新旧,不丢内容', async () => {
    const llm = new MockLlm(() => ({ content: '回复用简体中文;技术名词可保留英文' }));
    const existing: ExistingMemory[] = [{ type: 'preferences/writing_style', path: 'preferences/writing_style.md', title: '写作风格', content: '回复用简体中文' }];
    const ops = await mergeMemories([cand({ type: 'preferences/writing_style', title: '简体中文回复，技术名词可保留英文' })], existing, { llm });
    expect(ops[0]!.op).toBe('patch');
    expect(ops[0]!.path).toBe('preferences/writing_style.md');
    if (ops[0]!.op === 'patch') {
      expect(ops[0]!.content).toContain('简体中文');
      expect(ops[0]!.content).toContain('英文');
    }
  });

  it('用例 6-3:结论冲突 → 新记忆 add,旧记忆进 archive(superseded_by)', async () => {
    const llm = new MockLlm(() => ({ conflict: true, path: 'experiences/correction-should-use-set-x.md' }));
    const existing: ExistingMemory[] = [{ type: 'experiences/correction', path: 'experiences/correction-should-use-set-x.md', title: '脚本应该用 set -x 退出', content: '脚本应该用 set -x' }];
    const ops = await mergeMemories([cand({ type: 'experiences/correction', title: '脚本应该用 set -e 退出' })], existing, { llm });
    expect(ops[0]!.op).toBe('add');
    if (ops[0]!.op === 'add') {
      expect(ops[0]!.supersedePath).toBe('experiences/correction-should-use-set-x.md');
    }
  });

  it('用例 6-4:标题 <10 字符 → skip,不落盘', async () => {
    const llm = new MockLlm(() => ({}));
    const ops = await mergeMemories([cand({ type: 'experiences/gotcha', title: '太短了' })], [], { llm });
    expect(ops[0]!.op).toBe('skip');
  });

  it('append 类:有同路径则追加,无则 add', async () => {
    const llm = new MockLlm(() => ({}));
    const existing: ExistingMemory[] = [{ type: 'resources/doc', path: 'resources/docs/readme.md', title: 'README', content: '旧' }];
    const ops = await mergeMemories([cand({ type: 'resources/doc', title: '非常有用的文档资源合集', slug: 'readme' })], existing, { llm });
    expect(ops[0]!.op).toBe('append');
    expect(ops[0]!.path).toBe('resources/docs/readme.md');
  });

  it('append 类:相同正文重复候选 → 幂等跳过,不重复追加', async () => {
    const llm = new MockLlm(() => ({}));
    const existing: ExistingMemory[] = [{ type: 'resources/doc', path: 'resources/docs/readme.md', title: 'README', content: '已有条目' }];
    const ops = await mergeMemories([cand({ type: 'resources/doc', title: '非常有用的文档资源合集', slug: 'readme', content: '已有条目' })], existing, { llm });
    expect(ops).toHaveLength(0);
  });

  it('用例 6-5:add 类同路径重复候选 → 幂等跳过,不产生重复 add', async () => {
    const llm = new MockLlm(() => ({ conflict: true })); // 即便 LLM 报冲突,同路径也应直接跳过
    const title = 'Event Loop Starvation 时导致的假死';
    const type = 'experiences/gotcha';
    const path = buildFilename(getMemoryType(type)!, { title });
    const existing: ExistingMemory[] = [{ type, path, title, content: '已有内容' }];
    const ops = await mergeMemories([cand({ type, title })], existing, { llm });
    expect(ops).toHaveLength(0);
  });
});
