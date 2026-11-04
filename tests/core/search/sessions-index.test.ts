import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionsIndex } from '../../../src/core/search/sessions-index.js';
import { searchSessions, getSearchStatus } from '../../../src/core/search/service.js';
import { rebuildUnifiedIndex } from '../../../src/core/library/index-file.js';

interface Seed {
  harness: string;
  session: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  startedAt?: string;
  text?: string;
  toolOutput?: string;
}

async function seed(vault: string, device: string, s: Seed): Promise<void> {
  const rel = `sessions/${s.harness}/${s.session}/${device}.jsonl`;
  const abs = join(vault, 'library', ...rel.split('/'));
  await mkdir(join(abs, '..'), { recursive: true });
  const lines = [
    JSON.stringify({
      v: 1,
      seq: 0,
      kind: 'session',
      harness: s.harness,
      session: s.session,
      ...(s.title ? { title: s.title } : {}),
      ...(s.firstText ? { firstText: s.firstText } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    }),
    JSON.stringify({ v: 1, seq: 1, kind: 'message', role: 'user', text: s.text ?? '' }),
    ...(s.toolOutput
      ? [JSON.stringify({ v: 1, seq: 2, kind: 'tool_result', result: { output: s.toolOutput } })]
      : []),
  ];
  await writeFile(abs, lines.join('\n') + '\n');

  const shardPath = join(vault, 'library/index', `${device}.json`);
  let shard: {
    v: 1;
    device: string;
    mapper: string;
    updatedAt: string;
    sessions: Record<string, unknown>;
    skills: Record<string, unknown>;
  };
  try {
    shard = JSON.parse(await readFile(shardPath, 'utf8'));
  } catch {
    shard = { v: 1, device, mapper: 'test', updatedAt: '', sessions: {}, skills: {} };
  }
  shard.sessions[`${s.harness}:${s.session}`] = {
    device,
    path: rel,
    hash: `hash-${s.session}-${s.text ?? ''}`,
    events: lines.length,
    rawSources: [],
    ...(s.title ? { title: s.title } : {}),
    ...(s.firstText ? { firstText: s.firstText } : {}),
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
  };
  await mkdir(join(vault, 'library/index'), { recursive: true });
  await writeFile(shardPath, JSON.stringify(shard));
  await rebuildUnifiedIndex(vault);
}

async function fixture(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'trove-sessions-index-'));
  await seed(vault, 'dev1', {
    harness: 'claude-code',
    session: 's-cos',
    firstText: '修复 COS 签名报错',
    cwd: '/Users/admin/orca/trove',
    startedAt: '2026-11-04T02:30:00.000Z',
    text: 'S3 推送时报错，需要排查签名',
    toolOutput: 'SignatureDoesNotMatch: the request signature we calculated does not match',
  });
  await seed(vault, 'dev1', {
    harness: 'opencode',
    session: 's-feishu',
    title: '飞书文档编辑',
    cwd: '/Users/admin/pz/docs',
    startedAt: '2026-11-03T09:00:00.000Z',
    text: '用 TreeWalker 定位编辑态',
  });
  return vault;
}

let index: SessionsIndex | undefined;
afterEach(() => {
  index?.close();
  index = undefined;
});

describe('SessionsIndex', () => {
  it('构建后可用中文 FTS 检索，并返回会话级片段', async () => {
    const vault = await fixture();
    index = SessionsIndex.open(join(vault, 'cache/search.sqlite'));
    const stats = await index.build(vault);
    expect(stats.changed).toBe(2);

    const res = await index.search(vault, { query: 'COS 签名' });
    expect(res.results[0]?.session).toBe('s-cos');
    expect(res.results[0]?.snippet).toContain('签名');

    const feishu = await index.search(vault, { query: '飞书 编辑' });
    expect(feishu.results[0]?.session).toBe('s-feishu');
  });

  it('exact 模式覆盖工具输出，get 能定位 around', async () => {
    const vault = await fixture();
    index = SessionsIndex.open(join(vault, 'cache/search.sqlite'));
    await index.build(vault);

    const exact = await index.search(vault, { query: 'SignatureDoesNotMatch', exact: true });
    expect(exact.results[0]?.session).toBe('s-cos');

    const detail = await index.get(vault, 's-cos', { around: 'SignatureDoesNotMatch', limit: 4 });
    expect(detail).not.toBeNull();
    expect(detail?.events.some((e) => e.text.includes('SignatureDoesNotMatch'))).toBe(true);
  });

  it('rebuild 能感知内容变化并更新索引', async () => {
    const vault = await fixture();
    index = SessionsIndex.open(join(vault, 'cache/search.sqlite'));
    await index.build(vault);
    expect((await index.search(vault, { query: 'TreeWalker' })).results.length).toBe(1);

    await seed(vault, 'dev1', {
      harness: 'opencode',
      session: 's-feishu',
      title: '飞书文档编辑',
      cwd: '/Users/admin/pz/docs',
      startedAt: '2026-11-03T09:00:00.000Z',
      text: '改用 Range 替换单字符',
    });
    await index.build(vault, { force: true });
    expect((await index.search(vault, { query: 'Range 替换' })).results[0]?.session).toBe('s-feishu');
  });

  it('索引缺失时降级为线性检索，并标注 no_index', async () => {
    const vault = await fixture();
    const status = await getSearchStatus(vault, join(vault, 'cache-status'));
    expect(status.degraded).toBe('no_index');
    expect(status.sessions.totalSessions).toBe(2);
    expect(status.lessons.total).toBe(0);

    const res = await searchSessions(vault, join(vault, 'cache-missing'), {
      query: 'SignatureDoesNotMatch',
    });
    expect(res.degraded).toBe('no_index');
    expect(res.results[0]?.session).toBe('s-cos');
  });
});
