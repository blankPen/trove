import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VectorIndex } from '../../../src/core/lessons/vector-index.js';
import { syncVectorIndex } from '../../../src/core/lessons/vector-sync.js';
import type { Embedder } from '../../../src/core/lessons/embedding.js';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpVault(): Promise<{ vault: string; db: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'trove-vsync-'));
  dirs.push(dir);
  return { vault: join(dir, 'vault'), db: join(dir, 'cache', 'vectors.sqlite') };
}

function mem(id: string, updatedAt: string, body: string): string {
  return [
    '---',
    `id: ${JSON.stringify(id)}`,
    'kind: entity',
    'type: entities/tool',
    `title: ${JSON.stringify('工具' + id)}`,
    'tags: []',
    'scope: global',
    'status: active',
    'version: 1',
    'evidence: []',
    'created_at: "2026-01-01T00:00:00.000Z"',
    `updated_at: ${JSON.stringify(updatedAt)}`,
    'use_count: 0',
    'helpful_count: 0',
    '---',
    '',
    body,
  ].join('\n');
}

const embedder: Embedder = {
  dims: 3,
  async encode(texts) {
    return texts.map((t) => new Float32Array([t.length, 0, 0]));
  },
};

async function writeMem(vault: string, rel: string, text: string): Promise<void> {
  const abs = join(vault, 'library/lessons', rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, text, 'utf8');
}

describe('syncVectorIndex(增量同步)', () => {
  it('新增:磁盘记忆被编码并 upsert', async () => {
    const { vault, db } = await tmpVault();
    await writeMem(vault, 'entities/a.md', mem('ent_a', '2026-01-01T00:00:00.000Z', '这是一个工具实体的正文内容'));
    const index = VectorIndex.open(db);
    const r = await syncVectorIndex(vault, index, embedder);
    expect(r).toEqual({ indexed: 1, removed: 0, skipped: 0 });
    expect(index.count()).toBe(1);
    expect(index.get('ent_a')).not.toBeNull();
    index.close();
  });

  it('更新:updated_at 变化才重编码,不变则跳过', async () => {
    const { vault, db } = await tmpVault();
    await writeMem(vault, 'entities/a.md', mem('ent_a', '2026-01-01T00:00:00.000Z', '这是一个工具实体的正文内容'));
    const index = VectorIndex.open(db);
    await syncVectorIndex(vault, index, embedder);
    const again = await syncVectorIndex(vault, index, embedder);
    expect(again.indexed).toBe(0);
    await writeMem(vault, 'entities/a.md', mem('ent_a', '2026-01-02T00:00:00.000Z', '这是一个工具实体的正文内容'));
    const upd = await syncVectorIndex(vault, index, embedder);
    expect(upd.indexed).toBe(1);
    index.close();
  });

  it('删除:磁盘不存在的记忆从索引移除', async () => {
    const { vault, db } = await tmpVault();
    await writeMem(vault, 'entities/a.md', mem('ent_a', '2026-01-01T00:00:00.000Z', '这是一个工具实体的正文内容'));
    const index = VectorIndex.open(db);
    await syncVectorIndex(vault, index, embedder);
    await rm(join(vault, 'library/lessons/entities/a.md'));
    const r = await syncVectorIndex(vault, index, embedder);
    expect(r.removed).toBe(1);
    expect(index.count()).toBe(0);
    index.close();
  });

  it('跳过过短文本:不产生索引条目', async () => {
    const { vault, db } = await tmpVault();
    await writeMem(vault, 'entities/a.md', mem('ent_a', '2026-01-01T00:00:00.000Z', '短'));
    const index = VectorIndex.open(db);
    const r = await syncVectorIndex(vault, index, embedder);
    expect(r.skipped).toBe(1);
    expect(index.count()).toBe(0);
    index.close();
  });
});
