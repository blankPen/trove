import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LessonsIndex } from '../../../src/core/search/lessons-index.js';

async function seed(vault: string, rel: string, front: Record<string, unknown>, body: string): Promise<void> {
  const abs = join(vault, 'library/lessons', rel);
  await mkdir(join(abs, '..'), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(front)) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---', '', body);
  await writeFile(abs, lines.join('\n'));
}

async function fixture(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'trove-lessons-'));
  await seed(
    vault,
    'experiences/gotcha-cos-signature.md',
    {
      type: 'experiences/gotcha',
      title: 'COS 签名 403',
      tags: ['experiences', 'gotcha'],
      updated_at: '2026-11-03T10:00:00Z',
    },
    'S3 推送时报 SignatureDoesNotMatch，需要检查 SecretKey 与时间戳。',
  );
  await seed(
    vault,
    'experiences/gotcha-feishu-edit.md',
    {
      type: 'experiences/gotcha',
      title: '飞书文档编辑按钮点击命中测试',
      tags: ['experiences', 'gotcha'],
      updated_at: '2026-11-02T10:00:00Z',
    },
    '编辑态需要先校验 zoneCount 与 revCount。',
  );
  await seed(
    vault,
    'entities/tools/trove.md',
    {
      type: 'entities/tool',
      title: 'trove CLI',
      tags: ['entities', 'tools'],
      updated_at: '2026-11-01T10:00:00Z',
    },
    'trove 是 AI 会话归档工具。',
  );
  return vault;
}

let index: LessonsIndex | undefined;
afterEach(() => {
  index?.close();
  index = undefined;
});

describe('LessonsIndex', () => {
  it('中文 FTS5 检索 + 类目过滤', async () => {
    index = await LessonsIndex.build(await fixture());
    const hits = index.search({ query: 'COS 签名' });
    expect(hits[0]?.path).toBe('experiences/gotcha-cos-signature.md');
    expect(index.search({ query: '飞书 编辑' })[0]?.path).toBe('experiences/gotcha-feishu-edit.md');
    expect(index.search({ query: 'COS 签名', category: 'entities' })).toHaveLength(0);
  });

  it('list / get / 单字降级 / 路径穿越', async () => {
    index = await LessonsIndex.build(await fixture());
    expect(index.list({ category: 'experiences' })).toHaveLength(2);
    expect(index.get('experiences/gotcha-cos-signature.md')?.body).toContain('SignatureDoesNotMatch');
    expect(index.search({ query: '书' }).some((h) => h.path.includes('feishu'))).toBe(true);
    expect(index.get('../../etc/passwd')).toBeNull();
  });

  it('解析 frontmatter scope 到 doc 与 hit', async () => {
    const vault = await fixture();
    await seed(
      vault,
      'experiences/proj-note.md',
      { type: 'experiences/gotcha', title: '项目内经验', tags: ['experiences'], scope: 'project:trove' },
      '这是项目内经验正文。',
    );
    index = await LessonsIndex.build(vault);
    expect(index.get('experiences/proj-note.md')?.scope).toBe('project:trove');
    const hit = index.search({ query: '项目内' }).find((h) => h.path === 'experiences/proj-note.md');
    expect(hit?.scope).toBe('project:trove');
  });
});
