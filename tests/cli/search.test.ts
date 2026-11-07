import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/cli.js';
import { defaultConfig, saveConfig } from '../../src/config.js';
import { trovePaths } from '../../src/paths.js';
import { rebuildUnifiedIndex } from '../../src/core/library/index-file.js';

// lessons 检索只走 qmd；CLI 测试里用假 store，避免加载本地 GGUF 模型。
const { qmdSearch } = vi.hoisted(() => ({ qmdSearch: vi.fn() }));
vi.mock('@tobilu/qmd', () => ({
  createStore: async () => ({
    search: qmdSearch,
    getStatus: async () => ({ totalDocuments: 0, needsEmbedding: 0, hasVectorIndex: false }),
    update: async () => ({}),
    embed: async () => ({}),
    close: async () => {},
  }),
}));

async function writeLesson(vault: string, rel: string, front: Record<string, string[] | string>, body: string) {
  const abs = join(vault, 'library/lessons', rel);
  await mkdir(join(abs, '..'), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(front)) {
    lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  lines.push('---', '', body);
  await writeFile(abs, lines.join('\n'));
}

async function writeSession(
  vault: string,
  device: string,
  harness: string,
  session: string,
  firstText: string,
  body: string,
): Promise<void> {
  const rel = `sessions/${harness}/${session}/${device}.jsonl`;
  const abs = join(vault, 'library', ...rel.split('/'));
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(
    abs,
    [
      JSON.stringify({
        v: 1,
        seq: 0,
        kind: 'session',
        harness,
        session,
        firstText,
        cwd: '/Users/admin/orca/trove',
        startedAt: '2026-11-04T02:30:00.000Z',
      }),
      JSON.stringify({ v: 1, seq: 1, kind: 'message', role: 'user', text: body }),
      JSON.stringify({
        v: 1,
        seq: 2,
        kind: 'tool_result',
        result: { output: 'SignatureDoesNotMatch: signature mismatch' },
      }),
    ].join('\n') + '\n',
  );
  const shardPath = join(vault, 'library/index', `${device}.json`);
  let shard: Record<string, unknown>;
  try {
    shard = JSON.parse(await readFile(shardPath, 'utf8')) as Record<string, unknown>;
  } catch {
    shard = { v: 1, device, mapper: 'test', updatedAt: '', sessions: {}, skills: {} };
  }
  const sessions = shard.sessions as Record<string, unknown>;
  sessions[`${harness}:${session}`] = {
    device,
    path: rel,
    hash: `hash-${session}`,
    events: 3,
    rawSources: [],
    firstText,
    cwd: '/Users/admin/orca/trove',
    startedAt: '2026-11-04T02:30:00.000Z',
  };
  await mkdir(join(vault, 'library/index'), { recursive: true });
  await writeFile(shardPath, JSON.stringify(shard));
  await rebuildUnifiedIndex(vault);
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'trove-search-cli-'));
  const paths = trovePaths(base);
  await saveConfig(paths.config, defaultConfig({ deviceId: 'dev-search', deviceName: '测试机' }));
  await writeLesson(
    base + '/vault',
    'preferences/profile.md',
    {
      type: 'preferences/profile',
      title: '"阿振"',
      tags: ['preferences', 'profile'],
      updated_at: '"2026-11-03T10:00:00Z"',
    },
    '### 我是谁\n阿振，研发四部 TL。\n\n### 年龄\n不写。',
  );
  await writeLesson(
    base + '/vault',
    'experiences/gotcha-cos-signature.md',
    {
      type: 'experiences/gotcha',
      title: '"COS 签名 403"',
      tags: ['experiences', 'gotcha'],
      updated_at: '"2026-11-03T10:00:00Z"',
    },
    'S3 推送时报 SignatureDoesNotMatch，需要检查 SecretKey。',
  );
  await writeLesson(
    base + '/vault',
    'experiences/gotcha-feishu-edit.md',
    {
      type: 'experiences/gotcha',
      title: '"飞书文档编辑按钮命中"',
      tags: ['experiences', 'gotcha'],
      updated_at: '"2026-11-02T10:00:00Z"',
    },
    '编辑态需要校验 zoneCount 与 revCount。',
  );
  await writeSession(base + '/vault', 'dev1', 'claude-code', 's-cos', '修复 COS 签名报错', '排查 S3 签名');
  const lines: string[] = [];
  const deps = {
    base,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    isTTY: false,
    now: () => Date.parse('2026-11-04T10:00:00Z'),
  };
  return { base, paths, lines, deps };
}

describe('trove search CLI', () => {
  it('index build + sessions search + show', async () => {
    const { lines, deps } = await setup();
    expect(await run(['index', 'build', '--quiet'], deps)).toBe(0);

    lines.length = 0;
    expect(await run(['sessions', 'search', 'COS 签名', '--json'], deps)).toBe(0);
    const output = JSON.parse(lines.join('\n')) as { results: Array<{ session: string }> };
    expect(output.results[0]?.session).toBe('s-cos');

    lines.length = 0;
    expect(await run(['sessions', 'show', 's-cos', '--around', 'SignatureDoesNotMatch'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('SignatureDoesNotMatch');
  });

  it('lessons search/show + whoami + status --json', async () => {
    const { lines, deps } = await setup();
    qmdSearch.mockResolvedValue([
      { file: 'qmd://experiences/gotcha-feishu-edit.md', displayPath: '', title: '', score: 0.9 },
    ]);

    lines.length = 0;
    expect(await run(['lessons', 'search', '飞书 编辑', '--json'], deps)).toBe(0);
    const lessons = JSON.parse(lines.join('\n')) as { results: Array<{ path: string }> };
    expect(lessons.results[0]?.path).toBe('experiences/gotcha-feishu-edit.md');

    lines.length = 0;
    expect(await run(['lessons', 'show', 'experiences/gotcha-cos-signature.md'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('SignatureDoesNotMatch');

    lines.length = 0;
    expect(await run(['whoami', '--json'], deps)).toBe(0);
    const who = JSON.parse(lines.join('\n')) as { profile: string };
    expect(who.profile).toContain('阿振');
    expect(who.profile).not.toContain('不写');

    lines.length = 0;
    expect(await run(['status', '--json'], deps)).toBe(0);
    const status = JSON.parse(lines.join('\n')) as { search: { lessons: { total: number } } };
    expect(status.search.lessons.total).toBe(3);
  });
});
