import { describe, it, expect } from 'vitest';
import type { StorageAdapter } from '../../../src/core/lessons/storage.js';
import { appendDecision, readDecisions } from '../../../src/core/lessons/decisions.js';
import type { DecisionRecord } from '../../../src/core/lessons/decisions.js';

function memStorage(initial: Record<string, string> = {}): { storage: StorageAdapter; files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const storage: StorageAdapter = {
    async read(p) {
      return files.has(p) ? files.get(p)! : null;
    },
    async write(p, t) {
      files.set(p, t);
    },
    async exists(p) {
      return files.has(p);
    },
    async delete(p) {
      files.delete(p);
    },
    async list(prefix = '') {
      return [...files.keys()].filter((k) => k.startsWith(prefix));
    },
  };
  return { storage, files };
}

function rec(session: string, decision: string, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    at: '2026-11-05T00:00:00.000Z',
    session,
    stage: 'quality',
    decision,
    source: 'heuristic',
    reasons: [{ question: '是否具体', probability: 0.8 }],
    ...over,
  };
}

describe('决策日志', () => {
  it('追加多条,顺序保留,文件以换行结尾', async () => {
    const { storage } = memStorage();
    await appendDecision(storage, rec('s1', 'accept'));
    await appendDecision(storage, rec('s2', 'reject', { stage: 'triage' }));
    const all = await readDecisions(storage);
    expect(all).toHaveLength(2);
    expect(all[0].session).toBe('s1');
    expect(all[1].decision).toBe('reject');
    const raw = await storage.read('.trove/decisions.jsonl');
    expect(raw!.endsWith('\n')).toBe(true);
    expect(raw!.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('按 session 过滤', async () => {
    const { storage } = memStorage();
    await appendDecision(storage, rec('s1', 'accept'));
    await appendDecision(storage, rec('s2', 'skip'));
    const got = await readDecisions(storage, { session: 's2' });
    expect(got).toHaveLength(1);
    expect(got[0].session).toBe('s2');
  });

  it('损坏行忽略', async () => {
    const { storage } = memStorage({
      '.trove/decisions.jsonl': 'not-json\n' + JSON.stringify(rec('s9', 'skip')) + '\n',
    });
    const got = await readDecisions(storage);
    expect(got).toHaveLength(1);
    expect(got[0].session).toBe('s9');
  });

  it('文件不存在返回 []', async () => {
    const { storage } = memStorage();
    expect(await readDecisions(storage)).toEqual([]);
  });

  it('完整记录往返', async () => {
    const { storage } = memStorage();
    const full: DecisionRecord = {
      at: '2026-11-05T00:00:00.000Z',
      session: 's',
      stage: 'adjudicate',
      gate: 'B',
      decision: 'escalate',
      source: 'llm',
      reasons: [{ question: '是否可迁移', probability: 0.7 }],
      candidate: { type: 'experiences/debug_pattern', title: 't' },
      target: 'mem_xxx',
      model: 'sonnet',
      promptVersion: 'v2',
    };
    await appendDecision(storage, full);
    expect(await readDecisions(storage)).toEqual([full]);
  });
});
