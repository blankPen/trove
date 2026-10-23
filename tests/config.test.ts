import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, saveConfig, resolveRawSync } from '../src/config.js';
import { trovePaths } from '../src/paths.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('config(设计 §10.2)', () => {
  let dir: string;
  let cfg: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trove-cfg-'));
    cfg = join(dir, 'config.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaultConfig 生成 uuid 设备 id、hostname 名、默认 source', () => {
    const c = defaultConfig();
    expect(c.device.id).toMatch(UUID_RE);
    expect(c.device.name).toBeTypeOf('string');
    expect(c.device.name.length).toBeGreaterThan(0);
    expect(c.sources['claude-code']?.enabled).toBe(true);
    expect(c.sources.codex?.enabled).toBe(true);
    expect(c.sources.opencode?.enabled).toBe(true);
    expect(c.sources.doubao?.enabled).toBe(true);
  });

  it('默认同步 raw,可由 config.sync.raw 关闭,命令行显式开关优先', () => {
    expect(defaultConfig().sync.raw).toBe(true);

    const off = defaultConfig();
    off.sync = { raw: false };
    expect(resolveRawSync(off)).toBe(false);
    expect(resolveRawSync(off, true)).toBe(true); // --raw 覆盖配置
    expect(resolveRawSync(defaultConfig(), false)).toBe(false); // --no-raw 覆盖配置

    // 老配置文件没有 sync 字段时按开启处理
    const legacy = defaultConfig() as unknown as Record<string, unknown>;
    delete legacy['sync'];
    expect(resolveRawSync(legacy as never)).toBe(true);
  });

  it('defaultConfig 允许注入固定设备身份(便于测试)', () => {
    const c = defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz-macbook' });
    expect(c.device).toEqual({ id: 'a3f2c81e', name: 'pz-macbook' });
  });

  it('daemon 默认 300s / 7d / init 自动启动,老配置缺失时回填', async () => {
    expect(defaultConfig().daemon).toEqual({ intervalSeconds: 300, since: '7d', startOnInit: true });

    // 老配置文件没有 daemon 字段
    const legacy = defaultConfig() as unknown as Record<string, unknown>;
    delete legacy['daemon'];
    await saveConfig(cfg, legacy as never);
    const back = await loadConfig(cfg);
    expect(back.daemon).toEqual({ intervalSeconds: 300, since: '7d', startOnInit: true });

    // 显式 false 不会被回填覆盖
    const off = defaultConfig();
    off.daemon = { intervalSeconds: 60, since: '24h', startOnInit: false };
    await saveConfig(cfg, off);
    expect((await loadConfig(cfg)).daemon).toEqual({
      intervalSeconds: 60,
      since: '24h',
      startOnInit: false,
    });
  });

  it('文件不存在时 loadConfig 返回默认配置', async () => {
    const c = await loadConfig(cfg);
    expect(c.device.id).toMatch(UUID_RE);
  });

  it('saveConfig 写入可读 JSON,loadConfig 能完整读回(round-trip)', async () => {
    const c = defaultConfig({ deviceId: 'a3f2c81e', deviceName: 'pz-macbook' });
    c.remote.url = 'https://dav.example.com/trove/';
    await saveConfig(cfg, c);

    const raw = await readFile(cfg, 'utf8');
    expect(raw).toContain('"a3f2c81e"'); // 可读、带缩进
    const back = await loadConfig(cfg);
    expect(back).toEqual(c);
  });

  it('defaultConfig 的 remote 存明文 username/password(跨平台,不依赖钥匙串)', () => {
    const c = defaultConfig();
    expect(c.remote).toEqual({ url: '', username: 'webdav', password: '' });
  });

  it('saveConfig 写出的配置文件权限为 600(仅属主可读写)', async () => {
    await saveConfig(cfg, defaultConfig({ deviceId: 'x' }));
    const st = await stat(cfg);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('saveConfig 自动创建父目录', async () => {
    const nested = join(dir, 'a', 'b', 'config.json');
    await saveConfig(nested, defaultConfig({ deviceId: 'x' }));
    const back = await loadConfig(nested);
    expect(back.device.id).toBe('x');
  });

  it('损坏的 JSON → loadConfig 抛清晰错误(含路径)', async () => {
    await writeFile(cfg, '{ not json');
    await expect(loadConfig(cfg)).rejects.toThrow(cfg);
  });
});

describe('paths(设计 §6.1)', () => {
  it('从 base 目录推导出 config/vault/manifest/logs/tmp 各路径', () => {
    const p = trovePaths('/Users/pz/.trove');
    expect(p.config).toBe('/Users/pz/.trove/config.json');
    expect(p.vault).toBe('/Users/pz/.trove/vault');
    expect(p.state).toBe('/Users/pz/.trove/state.json');
    expect(p.logs).toBe('/Users/pz/.trove/logs');
    expect(p.tmp).toBe('/Users/pz/.trove/tmp');
  });

  it('未指定 base 时默认 ~/.trove', () => {
    const p = trovePaths();
    expect(p.base.endsWith('.trove')).toBe(true);
  });
});
