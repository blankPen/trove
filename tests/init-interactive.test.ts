import { describe, it, expect, vi } from 'vitest';

// mock @clack:按 message 返回固定值,便于断言"交互模式确实询问了哪些字段"。
vi.mock('@clack/prompts', () => ({
  text: vi.fn(async (opts: { message: string }) => {
    const byMessage: Record<string, string> = {
      设备名: 'myname',
      'WebDAV 用户名': 'trove',
      'WebDAV 地址': 'http://127.0.0.1:1900/',
    };
    return byMessage[opts.message];
  }),
  password: vi.fn(async () => 'secret'),
}));

import { resolveInitInputs } from '../src/cli.js';

describe('init 交互输入(设计 §10.1)', () => {
  it('交互模式询问设备名、用户名、地址、密码', async () => {
    const r = await resolveInitInputs({}, true);
    expect(r.name).toBe('myname');
    expect(r.username).toBe('trove');
    expect(r.url).toBe('http://127.0.0.1:1900/');
    expect(r.password).toBe('secret');
  });

  it('非交互模式 name/username 用默认值,url/password 缺失为 undefined', async () => {
    const r = await resolveInitInputs({}, false);
    expect(r.username).toBe('webdav');
    expect(r.name.length).toBeGreaterThan(0);
    expect(r.url).toBeUndefined();
    expect(r.password).toBeUndefined();
  });

  it('显式 flag 优先于交互询问', async () => {
    const r = await resolveInitInputs(
      { name: 'pz', username: 'u', url: 'http://x', password: 'p' },
      true,
    );
    expect(r.name).toBe('pz');
    expect(r.username).toBe('u');
    expect(r.url).toBe('http://x');
    expect(r.password).toBe('p');
  });
});
