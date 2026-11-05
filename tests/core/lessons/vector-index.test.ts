import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VectorIndex, cosineSimilarity } from '../../../src/core/lessons/vector-index.js';

const v = (...xs: number[]): Float32Array => new Float32Array(xs);

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trove-vec-'));
  dirs.push(dir);
  return join(dir, 'vectors.sqlite');
}

describe('cosineSimilarity', () => {
  it('同向=1,正交=0,反向=-1', () => {
    expect(cosineSimilarity(v(1, 0, 0), v(1, 0, 0))).toBeCloseTo(1, 5);
    expect(cosineSimilarity(v(1, 0, 0), v(0, 1, 0))).toBeCloseTo(0, 5);
    expect(cosineSimilarity(v(1, 0), v(-1, 0))).toBeCloseTo(-1, 5);
  });

  it('零向量或长度不同 → 0(不除零、不越界)', () => {
    expect(cosineSimilarity(v(0, 0), v(1, 1))).toBe(0);
    expect(cosineSimilarity(v(1, 1), v(0, 0))).toBe(0);
    expect(cosineSimilarity(v(1, 0), v(1, 0, 0))).toBe(0);
  });
});

describe('VectorIndex', () => {
  it('upsert/get/remove/count:覆盖更新、删除清空', async () => {
    const idx = VectorIndex.open(await tmpDb());
    idx.upsert('exp_1', 'a.md', 'global', v(1, 0, 0), 1000);
    expect(idx.count()).toBe(1);
    expect(idx.get('exp_1')?.vector).toEqual(v(1, 0, 0));
    expect(idx.get('exp_1')?.scope).toBe('global');
    expect(idx.get('missing')).toBeNull();

    idx.upsert('exp_1', 'a.md', 'project:x', v(0, 1, 0), 2000); // 同 id 覆盖
    expect(idx.count()).toBe(1);
    expect(idx.get('exp_1')?.vector).toEqual(v(0, 1, 0));
    expect(idx.get('exp_1')?.scope).toBe('project:x');

    idx.remove('exp_1');
    expect(idx.get('exp_1')).toBeNull();
    expect(idx.count()).toBe(0);
    idx.close();
  });

  it('all 返回全部行(含 scope 可选)', async () => {
    const idx = VectorIndex.open(await tmpDb());
    idx.upsert('a', 'a.md', undefined, v(1, 0));
    idx.upsert('b', 'b.md', 'global', v(0, 1));
    const all = idx.all();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.memoryId))).toEqual(new Set(['a', 'b']));
    expect(all.find((r) => r.memoryId === 'a')?.scope).toBeUndefined();
    idx.close();
  });

  it('search 按余弦降序取 topK', async () => {
    const idx = VectorIndex.open(await tmpDb());
    idx.upsert('far', 'far.md', undefined, v(1, 0, 0));
    idx.upsert('near', 'near.md', undefined, v(0.6, 0.8, 0));
    const hits = idx.search(v(0, 1, 0), 2);
    expect(hits.map((h) => h.memoryId)).toEqual(['near', 'far']);
    expect(hits[0]!.score).toBeCloseTo(0.8, 5);
    idx.close();
  });

  it('meta set/get 与 clear(清空向量与元数据)', async () => {
    const idx = VectorIndex.open(await tmpDb());
    expect(idx.getMeta('model')).toBeNull();
    idx.setMeta('model', 'Xenova/bge-small-zh-v1.5');
    idx.setMeta('dim', '512');
    expect(idx.getMeta('model')).toBe('Xenova/bge-small-zh-v1.5');
    idx.upsert('a', 'a.md', undefined, v(1));
    idx.clear();
    expect(idx.count()).toBe(0);
    expect(idx.getMeta('model')).toBeNull();
    idx.close();
  });

  it('1000 条随机向量暴力检索 < 1s(粗上限,防 flaky)', async () => {
    const idx = VectorIndex.open(await tmpDb());
    for (let i = 0; i < 1000; i++) {
      const arr = new Float32Array(512);
      for (let j = 0; j < 512; j++) arr[j] = Math.random();
      idx.upsert(`m${i}`, `p${i}.md`, undefined, arr);
    }
    const q = new Float32Array(512).map(() => Math.random());
    const t0 = Date.now();
    const hits = idx.search(q, 10);
    expect(hits).toHaveLength(10);
    expect(Date.now() - t0).toBeLessThan(1000);
    idx.close();
  });
});
