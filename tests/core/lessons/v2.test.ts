import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLessonPipelineV2 } from '../../../src/core/lessons/v2.js';
import type { V2RunDeps } from '../../../src/core/lessons/v2.js';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { MockLlm } from '../../../src/core/lessons/llm.js';
import { parseMemory } from '../../../src/core/lessons/memory.js';
import { readDecisions } from '../../../src/core/lessons/decisions.js';
import { renderEvents } from '../../../src/core/lessons/analyze.js';
import { filterEvents } from '../../../src/core/lessons/select.js';
import type { JevProvider } from '../../../src/core/lessons/jev.js';
import type { LearnConfig } from '../../../src/config.js';
import type { Event } from '../../../src/core/events/schema.js';

let root: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-v2-'));
  storage = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ev(seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event {
  return { v: 1, ts: '2026-01-01T00:00:00.000Z', seq, harness: 'claude-code', session: 'sess-1', kind, ...extra };
}

const events: Event[] = [
  ev(0, 'session', { cwd: '/Users/x/trove' }),
  ev(1, 'message', { role: 'user', text: 'git push 报错 Permission denied (publickey),帮我看看' }),
  ev(2, 'tool_call', { tool: { name: 'Bash' } }),
  ev(3, 'tool_result', { result: { status: 'ok', output: 'ssh -T git@github.com: success' } }),
];

const now = new Date('2026-01-02T00:00:00.000Z');

const EXPERIENCE = {
  type: 'experiences/gotcha',
  title: 'git push 报 Permission denied 需检查 ssh 密钥',
  content: [
    '## 适用场景',
    'Git 推送远端时遇到公钥被拒绝的报错',
    '',
    '## 做法',
    '先运行 `ssh-add -l` 确认密钥是否已加载,再用 `ssh -T git@github.com` 验证连通',
    '',
    '## 验证',
    '密钥加载后 push 命令成功退出,不再报 Permission denied',
    '',
    '## 边界与反例',
    '不适用于 HTTPS 凭证过期或用户名错误的情况',
  ].join('\n'),
  evidence: [{ seq: 1, quote: 'git push 报错 Permission denied' }],
};

function learn(mode: 'shadow' | 'auto'): LearnConfig {
  return { v2: true, mode, quality: { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 }, jev: { maxCallsPerSession: 8, timeoutMs: 2000 } };
}

function jevAllHigh(): JevProvider {
  return {
    async score() { return { taskSuccess: 1, meanScore: 1 }; },
    async keepCalls(_s: unknown, q: Record<string, unknown>): Promise<Record<string, number>> {
      return Object.fromEntries(Object.keys(q).map((k) => [k, 0.95]));
    },
  };
}

/** 按 task 路由的 LLM;memories 为提取阶段的返回候选。 */
function llmFor(memories: unknown[]): MockLlm {
  return new MockLlm((_p, _s, task) => {
    switch (task) {
      case 'learn:summarize':
        return { topic: 'git push', intent: '修复 push 权限报错', outcome: 'success', keySteps: ['ssh-add'], hasError: true, hasCorrection: false, hasWorkflow: true };
      case 'learn:classify':
        return { preferences: false, entities: false, experiences: true, events: false, resources: false };
      case 'learn:trajectory':
        return { task: '调试 git push 权限', outcome: 'success', reusableSignals: ['检查 ssh 密钥是否已加载'] };
      case 'learn:extract':
        return { memories };
      case 'learn:triage':
        return { decision: 'accept' };
      case 'learn:quality':
        return { decision: 'accept' };
      case 'learn:identity':
        return { decision: 'add' };
      case 'learn:merge':
        return { content: '合并后的正文' };
      default:
        throw new Error(`unexpected task ${task}`);
    }
  });
}

function deps(mode: 'shadow' | 'auto', llm: MockLlm, jev: JevProvider): V2RunDeps {
  return { llm, jev, storage, learn: learn(mode), loadEvents: async () => events, now: () => now };
}

/** >15 个 tool_call、文本很长的会话:不加压缩时原始渲染远超 60k。 */
function longEvents(): Event[] {
  const out: Event[] = [ev(0, 'session', { cwd: '/Users/x/trove' })];
  const long = 'y'.repeat(4000);
  let seq = 1;
  out.push(ev(seq++, 'message', { role: 'user', text: 'git push 报错 Permission denied (publickey),帮我看看' }));
  for (let i = 0; i < 20; i++) {
    out.push(ev(seq++, 'tool_call', { tool: { name: 'Bash', call_id: `c${i}` } }));
    out.push(ev(seq++, 'tool_result', { result: { call_id: `c${i}`, status: 'ok', output: long } }));
  }
  return out;
}

/** 只覆盖摘要/分类的 LLM,用于 trivial / no_category 跳过语义。 */
function skipLlm(outcome: 'trivial' | 'success', classification: Record<string, boolean>): MockLlm {
  return new MockLlm((_p, _s, task) => {
    switch (task) {
      case 'learn:summarize':
        return { topic: 't', intent: 'i', outcome, keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false };
      case 'learn:classify':
        return classification;
      default:
        throw new Error(`unexpected task ${task}`);
    }
  });
}

describe('runLessonPipelineV2(端到端)', () => {
  it('auto:写记忆 + 轨迹 + 审计 + 决策日志', async () => {
    const r = await runLessonPipelineV2('sess-1', deps('auto', llmFor([EXPERIENCE]), jevAllHigh()));

    expect(r.shadow).toBe(false);
    expect(r.diff?.summary.adds).toBe(1);

    const files = await storage.list();
    const memPath = files.find((f) => f.startsWith('experiences/') && f.endsWith('.md') && !f.startsWith('experiences/.'));
    expect(memPath).toBeTruthy();
    const mem = parseMemory((await storage.read(memPath!))!);
    expect(mem!.kind).toBe('experience');
    expect(mem!.evidence).toHaveLength(1);
    expect(mem!.sourceTrajectories).toHaveLength(1);
    expect(mem!.body).toContain('## 证据');
    expect(await storage.read(memPath!)).toContain('## 证据');

    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(true);
    expect(await storage.exists('audit/sess-1.json')).toBe(true);
    expect(await storage.exists('memory_diff.json')).toBe(true);

    const decisions = await readDecisions(storage);
    expect(decisions.some((d) => d.stage === 'triage' && d.gate === 'A')).toBe(true);
    expect(decisions.some((d) => d.stage === 'screen' && d.gate === 'B')).toBe(true);
    expect(decisions.some((d) => d.stage === 'identity' && d.gate === 'C')).toBe(true);
  });

  it('shadow:只写 .shadow.json 审计 + 决策,不写记忆/轨迹/标准审计', async () => {
    const r = await runLessonPipelineV2('sess-1', deps('shadow', llmFor([EXPERIENCE]), jevAllHigh()));

    expect(r.shadow).toBe(true);
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/'))).toBe(false);
    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(false);
    expect(await storage.exists('audit/sess-1.shadow.json')).toBe(true);
    expect(await storage.exists('audit/sess-1.json')).toBe(false);
    expect(await storage.exists('memory_diff.json')).toBe(false);

    const audit = JSON.parse((await storage.read('audit/sess-1.shadow.json'))!);
    expect(audit.v2.shadow).toBe(true);
    expect(audit.summary.skips).toBe(1);
    expect(audit.operations.skips[0].reason).toBe('shadow:add');
    expect((await readDecisions(storage)).length).toBeGreaterThan(0);
  });

  it('Gate A 硬拒 → triage_rejected,不写任何记忆/轨迹', async () => {
    const jev: JevProvider = {
      async score() { return { taskSuccess: 1, meanScore: 1 }; },
      async keepCalls(_s: unknown, q: Record<string, unknown>): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(q).map((k) => [k, k === 'has_task' ? 0.2 : 0.9]));
      },
    };
    const r = await runLessonPipelineV2('sess-1', deps('auto', llmFor([EXPERIENCE]), jev));

    expect(r.skipReason).toBe('triage_rejected');
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/'))).toBe(false);
    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(false);
  });

  it('证据不落在事件原文 → 候选被丢弃,adds=0(轨迹仍写)', async () => {
    const bad = { ...EXPERIENCE, evidence: [{ seq: 1, quote: '完全不存在于任何事件里的引用文字' }] };
    const r = await runLessonPipelineV2('sess-1', deps('auto', llmFor([bad]), jevAllHigh()));

    expect(r.shadow).toBe(false);
    expect(r.diff?.summary.adds).toBe(0);
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/'))).toBe(false);
    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(true);
    expect((await readDecisions(storage)).some((d) => d.decision === 'evidence_missing')).toBe(true);
  });

  it('T0 只对高置信密钥形态 skip:token: string 可继续', async () => {
    const evs = [...events, ev(4, 'message', { role: 'user', text: '类型声明 token: string 是常见代码' })];
    const r = await runLessonPipelineV2('sess-1', { ...deps('auto', llmFor([EXPERIENCE]), jevAllHigh()), loadEvents: async () => evs });
    expect(r.skipReason).toBeUndefined();
    expect(r.diff?.summary.adds).toBe(1);
  });

  it('T0 对 AKIA 密钥形态 skip', async () => {
    const evs = [...events, ev(4, 'message', { role: 'user', text: 'AWS 密钥 AKIAABCDEFGHIJKLMNOP 泄露了' })];
    const r = await runLessonPipelineV2('sess-1', { ...deps('auto', llmFor([EXPERIENCE]), jevAllHigh()), loadEvents: async () => evs });
    expect(r.skipReason).toBe('sensitive');
  });

  it('质量自动通过落 stage:quality 决策记录,reasons 带五维概率', async () => {
    await runLessonPipelineV2('sess-1', deps('auto', llmFor([EXPERIENCE]), jevAllHigh()));
    const decisions = await readDecisions(storage);
    const q = decisions.find((d) => d.stage === 'quality' && d.decision === 'quality_auto');
    expect(q).toBeTruthy();
    expect(q!.reasons.map((r) => r.question).sort()).toEqual(['actionable', 'evidence', 'non_duplicate', 'specific', 'transferable']);
  });

  it('Jev 抛错 → 降级启发式,LLM 质量裁决 accept 后仍写记忆', async () => {
    const jev: JevProvider = {
      async score() { return { taskSuccess: 1, meanScore: 1 }; },
      async keepCalls(): Promise<Record<string, number>> { throw new Error('Jev 炸了'); },
    };
    const r = await runLessonPipelineV2('sess-1', deps('auto', llmFor([EXPERIENCE]), jev));

    expect(r.shadow).toBe(false);
    expect(r.diff?.summary.adds).toBe(1);
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/'))).toBe(true);
    const decisions = await readDecisions(storage);
    expect(decisions.some((d) => d.stage === 'triage' && d.source === 'heuristic')).toBe(true);
  });

  it('summary.outcome=trivial → skip trivial,不写记忆/轨迹,落决策痕迹', async () => {
    const r = await runLessonPipelineV2('sess-1', deps('auto', skipLlm('trivial', {}), jevAllHigh()));

    expect(r.skipReason).toBe('trivial');
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/'))).toBe(false);
    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(false);
    expect((await readDecisions(storage)).some((d) => d.decision === 'trivial')).toBe(true);
  });

  it('分类全 false → skip no_category,不写记忆/轨迹,落决策痕迹', async () => {
    const classification = { preferences: false, entities: false, experiences: false, events: false, resources: false };
    const r = await runLessonPipelineV2('sess-1', deps('auto', skipLlm('success', classification), jevAllHigh()));

    expect(r.skipReason).toBe('no_category');
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/'))).toBe(false);
    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(false);
    expect((await readDecisions(storage)).some((d) => d.decision === 'no_category')).toBe(true);
  });

  it('长会话走 Jev 压缩:keepCalls 被调用,摘要/提取 prompt 有界', async () => {
    const evs = longEvents();
    let compactCalls = 0;
    const jev: JevProvider = {
      async score() { return { taskSuccess: 1, meanScore: 1 }; },
      async keepCalls(s: unknown, q: Record<string, unknown>): Promise<Record<string, number>> {
        // 压缩传 renderEvents 字符串,网关传对象:据此区分并只记压缩调用对数
        if (typeof s === 'string') {
          compactCalls = Object.keys(q).length;
          return Object.fromEntries(Object.keys(q).map((k) => [k, 0.1])); // 全丢:压缩后只剩文字
        }
        return Object.fromEntries(Object.keys(q).map((k) => [k, 0.95])); // 网关高分通过
      },
    };
    const promptLens: Record<string, number> = {};
    const llm = new MockLlm((p, _s, task) => {
      promptLens[task ?? ''] = p.length;
      switch (task) {
        case 'learn:summarize':
          return { topic: 'x', intent: 'x', outcome: 'success', keySteps: [], hasError: true, hasCorrection: false, hasWorkflow: true };
        case 'learn:classify':
          return { preferences: false, entities: false, experiences: true, events: false, resources: false };
        case 'learn:trajectory':
          return { task: 't', outcome: 'success', reusableSignals: [] };
        case 'learn:extract':
          return { memories: [EXPERIENCE] };
        case 'learn:triage':
          return { decision: 'accept' };
        case 'learn:quality':
          return { decision: 'accept' };
        case 'learn:identity':
          return { decision: 'add' };
        case 'learn:merge':
          return { content: '合并后的正文' };
        default:
          throw new Error(`unexpected task ${task}`);
      }
    });

    const r = await runLessonPipelineV2('sess-1', { ...deps('auto', llm, jev), loadEvents: async () => evs });

    expect(compactCalls).toBeGreaterThan(15);
    expect(renderEvents(filterEvents(evs)).length).toBeGreaterThan(60000);
    expect(promptLens['learn:summarize']).toBeLessThan(60000);
    expect(promptLens['learn:extract']).toBeLessThan(60000);
    expect(promptLens['learn:summarize']).toBeLessThan(renderEvents(filterEvents(evs)).length);
    expect(r.diff?.summary.adds).toBe(1);
  });

  it('Jev 压缩抛错 → 确定性截断仍跑通', async () => {
    const evs = longEvents();
    const jev: JevProvider = {
      async score() { return { taskSuccess: 1, meanScore: 1 }; },
      async keepCalls(): Promise<Record<string, number>> { throw new Error('Jev 压缩炸了'); },
    };
    const r = await runLessonPipelineV2('sess-1', { ...deps('auto', llmFor([EXPERIENCE]), jev), loadEvents: async () => evs });

    expect(r.skipReason).toBeUndefined();
    expect(r.diff?.summary.adds).toBe(1);
  });
});
