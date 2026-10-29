import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// mock @clack:按 message 返回固定值,password 默认给新密码,可单测覆盖成空串验证"留空保留"。
vi.mock('@clack/prompts', () => ({
  text: vi.fn(async (opts: { message: string }) => {
    const byMessage: Record<string, string> = {
      设备名: '新设备',
      'WebDAV 地址': 'http://127.0.0.1:1900/',
      'WebDAV 用户名': 'trove',
    };
    return byMessage[opts.message];
  }),
  password: vi.fn(async () => 'newsecret'),
}));

import { run } from '../src/cli.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { trovePaths } from '../src/paths.js';
import { password } from '@clack/prompts';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'trove-config-'));
  const paths = trovePaths(base);
  const config = defaultConfig({ deviceId: 'dev1', deviceName: '旧设备' });
  config.remote = { url: 'http://old.invalid/', username: 'olduser', password: 'oldpass' };
  await saveConfig(paths.config, config);
  const lines: string[] = [];
  const deps = {
    base,
    isTTY: true,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
  };
  return { paths, lines, deps };
}

describe('trove config 交互式', () => {
  it('交互式改写设备名与远端,写入新密码', async () => {
    const { paths, lines, deps } = await setup();
    const code = await run(['config'], deps);

    expect(code).toBe(0);
    const cfg = await loadConfig(paths.config);
    expect(cfg.device.name).toBe('新设备');
    expect(cfg.remote.url).toBe('http://127.0.0.1:1900/');
    expect(cfg.remote.username).toBe('trove');
    expect(cfg.remote.password).toBe('newsecret');
    expect(lines.join('\n')).toContain('配置已保存');
  });

  it('密码留空则保留原密码', async () => {
    const { paths, deps } = await setup();
    vi.mocked(password).mockResolvedValueOnce('');

    await run(['config'], deps);

    expect((await loadConfig(paths.config)).remote.password).toBe('oldpass');
  });

  it('非交互环境给出提示并退出 1', async () => {
    const { lines, deps } = await setup();
    const code = await run(['config'], { ...deps, isTTY: false });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('config set');
  });
});
