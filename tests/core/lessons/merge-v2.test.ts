import { describe, it, expect, vi } from 'vitest';
import { mergeMemoriesV2 } from '../../../src/core/lessons/merge.js';
import { MockLlm } from '../../../src/core/lessons/llm.js';
import type { MemoryCandidateV2 } from '../../../src/core/lessons/extract.js';
import type { DecisionGateway, IdentityResult, ExistingForGate } from '../../../src/core/lessons/gateway.js';
import type { LearnConfig } from '../../../src/config.js';

const learn: LearnConfig = { mode: 'auto', autoMigrate: true, quality: { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 }, jev: { maxCallsPerSession: 8, timeoutMs: 2000 } };

const evidence = [{ session: 's1', seq: 1, quote: '足够长的引用内容' }];

function cand(over: Partial<MemoryCandidateV2> = {}): MemoryCandidateV2 {
  return { type: 'experiences/gotcha', title: 'ECONNRESET 时指数退避重试', content: '正文', evidence, ...over };
}

function ex(path: string, type = 'experiences/gotcha', scope?: string): ExistingForGate {
  return { id: 'exp_OLD', path, title: '旧标题', content: '旧正文', type, ...(scope ? { scope } : {}) };
}

function gateway(resolve: (c: unknown, e: ExistingForGate[]) => IdentityResult | Promise<IdentityResult>, captured?: { existing: ExistingForGate[][] }): DecisionGateway {
  return {
    async triageSession() { return { decision: 'accept', confidence: 1, reasons: [], source: 'jev' }; },
    async screenCandidates() { return []; },
    async resolveIdentity(c, e) {
      captured?.existing.push(e);
      return resolve(c, e);
    },
  };
}

describe('mergeMemoriesV2(Gate C → ops + meta)', () => {
  it('add → add op,meta 带 id/kind/evidence', async () => {
    const g = gateway(() => ({ decision: 'add', confidence: 0.9, reasons: [], source: 'jev' }));
    const ops = await mergeMemoriesV2([cand()], [ex('experiences/gotcha-old.md')], { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('add');
    if (ops[0]!.op === 'add') {
      expect(ops[0]!.meta!.kind).toBe('experience');
      expect(ops[0]!.meta!.id.startsWith('exp_')).toBe(true);
      expect(ops[0]!.meta!.evidence).toEqual(evidence);
      expect(ops[0]!.meta!.promptVersion).toBe('exp-v3');
    }
  });

  it('merge → patch op,路径=targetPath,保留旧正文作 before', async () => {
    const g = gateway(() => ({ decision: 'merge', confidence: 0.9, reasons: [], source: 'jev', targetPath: 'experiences/gotcha-old.md', targetId: 'exp_OLD' }));
    const llm = new MockLlm(() => ({ content: '合并后正文' }));
    const ops = await mergeMemoriesV2([cand()], [ex('experiences/gotcha-old.md')], { gateway: g, llm, learn });
    expect(ops[0]!.op).toBe('patch');
    if (ops[0]!.op === 'patch') {
      expect(ops[0]!.path).toBe('experiences/gotcha-old.md');
      expect(ops[0]!.before).toBe('旧正文');
      expect(ops[0]!.content).toBe('合并后正文');
      expect(ops[0]!.meta).toBeDefined();
    }
  });

  it('supersede → add op + archivePath=旧路径 + meta.supersedes', async () => {
    const g = gateway(() => ({ decision: 'supersede', confidence: 0.9, reasons: [], source: 'jev', targetPath: 'experiences/gotcha-old.md', targetId: 'exp_OLD' }));
    const ops = await mergeMemoriesV2([cand()], [ex('experiences/gotcha-old.md')], { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(ops[0]!.op).toBe('add');
    if (ops[0]!.op === 'add') {
      expect(ops[0]!.archivePath).toBe('experiences/gotcha-old.md');
      expect(ops[0]!.meta!.supersedes).toBe('exp_OLD');
    }
  });

  it('escalate → LLM 身份裁决后同分支(merge)', async () => {
    const g = gateway(() => ({ decision: 'escalate', confidence: 0.5, reasons: [], source: 'jev' }));
    const llm = new MockLlm(() => ({ decision: 'merge', reason: '同一意图' }));
    const ops = await mergeMemoriesV2([cand()], [ex('experiences/gotcha-old.md')], { gateway: g, llm, learn });
    expect(ops[0]!.op).toBe('patch');
  });

  it('escalate → LLM 失败回退 add(非破坏性)', async () => {
    const g = gateway(() => ({ decision: 'escalate', confidence: 0.5, reasons: [], source: 'jev' }));
    const llm = new MockLlm(() => { throw new Error('LLM 炸了'); });
    const ops = await mergeMemoriesV2([cand()], [ex('experiences/gotcha-old.md')], { gateway: g, llm, learn });
    expect(ops[0]!.op).toBe('add');
  });

  it('topSimilar 只传同 type 且最多 5 条给网关', async () => {
    const captured: { existing: ExistingForGate[][] } = { existing: [] };
    const existing: ExistingForGate[] = [
      ex('experiences/g-1.md'), ex('experiences/g-2.md'), ex('experiences/g-3.md'),
      ex('experiences/g-4.md'), ex('experiences/g-5.md'), ex('experiences/g-6.md'),
      ex('preferences/profile.md', 'preferences/profile'),
    ];
    const g = gateway(() => ({ decision: 'add', confidence: 1, reasons: [], source: 'jev' }), captured);
    await mergeMemoriesV2([cand()], existing, { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(captured.existing[0]!.length).toBe(5);
    expect(captured.existing[0]!.every((e) => e.type === 'experiences/gotcha')).toBe(true);
  });

  it('topSimilar 过滤 scope 不兼容:不同项目不参与 Gate C', async () => {
    const captured: { existing: ExistingForGate[][] } = { existing: [] };
    const existing = [ex('experiences/g-1.md', 'experiences/gotcha', 'project:a')];
    const g = gateway(() => ({ decision: 'add', confidence: 1, reasons: [], source: 'jev' }), captured);
    await mergeMemoriesV2([cand({ scope: 'project:b' })], existing, { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(captured.existing[0]!.length).toBe(0);
  });

  it('旧 global 记忆可被项目候选合并(scope 兼容)', async () => {
    const captured: { existing: ExistingForGate[][] } = { existing: [] };
    const existing = [ex('experiences/g-1.md', 'experiences/gotcha', 'global')];
    const g = gateway(() => ({ decision: 'add', confidence: 1, reasons: [], source: 'jev' }), captured);
    await mergeMemoriesV2([cand({ scope: 'project:a' })], existing, { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(captured.existing[0]!.length).toBe(1);
  });

  it('add op meta.scope 继承候选 scope', async () => {
    const g = gateway(() => ({ decision: 'add', confidence: 0.9, reasons: [], source: 'jev' }));
    const ops = await mergeMemoriesV2([cand({ scope: 'project:a' })], [], { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(ops[0]!.op).toBe('add');
    if (ops[0]!.op === 'add') expect(ops[0]!.meta!.scope).toBe('project:a');
  });

  it('add op 的 evidence 保留 seq(旧 audit 口径)', async () => {
    const g = gateway(() => ({ decision: 'add', confidence: 0.9, reasons: [], source: 'jev' }));
    const ops = await mergeMemoriesV2([cand()], [], { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(ops[0]!.op).toBe('add');
    if (ops[0]!.op === 'add') expect(ops[0]!.evidence).toEqual([1]);
  });
});

describe('mergeMemoriesV2 · 同路径覆盖防护', () => {
  it('append 类型同路径已存在 → append op', async () => {
    const g = gateway(() => ({ decision: 'add', confidence: 0.9, reasons: [], source: 'jev' }));
    const existing = [ex('resources/docs/x.md', 'resources/doc')];
    const c = cand({ type: 'resources/doc', title: '文档资源标题', content: '新内容', slug: 'x' });
    const ops = await mergeMemoriesV2([c], existing, { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(ops[0]!.op).toBe('append');
    if (ops[0]!.op === 'append') expect(ops[0]!.path).toBe('resources/docs/x.md');
  });

  it('append 类型同路径旧内容已含新正文 → 幂等跳过', async () => {
    const g = gateway(() => ({ decision: 'add', confidence: 0.9, reasons: [], source: 'jev' }));
    const existing = [ex('resources/docs/x.md', 'resources/doc')];
    const c = cand({ type: 'resources/doc', title: '文档资源标题', content: '旧正文', slug: 'x' });
    const ops = await mergeMemoriesV2([c], existing, { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(ops).toHaveLength(0);
  });

  it('patch 类型同路径已存在 → 强制 merge 到该路径,保留旧内容', async () => {
    const g = gateway(() => ({ decision: 'add', confidence: 0.9, reasons: [], source: 'jev' }));
    const llm = new MockLlm(() => ({ content: '合并后正文' }));
    const existing = [ex('experiences/workflow-x.md', 'experiences/workflow')];
    const c = cand({ type: 'experiences/workflow', title: '工作流标题', content: '新内容', slug: 'x' });
    const ops = await mergeMemoriesV2([c], existing, { gateway: g, llm, learn });
    expect(ops[0]!.op).toBe('patch');
    if (ops[0]!.op === 'patch') {
      expect(ops[0]!.path).toBe('experiences/workflow-x.md');
      expect(ops[0]!.before).toBe('旧正文');
      expect(ops[0]!.content).toBe('合并后正文');
    }
  });

  it('add 类型同路径已存在 → 幂等跳过(null)', async () => {
    const g = gateway(() => ({ decision: 'add', confidence: 0.9, reasons: [], source: 'jev' }));
    const existing = [ex('experiences/gotcha-x.md')];
    const c = cand({ slug: 'x' });
    const ops = await mergeMemoriesV2([c], existing, { gateway: g, llm: new MockLlm(() => ({})), learn });
    expect(ops).toHaveLength(0);
  });
});
