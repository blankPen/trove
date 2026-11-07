import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// qmd 会真实加载本地 GGUF 模型；单测里换成假 store，只验证 trove 侧的映射。
const search = vi.fn();
vi.mock('@tobilu/qmd', () => ({
  createStore: async () => ({ search, getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false }), update: async () => ({}), embed: async () => ({}), close: async () => {} }),
}));

const { searchLessons, closeSearchCache } = await import('../../../src/core/search/service.js');

let vault: string;
const backend = { provider: 'local' as const, dbPath: join(tmpdir(), 'nope.sqlite'), model: 'hf:test' };

async function seed(rel: string, fm: string[], body: string): Promise<void> {
  const abs = join(vault, 'library/lessons', rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, ['---', ...fm, '---', '', body, ''].join('\n'), 'utf8');
}

beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), 'trove-qmd-search-'));
  search.mockReset();
  await seed(
    'experiences/cos.md',
    [
      'id: "exp_cos_1"',
      'type: experiences/gotcha',
      'title: "COS 签名 403"',
      'tags: ["experiences"]',
      'scope: project:trove',
      'updated_at: "2026-10-01T00:00:00.000Z"',
    ],
    'S3 推送时报 SignatureDoesNotMatch，签名串要按原始路径重算。',
  );
  await seed(
    'entities/lark.md',
    ['id: "ent_lark_1"', 'type: entities/tool', 'title: "lark-cli"', 'tags: ["entities"]', 'updated_at: "2026-11-01T00:00:00.000Z"'],
    '读取飞书文档评论用 lark-cli 的 docs 子命令。',
  );
});

afterEach(async () => {
  closeSearchCache();
  await rm(vault, { recursive: true, force: true });
});

describe('searchLessons · qmd 后端', () => {
  it('qmd 命中映射回 trove 语义：路径、frontmatter、正文片段、qmd 分数', async () => {
    search.mockResolvedValue([
      { file: 'qmd://experiences/cos.md', displayPath: 'experiences/cos.md', title: '占位标题', score: 0.75 },
    ]);
    const hits = await searchLessons(vault, { query: 'COS 签名' }, backend);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      path: 'experiences/cos.md',
      title: 'COS 签名 403',
      type: 'experiences/gotcha',
      id: 'exp_cos_1',
      scope: 'project:trove',
      score: 0.75,
    });
    expect(hits[0]!.snippet).toContain('SignatureDoesNotMatch');
    expect(hits[0]!.snippet).not.toContain('---');
    // 不限定类目时不传 collections，交给 qmd 查全部 collection。
    expect(search.mock.calls[0]![0]).toMatchObject({ query: 'COS 签名' });
    expect(search.mock.calls[0]![0]).not.toHaveProperty('collections');
  });

  it('type 过滤在 trove 侧生效，被过滤掉的命中不会回落到 FTS', async () => {
    search.mockResolvedValue([
      { file: 'qmd://experiences/cos.md', displayPath: '', title: '', score: 0.9 },
      { file: 'qmd://entities/lark.md', displayPath: '', title: '', score: 0.8 },
    ]);
    const hits = await searchLessons(vault, { query: '怎么读评论', type: 'entities/tool' }, backend);
    expect(hits.map((h) => h.path)).toEqual(['entities/lark.md']);
  });

  it('category 透传给 qmd；since 过滤在 trove 侧生效', async () => {
    search.mockResolvedValue([
      { file: 'qmd://experiences/cos.md', displayPath: '', title: '', score: 0.9 },
      { file: 'qmd://entities/lark.md', displayPath: '', title: '', score: 0.8 },
    ]);
    const recent = await searchLessons(vault, { query: '签名', since: Date.parse('2026-10-15T00:00:00Z') }, backend);
    expect(recent.map((h) => h.path)).toEqual(['entities/lark.md']);
    await searchLessons(vault, { query: '签名', category: 'experiences' }, backend);
    expect(search.mock.calls[1]![0]).toMatchObject({ collections: ['experiences'] });
  });

  it('qmd 报错时回落纯 FTS，不抛错', async () => {
    search.mockRejectedValue(new Error('database disk image is malformed'));
    const hits = await searchLessons(vault, { query: 'SignatureDoesNotMatch' }, backend);
    expect(hits.map((h) => h.path)).toEqual(['experiences/cos.md']);
  });

  it('qmd 无命中时回落纯 FTS', async () => {
    search.mockResolvedValue([]);
    const hits = await searchLessons(vault, { query: 'lark-cli' }, backend);
    expect(hits.map((h) => h.path)).toEqual(['entities/lark.md']);
  });

  it('不传后端时不碰 qmd', async () => {
    const hits = await searchLessons(vault, { query: 'lark-cli' });
    expect(search).not.toHaveBeenCalled();
    expect(hits.map((h) => h.path)).toEqual(['entities/lark.md']);
  });
});
