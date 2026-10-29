import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../src/core/lessons/storage.js';
import { loadExistingMemories } from '../../src/core/lessons/existing.js';
import { parseFrontmatter, stripFrontmatter, renderFrontmatter } from '../../src/core/lessons/frontmatter.js';

let root: string;
let store: LocalStorageAdapter;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lessons-existing-'));
  store = new LocalStorageAdapter(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('现有记忆加载(Stage 9 前置)', () => {
  it('从落盘的记忆文件解析出 type/path/title/content', async () => {
    await store.write(
      'experiences/debug-econnreset.md',
      renderFrontmatter({ type: 'experiences/debug_pattern', title: 'ECONNRESET 时指数退避重试', createdAt: '2026-01-01T00:00:00.000Z' }) + '\n正文内容\n',
    );
    const mems = await loadExistingMemories(store);
    expect(mems).toHaveLength(1);
    expect(mems[0]).toMatchObject({
      type: 'experiences/debug_pattern',
      path: 'experiences/debug-econnreset.md',
      title: 'ECONNRESET 时指数退避重试',
    });
    expect(mems[0]!.content).toContain('正文内容');
  });

  it('忽略 INDEX/概述/审计/归档等非记忆文件', async () => {
    await store.write('INDEX.md', '# INDEX\n');
    await store.write('.overview.md', '# 概览\n');
    await store.write('audit/sess.json', '{}');
    await store.write(
      'archive/experiences/old.md',
      renderFrontmatter({ type: 'experiences/gotcha', title: '已归档的坑' }) + '\n旧正文\n',
    );
    await store.write(
      'preferences/writing_style.md',
      renderFrontmatter({ type: 'preferences/writing_style', title: '写作风格' }) + '\n正文\n',
    );
    const mems = await loadExistingMemories(store);
    expect(mems).toHaveLength(1);
    expect(mems[0]!.path).toBe('preferences/writing_style.md');
  });

  it('parseFrontmatter 反向读回 type/title/tags/scope/source', () => {
    const fm = renderFrontmatter({
      type: 'entities/tool',
      title: 'git',
      tags: ['tool', 'vcs'],
      scope: 'project:trove',
      source: 'session:s1/seq:2',
    });
    const p = parseFrontmatter(fm)!;
    expect(p.type).toBe('entities/tool');
    expect(p.title).toBe('git');
    expect(p.tags).toEqual(['tool', 'vcs']);
    expect(p.scope).toBe('project:trove');
    expect(p.source).toBe('session:s1/seq:2');
  });

  it('stripFrontmatter 返回正文', () => {
    const text = renderFrontmatter({ type: 'events/decision', title: '拍板决定' }) + '\n这是正文第一行\n';
    expect(stripFrontmatter(text)).toContain('这是正文第一行');
  });
});