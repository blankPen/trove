import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemoryDiff, writeMemoryDiff, readLatestDiff, readSessionDiff, formatDiff } from '../../src/core/lessons/audit.js';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import type { MemoryOp } from '../../src/core/lessons/merge.js';

let root: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-audit-'));
  storage = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CTX = { sessionId: 'sess-1', project: 'proj', extractedAt: '2026-10-28T12:00:00Z' };

describe('审计日志(Stage 8)', () => {
  it('用例 8-1:add/update/skip 汇总计数一致,adds 含 evidence、updates 含 before/after、skips 含 reason', () => {
    const ops: MemoryOp[] = [
      { op: 'add', type: 'experiences/debug_pattern', path: 'experiences/a.md', title: '新增的经验标题', content: '正文', evidence: [3, 5] },
      { op: 'patch', type: 'preferences/writing_style', path: 'preferences/ws.md', title: '写作风格', content: '合并后', before: '合并前' },
      { op: 'skip', type: 'experiences/foo', title: '太短', reason: 'title_too_short' },
    ];

    const diff = buildMemoryDiff(ops, CTX);

    expect(diff.session_id).toBe('sess-1');
    expect(diff.project).toBe('proj');
    expect(diff.summary).toEqual({ adds: 1, updates: 1, appends: 0, skips: 1 });

    expect(diff.operations.adds).toHaveLength(1);
    expect(diff.operations.adds[0]).toMatchObject({ uri: 'experiences/a.md', title: '新增的经验标题', evidence: [3, 5] });

    expect(diff.operations.updates).toHaveLength(1);
    expect(diff.operations.updates[0]).toMatchObject({ uri: 'preferences/ws.md', before: '合并前', after: '合并后' });

    expect(diff.operations.skips).toHaveLength(1);
    expect(diff.operations.skips[0]).toMatchObject({ title: '太短', reason: 'title_too_short' });
  });

  it('用例 8-2:查看命令(人可读摘要)展示新增/更新/追加/跳过计数,跳过项带原因', () => {
    const ops: MemoryOp[] = [
      { op: 'add', type: 'experiences/debug_pattern', path: 'experiences/a.md', title: '新增的经验标题', content: '正文', evidence: [1] },
      { op: 'append', type: 'resources/doc', path: 'resources/docs/r.md', content: '追加内容' },
      { op: 'skip', type: 'experiences/foo', title: '短标题', reason: 'unknown_type' },
    ];
    const text = formatDiff(buildMemoryDiff(ops, CTX));

    expect(text).toContain('本次新增 1 条、更新 0 条、追加 1 条、跳过 1 条');
    expect(text).toContain('新增: 新增的经验标题 (experiences/a.md)');
    expect(text).toContain('追加: resources/docs/r.md');
    expect(text).toContain('跳过: 短标题（unknown_type）');
  });

  it('用例 8-3:全跳过(无任何操作)时 summary 全 0,查看命令显示「本次无新增记忆」而非报错', () => {
    const diff = buildMemoryDiff([], CTX);

    expect(diff.summary).toEqual({ adds: 0, updates: 0, appends: 0, skips: 0 });
    expect(formatDiff(diff)).toBe('本次无新增记忆');
  });

  it('落盘后可从最近一次与指定会话读回同一份 diff', async () => {
    const diff = buildMemoryDiff(
      [{ op: 'add', type: 'experiences/debug_pattern', path: 'experiences/a.md', title: '新增的经验标题', content: '正文', evidence: [1] }],
      CTX,
    );
    await writeMemoryDiff(diff, storage);

    const latest = await readLatestDiff(storage);
    expect(latest).toEqual(diff);

    const session = await readSessionDiff(storage, 'sess-1');
    expect(session).toEqual(diff);

    expect(await readSessionDiff(storage, 'no-such')).toBeNull();
  });
});
