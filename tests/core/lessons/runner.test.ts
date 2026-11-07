import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueuedJobs } from '../../../src/core/lessons/runner.js';
import { JobQueue } from '../../../src/core/lessons/jobs.js';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { libraryDir, libraryLessonsDir, safeSessionName } from '../../../src/core/layout.js';
import { buildMemoryDiff } from '../../../src/core/lessons/audit.js';
import type { MemoryOp } from '../../../src/core/lessons/merge.js';
import { MockLlm } from '../../../src/core/lessons/llm.js';
import type { JevProvider } from '../../../src/core/lessons/jev.js';
import type { Event } from '../../../src/core/events/schema.js';
import type { LessonProviderDeps } from '../../../src/core/lessons/learn.js';

let vault: string;
let dbPath: string;
let usagePath: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'lessons-runner-'));
  dbPath = join(vault, 'learn.db');
  usagePath = join(vault, 'usage.jsonl');
  storage = new LocalStorageAdapter(libraryLessonsDir(vault));
});

afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

const NOW = new Date('2026-01-05T12:00:00.000Z').getTime();
const now = () => new Date(NOW);

function learnCfg(overrides: Record<string, unknown> = {}): NonNullable<LessonProviderDeps['config']> {
  return {
    learn: {
      mode: 'auto',
      autoMigrate: true,
      paused: false,
      dailyTokenBudget: 200000,
      maxAttempts: 5,
      leaseTtlMs: 300000,
      quality: { autoAccept: 0.8, reviewFloor: 0.6, evidenceMin: 0.8 },
      jev: { maxCallsPerSession: 8, timeoutMs: 2000 },
      ...overrides,
    },
  } as NonNullable<LessonProviderDeps['config']>;
}

function sampleEvents(session: string): Event[] {
  const t0 = NOW - 11 * 60 * 1000;
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

async function writeSession(harness: string, session: string, events: Event[]): Promise<void> {
  const dir = join(libraryDir(vault), 'sessions', harness, safeSessionName(session));
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
  await mkdir(libraryDir(vault), { recursive: true });
  await writeFile(join(libraryDir(vault), 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
}

function v2Jev(): JevProvider {
  return {
    async score() { return { taskSuccess: 1, meanScore: 1 }; },
    async keepCalls(_s: unknown, q: Record<string, unknown>): Promise<Record<string, number>> {
      return Object.fromEntries(Object.keys(q).map((k) => [k, k.endsWith(':noise') ? 0 : 0.95]));
    },
  };
}

function happyLlm(): MockLlm {
  return new MockLlm((_p, _s, task) => {
    if (task === 'learn:extract-ops') {
      return {
        ops: [
          {
            action: 'add',
            type: 'experiences/debug_pattern',
            title: '脚本退出应该用 set -e', slug: 'set-e',
            content: '## 适用场景\nshell 脚本需要失败即中断\n\n## 做法\n用 `set -e`\n\n## 验证\n命令出错立即退出\n\n## 边界与反例\n不适用需要忽略单命令失败的场景',
            evidence: [{ seq: 1, quote: '脚本退出应该用 set -e' }],
          },
        ],
      };
    }
    throw new Error(`unexpected task ${task}`);
  });
}

function throwingLlm(err: unknown): MockLlm {
  return new MockLlm(() => { throw err; });
}

function opts(overrides: Partial<Parameters<typeof runQueuedJobs>[3]> = {}): Parameters<typeof runQueuedJobs>[3] {
  return { owner: 'test', batch: 5, usagePath, dailyTokenBudget: 200000, ...overrides };
}

describe('runQueuedJobs 作业执行', () => {
  it('checkpoint 恢复:直接补写审计,不调 LLM', async () => {
    const q = JobQueue.open(dbPath);
    q.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h' }], 1000);
    const leased = q.lease('w', 1, 1000)!;
    const ops: MemoryOp[] = [{ op: 'add', type: 'experiences/debug_pattern', path: 'experiences/a.md', title: 'T', content: 'C', evidence: [1] }];
    q.setCheckpoint(leased.id, JSON.stringify({ stage: 'written', diff: buildMemoryDiff(ops, { sessionId: 'claude-code:s-1', project: 'p' }) }));
    q.requeueExpired(1002); // 租约过期 → 回 queued,保留 checkpoint

    const res = await runQueuedJobs(vault, q, { llm: throwingLlm(new Error('不应被调用')), jev: v2Jev(), config: learnCfg(), now }, opts());

    expect(res).toMatchObject({ done: 1, processed: 1, failed: 0 });
    expect(await storage.read('audit/claude-code:s-1.json')).not.toBeNull();
    expect(q.get(leased.id)!.state).toBe('done');
    q.close();
  });

  it('happy path:跑通提取,写记忆并 complete', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    const q = JobQueue.open(dbPath);
    q.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h' }], 1000);

    const res = await runQueuedJobs(vault, q, { llm: happyLlm(), jev: v2Jev(), config: learnCfg(), now }, opts());

    expect(res).toMatchObject({ done: 1, failed: 0 });
    expect(await storage.read('audit/claude-code:s-1.json')).not.toBeNull();
    expect((await storage.list()).some((f) => f.startsWith('experiences/') && f.endsWith('.md'))).toBe(true);
    q.close();
  });

  it('off / paused 模式直接阻塞,不 lease', async () => {
    const q = JobQueue.open(dbPath);
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    expect(await runQueuedJobs(vault, q, { config: learnCfg({ mode: 'off' }), now }, opts())).toMatchObject({ blocked: 'off', processed: 0 });
    expect(await runQueuedJobs(vault, q, { config: learnCfg({ paused: true }), now }, opts())).toMatchObject({ blocked: 'paused', processed: 0 });
    expect(q.stats().queued).toBe(1); // 未被消费
    q.close();
  });

  it('当天 token 超预算 → blocked budget 不 lease;次日恢复', async () => {
    const q = JobQueue.open(dbPath);
    q.enqueue([{ sessionKey: 'a', contentHash: 'h' }], 1000);
    await writeFile(usagePath, `${JSON.stringify({ at: '2026-01-05T10:00:00.000Z', task: 'learn:summarize', model: 'm', totalTokens: 100 })}\n`, 'utf8');

    expect(await runQueuedJobs(vault, q, { config: learnCfg(), now }, opts({ dailyTokenBudget: 50 }))).toMatchObject({ blocked: 'budget', processed: 0 });

    // 次日:昨天用量不计入今天
    const tomorrow = () => new Date('2026-01-06T12:00:00.000Z');
    const res = await runQueuedJobs(vault, q, { config: learnCfg(), now: tomorrow }, opts({ dailyTokenBudget: 50 }));
    expect(res.blocked).toBeUndefined();
    expect(res.processed).toBe(1); // 空会话会跳过,但至少消费了
    q.close();
  });

  it('config 错误 → dead;network 错误 → retry_wait 退避', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);

    const q1 = JobQueue.open(dbPath);
    q1.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h' }], NOW);
    const r1 = await runQueuedJobs(vault, q1, { llm: throwingLlm(new Error('401 Unauthorized')), jev: v2Jev(), config: learnCfg(), now }, opts());
    expect(r1).toMatchObject({ failed: 1, retryWait: 0 });
    expect(q1.stats()).toMatchObject({ dead: 1 });
    expect(q1.lease('zz', 1000, NOW + 1)).toBeNull(); // dead 不可再租
    q1.close();

    const q2 = JobQueue.open(join(vault, 'learn2.db'));
    q2.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h' }], NOW);
    const err = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    const r2 = await runQueuedJobs(vault, q2, { llm: throwingLlm(err), jev: v2Jev(), config: learnCfg(), now }, opts({ usagePath }));
    expect(r2).toMatchObject({ failed: 1, retryWait: 1 });
    const job2 = q2.lease('x', 1000, NOW + 40000); // 退避 30s 后到期才可重领
    expect(job2).not.toBeNull();
    expect(job2!.errorClass).toBe('network');
    expect(job2!.attempts).toBe(2);
    q2.close();
  });

  it('disk 错误 → dead 且返回 blocked disk', async () => {
    const ev = sampleEvents('s-1');
    await writeSession('claude-code', 's-1', ev);
    const q = JobQueue.open(dbPath);
    q.enqueue([{ sessionKey: 'claude-code:s-1', contentHash: 'h' }], NOW);
    const err = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    const res = await runQueuedJobs(vault, q, { llm: throwingLlm(err), jev: v2Jev(), config: learnCfg(), now }, opts());
    expect(res).toMatchObject({ failed: 1, blocked: 'disk' });
    expect(q.stats()).toMatchObject({ dead: 1 });
    q.close();
  });
});
