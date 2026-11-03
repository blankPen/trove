import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadConfig, saveConfig, defaultConfig, type Config } from '../src/config.js';

/**
 * 远端配置:从扁平 WebDAV 字段演进到带 type 的判别联合,
 * 老配置文件必须继续能读(不破坏已有用户)。
 */

async function withConfigFile(content: unknown): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'trove-rcfg-'));
  const dir = join(base, '.trove');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify(content, null, 2));
  return join(dir, 'config.json');
}

describe('远端配置类型', () => {
  it('老配置(只有 url/username/password)按 webdav 读取', async () => {
    const p = await withConfigFile({
      device: { id: 'd1', name: 'dev' },
      remote: { url: 'http://x/', username: 'u', password: 'p' },
    });
    const cfg = await loadConfig(p);
    expect(cfg.remote.type).toBe('webdav');
    expect(cfg.remote.url).toBe('http://x/');
    expect(cfg.remote.username).toBe('u');
    expect(cfg.remote.password).toBe('p');
    await rm(join(p, '..'), { recursive: true, force: true });
  });

  it('s3 配置原样保留 provider/region/bucket/凭证', async () => {
    const p = await withConfigFile({
      device: { id: 'd1', name: 'dev' },
      remote: {
        type: 's3',
        provider: 'aliyun',
        region: 'cn-hangzhou',
        bucket: 'my-bucket',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      },
    });
    const cfg = await loadConfig(p);
    expect(cfg.remote.type).toBe('s3');
    if (cfg.remote.type === 's3') {
      expect(cfg.remote.provider).toBe('aliyun');
      expect(cfg.remote.region).toBe('cn-hangzhou');
      expect(cfg.remote.bucket).toBe('my-bucket');
      expect(cfg.remote.accessKeyId).toBe('AK');
      expect(cfg.remote.secretAccessKey).toBe('SK');
    }
    await rm(join(p, '..'), { recursive: true, force: true });
  });

  it('手填 endpoint 的 s3 配置也被接受', async () => {
    const p = await withConfigFile({
      device: { id: 'd1', name: 'dev' },
      remote: {
        type: 's3',
        region: 'us-east-1',
        bucket: 'b',
        endpoint: 'https://custom.example.com',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      },
    });
    const cfg = await loadConfig(p);
    if (cfg.remote.type === 's3') {
      expect(cfg.remote.endpoint).toBe('https://custom.example.com');
      expect(cfg.remote.provider).toBeUndefined();
    }
    await rm(join(p, '..'), { recursive: true, force: true });
  });

  it('默认配置是 webdav 类型', () => {
    const cfg = defaultConfig();
    expect(cfg.remote.type).toBe('webdav');
  });

  it('保存后读回类型不丢', async () => {
    const base = await mkdtemp(join(tmpdir(), 'trove-rcfg-'));
    const dir = join(base, '.trove');
    await mkdir(dir, { recursive: true });
    const p = join(dir, 'config.json');
    const cfg: Config = {
      ...defaultConfig(),
      remote: {
        type: 's3',
        provider: 'tencent',
        region: 'ap-guangzhou',
        bucket: 'b-1250000000',
        accessKeyId: 'AK',
        secretAccessKey: 'SK',
      },
    };
    await saveConfig(p, cfg);
    const back = await loadConfig(p);
    expect(back.remote.type).toBe('s3');
    await rm(base, { recursive: true, force: true });
  });
});
