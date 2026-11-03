import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeMemo, mapClaudeMemoType, collectClaudeMemos } from '../../src/core/lessons/memo.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs.length = 0;
});

describe('parseClaudeMemo', () => {
  it('解析顶层 type 变体', () => {
    const m = parseClaudeMemo(
      '---\nname: user_pz\ndescription: 用户基本信息\ntype: user\noriginSessionId: abc\n---\n\n正文内容\n',
    );
    expect(m).toMatchObject({ name: 'user_pz', description: '用户基本信息', type: 'user' });
    expect(m!.body).toBe('正文内容');
  });

  it('解析 metadata 块下的 type 变体', () => {
    const m = parseClaudeMemo(
      '---\nname: resttemplate-double-encoding\ndescription: 编码坑\nmetadata:\n  node_type: memory\n  type: feedback\n  originSessionId: xyz\n---\n\n## Why\n原因\n',
    );
    expect(m!.type).toBe('feedback');
    expect(m!.body).toContain('## Why');
  });

  it('无 type 返回 null', () => {
    expect(parseClaudeMemo('---\nname: x\ndescription: y\n---\nbody')).toBeNull();
    expect(parseClaudeMemo('没有 frontmatter')).toBeNull();
  });
});

describe('mapClaudeMemoType', () => {
  it('四类映射正确,未知 type 返回 undefined', () => {
    expect(mapClaudeMemoType('user')).toBe('preferences/profile');
    expect(mapClaudeMemoType('feedback')).toBe('experiences/correction');
    expect(mapClaudeMemoType('project')).toBe('experiences/gotcha');
    expect(mapClaudeMemoType('reference')).toBe('resources/doc');
    expect(mapClaudeMemoType('unknown')).toBeUndefined();
  });
});

describe('collectClaudeMemos', () => {
  it('排除 MEMORY.md、跳过未知 type、patch 固定文件多条合并', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trove-memo-'));
    tmpDirs.push(root);

    const mem = join(root, 'projects', 'p1', 'memory');
    await mkdir(mem, { recursive: true });
    await writeFile(join(mem, 'user_pz.md'), '---\nname: user_pz\ndescription: 用户A\ntype: user\n---\n\nA 是前端\n');
    await writeFile(join(mem, 'user_profile.md'), '---\nname: user-profile\ndescription: 用户B\ntype: user\n---\n\nB 是后端\n');
    await writeFile(join(mem, 'backend.md'), '---\nname: backend architecture\ndescription: 后端架构\ntype: project\n---\n\n架构说明\n');
    await writeFile(join(mem, 'MEMORY.md'), '# 索引\n');
    await writeFile(join(mem, 'unknown.md'), '---\nname: x\ndescription: y\ntype: foo\n---\n\n忽略\n');

    const p2mem = join(root, 'projects', 'p2', 'memory');
    await mkdir(p2mem, { recursive: true });
    await writeFile(join(p2mem, 'ref.md'), '---\nname: doc-ref\ndescription: 文档\ntype: reference\n---\n\n文档正文\n');

    const cands = await collectClaudeMemos(root);
    // user 合并为 1 条 profile,project 1 条 gotcha,reference 1 条 doc,共 3 条(排除 MEMORY.md 与未知 type)
    expect(cands).toHaveLength(3);
    const profile = cands.find((c) => c.type === 'preferences/profile')!;
    expect(profile.content).toContain('A 是前端');
    expect(profile.content).toContain('B 是后端');
    expect(cands.some((c) => c.type === 'experiences/gotcha')).toBe(true);
    expect(cands.some((c) => c.type === 'resources/doc')).toBe(true);
    expect(cands.some((c) => c.type === 'experiences/correction')).toBe(false);
  });
});