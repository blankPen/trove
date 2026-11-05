import { describe, expect, it } from 'vitest';
import { getEmbedder, isEmbeddableText, embedText } from '../../../src/core/lessons/embedding.js';
import type { EmbeddingConfig, PipelineFn } from '../../../src/core/lessons/embedding.js';
import type { MemoryV2 } from '../../../src/core/lessons/memory.js';

const cfg: EmbeddingConfig = {
  enabled: true,
  model: 'test/model',
  host: 'https://hf-mirror.com',
  batchSize: 8,
  timeoutMs: 60000,
};

describe('isEmbeddableText', () => {
  it('长度 >= 8 码点才可编码', () => {
    expect(isEmbeddableText('12345678')).toBe(true);
    expect(isEmbeddableText('1234567')).toBe(false);
    expect(isEmbeddableText('  足够长的文本  ')).toBe(true);
  });
});

describe('embedText(编码文本抽取)', () => {
  it('经验五段式只取 适用场景/做法/边界与反例 三节,不含标题', () => {
    const mem = {
      body: '## 适用场景\n场景正文\n## 做法\n做法正文\n## 验证\n验证正文\n## 边界与反例\n边界正文\n',
    } as MemoryV2;
    const t = embedText(mem);
    expect(t).toContain('场景正文');
    expect(t).toContain('做法正文');
    expect(t).toContain('边界正文');
    expect(t).not.toContain('验证正文');
    expect(t).not.toContain('## 适用场景');
  });

  it('无分段正文回退全文', () => {
    const mem = { body: '这是一段没有小节的正文内容。' } as MemoryV2;
    expect(embedText(mem)).toBe('这是一段没有小节的正文内容。');
  });
});

describe('getEmbedder(注入假 pipeline,不联网)', () => {
  it('编码返回 Float32Array,并传 pooling/normalize 选项', async () => {
    let captured: unknown;
    const fake: PipelineFn = async (_texts, options) => {
      captured = options;
      return { dims: [2, 3], data: new Float32Array([1, 0, 0, 0, 1, 0]) };
    };
    const e = await getEmbedder({ ...cfg, model: 'test/a' }, { loadPipeline: async () => fake });
    expect(e).not.toBeNull();
    const vecs = await e!.encode(['你好', '世界']);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toBeInstanceOf(Float32Array);
    expect(vecs[0]!.length).toBe(3);
    expect(vecs[1]!.length).toBe(3);
    expect(captured).toMatchObject({ pooling: 'cls', normalize: true });
  });

  it('加载失败(注入抛错)→ null', async () => {
    const e = await getEmbedder(
      { ...cfg, model: 'test/b' },
      { loadPipeline: async () => { throw new Error('no network'); } },
    );
    expect(e).toBeNull();
  });

  it('enabled=false → null 且不加载 pipeline', async () => {
    let loaded = false;
    const e = await getEmbedder(
      { ...cfg, enabled: false, model: 'test/c' },
      { loadPipeline: async () => { loaded = true; return async () => ({ dims: [1], data: new Float32Array([1]) }); } },
    );
    expect(e).toBeNull();
    expect(loaded).toBe(false);
  });
});
