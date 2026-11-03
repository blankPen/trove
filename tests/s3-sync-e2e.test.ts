import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { S3Store } from '../src/remote/s3-store.js';

/**
 * 端到端:用真实 S3 服务端跑完整的 trove sync 流程。
 * 验证 S3 后端能真正承担当前 WebDAV 后端的角色。
 */

const ACCOUNT = 'S3RVER';
const SECRET = 'S3RVER';

interface S3rverInstance {
  run: (port: number) => Promise<void>;
  close: () => void;
}

describe('trove sync 跑在真实 S3 后端上', () => {
  let server: S3rverInstance;
  let dir: string;
  let base: string;
  let port: number;

  beforeAll(async () => {
    const { default: S3rver } = (await import('s3rver')) as unknown as {
      default: new (opts: unknown) => S3rverInstance;
    };
    dir = await mkdtemp(join(tmpdir(), 'trove-s3sync-'));
    port = 19600 + Math.floor(Math.random() * 300);
    server = new S3rver({
      port,
      address: '127.0.0.1',
      silent: true,
      configureBuckets: [{ name: 'trove-bucket', configs: [] }],
      authentication: { accessKeyId: ACCOUNT, secretAccessKey: SECRET },
      storage: 'S3rverFileStorage',
      storageOptions: { directory: dir },
    });
    await server.run(port);

    // 造一个假的 Claude Code 会话源
    base = await mkdtemp(join(tmpdir(), 'trove-s3cli-'));
    const src = join(base, 'src', 'projects');
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, 's1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }) + '\n',
    );
  });

  afterAll(async () => {
    server?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  it('init 配 S3 → sync 归档并推送 → status 显示远端可达', async () => {
    const lines: string[] = [];
    const deps = {
      base,
      isTTY: false,
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
    };

    // 1. init:用命令行参数配 S3(非交互)
    const initCode = await run(
      [
        'init',
        '--name',
        '测试机',
        '--type',
        's3',
        '--provider',
        'aliyun',
        '--region',
        'cn-hangzhou',
        '--bucket',
        'trove-bucket',
        '--access-key-id',
        ACCOUNT,
        '--secret-access-key',
        SECRET,
        '--no-daemon',
      ],
      {
        ...deps,
        createRemote: (config) =>
          new S3Store({
            endpoint: `http://127.0.0.1:${port}`,
            region: 'us-east-1',
            bucket: 'trove-bucket',
            accessKeyId: ACCOUNT,
            secretAccessKey: SECRET,
            forcePathStyle: true,
          }),
      },
    );
    expect(initCode, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain('初始化完成');

    // 2. sync:归档并推送到 S3
    lines.length = 0;
    const syncCode = await run(
      ['sync', '--since', 'all'],
      {
        ...deps,
        createRemote: (config) =>
          new S3Store({
            endpoint: `http://127.0.0.1:${port}`,
            region: 'us-east-1',
            bucket: 'trove-bucket',
            accessKeyId: ACCOUNT,
            secretAccessKey: SECRET,
            forcePathStyle: true,
          }),
      },
    );
    expect(syncCode, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain('同步完成');

    // 3. 验证远端真的收到了东西
    const store = new S3Store({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'trove-bucket',
      accessKeyId: ACCOUNT,
      secretAccessKey: SECRET,
      forcePathStyle: true,
    });
    const devices = await store.listDevices();
    expect(devices.length).toBeGreaterThan(0);
    const index = (await store.readJson(`raw/${devices[0]}/index.json`)) as {
      items: Record<string, unknown>;
    };
    expect(Object.keys(index.items).length).toBeGreaterThan(0);

    // 4. status 能探到远端
    lines.length = 0;
    const statusCode = await run(['status'], {
      ...deps,
      createRemote: () =>
        new S3Store({
          endpoint: `http://127.0.0.1:${port}`,
          region: 'us-east-1',
          bucket: 'trove-bucket',
          accessKeyId: ACCOUNT,
          secretAccessKey: SECRET,
          forcePathStyle: true,
        }),
    });
    expect(statusCode, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain('可达');
  });

  it('第二次 sync 零重传(增量不重复上传)', async () => {
    const lines: string[] = [];
    const deps = {
      base,
      isTTY: false,
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
    };
    const store = new S3Store({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: 'trove-bucket',
      accessKeyId: ACCOUNT,
      secretAccessKey: SECRET,
      forcePathStyle: true,
    });

    await run(['sync', '--since', 'all'], {
      ...deps,
      createRemote: () => store,
    });

    lines.length = 0;
    await run(['sync', '--since', 'all'], {
      ...deps,
      createRemote: () => store,
    });
    // 第二次没有新内容 → 跳过,不重传
    expect(lines.join('\n')).toContain('跳过');
  });
});
