import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { run } from '../src/cli.js';
import type { Remote, RemoteFile } from '../src/remote/types.js';
import type { Source } from '../src/adapters/types.js';
import { defaultConfig, saveConfig } from '../src/config.js';

class FakeRemote implements Remote {
  files = new Map<string, Buffer>();
  uploads: string[] = [];
  deletes: string[] = [];
  async listAll(): Promise<RemoteFile[]> {
    return [...this.files].map(([path, buf]) => ({ path, size: buf.length }));
  }
  async download(remotePath: string, localPath: string): Promise<void> {
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, this.files.get(remotePath)!);
  }
  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push(remotePath);
    this.files.set(remotePath, await readFile(localPath));
  }
  async delete(remotePath: string): Promise<void> {
    this.deletes.push(remotePath);
    this.files.delete(remotePath);
  }
}

const TEMP_DIRS: string[] = [];

function makeCtx(overrides: Record<string, unknown> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'trove-cli-'));
  TEMP_DIRS.push(base);
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    base,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    ...overrides,
  };
  const paths = { base, config: join(base, 'config.json'), vault: join(base, 'vault') };
  return { base, out, err, deps, paths };
}

afterEach(async () => {
  for (const d of TEMP_DIRS.splice(0)) await rm(d, { recursive: true, force: true });
});

async function putFile(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}

describe('CLI(设计 §10)', () => {
  it('--help 打印用法', async () => {
    const { out, deps } = makeCtx();
    const code = await run(['--help'], deps);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Usage:');
    expect(text).toContain('init');
    expect(text).toContain('sync');
    expect(text).toContain('status');
  });

  it('--version 打印语义化版本', async () => {
    const { out, deps } = makeCtx();
    await run(['--version'], deps);
    expect(out.join('\n')).toMatch(/^\d+\.\d+\.\d+$/m);
  });

  it('未知命令返回非零并提示', async () => {
    const { err, deps } = makeCtx();
    const code = await run(['frobnicate'], deps);
    expect(code).not.toBe(0);
    expect(err.join('\n')).toContain('unknown command');
  });

  it('status 展示会话数与待同步', async () => {
    const { base, out, deps } = makeCtx();
    await saveConfig(join(base, 'config.json'), defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz' }));
    await putFile(join(base, 'vault', 'devices', 'a3f2c81e', 'claude-code', 'projects', '-p', 'a.jsonl'), 'aaa');
    await putFile(join(base, 'vault', 'devices', 'a3f2c81e', 'claude-code', 'projects', '-p', 'b.jsonl'), 'bbbb');

    await run(['status'], deps);

    const text = out.join('\n');
    expect(text).toContain('pz');
    expect(text).toContain('2 个会话');
    expect(text).toContain('7 B');
  });

  it('config path 打印配置文件路径', async () => {
    const { base, out, deps } = makeCtx();
    await run(['config', 'path'], deps);
    expect(out.join('\n')).toBe(join(base, 'config.json'));
  });

  it('config get 读取点路径', async () => {
    const { base, out, deps } = makeCtx();
    await saveConfig(join(base, 'config.json'), defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz' }));
    await run(['config', 'get', 'device.name'], deps);
    expect(out.join('\n')).toBe('pz');
  });

  it('config set 写入点路径', async () => {
    const { base, out, deps } = makeCtx();
    await saveConfig(join(base, 'config.json'), defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz' }));
    await run(['config', 'set', 'device.name', 'work-mac'], deps);
    const cfg = JSON.parse(await readFile(join(base, 'config.json'), 'utf8'));
    expect(cfg.device.name).toBe('work-mac');
  });

  it('sync 先 collect 再 pull→push', async () => {
    const { base, out, deps } = makeCtx();
    const cfg = defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz' });
    cfg.remote.url = 'http://dav.example';
    cfg.remote.username = 'webdav';
    cfg.remote.password = 'secret';
    await saveConfig(join(base, 'config.json'), cfg);

    const srcRoot = join(base, 'claude');
    await mkdir(join(srcRoot, 'projects', '-p'), { recursive: true });
    await writeFile(join(srcRoot, 'projects', '-p', 'a.jsonl'), 'hello\n');
    const source: Source = {
      id: 'claude-code',
      displayName: 'Claude Code',
      root: srcRoot,
      patterns: ['projects/**/*.jsonl'],
      exclusions: [],
      mapToVaultPath: (abs) => join('claude-code', relative(srcRoot, abs)),
    };
    deps.resolveSources = () => [source];

    const remote = new FakeRemote();
    const created: [string, string, string][] = [];
    deps.createRemote = (url: string, u: string, p: string) => {
      created.push([url, u, p]);
      return remote;
    };

    await run(['sync'], deps);

    // ① collect:源文件进 vault
    const content = await readFile(
      join(base, 'vault', 'devices', 'a3f2c81e', 'claude-code', 'projects', '-p', 'a.jsonl'),
      'utf8',
    );
    expect(content).toBe('hello\n');
    // ② push:文件到远端
    expect(created).toEqual([['http://dav.example', 'webdav', 'secret']]);
    expect(remote.uploads).toContain('a3f2c81e/claude-code/projects/-p/a.jsonl');
    expect(out.join('\n')).toContain('已收集');
    expect(out.join('\n')).toContain('已同步');
  });

  it('sync 从配置取密码、走 pull→push 并输出报告', async () => {
    const { base, out, deps } = makeCtx();
    const cfg = defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz' });
    cfg.remote.url = 'http://dav.example';
    cfg.remote.username = 'webdav';
    cfg.remote.password = 'secret';
    await saveConfig(join(base, 'config.json'), cfg);

    const remote = new FakeRemote();
    const created: [string, string, string][] = [];
    deps.createRemote = (url: string, u: string, p: string) => {
      created.push([url, u, p]);
      return remote;
    };
    deps.resolveSources = () => [];

    await putFile(
      join(base, 'vault', 'devices', 'a3f2c81e', 'claude-code', 'projects', '-p', 'a.jsonl'),
      'hi\n',
    );

    await run(['sync'], deps);

    expect(created).toEqual([['http://dav.example', 'webdav', 'secret']]);
    expect(remote.uploads).toContain('a3f2c81e/claude-code/projects/-p/a.jsonl');
    expect(out.join('\n')).toContain('已同步');
  });

  it('sync --dry-run 不 collect、源文件不进 vault', async () => {
    const { base, deps } = makeCtx();
    const cfg = defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz' });
    cfg.remote.url = 'http://dav.example';
    cfg.remote.username = 'webdav';
    cfg.remote.password = 'secret';
    await saveConfig(join(base, 'config.json'), cfg);

    const srcRoot = join(base, 'claude');
    await mkdir(join(srcRoot, 'projects', '-p'), { recursive: true });
    await writeFile(join(srcRoot, 'projects', '-p', 'a.jsonl'), 'hello\n');
    const source: Source = {
      id: 'claude-code',
      displayName: 'Claude Code',
      root: srcRoot,
      patterns: ['projects/**/*.jsonl'],
      exclusions: [],
      mapToVaultPath: (abs) => join('claude-code', relative(srcRoot, abs)),
    };
    deps.resolveSources = () => [source];
    deps.createRemote = () => new FakeRemote();

    await run(['sync', '--dry-run'], deps);

    // collect 未执行:vault 里没有源文件
    await expect(
      readFile(join(base, 'vault', 'devices', 'a3f2c81e', 'claude-code', 'projects', '-p', 'a.jsonl'), 'utf8'),
    ).rejects.toThrow();
  });

  it('sync 缺密码时报错并引导 init', async () => {
    const { base, err, deps } = makeCtx();
    const cfg = defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz' });
    cfg.remote.url = 'http://dav.example';
    await saveConfig(join(base, 'config.json'), cfg);

    const code = await run(['sync'], deps);
    expect(code).not.toBe(0);
    expect(err.join('\n')).toContain('trove init');
  });

  it('init 非交互且缺 --url 时报错,不进入交互提示', async () => {
    const { err, deps } = makeCtx();
    deps.createRemote = () => new FakeRemote();
    const code = await run(['init', '--name', 'pz', '--username', 'u', '--password', 'p'], deps);
    expect(code).not.toBe(0);
    expect(err.join('\n')).toContain('WebDAV 地址');
  });

  it('init 非交互且缺 --password 时报错,不进入交互提示', async () => {
    const { err, deps } = makeCtx();
    deps.createRemote = () => new FakeRemote();
    const code = await run(['init', '--name', 'pz', '--url', 'http://dav.example', '--username', 'u'], deps);
    expect(code).not.toBe(0);
    expect(err.join('\n')).toContain('TROVE_PASSWORD');
  });

  it('init 可用 TROVE_PASSWORD 环境变量代替 --password', async () => {
    const { base, deps } = makeCtx();
    deps.createRemote = () => new FakeRemote();
    const prev = process.env.TROVE_PASSWORD;
    process.env.TROVE_PASSWORD = 'env-secret';
    try {
      await run(
        ['init', '--name', 'pz', '--url', 'http://dav.example', '--username', 'u'],
        deps,
      );
    } finally {
      if (prev === undefined) delete process.env.TROVE_PASSWORD;
      else process.env.TROVE_PASSWORD = prev;
    }
    const cfg = JSON.parse(await readFile(join(base, 'config.json'), 'utf8'));
    expect(cfg.remote.password).toBe('env-secret');
  });

  it('init 写配置(含明文密码)并做连通性探针(写→读回→删)', async () => {
    const { base, out, deps } = makeCtx();
    const remote = new FakeRemote();
    deps.createRemote = () => remote;

    await run(
      ['init', '--name', 'pz', '--url', 'http://dav.example', '--username', 'u', '--password', 'p'],
      deps,
    );

    const cfg = JSON.parse(await readFile(join(base, 'config.json'), 'utf8'));
    expect(cfg.device.name).toBe('pz');
    expect(cfg.remote.url).toBe('http://dav.example');
    expect(cfg.remote.username).toBe('u');
    expect(cfg.remote.password).toBe('p');
    // 探针:写过、删过
    expect(remote.uploads.length).toBeGreaterThan(0);
    expect(remote.deletes.length).toBeGreaterThan(0);
    expect(out.join('\n')).toContain('初始化完成');
  });
});
