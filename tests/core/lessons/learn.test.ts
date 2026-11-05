import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSessionEvents, runLessonExtraction, learnPendingBatch, learnRecentBatch, recentUnlearnedKeys, hashSessionContent, enqueueLearnSessions, migrateJsonQueue } from '../../../src/core/lessons/learn.js';
import { JobQueue } from '../../../src/core/lessons/jobs.js';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { libraryDir, libraryLessonsDir, safeSessionName } from '../../../src/core/layout.js';
import { MockLlm, LlmParseError } from '../../../src/core/lessons/llm.js';
import { parseMemory } from '../../../src/core/lessons/memory.js';
import type { JevProvider } from '../../../src/core/lessons/jev.js';
import type { Event } from '../../../src/core/events/schema.js';

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

async function writeIndex(sessions: Array<{ harness: string; session: string; events: Event[]; startedAt?: string }>): Promise<void> {
  const sessionsMap: Record<string, unknown> = {};
  for (const s of sessions) {
    sessionsMap[`${s.harness}:${s.session}`] = {
      harness: s.harness,
      session: s.session,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
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

/** v2 单轨配置。 */
function learnCfg(mode: 'auto' | 'shadow' | 'off' | 'review') {
  return { learn: { mode, autoMigrate: true, quality: { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 }, jev: { maxCallsPerSession: 8, timeoutMs: 2000 } } };
}

/** 直接入队(绕过会话文件哈希),contentHash 用 key 推导,便于断言唯一键去重。 */
function enq(queue: JobQueue, keys: string[]): number {
  return queue.enqueue(keys.map((k) => ({ sessionKey: k, contentHash: `h-${k}` })));
}

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** v2 Jev:score 全高、keepCalls 全高,通过 Gate A/B。 */
function v2Jev(): JevProvider {
  return {
    async score() { return { taskSuccess: 1, meanScore: 1 }; },
    async keepCalls(_s: unknown, q: Record<string, { instructions: string }>): Promise<Record<string, number>> {
      return Object.fromEntries(Object.keys(q).map((k) => [k, 0.95]));
    },
  };
}

/** v2 LLM:按 task 路由,走通 auto 全链路(摘要→分类→轨迹→提取→质量/身份裁决)。 */
function v2Llm(): MockLlm {
  return new MockLlm((_p, _s, task) => {
    switch (task) {
      case 'learn:summarize':
        return { topic: '脚本退出码', intent: '修复脚本退出码', outcome: 'success', keySteps: ['set -e'], hasError: true, hasCorrection: true, hasWorkflow: false };
      case 'learn:classify':
        return { preferences: false, entities: false, experiences: true, events: false, resources: false };
      case 'learn:trajectory':
        return { task: '调试脚本退出码', outcome: 'success', reusableSignals: ['用 set -e 立即中断'] };
      case 'learn:extract':
        return { memories: [{ type: 'experiences/debug_pattern', title: '脚本退出应该用 set -e', content: '## 适用场景\nshell 脚本需要失败即中断的场景\n\n## 做法\n在脚本开头运行 `set -e`\n\n## 验证\n后续命令出错时脚本立即退出\n\n## 边界与反例\n不适用于需要忽略单个命令失败的场景', evidence: [{ seq: 1, quote: '脚本退出应该用 set -e' }] }] };
      case 'learn:triage':
        return { decision: 'accept' };
      case 'learn:quality':
        return { decision: 'accept' };
      case 'learn:identity':
        return { decision: 'add' };
      case 'learn:merge':
        return { content: 'merged' };
      default:
        throw new Error(`unexpected task ${task}`);
    }
  });
}

/** 摘要 outcome=trivial 的 LLM,用于验证跳过语义。 */
function trivialLlm(): MockLlm {
  return new MockLlm((_p, _s, task) => {
    if (task === 'learn:summarize') return { topic: '闲聊', intent: '聊天', outcome: 'trivial', keySteps: [], hasError: false, hasCorrection: false, hasWorkflow: false };
    throw new Error(`unexpected task ${task}`);
  });
}

describe('learn 入口(v2 单轨编排)', () => {
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

  it('runLessonExtraction 单会话端到端(auto):写 v2 记忆 + 轨迹 + INDEX + audit', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const outcome = await runLessonExtraction(vault, 's-1', { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') });

    expect(outcome.skipReason).toBeUndefined();
    expect(outcome.shadow).toBe(false);
    expect(outcome.diff?.summary.adds).toBe(1);
    const files = await storage.list();
    const memPath = files.find((f) => f.startsWith('experiences/') && !f.startsWith('experiences/.'));
    expect(memPath).toBeTruthy();
    expect(await storage.read(memPath!)).toContain('kind: experience');
    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(true);
    expect(await storage.read('INDEX.md')).not.toBeNull();
    expect(await storage.read('audit/s-1.json')).not.toBeNull();
  });

  it('auto 模式正式学习前自动迁移旧 v1 记忆一次,落迁移标记', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);
    // 一条 v1 旧记忆(无 id);类型与本会话提取的 experiences 无关,避免被 Gate C 合并。
    await storage.write(
      'preferences/style.md',
      [
        '---',
        'type: preferences/coding_style',
        'title: "旧标题"',
        'tags: ["preferences"]',
        'scope: global',
        'created_at: "2026-01-01T00:00:00.000Z"',
        'updated_at: "2026-01-01T00:00:00.000Z"',
        '---',
        '',
        '旧正文内容',
      ].join('\n'),
    );

    const outcome = await runLessonExtraction(vault, 's-1', { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') });

    expect(outcome.skipReason).toBeUndefined();
    expect(await storage.exists('.trove/migrated-v2.json')).toBe(true);
    const mem = parseMemory((await storage.read('preferences/style.md'))!)!;
    expect(mem.id.startsWith('pref_')).toBe(true);
    expect(mem.body).toBe('旧正文内容');
  });

  it('runLessonExtraction 对已审计会话默认跳过,force 强制重跑', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);
    await storage.write('audit/s-1.json', '{}'); // 模拟已学习过

    const skipped = await runLessonExtraction(vault, 's-1', { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') });
    expect(skipped.skipReason).toBe('already_learned');
    expect(skipped.diff).toBeUndefined();

    const forced = await runLessonExtraction(vault, 's-1', { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') }, { force: true });
    expect(forced.skipReason).toBeUndefined();
    expect(forced.diff?.summary.adds).toBe(1);
  });

  it('runLessonExtraction 摘要 trivial 跳过 → 落 skipped 标记,不写记忆', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const outcome = await runLessonExtraction(vault, 's-1', { llm: trivialLlm(), jev: v2Jev(), config: learnCfg('auto') });

    expect(outcome.skipReason).toBe('trivial');
    expect(await storage.read('audit/s-1.skipped.json')).not.toBeNull();
    expect(await storage.read('audit/s-1.json')).toBeNull();
  });

  it('runLessonExtraction LLM 返回无法解析为 JSON → 落 skipped(忽略),不记失败', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const parseFailingLlm = new MockLlm(() => { throw new LlmParseError('LLM 返回无法解析为 JSON:xxx'); });
    const outcome = await runLessonExtraction(vault, 's-1', { llm: parseFailingLlm, jev: v2Jev(), config: learnCfg('auto') });

    expect(outcome.skipReason).toBe('llm_parse_failed');
    expect(await storage.read('audit/s-1.skipped.json')).not.toBeNull();
    expect(await storage.read('audit/s-1.failed.json')).toBeNull();
    expect(await storage.read('audit/s-1.json')).toBeNull();
  });

  it('runLessonExtraction 进行中(in_progress)跳过 → 不落 skipped 标记,可重复触发', async () => {
    const t0 = Date.now() - 2 * 60 * 1000; // 2 分钟前,仍在进行
    const mk = (seq: number, kind: Event['kind'], extra: Partial<Event> = {}): Event => ({
      v: 1,
      ts: new Date(t0 + seq * 1000).toISOString(),
      seq,
      harness: 'claude-code',
      session: 's-1',
      kind,
      ...extra,
    });
    const ev = [
      mk(0, 'session', { cwd: '/tmp' }),
      mk(1, 'message', { role: 'user', text: '在吗' }),
      mk(2, 'message', { role: 'assistant', text: '在' }),
    ];
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const outcome = await runLessonExtraction(vault, 's-1', { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') });

    expect(outcome.skipReason).toBe('in_progress');
    expect(await storage.read('audit/s-1.skipped.json')).toBeNull();
    expect(await storage.read('audit/s-1.json')).toBeNull();
  });

  it('shadow 模式:只写 shadow 审计,不写记忆/轨迹/标准审计', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const outcome = await runLessonExtraction(vault, 's-1', { llm: v2Llm(), jev: v2Jev(), config: learnCfg('shadow') });

    expect(outcome.shadow).toBe(true);
    const files = await storage.list();
    expect(files.some((f) => f.startsWith('experiences/') && !f.startsWith('experiences/.'))).toBe(false);
    expect(files.some((f) => f.startsWith('trajectories/'))).toBe(false);
    expect(await storage.read('audit/s-1.shadow.json')).not.toBeNull();
    expect(await storage.read('audit/s-1.json')).toBeNull();
  });

  it('learnPendingBatch 只处理队列里的候选,已审计跳过,处理完落终态', async () => {
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
    const queue = JobQueue.open(join(vault, 'learn.db'));
    enq(queue, ['claude-code:s-1', 'claude-code:s-2']);

    const note = await learnPendingBatch(vault, queue, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') }, 10);

    expect(note).toContain('新增 1');
    expect(note).toContain('跳过 1');
    expect(await storage.read('audit/claude-code:s-1.json')).not.toBeNull();
    expect(await storage.read('audit/claude-code:s-2.json')).toBe('{}'); // 未被重写
    expect(queue.stats()).toMatchObject({ done: 1, skipped: 1, queued: 0 });
    queue.close();
  });

  it('learnPendingBatch 裸 session 跨 harness 撞名时各自独立去重', async () => {
    const e1 = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', e1);
    await writeSession('codex', 's-1', e1);
    await writeIndex([
      { harness: 'claude-code', session: 's-1', events: e1 },
      { harness: 'codex', session: 's-1', events: e1 },
    ]);
    // 仅 codex 已提取过
    await storage.write('audit/codex:s-1.json', '{}');
    const queue = JobQueue.open(join(vault, 'learn.db'));
    enq(queue, ['claude-code:s-1', 'codex:s-1']);

    const note = await learnPendingBatch(vault, queue, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') }, 10);

    expect(note).toContain('新增 1');
    expect(note).toContain('跳过 1');
    expect(await storage.read('audit/claude-code:s-1.json')).not.toBeNull();
    expect(await storage.read('audit/codex:s-1.json')).toBe('{}'); // 未被重写
    queue.close();
  });

  it('learnPendingBatch 按 batch 限量,只处理前 N 个候选,其余留在队列', async () => {
    for (let i = 1; i <= 5; i++) await storage.write(`audit/claude-code:s-${i}.json`, '{}');
    const queue = JobQueue.open(join(vault, 'learn.db'));
    enq(queue, ['s-1', 's-2', 's-3', 's-4', 's-5'].map((s) => `claude-code:${s}`));

    const note = await learnPendingBatch(vault, queue, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') }, 3);

    expect(note).toContain('跳过 3');
    expect(note).toContain('待办 2');
    expect(queue.stats()).toMatchObject({ skipped: 3, queued: 2 });
    queue.close();
  });

  it('learnPendingBatch 空队列直接返回 undefined,不触碰 providers', async () => {
    const queue = JobQueue.open(join(vault, 'learn.db'));
    const note = await learnPendingBatch(vault, queue, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') }, 10);
    expect(note).toBeUndefined();
    queue.close();
  });

  it('learnPendingBatch 提取失败落 retry_wait,可退避重试', async () => {
    const e1 = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', e1);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: e1 }]);
    const queue = JobQueue.open(join(vault, 'learn.db'));
    enq(queue, ['claude-code:s-1']);

    const failingLlm = new MockLlm(() => { throw new Error('LLM 炸了'); });
    const note = await learnPendingBatch(vault, queue, { llm: failingLlm, jev: v2Jev(), config: learnCfg('auto') }, 10);

    expect(note).toContain('失败 1');
    expect(note).toContain('待办 1');
    expect(queue.stats()).toMatchObject({ retryWait: 1, done: 0, dead: 0 });
    queue.close();
  });

  it('learnPendingBatch off 模式打印关闭提示,不动队列', async () => {
    const queue = JobQueue.open(join(vault, 'learn.db'));
    enq(queue, ['claude-code:s-1']);

    const note = await learnPendingBatch(vault, queue, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('off') }, 10);

    expect(note).toBe('learn 已关闭（learn.mode=off）');
    expect(queue.stats()).toMatchObject({ queued: 1 });
    queue.close();
  });
});

describe('入队与会话哈希', () => {
  it('hashSessionContent 稳定,内容变化后哈希变化', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);

    const h1 = await hashSessionContent(vault, 'claude-code:s-1');
    const h2 = await hashSessionContent(vault, 'claude-code:s-1');
    expect(h1).toBe(h2);

    // 追加一行 → 内容变化 → 哈希变化
    const dir = join(libraryDir(vault), 'sessions', 'claude-code', safeSessionName('s-1'));
    await writeFile(join(dir, 'd1.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n' + JSON.stringify(ev[0]) + '\n', 'utf8');
    expect(await hashSessionContent(vault, 'claude-code:s-1')).not.toBe(h1);
  });

  it('hashSessionContent 索引缺失回退 sha256(sessionKey)', async () => {
    expect(await hashSessionContent(vault, 'claude-code:s-x')).toBe(sha256hex('claude-code:s-x'));
  });

  it('enqueueLearnSessions 重复入队不增(唯一键幂等)', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);
    const queue = JobQueue.open(join(vault, 'learn.db'));

    expect(await enqueueLearnSessions(vault, queue, ['claude-code:s-1'])).toBe(1);
    expect(await enqueueLearnSessions(vault, queue, ['claude-code:s-1'])).toBe(0);
    expect(queue.stats().queued).toBe(1);
    queue.close();
  });

  it('migrateJsonQueue 读旧 JSON 入队并改名 .migrated;文件不存在返回 0', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: ev }]);
    const jsonPath = join(vault, 'learn-queue.json');
    await writeFile(jsonPath, JSON.stringify(['claude-code:s-1'], null, 2) + '\n', 'utf8');
    const queue = JobQueue.open(join(vault, 'learn.db'));

    expect(await migrateJsonQueue(jsonPath, queue, vault)).toBe(1);
    expect(queue.stats().queued).toBe(1);
    await expect(readFile(jsonPath, 'utf8')).rejects.toThrow(); // 原文件已改名
    expect(await readFile(`${jsonPath}.migrated`, 'utf8')).toContain('claude-code:s-1');
    expect(await migrateJsonQueue(jsonPath, queue, vault)).toBe(0); // 已不存在
    queue.close();
  });
});

describe('learnRecentBatch 手动批量学习', () => {
  it('recentUnlearnedKeys:shadow 模式把 .shadow.json 视为已处理,不重复入列', async () => {
    const e1 = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', e1);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: e1, startedAt: '2026-01-01T00:00:00.000Z' }]);
    await storage.write('audit/claude-code:s-1.shadow.json', '{}');

    expect(await recentUnlearnedKeys(vault, 10, learnCfg('shadow'))).toEqual([]);
  });

  it('recentUnlearnedKeys:auto 模式忽略 .shadow.json,会话可真正补学', async () => {
    const e1 = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', e1);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: e1, startedAt: '2026-01-01T00:00:00.000Z' }]);
    await storage.write('audit/claude-code:s-1.shadow.json', '{}');

    expect(await recentUnlearnedKeys(vault, 10, learnCfg('auto'))).toEqual(['claude-code:s-1']);
  });

  it('按 startedAt 降序取最近 N 个未学习会话,超出部分不学', async () => {
    const e1 = sampleEvents('s-1');
    const e2 = sampleEvents('s-2');
    const e3 = sampleEvents('s-3');
    for (const [s, e] of [['s-1', e1], ['s-2', e2], ['s-3', e3]] as const) await writeSession('claude-code', s, e);
    await writeIndex([
      { harness: 'claude-code', session: 's-1', events: e1, startedAt: '2026-01-01T00:00:00.000Z' },
      { harness: 'claude-code', session: 's-2', events: e2, startedAt: '2026-02-01T00:00:00.000Z' },
      { harness: 'claude-code', session: 's-3', events: e3, startedAt: '2026-03-01T00:00:00.000Z' },
    ]);

    const logs: string[] = [];
    const note = await learnRecentBatch(vault, 2, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') }, { log: (l) => logs.push(l) });

    expect(note).toContain('新增 2');
    expect(note).toContain('共 2');
    expect(await storage.read('audit/claude-code:s-3.json')).not.toBeNull();
    expect(await storage.read('audit/claude-code:s-2.json')).not.toBeNull();
    expect(await storage.read('audit/claude-code:s-1.json')).toBeNull();
    expect(logs[0]).toMatch(/^\[1\/2\] claude-code:s-3/);
    expect(logs[1]).toMatch(/^\[2\/2\] claude-code:s-2/);
  });

  it('跳过已学习与已失败会话(双形式兜底裸 session 历史记录)', async () => {
    const e1 = sampleEvents('s-1');
    const e2 = sampleEvents('s-2');
    const e3 = sampleEvents('s-3');
    for (const [s, e] of [['s-1', e1], ['s-2', e2], ['s-3', e3]] as const) await writeSession('claude-code', s, e);
    await writeIndex([
      { harness: 'claude-code', session: 's-1', events: e1, startedAt: '2026-01-01T00:00:00.000Z' },
      { harness: 'claude-code', session: 's-2', events: e2, startedAt: '2026-02-01T00:00:00.000Z' },
      { harness: 'claude-code', session: 's-3', events: e3, startedAt: '2026-03-01T00:00:00.000Z' },
    ]);
    await storage.write('audit/claude-code:s-1.json', '{}');
    await storage.write('audit/s-3.json', '{}');
    await storage.write('audit/claude-code:s-2.failed.json', '{}');

    const note = await learnRecentBatch(vault, 10, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') });

    expect(note).toBe('没有可学习的会话(都已学习或索引为空)');
    expect(await storage.read('audit/s-1.json')).toBeNull();
  });

  it('无 startedAt 的会话排最后,仍纳入候选', async () => {
    const e1 = sampleEvents('s-1');
    const e2 = sampleEvents('s-2');
    await writeSession('claude-code', 's-1', e1);
    await writeSession('claude-code', 's-2', e2);
    await writeIndex([
      { harness: 'claude-code', session: 's-1', events: e1, startedAt: '2026-01-01T00:00:00.000Z' },
      { harness: 'claude-code', session: 's-2', events: e2 },
    ]);

    const note = await learnRecentBatch(vault, 1, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('auto') });

    expect(note).toContain('共 1');
    expect(await storage.read('audit/claude-code:s-1.json')).not.toBeNull();
    expect(await storage.read('audit/claude-code:s-2.json')).toBeNull();
  });

  it('learnRecentBatch off 模式打印关闭提示,不触碰索引', async () => {
    const e1 = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', e1);
    await writeIndex([{ harness: 'claude-code', session: 's-1', events: e1 }]);

    const note = await learnRecentBatch(vault, 10, { llm: v2Llm(), jev: v2Jev(), config: learnCfg('off') });

    expect(note).toBe('learn 已关闭（learn.mode=off）');
    expect(await storage.read('audit/claude-code:s-1.json')).toBeNull();
  });
});
