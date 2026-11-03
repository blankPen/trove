import { describe, it, expect, vi } from 'vitest';

/**
 * 远端后端选择与 S3 参数引导。
 * 交互顺序:先选后端类型(webdav / s3),再按类型问对应字段。
 */

vi.mock('@clack/prompts', () => ({
  text: vi.fn(async (opts: { message: string; initialValue?: string }) => {
    const byMessage: Record<string, string> = {
      设备名: 'myname',
      'WebDAV 地址': 'http://127.0.0.1:1900/',
      'WebDAV 用户名': 'trove',
      '远端类型': 's3',
      'S3 厂商': 'aliyun',
      地域: 'cn-hangzhou',
      Bucket: 'my-bucket',
      'AccessKey ID': 'AKIDEXAMPLE',
    };
    return byMessage[opts.message] ?? opts.initialValue ?? '';
  }),
  password: vi.fn(async (opts: { message: string }) => {
    if (opts.message.includes('Secret')) return 'SECRETKEY';
    return 'secret';
  }),
  select: vi.fn(async (opts: { options?: Array<{ value: string }> }) => {
    const values = (opts.options ?? []).map((o) => o.value);
    return values.includes('s3') ? 's3' : values[0]!;
  }),
}));

import { resolveInitInputs } from '../src/cli.js';
import { promptRemoteConfig } from '../src/remote/prompt.js';

describe('init 交互:远端类型选择', () => {
  it('选择 s3 时收集完整 S3 配置', async () => {
    const r = await promptRemoteConfig(undefined, true);
    expect(r?.type).toBe('s3');
    if (r?.type === 's3') {
      expect(r.provider).toBe('aliyun');
      expect(r.region).toBe('cn-hangzhou');
      expect(r.bucket).toBe('my-bucket');
      expect(r.accessKeyId).toBe('AKIDEXAMPLE');
      expect(r.secretAccessKey).toBe('SECRETKEY');
    }
  });

  it('选择 webdav 时收集地址/用户名/密码', async () => {
    const r = await promptRemoteConfig(undefined, true, 'webdav');
    expect(r?.type).toBe('webdav');
    if (r?.type === 'webdav') {
      expect(r.url).toBe('http://127.0.0.1:1900/');
      expect(r.username).toBe('trove');
      expect(r.password).toBe('secret');
    }
  });

  it('非交互模式返回 undefined(由命令行 flag 提供)', async () => {
    const r = await promptRemoteConfig(undefined, false);
    expect(r).toBeUndefined();
  });
});

describe('init 交互:保留 WebDAV 默认行为', () => {
  it('非交互模式仍返回默认 username= webdav', async () => {
    const r = await resolveInitInputs({}, false);
    expect(r.username).toBe('webdav');
    expect(r.url).toBeUndefined();
    expect(r.password).toBeUndefined();
  });
});
