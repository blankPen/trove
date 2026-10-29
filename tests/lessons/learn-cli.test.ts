import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.js';
import { trovePaths } from '../../src/paths.js';
import { libraryDir, libraryLessonsDir, safeSessionName } from '../../src/core/layout.js';
import { buildMemoryDiff, writeMemoryDiff } from '../../src/core/lessons/audit.js';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import type { MemoryOp } from '../../src/core/lessons/merge.js';
import { MockLlm } from '../../src/core/lessons/llm.js';
import { MockJev } from '../../src/core/lessons/jev.js';
import type { Event } from '../../src/core/events/schema.js';

let base: string;
let storage: LocalStorageAdapter;
let lines: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'trove-learn-'));
  storage = new LocalStorageAdapter(libraryLessonsDir(trovePaths(base).vault));
  lines = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function runLearn(args: string[], deps: Parameters<typeof run>[1] = {}): Promise<number> {
  return run(args, {
    base,
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    ...deps,
  });
}

/** 一条可提取出经验的会话事件流:含 `改成` 纠正信号。 */
function sampleEvents(session: string): Event[] {
  const t0 = Date.now() - 11 * 60 * 1000;
  const mk = (seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event => ({
    v: 1,
    ts: new Date(t0 + seq * 1000).toISOString(),
    seq,
    harness: 'claude-code',
    session,
    kind,
    ...extra,
  });
  return [
    mk(0, 'session', { cwd: '/Users/admin/orca/trove' }),
    mk(1, 'message', { role: 'user', text: '这里不对,脚本退出应该用 set -e' }),
    mk(2, 'tool_call', { tool: { name: 'Bash', call_id: 'c1' } }),
    mk(3, 'tool_result', { role: 'tool', result: { call_id: 'c1', status: 'ok', output: 'ok' } }),
    mk(4, 'message', { role: 'assistant', text: '好的,已修正' }),
  ];
}

/** 写一个 canonical 会话 jsonl + 统一索引,供 loadSessionEvents 使用。 */
async function writeSession(harness: string, session: string, events: Event[]): Promise<void> {
  const dir = join(libraryDir(trovePaths(base).vault), 'sessions', harness, safeSessionName(session));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'd1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const index = {
    v: 1,
    generatedAt: new Date().toISOString(),
    hash: '',
    sessions: {
      [`${harness}:${session}`]: {
        harness,
        session,
        canonical: { device: 'd1', path: `sessions/${harness}/${safeSessionName(session)}/d1.jsonl`, hash: 'h', events: events.length },
        variants: [],
        sources: ['d1'],
      },
    },
    skills: {},
  };
  await mkdir(libraryDir(trovePaths(base).vault), { recursive: true });
  await writeFile(join(libraryDir(trovePaths(base).vault), 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
}

/** 按 schema 的 properties 键区分返回的 stage 结果。 */
function happyLlm(): MockLlm {
  return new MockLlm((_prompt, schema) => {
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    if ('keySteps' in props) return { topic: '调试脚本', intent: '修复脚本退出码', outcome: 'success', keySteps: ['改用 set -e'], hasError: true, hasCorrection: true, hasWorkflow: false };
    if ('experiences' in props) return { preferences: false, entities: false, experiences: true, events: false, resources: false };
    if ('memories' in props) return { memories: [{ type: 'experiences/debug_pattern', title: '脚本退出应该用 set -e', content: 'shell 脚本退出时应使用 set -e', slug: 'set-e', evidence: [1] }] };
    if ('conflict' in props) return { conflict: false };
    if ('content' in props) return { content: 'merged' };
    return {};
  });
}

function mockJev(): MockJev {
  return new MockJev(() => ({ taskSuccess: 1, meanScore: 1 }));
}

/** 端到端会话:含调试错误、`改成` 纠正、明确编码偏好三种信号。 */
function richEvents(session: string): Event[] {
  const t0 = Date.now() - 11 * 60 * 1000;
  const mk = (seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event => ({
    v: 1,
    ts: new Date(t0 + seq * 1000).toISOString(),
    seq,
    harness: 'claude-code',
    session,
    kind,
    ...extra,
  });
  return [
    mk(0, 'session', { cwd: '/Users/admin/orca/trove' }),
    mk(1, 'message', { role: 'user', text: '这里不对,脚本退出应该用 set -e,改成 set -e' }),
    mk(2, 'message', { role: 'user', text: '以后所有 shell 脚本都用 set -e,这是我的编码偏好' }),
    mk(3, 'tool_call', { tool: { name: 'Bash', call_id: 'c1' } }),
    mk(4, 'tool_result', { role: 'tool', result: { call_id: 'c1', status: 'error', output: 'command not found' } }),
    mk(5, 'message', { role: 'assistant', text: '好的,已修正' }),
  ];
}

/** 纯闲聊会话:无错误、无纠正,应被 no_learning_signal 过滤。 */
function chatEvents(session: string): Event[] {
  const t0 = Date.now() - 11 * 60 * 1000;
  const mk = (seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event => ({
    v: 1,
    ts: new Date(t0 + seq * 1000).toISOString(),
    seq,
    harness: 'claude-code',
    session,
    kind,
    ...extra,
  });
  return [
    mk(0, 'session', { cwd: '/Users/admin/orca/trove' }),
    mk(1, 'message', { role: 'user', text: '今天天气怎么样?' }),
    mk(2, 'message', { role: 'assistant', text: '今天天气不错' }),
    mk(3, 'message', { role: 'user', text: '周末有什么安排?' }),
    mk(4, 'message', { role: 'assistant', text: '没有特别安排' }),
    mk(5, 'message', { role: 'user', text: '好的,谢谢' }),
  ];
}

/** 端到端 mock:分类同时开偏好与经验;memories 按提示词里的类别标签返回对应记忆。 */
function richLlm(): MockLlm {
  return new MockLlm((prompt, schema) => {
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    if ('keySteps' in props) {
      return { topic: '调试脚本', intent: '修复脚本退出码并固化偏好', outcome: 'success', keySteps: ['改用 set -e'], hasError: true, hasCorrection: true, hasWorkflow: false };
    }
    if ('experiences' in props) {
      return { preferences: true, entities: false, experiences: true, events: false, resources: false };
    }
    if ('memories' in props) {
      if (prompt.includes('「偏好」')) {
        return { memories: [{ type: 'preferences/coding_style', title: 'shell 脚本统一使用 set -e', content: '用户偏好:shell 脚本统一使用 set -e 让错误立即中断', slug: 'set-e-style', evidence: [2] }] };
      }
      return { memories: [{ type: 'experiences/debug_pattern', title: '脚本退出应该用 set -e', content: 'shell 脚本退出时应使用 set -e 让错误立即中断', slug: 'set-e', evidence: [1] }] };
    }
    if ('conflict' in props) return { conflict: false };
    if ('content' in props) return { content: 'merged' };
    return {};
  });
}

/** 纯闲聊 mock:本不应被调用,select 阶段就被 no_learning_signal 过滤。 */
function chatLlm(): MockLlm {
  return new MockLlm(() => ({ topic: '闲聊', intent: '聊天', outcome: 'trivial', keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false }));
}

describe('trove learn --list(Stage 8 查看命令)', () => {
  it('用例 8-2:输出最近一次提取的审计摘要,跳过项带原因', async () => {
    const ops: MemoryOp[] = [
      { op: 'add', type: 'experiences/debug_pattern', path: 'experiences/a.md', title: '新增的经验标题', content: '正文', evidence: [1] },
      { op: 'skip', type: 'experiences/foo', title: '短标题', reason: 'title_too_short' },
    ];
    await writeMemoryDiff(buildMemoryDiff(ops, { sessionId: 'sess-1', project: 'proj' }), storage);

    const code = await runLearn(['learn', '--list']);

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('本次新增 1 条、更新 0 条、追加 0 条、跳过 1 条');
    expect(lines.join('\n')).toContain('新增: 新增的经验标题 (experiences/a.md)');
    expect(lines.join('\n')).toContain('跳过: 短标题（title_too_short）');
  });

  it('用例 8-3:summary 全 0 时显示「本次无新增记忆」而非报错', async () => {
    await writeMemoryDiff(buildMemoryDiff([], { sessionId: 'sess-1', project: 'proj' }), storage);

    const code = await runLearn(['learn', '--list']);

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('本次无新增记忆');
  });

  it('无任何提取记录时给出提示且不报错', async () => {
    const code = await runLearn(['learn', '--list']);

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('尚无提取记录');
  });
});

describe('trove learn <session-id>(Stage 9 单会话提取命令)', () => {
  it('用例 9-1:注入 mock 提供方,对单会话跑通全链路并输出审计摘要', async () => {
    await writeSession('claude-code', 's-1', sampleEvents('s-1'));

    const code = await runLearn(['learn', 's-1'], { lessonDeps: { llm: happyLlm(), jev: mockJev() } });

    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('本次新增 1 条、更新 0 条、追加 0 条、跳过 0 条');
    expect(output).toContain('新增: 脚本退出应该用 set -e (experiences/debug-set-e.md)');
  });
});

describe('全局端到端验收(端到端-1..4)', () => {
  it('端到端-1:调试错误+用户纠正+明确偏好 → debug_pattern(add)+preference(add),审计完整,索引一致', async () => {
    await writeSession('claude-code', 'e2e-1', richEvents('e2e-1'));

    const code = await runLearn(['learn', 'e2e-1'], { lessonDeps: { llm: richLlm(), jev: mockJev() } });

    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('本次新增 2 条、更新 0 条、追加 0 条、跳过 0 条');
    expect(output).toContain('新增: 脚本退出应该用 set -e (experiences/debug-set-e.md)');
    expect(output).toContain('新增: shell 脚本统一使用 set -e (preferences/coding_style.md)');

    const files = (await storage.list()).sort();
    expect(files).toContain('experiences/debug-set-e.md');
    expect(files).toContain('preferences/coding_style.md');
    expect(files).toContain('INDEX.md');
    expect(files).toContain('.overview.md');
    expect(files).toContain('memory_diff.json');
    expect(files).toContain('audit/e2e-1.json');
  });

  it('端到端-2:纯闲聊会话被 no_learning_signal 跳过,不产生记忆文件与审计', async () => {
    await writeSession('claude-code', 'e2e-2', chatEvents('e2e-2'));

    const code = await runLearn(['learn', 'e2e-2'], { lessonDeps: { llm: chatLlm(), jev: mockJev() } });

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('会话未达提取阈值,跳过: no_learning_signal');
    // 只留初始化的骨架文件;无记忆文件、memory_diff 或 audit
    const SKELETON = new Set(['INDEX.md', '.overview.md', 'README.md']);
    const extra = (await storage.list()).filter((f) => !SKELETON.has(f));
    expect(extra).toEqual([]);
    expect(await storage.exists('memory_diff.json')).toBe(false);
  });

  it('端到端-3:同一会话默认第二次跳过,已学习不再重复;--force 重跑则 merge 层幂等不翻倍', async () => {
    await writeSession('claude-code', 'e2e-3', richEvents('e2e-3'));
    const deps = { lessonDeps: { llm: richLlm(), jev: mockJev() } };

    expect(await runLearn(['learn', 'e2e-3'], deps)).toBe(0);
    const files1 = (await storage.list()).sort();

    // 默认第二次:入口去重,直接跳过,不再消耗提取
    lines.length = 0;
    expect(await runLearn(['learn', 'e2e-3'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('该会话已提取过,跳过');

    // --force 重跑:merge 层幂等,add 跳过 / patch 记为更新,文件集不翻倍
    lines.length = 0;
    expect(await runLearn(['learn', 'e2e-3', '--force'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('本次新增 0 条、更新 1 条、追加 0 条、跳过 0 条');
    expect((await storage.list()).sort()).toEqual(files1);
    expect((await storage.list()).filter((f) => f.startsWith('experiences/debug-'))).toEqual(['experiences/debug-set-e.md']);
  });

  it('端到端-4:L0 INDEX → L1 overview → L2 详情三级可读,INDEX 行路径指向真实文件', async () => {
    await writeSession('claude-code', 'e2e-4', richEvents('e2e-4'));

    expect(await runLearn(['learn', 'e2e-4'], { lessonDeps: { llm: richLlm(), jev: mockJev() } })).toBe(0);

    const index = await storage.read('INDEX.md');
    expect(index).not.toBeNull();
    expect(index).toContain('(experiences/debug-set-e.md)');
    expect(index).toContain('(preferences/coding_style.md)');

    const detail = await storage.read('experiences/debug-set-e.md');
    expect(detail).not.toBeNull();
    expect(detail).toContain('type: experiences/debug_pattern');

    const overview = await storage.read('.overview.md');
    expect(overview).not.toBeNull();
    expect(overview).toContain('`preferences/`: 用户偏好（1 个文件）');
    expect(overview).toContain('`experiences/`: 经验库（1 个文件）');
  });
});