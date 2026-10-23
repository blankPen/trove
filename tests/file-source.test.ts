import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { discoverFiles, type FileSourceConfig } from '../src/adapters/file-source.js';

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trove-src-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  return root;
}

const base = (root: string, over: Partial<FileSourceConfig> = {}): FileSourceConfig => ({
  id: 'demo',
  displayName: 'Demo',
  root,
  patterns: ['**/*.jsonl'],
  exclusions: [],
  pruneDirs: [],
  ...over,
});

describe('discoverFiles(白名单,不是黑名单)', () => {
  it('只收白名单命中的文件,路径统一用 /', async () => {
    const root = await tree({ 'a/x.jsonl': '1', 'a/y.txt': '2', 'z.jsonl': '3' });
    const out = await discoverFiles(base(root));
    expect(out.map((f) => f.relPath).sort()).toEqual(['a/x.jsonl', 'z.jsonl']);
    expect(out.every((f) => f.absPath.startsWith(root))).toBe(true);
  });

  it('排除项优先于白名单', async () => {
    const root = await tree({ 'a/x.jsonl': '1', 'a/secret/x.jsonl': '2' });
    const out = await discoverFiles(base(root, { exclusions: ['**/secret/**'] }));
    expect(out.map((f) => f.relPath)).toEqual(['a/x.jsonl']);
  });

  it('剪枝目录整棵跳过(不进去遍历)', async () => {
    const root = await tree({ 'plugins/big/x.jsonl': '1', 'ok.jsonl': '2' });
    const out = await discoverFiles(base(root, { pruneDirs: ['plugins'] }));
    expect(out.map((f) => f.relPath)).toEqual(['ok.jsonl']);
  });

  it('点开头的目录可被匹配(minimatch dot:true)', async () => {
    const root = await tree({ '.sessions/s1/board.md': 'x' });
    const out = await discoverFiles(base(root, { patterns: ['.sessions/**'], pruneDirs: [] }));
    expect(out.map((f) => f.relPath)).toEqual(['.sessions/s1/board.md']);
  });

  it('悬空符号链接跳过,指向文件的链接收录', async () => {
    const root = await tree({ 'real.jsonl': 'hi' });
    await symlink(join(root, 'real.jsonl'), join(root, 'link.jsonl'));
    await symlink(join(root, 'nope.jsonl'), join(root, 'dangling.jsonl'));
    const out = await discoverFiles(base(root));
    expect(out.map((f) => f.relPath).sort()).toEqual(['link.jsonl', 'real.jsonl']);
  });

  it('会话归组:同目录多文件共享 sessionKey,sessionMtime 取最大值', async () => {
    const root = await tree({ '.sessions/s1/a.jsonl': 'aaa', '.sessions/s1/b/c.jsonl': 'c' });
    const out = await discoverFiles(
      base(root, {
        patterns: ['.sessions/**'],
        sessionKeyOf: (rel) => rel.split('/')[1] ?? rel,
      }),
    );
    expect(out.map((f) => f.sessionKey)).toEqual(['s1', 's1']);
    const maxMtime = Math.max(...out.map((f) => f.mtimeMs));
    expect(out.every((f) => f.sessionMtimeMs === maxMtime)).toBe(true);
  });

  it('未提供 sessionKeyOf 时会话即文件自身', async () => {
    const root = await tree({ 'a.jsonl': '1' });
    const out = await discoverFiles(base(root));
    expect(out[0]!.sessionKey).toBe('a.jsonl');
    expect(out[0]!.sessionMtimeMs).toBe(out[0]!.mtimeMs);
  });
});
