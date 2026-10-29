import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { run } from '../src/cli.js';
import { defaultConfig, saveConfig } from '../src/config.js';
import { trovePaths } from '../src/paths.js';
import { indexPath, type DeviceIndex } from '../src/core/remote-layout.js';
import { MemoryRemote } from './helpers/memory-remote.js';

async function setup(body = 'hello world') {
  const base = await mkdtemp(join(tmpdir(), 'trove-cli-'));
  const src = join(base, 'src');
  await mkdir(join(src, 'projects'), { recursive: true });
  await writeFile(join(src, 'projects/a.jsonl'), body);

  const paths = trovePaths(base);
  const config = defaultConfig({ deviceId: 'dev-cli', deviceName: '测试机' });
  config.remote = { url: 'http://example.invalid', username: 'u', password: 'p' };
  config.sources = { 'claude-code': { enabled: true } };
  await saveConfig(paths.config, config);

  const remote = new MemoryRemote();
  const lines: string[] = [];
  const raw: string[] = [];
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
          patterns: ['**/*.jsonl'],
          exclusions: [],
        },
      },
    ],
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    rawOut: (s: string) => raw.push(s),
    isTTY: false,
    now: () => 1_000_000,
  };
  return { base, paths, remote, lines, raw, deps };
}

describe('trove CLI', () => {
  it('sync:归档 → 推送 → 汇总输出,state 与远端索引落盘', async () => {
    const { paths, remote, lines, deps } = await setup();

    const code = await run(['sync'], deps);

    expect(code).toBe(0);
    expect(existsSync(paths.state)).toBe(true);
    const index = (await remote.readJson(indexPath('dev-cli'))) as DeviceIndex;
    expect(Object.keys(index.items)).toHaveLength(1);
    expect(lines.join('\n')).toContain('同步完成');
    expect(lines.join('\n')).toContain('推送 1 项');
  });

  it('sync --since 非法值 → 非零退出并给出提示', async () => {
    const { lines, deps } = await setup();
    const code = await run(['sync', '--since', '7x'], deps);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('时间范围');
  });

  it('status:本地 / 远端 / daemon / 待同步 四段齐全', async () => {
    const { lines, deps } = await setup();
    await run(['sync'], deps);
    lines.length = 0;

    const code = await run(['status'], deps);

    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('测试机');
    expect(text).toContain('Claude Code');
    expect(text).toContain('1 个会话');
    expect(text).toContain('远端 http://example.invalid');
    expect(text).toContain('可达');
    expect(text).toContain('daemon');
    expect(text).toContain('未运行');
    expect(text).toContain('待同步');
    expect(text).toContain('无');
  });

  it('status:远端未配置时降级提示,不影响退出码', async () => {
    const { paths, lines, deps } = await setup();
    const config = defaultConfig({ deviceId: 'd', deviceName: 'n' });
    await saveConfig(paths.config, config);
    lines.length = 0;

    expect(await run(['status'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('未配置(先 trove init)');
  });

  it('daemon start:未显式传参时回落 config.daemon', async () => {
    const { paths, deps } = await setup();
    const config = defaultConfig({ deviceId: 'd', deviceName: 'n' });
    config.daemon = { intervalSeconds: 60, since: '24h', startOnInit: true };
    await saveConfig(paths.config, config);
    const got: Array<{ intervalSeconds: number; since: string }> = [];

    const code = await run(['daemon', 'start'], {
      ...deps,
      startDaemon: async (opts) => {
        got.push({ intervalSeconds: opts.intervalSeconds, since: opts.since });
        return 123;
      },
    });

    expect(code).toBe(0);
    expect(got).toEqual([{ intervalSeconds: 60, since: '24h' }]);
  });

  it('daemon start:显式 --interval/--since 覆盖配置', async () => {
    const { paths, deps } = await setup();
    const config = defaultConfig({ deviceId: 'd', deviceName: 'n' });
    config.daemon = { intervalSeconds: 60, since: '24h', startOnInit: true };
    await saveConfig(paths.config, config);
    const got: Array<{ intervalSeconds: number; since: string }> = [];

    await run(['daemon', 'start', '--interval', '30', '--since', '7d'], {
      ...deps,
      startDaemon: async (opts) => {
        got.push({ intervalSeconds: opts.intervalSeconds, since: opts.since });
        return 123;
      },
    });

    expect(got).toEqual([{ intervalSeconds: 30, since: '7d' }]);
  });

  it('init:默认启动 daemon;--no-daemon 不启动', async () => {
    const { lines, deps } = await setup();
    const started: number[] = [];
    const depsWithStart = {
      ...deps,
      startDaemon: async () => {
        started.push(1);
        return 456;
      },
    };

    expect(
      await run(
        ['init', '--name', '新机器', '--url', 'http://example.invalid', '--password', 'p'],
        depsWithStart,
      ),
    ).toBe(0);
    expect(started).toHaveLength(1);
    expect(lines.join('\n')).toContain('daemon: 已启动');

    lines.length = 0;
    expect(
      await run(
        [
          'init',
          '--name',
          '新机器',
          '--url',
          'http://example.invalid',
          '--password',
          'p',
          '--no-daemon',
        ],
        depsWithStart,
      ),
    ).toBe(0);
    expect(started).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('daemon: 已启动');
  });

  it('config get/set 往返', async () => {
    const { lines, deps } = await setup();
    expect(await run(['config', 'set', 'device.name', '"改名后"'], deps)).toBe(0);
    lines.length = 0;
    expect(await run(['config', 'get', 'device.name'], deps)).toBe(0);
    expect(lines.join('')).toBe('改名后');
  });

  it('daemon status / stop 在未运行时给出一致提示', async () => {
    const { lines, deps } = await setup();
    expect(await run(['daemon', 'status'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('daemon 未运行');
    lines.length = 0;
    expect(await run(['daemon', 'stop'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('daemon 未运行');
  });

  it('未配置远端时 sync 降级为本地模式,仅本地归档不报错', async () => {
    const { paths, lines, deps } = await setup();
    const config = defaultConfig({ deviceId: 'd', deviceName: 'n' });
    await saveConfig(paths.config, config);
    const code = await run(['sync'], deps);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('本地模式');
    expect(lines.join('\n')).toContain('归档 1');
  });

  it('init:未提供 --url 时进入本地模式,不探测远端', async () => {
    const { lines, deps } = await setup();
    const started: number[] = [];
    const code = await run(['init', '--name', '本机'], {
      ...deps,
      startDaemon: async () => {
        started.push(1);
        return 456;
      },
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('本地模式');
    expect(started).toHaveLength(1);
  });
});
