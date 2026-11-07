import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudIndexStatus,
  cloudVectorSearch,
  syncCloudIndex,
  type CloudSearchConfig,
} from '../../../src/core/search/cloud.js';
import { searchLessons, closeSearchCache } from '../../../src/core/search/service.js';

/** 假向量：命中词写进固定维度，便于断言最近邻与增量行为。 */
function fakeEmbedding(text: string): number[] {
  const v = [0, 0, 0, 0];
  if (/COS|签名|上传/i.test(text)) v[0] = 1;
  if (/lark|飞书|评论/i.test(text)) v[1] = 1;
  if (!v[0] && !v[1]) v[2] = 1;
  return v;
}

const defaultFetch = async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  return new Response(
    JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: fakeEmbedding(text) })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

const fetchMock = vi.fn(defaultFetch);

let vault: string;
let cfg: CloudSearchConfig;

async function seed(rel: string, body: string): Promise<string> {
  const abs = join(vault, 'library/lessons', rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(
    abs,
    [
      '---',
      'type: experiences/gotcha',
      'title: "T-' + rel + '"',
      'updated_at: "2026-10-01T00:00:00.000Z"',
      '---',
      '',
      body,
      '',
    ].join('\n'),
    'utf8',
  );
  return abs;
}

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'trove-cloud-search-'));
  cfg = {
    dbPath: join(vault, 'cache', 'cloud-vectors.sqlite'),
    apiKey: 'sk-test',
    baseUrl: 'https://dashscope.example/compatible-mode/v1',
    model: 'text-embedding-v4',
    dimension: 4,
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(defaultFetch);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  closeSearchCache();
  vi.unstubAllGlobals();
  await rm(vault, { recursive: true, force: true });
});

describe('syncCloudIndex · 百炼云端向量', () => {
  it('首次同步嵌入全部文档，第二次同步不重复调用接口', async () => {
    await seed('experiences/cos.md', 'S3 上传报 SignatureDoesNotMatch。');
    await seed('entities/lark.md', '飞书文档评论用 lark-cli 读取。');

    const first = await syncCloudIndex(vault, cfg);
    expect(first).toEqual({ documents: 2, chunksEmbedded: 2, needsEmbedding: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await syncCloudIndex(vault, cfg);
    expect(second.chunksEmbedded).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('文件内容变更触发重嵌，删除的文件向量随之清理', async () => {
    const abs = await seed('experiences/cos.md', 'S3 上传报 403。');
    await seed('entities/lark.md', '飞书文档评论。');
    await syncCloudIndex(vault, cfg);

    await writeFile(abs, ['---', 'title: "T-cos"', '---', '', '换了内容：COS 签名问题。', ''].join('\n'), 'utf8');
    await utimes(abs, new Date(), new Date(Date.now() + 2000));
    const changed = await syncCloudIndex(vault, cfg);
    expect(changed.chunksEmbedded).toBe(1);
    expect(changed.documents).toBe(2);

    await unlink(join(vault, 'library/lessons/entities/lark.md'));
    const removed = await syncCloudIndex(vault, cfg);
    expect(removed.documents).toBe(1);
  });

  it('模型或维度变化清空旧向量重新嵌入', async () => {
    await seed('experiences/cos.md', 'S3 上传报 403。');
    await syncCloudIndex(vault, cfg);

    const switched = await syncCloudIndex(vault, { ...cfg, model: 'text-embedding-v3' });
    expect(switched.chunksEmbedded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://dashscope.example/compatible-mode/v1/embeddings');
  });

  it('接口失败时抛出可读错误，不写坏向量', async () => {
    await seed('experiences/cos.md', 'S3 上传报 403。');
    fetchMock.mockResolvedValueOnce(new Response('{"message":"invalid api key"}', { status: 401 }));
    await expect(syncCloudIndex(vault, cfg)).rejects.toThrow(/百炼 embeddings 调用失败:HTTP 401/);
    expect(cloudIndexStatus(cfg)?.documents).toBe(0);
  });
});

describe('cloudVectorSearch', () => {
  it('按余弦相似度召回，索引不存在时返回空', async () => {
    expect(await cloudVectorSearch('飞书', cfg)).toEqual([]);

    await seed('experiences/cos.md', 'S3 上传报 403。');
    await seed('entities/lark.md', '飞书文档评论。');
    await syncCloudIndex(vault, cfg);

    const hits = await cloudVectorSearch('飞书怎么读评论', cfg, 2);
    expect(hits[0]!.path).toBe('entities/lark.md');
    expect(hits[0]!.score).toBeGreaterThan(0.9);
  });
});

describe('searchLessons · 云端后端', () => {
  it('词法无命中时向量召回仍能返回结果', async () => {
    await seed('experiences/cos.md', 'S3 上传报 SignatureDoesNotMatch，签名要按原始路径重算。');
    await syncCloudIndex(vault, cfg);

    const hits = await searchLessons(vault, { query: '上传' }, { provider: 'dashscope', ...cfg });
    expect(hits.map((h) => h.path)).toEqual(['experiences/cos.md']);
    expect(hits[0]!.title).toBe('T-experiences/cos.md');
    expect(hits[0]!.snippet).toContain('SignatureDoesNotMatch');
  });

  it('云端不可达时落回纯 FTS，不抛错', async () => {
    await seed('entities/lark.md', '飞书文档评论用 lark-cli 读取。');
    await syncCloudIndex(vault, cfg);
    fetchMock.mockRejectedValue(new Error('network down'));

    const hits = await searchLessons(vault, { query: 'lark-cli' }, { provider: 'dashscope', ...cfg });
    expect(hits.map((h) => h.path)).toEqual(['entities/lark.md']);
  });

  it('category/type 过滤对向量命中同样生效', async () => {
    await seed('experiences/cos.md', 'COS 上传报 403。');
    await seed('entities/lark.md', '飞书文档评论。');
    await syncCloudIndex(vault, cfg);

    const hits = await searchLessons(vault, { query: '飞书', category: 'experiences' }, { provider: 'dashscope', ...cfg });
    expect(hits).toEqual([]);
  });
});