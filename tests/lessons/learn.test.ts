import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSessionEvents, runLessonExtraction, learnNewSessions } from '../../src/core/lessons/learn.js';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import { libraryDir, libraryLessonsDir, safeSessionName } from '../../src/core/layout.js';
import { MockLlm } from '../../src/core/lessons/llm.js';
import { MockJev } from '../../src/core/lessons/jev.js';
import type { Event } from '../../src/core/events/schema.js';

let vault: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'lessons-learn-'));
  storage = new LocalStorageAdapter(libraryLessonsDir(vault));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

/** 6 条事件:含 session 头、`改成` 纠正信号、tool_call、失败的 tool_result。ts 距今 10+ 分钟,已结束。 */
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
    mk(1, 'message', { role: 'user', text: '这里不对,脚本退出应该用 set -e,改成 set -e' }),
    mk(2, 'tool_call', { tool: { name: 'Bash', call_id: 'c1' } }),
    mk(3, 'tool_result', { role: 'tool', result: { call_id: 'c1', status: 'ok', output: 'ok' } }),
    mk(4, 'tool_result', { role: 'tool', result: { call_id: 'c2', status: 'error', output: 'command not found' } }),
    mk(5, 'message', { role: 'assistant', text: '好的,已修正' }),
  ];
}

/** 写一个 canonical 会话 jsonl + 统一索引,供 loadSessionEvents/listSessions 使用。 */
async function writeSession(harness: string, session: string, events: Event[]): Promise<void> {
  const dir = join(libraryDir(vault), 'sessions', harness, safeSessionName(session));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'd1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

async function writeIndex(sessions: Array<{ harness: string; session: string; events: Event[] }>): Promise<void> {
  const sessionsMap: Record<string, unknown> = {};
  for (const s of sessions) {
    sessionsMap[`${s.harness}:${s.session}`] = {
      harness: s.harness,
      session: s.session,
      canonical: {
        device: 'd1',
        path: `sessions/${s.harness}/${safeSessionName(s.session)}/d1.jsonl`,
        hash: 'h',
        events: s.events.length,
      },
      variants: [],
      sources: ['d1'],
    };
  }
  const index = { v: 1, generatedAt: new Date().toISOString(), hash: '', sessions: sessionsMap, skills: {} };
  await mkdir(libraryDir(vault), { recursive: true });
  await writeFile(join(libraryDir(vault), 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
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

function mockJev(): MockJev {
  return new MockJev(() => ({ taskSuccess: 1, meanScore: 1 }));
}

describe('learn 入口(Stage 9 编排接入)', () => {
  it('loadSessionEvents 从统一索引解析 canonical 事件', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const events = await loadSessionEvents(vault, 's-1');
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({ kind: 'session', cwd: '/Users/admin/orca/trove' });
  });

  it('loadSessionEvents 裸 session 在多个 harness 下报歧义', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeSession('codex', 's-1', ev);
    await writeIndex([
      { harness: 'claude-code', session: 's-1', events: ev },
      { harness: 'codex', session: 's-1', events: ev },
    ]);

    await expect(loadSessionEvents(vault, 's-1')).rejects.toThrow(/歧义/);
  });

  it('runLessonExtraction 单会话端到端:写记忆文件 + INDEX + audit', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const outcome = await runLessonExtraction(vault, 's-1', { llm: happyLlm(), jev: mockJev() });

    expect(outcome.skipReason).toBeUndefined();
    expect(outcome.diff?.summary.adds).toBe(1);
    expect(await storage.read('experiences/debug-set-e.md')).not.toBeNull();
    expect(await storage.read('INDEX.md')).not.toBeNull();
    expect(await storage.read('audit/s-1.json')).not.toBeNull();
  });

  it('runLessonExtraction 对已审计会话默认跳过,force 强制重跑', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);
    await storage.write('audit/s-1.json', '{}'); // 模拟已学习过

    const skipped = await runLessonExtraction(vault, 's-1', { llm: happyLlm(), jev: mockJev() });
    expect(skipped.skipReason).toBe('already_learned');
    expect(skipped.diff).toBeUndefined();

    const forced = await runLessonExtraction(vault, 's-1', { llm: happyLlm(), jev: mockJev() }, { force: true });
    expect(forced.skipReason).toBeUndefined();
    expect(forced.diff?.summary.adds).toBe(1);
  });

  it('learnNewSessions 按 harness:session 去重,已审计的跳过', async () => {
    const e1 = sampleEvents('s-1');
    const e2 = sampleEvents('s-2');
    await writeSession('claude-code', 's-1', e1);
    await writeSession('claude-code', 's-2', e2);
    await writeIndex([
      { harness: 'claude-code', session: 's-1', events: e1 },
      { harness: 'claude-code', session: 's-2', events: e2 },
    ]);
    // s-2 已提取过:harness:session 审计文件已存在 → 跳过
    await storage.write('audit/claude-code:s-2.json', '{}');

    const res = await learnNewSessions(vault, { llm: happyLlm(), jev: mockJev() });

    expect(res).toMatchObject({ attempted: 1, extracted: 1, skipped: 1, errors: [] });
    expect(await storage.read('audit/claude-code:s-1.json')).not.toBeNull();
    expect(await storage.read('audit/claude-code:s-2.json')).toBe('{}'); // 未被重写
  });

  it('learnNewSessions 裸 session 跨 harness 撞名时各自独立去重', async () => {
    const e1 = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', e1);
    await writeSession('codex', 's-1', e1);
    await writeIndex([
      { harness: 'claude-code', session: 's-1', events: e1 },
      { harness: 'codex', session: 's-1', events: e1 },
    ]);
    // 仅 codex 已提取过
    await storage.write('audit/codex:s-1.json', '{}');

    const res = await learnNewSessions(vault, { llm: happyLlm(), jev: mockJev() });

    expect(res).toMatchObject({ attempted: 1, extracted: 1, skipped: 1, errors: [] });
    expect(await storage.read('audit/claude-code:s-1.json')).not.toBeNull();
    expect(await storage.read('audit/codex:s-1.json')).toBe('{}'); // 未被重写
  });

  it('learnNewSessions 提取失败落标记,后续轮次不再重试', async () => {
    const e1 = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', e1);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: e1 }]);

    const failingLlm = new MockLlm(() => { throw new Error('LLM 炸了'); });
    const res1 = await learnNewSessions(vault, { llm: failingLlm, jev: mockJev() });

    expect(res1).toMatchObject({ attempted: 1, extracted: 0, skipped: 0 });
    expect(res1.errors).toHaveLength(1);
    expect(await storage.read('audit/claude-code:s-1.failed.json')).not.toBeNull();

    // 第二轮:失败标记存在 → 直接跳过,不再重试
    const res2 = await learnNewSessions(vault, { llm: happyLlm(), jev: mockJev() });
    expect(res2).toMatchObject({ attempted: 0, extracted: 0, skipped: 1, errors: [] });
  });
});
