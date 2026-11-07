import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMemoryUsage, recordMemoryUsage } from '../../../src/core/lessons/memory-usage.js';
import { LocalStorageAdapter } from '../../../src/core/lessons/storage.js';

// 检索只走 qmd；单测里用假 store 避免加载本地 GGUF 模型。
const search = vi.fn();
vi.mock('@tobilu/qmd', () => ({
  createStore: async () => ({
    search,
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false }),
    update: async () => ({}),
    embed: async () => ({}),
    close: async () => {},
  }),
}));

const { getLesson, searchLessons, closeSearchCache } = await import('../../../src/core/search/service.js');

let vault: string;
let storage: LocalStorageAdapter;
const backend = { dbPath: join(tmpdir(), 'nope.sqlite'), model: 'hf:test' };

function hit(path: string, score = 0.9): { file: string; displayPath: string; title: string; score: number } {
  return { file: `qmd://${path}`, displayPath: path, title: '', score };
}

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'trove-usage-track-'));
  storage = new LocalStorageAdapter(join(vault, 'library/lessons'));
  search.mockReset();
  const abs = join(vault, 'library/lessons/experiences');
  await mkdir(abs, { recursive: true });
  await writeFile(
    join(abs, 'a.md'),
    [
      '---',
      'id: "exp_track_1"',
      'kind: experience',
      'type: experiences/debug_pattern',
      'title: "COS 签名 403"',
      'tags: ["experiences"]',
      'scope: global',
      'status: active',
      'version: 1',
      'evidence: []',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'use_count: 0',
      'helpful_count: 0',
      '---',
      '',
      'S3 推送时报 SignatureDoesNotMatch。',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  closeSearchCache();
  await rm(vault, { recursive: true, force: true });
});

describe('检索埋点(使用事件)', () => {
  it('searchLessons 对命中记忆记 retrieved(含 query 与 rank)', async () => {
    search.mockResolvedValue([hit('experiences/a.md')]);
    const hits = await searchLessons(vault, { query: 'COS 签名' }, backend);
    expect(hits.length).toBeGreaterThan(0);

    const events = await readMemoryUsage(storage);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('retrieved');
    expect(events[0]!.memory_id).toBe('exp_track_1');
    expect(events[0]!.query).toBe('COS 签名');
    expect(events[0]!.rank).toBe(1);
  });

  it('getLesson 记 viewed', async () => {
    const doc = await getLesson(vault, 'experiences/a.md');
    expect(doc).not.toBeNull();

    const events = await readMemoryUsage(storage);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('viewed');
    expect(events[0]!.memory_id).toBe('exp_track_1');
  });

  it('无 id 的旧文件不产生事件', async () => {
    const abs = join(vault, 'library/lessons/experiences');
    await writeFile(
      join(abs, 'old.md'),
      '---\ntype: experiences/gotcha\ntitle: "旧记忆"\n---\n\n旧正文\n',
      'utf8',
    );
    search.mockResolvedValue([hit('experiences/old.md')]);

    await searchLessons(vault, { query: '旧记忆' }, backend);

    expect(await readMemoryUsage(storage)).toEqual([]);
  });

  it('searchLessons 读 usage 后按反馈重排(有帮助/检索的记忆排前)', async () => {
    // qmd 认为两条同样相关；usage 反馈把 b.md 顶到最前。
    const abs = join(vault, 'library/lessons/experiences');
    await writeFile(
      join(abs, 'b.md'),
      [
        '---',
        'id: "exp_track_2"',
        'kind: experience',
        'type: experiences/debug_pattern',
        'title: "COS 签名 403 补充"',
        'tags: ["experiences"]',
        'scope: global',
        'status: active',
        'version: 1',
        'evidence: []',
        'created_at: "2026-01-01T00:00:00.000Z"',
        'updated_at: "2026-01-01T00:00:00.000Z"',
        'use_count: 0',
        'helpful_count: 0',
        '---',
        '',
        'S3 推送时报 SignatureDoesNotMatch。',
        '',
      ].join('\n'),
      'utf8',
    );
    await recordMemoryUsage(storage, { at: '2026-01-02T00:00:00.000Z', memory_id: 'exp_track_2', action: 'retrieved' });
    await recordMemoryUsage(storage, { at: '2026-01-02T00:00:00.000Z', memory_id: 'exp_track_2', action: 'helpful' });
    search.mockResolvedValue([hit('experiences/a.md', 0.9), hit('experiences/b.md', 0.9)]);

    const hits = await searchLessons(vault, { query: 'COS 签名' }, backend);
    expect(hits[0]?.path).toBe('experiences/b.md');
  });
});