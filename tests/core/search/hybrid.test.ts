import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LessonsIndex } from '../../../src/core/search/lessons-index.js';
import { rrfFuse, searchLessonsHybrid } from '../../../src/core/search/hybrid.js';
import { VectorIndex } from '../../../src/core/lessons/vector-index.js';
import type { Embedder } from '../../../src/core/lessons/embedding.js';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seedMem(vault: string, rel: string, id: string, title: string, body: string): Promise<void> {
  const abs = join(vault, 'library/lessons', rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(
    abs,
    [
      '---',
      `id: ${JSON.stringify(id)}`,
      'kind: experience',
      'type: experiences/gotcha',
      `title: ${JSON.stringify(title)}`,
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
      body,
    ].join('\n'),
    'utf8',
  );
}

describe('rrfFuse', () => {
  it('两列表单元素 → 各 1/(k+1)', () => {
    const fused = rrfFuse([[{ id: 'a' }], [{ id: 'b' }]]);
    expect(fused).toHaveLength(2);
    for (const e of fused) expect(e.score).toBeCloseTo(1 / 61, 10);
  });

  it('同 id 出现在多列表 → 分数相加', () => {
    const fused = rrfFuse([[{ id: 'a' }], [{ id: 'a' }]]);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.score).toBeCloseTo(2 / 61, 10);
  });

  it('分数按降序,自定义 rrfK 生效', () => {
    const fused = rrfFuse([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }]], { rrfK: 0 });
    // rrfK=0: a rank1 = 1/1 = 1; b = 1/2 + 1/1 = 1.5
    expect(fused[0]!.id).toBe('b');
    expect(fused[0]!.score).toBeCloseTo(1.5, 10);
    expect(fused[1]!.score).toBeCloseTo(1, 10);
  });
});

describe('searchLessonsHybrid', () => {
  it('向量缺失(embedder null)→ 回退 FTS', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-hybrid-'));
    dirs.push(vault);
    await seedMem(vault, 'experiences/a.md', 'exp_a', 'COS 签名 403', 'S3 推送时报 SignatureDoesNotMatch。');
    const index = await LessonsIndex.build(vault);
    const fts = index.search({ query: 'COS 签名' });
    const got = await searchLessonsHybrid(vault, 'COS 签名', { query: 'COS 签名' }, { index, embedder: null, vectors: null });
    expect(got.map((h) => h.path)).toEqual(fts.map((h) => h.path));
    index.close();
  });

  it('向量召回补充 FTS 未命中的记忆,并映射 path', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-hybrid-'));
    dirs.push(vault);
    await seedMem(vault, 'experiences/a.md', 'exp_a', 'COS 签名 403', 'S3 推送时报 SignatureDoesNotMatch。');
    await seedMem(vault, 'experiences/b.md', 'exp_b', '远程存储鉴权', '对象存储上传失败时的排查思路。');
    const index = await LessonsIndex.build(vault);
    const vectors = VectorIndex.open(join(vault, 'vectors.sqlite'));
    vectors.upsert('exp_a', 'experiences/a.md', 'global', new Float32Array([1, 0]));
    vectors.upsert('exp_b', 'experiences/b.md', 'global', new Float32Array([0, 1]));
    const embedder: Embedder = { dims: 2, encode: async () => [new Float32Array([0, 1])] };

    const hits = await searchLessonsHybrid(vault, 'COS 签名', { query: 'COS 签名' }, { index, embedder, vectors, recallTopK: 5 });
    expect(hits.some((h) => h.path === 'experiences/a.md')).toBe(true);
    expect(hits.some((h) => h.path === 'experiences/b.md')).toBe(true);

    index.close();
    vectors.close();
  });

  it('minScore 过滤低相似度向量结果,避免短问句硬凑', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'trove-hybrid-'));
    dirs.push(vault);
    await seedMem(vault, 'experiences/a.md', 'exp_a', '本地向量索引', 'bge-small-zh 的 512 维向量。');
    await seedMem(vault, 'experiences/b.md', 'exp_b', '飞书文档同步', '对象存储归档与拉取。');
    const index = await LessonsIndex.build(vault);
    const vectors = VectorIndex.open(join(vault, 'vectors.sqlite'));
    vectors.upsert('exp_a', 'experiences/a.md', 'global', new Float32Array([1, 0]));
    vectors.upsert('exp_b', 'experiences/b.md', 'global', new Float32Array([0, 1]));
    const embedder: Embedder = { dims: 2, encode: async () => [new Float32Array([1, 0])] };
    // FTS 不命中的 query,结果全部来自向量
    const q = '完全不存在的字面';

    const all = await searchLessonsHybrid(vault, q, { query: q }, { index, embedder, vectors, recallTopK: 5 });
    const filtered = await searchLessonsHybrid(vault, q, { query: q }, { index, embedder, vectors, recallTopK: 5, minScore: 0.5 });

    expect(all.map((h) => h.path)).toEqual(expect.arrayContaining(['experiences/a.md', 'experiences/b.md']));
    expect(filtered.map((h) => h.path)).toEqual(['experiences/a.md']);

    index.close();
    vectors.close();
  });
});
