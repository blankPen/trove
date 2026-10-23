import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { trovePaths } from '../src/paths.js';
import { indexPath } from '../src/core/remote-layout.js';
import { MemoryRemote } from './helpers/memory-remote.js';

function sessionBody(): string {
  return (
    [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:00.000Z',
        cwd: '/Users/admin/orca/trove',
        message: { role: 'user', content: '为什么我 link 了还是 trove init' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-10-22T13:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: '看下 PATH' }],
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'trove-cli-dlg-'));
  const src = join(base, 'src');
  await mkdir(join(src, 'projects'), { recursive: true });
  await writeFile(join(src, 'projects/a.jsonl'), sessionBody());

  const paths = trovePaths(base);
  const config = defaultConfig({ deviceId: 'dev-cli', deviceName: '测试机' });
  config.remote = { url: 'http://example.invalid', username: 'u', password: 'p' };
  config.sources = { 'claude-code': { enabled: true } };
  await saveConfig(paths.config, config);

  const remote = new MemoryRemote();
  const lines: string[] = [];
  const deps = {
    base,
    createRemote: () => remote,
    resolveAdapters: () => [
      {
        kind: 'files' as const,
        id: 'claude-code' as const,
        displayName: 'Claude Code',
        source: {
          id: 'claude-code',
          displayName: 'Claude Code',
          root: src,
          patterns: ['projects/**/*.jsonl'],
          exclusions: [],
          sessionPatterns: ['projects/**/*.jsonl'],
        },
      },
    ],
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    rawOut: () => {},
    isTTY: false,
    now: () => 1_000_000,
  };
  return { base, paths, remote, lines, deps };
}

describe('trove sessions', () => {
  it('列出对话层会话,支持 --grep 与 --json', async () => {
    const { lines, deps } = await setup();
    await run(['sync'], deps);

    lines.length = 0;
    expect(await run(['sessions'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('为什么我 link 了还是 trove init');
    expect(lines.join('\n')).toContain('claude-code');

    lines.length = 0;
    expect(await run(['sessions', '--grep', 'PATH'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('1 个会话');

    lines.length = 0;
    expect(await run(['sessions', '--grep', '不存在的词'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('没有匹配');

    lines.length = 0;
    expect(await run(['sessions', '--json'], deps)).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as Array<{ session: string; harness: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ session: 's1', harness: 'claude-code' });
  });

  it('config.sync.raw=false 时默认只同步 library,--raw 可覆盖', async () => {
    const { paths, remote, deps } = await setup();
    const cfg = await loadConfig(paths.config);
    cfg.sync.raw = false;
    await saveConfig(paths.config, cfg);

    expect(await run(['sync'], deps)).toBe(0);
    expect(await remote.readJson(indexPath('dev-cli'))).toBeNull();
    expect(remote.files.has('library/index/dev-cli.json')).toBe(true);

    expect(await run(['sync', '--raw'], deps)).toBe(0);
    expect(await remote.readJson(indexPath('dev-cli'))).not.toBeNull();
  });

  it('sync --no-raw 只推送 library', async () => {
    const { remote, deps } = await setup();

    expect(await run(['sync', '--no-raw'], deps)).toBe(0);

    expect(await remote.readJson(indexPath('dev-cli'))).toBeNull();
    expect(remote.files.has('library/index/dev-cli.json')).toBe(true);
    expect([...remote.files.keys()].some((p) => p.startsWith('library/sessions/'))).toBe(true);
  });
});
