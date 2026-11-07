import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOperations } from '../../../src/core/lessons/write.js';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';
import { parseMemory } from '../../../src/core/lessons/memory.js';
import type { MemoryOp, MemoryMeta } from '../../../src/core/lessons/merge.js';
import type { EvidenceRef } from '../../../src/core/lessons/memory.js';

let root: string;
let storage: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-write-v2-'));
  storage = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ev: EvidenceRef[] = [{ session: 's1', seq: 1, quote: '足够长的引用内容', path: 'raw/a.jsonl', line: 2 }];

function meta(over: Partial<MemoryMeta> = {}): MemoryMeta {
  return {
    id: 'exp_1',
    kind: 'experience',
    status: 'active',
    version: 1,
    quality: { specific: 0.9, actionable: 0.9, transferable: 0.8, evidence: 0.9, non_duplicate: 0.8 },
    evidence: ev,
    promptVersion: 'exp-v3',
    ...over,
  };
}

const t0 = new Date('2026-01-01T00:00:00.000Z');

describe('applyOperations · v2 meta', () => {
  it('add + meta 渲染 v2 字段,可被 parseMemory 读回', async () => {
    const op: MemoryOp = { op: 'add', type: 'experiences/gotcha', path: 'experiences/gotcha-ecn.md', title: 'ECONNRESET 重试', content: '正文内容', evidence: [], meta: meta() };
    await applyOperations([op], { storage, now: () => t0 });

    const text = await storage.read('experiences/gotcha-ecn.md');
    expect(text).toContain('id: "exp_1"');
    expect(text).toContain('kind: experience');
    expect(text).toContain('status: active');
    expect(text).toContain('version: 1');
    expect(text).toContain('evidence:');
    expect(text).toContain('quality:');
    expect(text).toContain('created_at: "2026-01-01T00:00:00.000Z"');

    const mem = parseMemory(text!);
    expect(mem).not.toBeNull();
    expect(mem!.id).toBe('exp_1');
    expect(mem!.kind).toBe('experience');
    expect(mem!.evidence).toHaveLength(1);
  });

  it('patch + meta 版本递增、保留 id/created_at、证据合并去重', async () => {
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '旧标题', content: '旧正文', evidence: [], meta: meta() }],
      { storage, now: () => t0 },
    );
    const t1 = new Date('2026-02-01T00:00:00.000Z');
    await applyOperations(
      [{ op: 'patch', type: 'experiences/gotcha', path: 'experiences/g.md', title: '新标题', content: '新正文', before: '旧正文', meta: meta({ evidence: ev }) }],
      { storage, now: () => t1 },
    );

    const mem = parseMemory((await storage.read('experiences/g.md'))!);
    expect(mem!.id).toBe('exp_1');
    expect(mem!.version).toBe(2);
    expect(mem!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(mem!.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(mem!.body).toContain('新正文');
  });

  it('supersede(add + archivePath)归档旧文件并标 status: superseded,INDEX 替换行', async () => {
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g-old.md', title: '旧结论', content: '旧正文', evidence: [], meta: meta({ id: 'exp_OLD' }) }],
      { storage, now: () => t0 },
    );
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g-new.md', title: '新结论', content: '新正文', evidence: [], archivePath: 'experiences/g-old.md', meta: meta({ id: 'exp_NEW', supersedes: 'exp_OLD' }) }],
      { storage, now: () => t0 },
    );

    const archived = await storage.read('archive/experiences/g-old.md');
    expect(archived).toContain('superseded_by');
    expect(archived).toContain('experiences/g-new.md');
    expect(parseMemory(archived!)!.status).toBe('superseded');
    expect(await storage.exists('experiences/g-old.md')).toBe(false);
    expect(await storage.exists('experiences/g-new.md')).toBe(true);

    const index = await storage.read('INDEX.md');
    expect(index).not.toContain('experiences/g-old.md');
    expect(index).toContain('experiences/g-new.md');
  });

  it('无 meta 的 add 也落 v2(补 id/kind/status/version)', async () => {
    await applyOperations([{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '标题', content: '正文', evidence: [1] }], { storage, now: () => t0 });
    const text = await storage.read('experiences/g.md');
    expect(text).toContain('type: experiences/gotcha');
    expect(text).toMatch(/^id: "exp_/m);
    expect(text).toContain('kind: experience');
    expect(text).toContain('status: active');
    expect(text).toContain('version: 1');
    expect(text).not.toContain('source:');
  });

  it('add 经验类正文追加 ## 证据 段(quote 可溯源,仅一段)', async () => {
    const op: MemoryOp = { op: 'add', type: 'experiences/gotcha', path: 'experiences/gotcha-ecn.md', title: 'ECONNRESET 重试', content: '正文内容', evidence: [], meta: meta() };
    await applyOperations([op], { storage, now: () => t0 });
    const text = await storage.read('experiences/gotcha-ecn.md');
    expect(text).toContain('## 证据');
    expect(text).toContain('足够长的引用内容');
    expect((text!.match(/## 证据/g) ?? []).length).toBe(1);
  });

  it('patch 合并后证据段只有一份且包含新旧 quote', async () => {
    const evOld: EvidenceRef[] = [{ session: 's1', seq: 1, quote: '旧引用内容足够长' }];
    const evNew: EvidenceRef[] = [{ session: 's1', seq: 2, quote: '新引用内容足够长' }];
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '旧标题', content: '旧正文', evidence: [], meta: meta({ evidence: evOld }) }],
      { storage, now: () => t0 },
    );
    const t1 = new Date('2026-02-01T00:00:00.000Z');
    await applyOperations(
      [{ op: 'patch', type: 'experiences/gotcha', path: 'experiences/g.md', title: '新标题', content: '新正文', before: '旧正文', meta: meta({ evidence: evNew }) }],
      { storage, now: () => t1 },
    );
    const text = await storage.read('experiences/g.md');
    expect((text!.match(/## 证据/g) ?? []).length).toBe(1);
    expect(text).toContain('旧引用内容足够长');
    expect(text).toContain('新引用内容足够长');
  });

  it('非经验类型不追加 ## 证据 段', async () => {
    await applyOperations(
      [{ op: 'add', type: 'preferences/profile', path: 'preferences/profile.md', title: '用户画像', content: '正文内容', evidence: [], meta: meta({ kind: 'preference' }) }],
      { storage, now: () => t0 },
    );
    expect(await storage.read('preferences/profile.md')).not.toContain('## 证据');
  });

  it('archivePath 与新路径相同 → 不归档/删除,仅保留 supersedes 元数据', async () => {
    const op: MemoryOp = { op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '原位取代', content: '新正文', evidence: [], archivePath: 'experiences/g.md', meta: meta({ supersedes: 'exp_OLD' }) };
    await applyOperations([op], { storage, now: () => t0 });
    expect(await storage.exists('experiences/g.md')).toBe(true);
    expect(await storage.exists('archive/experiences/g.md')).toBe(false);
    expect(parseMemory((await storage.read('experiences/g.md'))!)!.supersedes).toBe('exp_OLD');
  });

  it('add 用 meta.scope 渲染 scope,缺省 global', async () => {
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '标题', content: '正文', evidence: [], meta: meta({ scope: 'project:a' }) }],
      { storage, now: () => t0 },
    );
    expect(parseMemory((await storage.read('experiences/g.md'))!)!.scope).toBe('project:a');
  });

  it('patch 旧 global 被项目 meta.scope 升级', async () => {
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '旧标题', content: '旧正文', evidence: [], meta: meta() }],
      { storage, now: () => t0 },
    );
    await applyOperations(
      [{ op: 'patch', type: 'experiences/gotcha', path: 'experiences/g.md', title: '新标题', content: '新正文', before: '旧正文', meta: meta({ scope: 'project:a' }) }],
      { storage, now: () => t0 },
    );
    expect(parseMemory((await storage.read('experiences/g.md'))!)!.scope).toBe('project:a');
  });

  it('归档只改 frontmatter 的 status,正文 status: 行不动', async () => {
    await applyOperations(
      [{ op: 'add', type: 'events/decision', path: 'events/2026-01-01-decided-a.md', title: '旧决策标题', content: '正文含\nstatus: 这是正文内容', evidence: [] }],
      { storage, now: () => t0 },
    );
    await applyOperations(
      [{ op: 'add', type: 'events/decision', path: 'events/2026-01-01-decided-b.md', title: '新决策标题', content: '新正文', evidence: [], supersedePath: 'events/2026-01-01-decided-a.md' }],
      { storage, now: () => t0 },
    );
    const archived = await storage.read('archive/events/2026-01-01-decided-a.md');
    expect(archived).toContain('status: 这是正文内容');
    // v2 归档:仅 frontmatter 的 status 标 superseded,正文 status: 行不动
    expect(archived).toContain('status: superseded');
    expect(archived).not.toContain('status: active');
  });
});

describe('applyOperations · 增量写入安全', () => {
  it('patch 锚点失配 → stale,不覆盖现有内容', async () => {
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '旧标题', content: '旧正文', evidence: [], meta: meta() }],
      { storage, now: () => t0 },
    );
    const r = await applyOperations(
      [{ op: 'patch', type: 'experiences/gotcha', path: 'experiences/g.md', title: '新标题', content: '新正文', before: '不存在的锚点文本', meta: meta() }],
      { storage, now: () => t0 },
    );
    expect(r.stale).toEqual(['experiences/g.md']);
    expect(r.updated).toEqual([]);
    expect(await storage.read('experiences/g.md')).toContain('旧正文');
  });

  it('patch 成功时留一份 archive 备份', async () => {
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '旧标题', content: '旧正文', evidence: [], meta: meta() }],
      { storage, now: () => t0 },
    );
    const r = await applyOperations(
      [{ op: 'patch', type: 'experiences/gotcha', path: 'experiences/g.md', title: '新标题', content: '新正文', before: '旧正文', meta: meta() }],
      { storage, now: () => t0 },
    );
    expect(r.updated).toEqual(['experiences/g.md']);
    const backups = (await storage.list('archive/')).filter((p) => p.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(await storage.read(backups[0]!)).toContain('旧正文');
  });

  it('add 同路径已存在 → skipped,不覆盖', async () => {
    await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '标题', content: '原正文', evidence: [], meta: meta() }],
      { storage, now: () => t0 },
    );
    const r = await applyOperations(
      [{ op: 'add', type: 'experiences/gotcha', path: 'experiences/g.md', title: '标题', content: '覆盖正文', evidence: [], meta: meta() }],
      { storage, now: () => t0 },
    );
    expect(r.skipped).toEqual(['experiences/g.md']);
    expect(await storage.read('experiences/g.md')).toContain('原正文');
  });

  it('append 内容已存在 → skipped,不重复追加', async () => {
    await applyOperations(
      [{ op: 'append', type: 'resources/doc', path: 'resources/docs/a.md', content: '资源正文' }],
      { storage, now: () => t0 },
    );
    const r = await applyOperations(
      [{ op: 'append', type: 'resources/doc', path: 'resources/docs/a.md', content: '资源正文' }],
      { storage, now: () => t0 },
    );
    expect(r.skipped).toEqual(['resources/docs/a.md']);
    const text = (await storage.read('resources/docs/a.md'))!;
    expect(text.split('资源正文')).toHaveLength(2); // 只出现一次
  });
});
