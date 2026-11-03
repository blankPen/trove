import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { createAdapters, type Adapter } from '../src/adapters/index.js';
import { createServer } from 'node:net';
import { S3Store } from '../src/remote/s3-store.js';

/**
 * 端到端:用真实 S3 服务端跑完整的 trove sync 流程。
 * 验证 S3 后端能真正承担当前 WebDAV 后端的角色。
 *
 * 四个数据源都指向临时目录(TROVE_*_ROOT),不碰本机真实的会话 ——
 * 否则会把 ~/.claude 全部归档进来,既慢又不确定。
 */

const ACCOUNT = 'S3RVER';
const SECRET = 'S3RVER';

/** 让系统分配一个空闲端口,避免撞上残留的实例。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
    s.on('error', reject);
  });
}

interface S3rverInstance {
  run: (port: number) => Promise<void>;
  close: () => void;
}

/** 每次跑用独立 bucket 名:端口可能撞上别的 s3rver 实例,同名 bucket 会读到别人的数据。 */
const BUCKET = `trove-e2e-${randomUUID().slice(0, 8)}`;

describe('trove sync 跑在真实 S3 后端上', () => {
  let server: S3rverInstance;
  let dir: string;
  let base: string;
  let port: number;
  /** 只含一个 Claude Code 会话文件的临时数据源 */
  let fakeHome: string;

  beforeAll(async () => {
    const { default: S3rver } = (await import('s3rver')) as unknown as {
      default: new (opts: unknown) => S3rverInstance;
    };
    dir = await mkdtemp(join(tmpdir(), 'trove-s3sync-'));
    // 端口让系统分配:随机端口可能撞上残留的 s3rver 实例,读到别人的 bucket
    port = await freePort();
    server = new S3rver({
      port,
      address: '127.0.0.1',
      silent: true,
      configureBuckets: [{ name: BUCKET, configs: [] }],
      authentication: { accessKeyId: ACCOUNT, secretAccessKey: SECRET },
      storage: 'S3rverFileStorage',
      storageOptions: { directory: dir },
    });
    await server.run(port);

    // 造一个假的 Claude Code 会话源
    fakeHome = await mkdtemp(join(tmpdir(), 'trove-s3home-'));
    const projects = join(fakeHome, 'projects');
    await mkdir(projects, { recursive: true });
    await writeFile(
      join(projects, 's1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '你好' } }) + '\n',
    );
    base = await mkdtemp(join(tmpdir(), 'trove-s3cli-'));
  });

  afterAll(async () => {
    server?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  /**
   * 四个数据源全部指向临时目录,只留那个假的 Claude Code 会话。
   * 用 resolveAdapters 注入(CliDeps 提供的钩子),不去碰 process.env。
   */
  function isolatedAdapters(): Adapter[] {
    return createAdapters({
      home: fakeHome,
      claudeRoot: fakeHome,
      codexRoot: join(fakeHome, 'empty-codex'),
      opencodeDb: join(fakeHome, 'empty.db'),
      doubaoRoot: join(fakeHome, 'empty-doubao'),
    });
  }

  function makeStore(): S3Store {
    return new S3Store({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'us-east-1',
      bucket: BUCKET,
      accessKeyId: ACCOUNT,
      secretAccessKey: SECRET,
      forcePathStyle: true,
    });
  }

  it('init 配 S3 → sync 归档并推送 → status 显示远端可达', async () => {
    const lines: string[] = [];
    const deps = {
      base,
      isTTY: false,
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(`ERR ${l}`),
      createRemote: () => makeStore(),
      resolveAdapters: () => isolatedAdapters(),
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
        BUCKET,
        '--endpoint',
        `http://127.0.0.1:${port}`,
        '--force-path-style',
        '--access-key-id',
        ACCOUNT,
        '--secret-access-key',
        SECRET,
        '--no-daemon',
      ],
      deps,
    );
    expect(initCode, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain('初始化完成');

    // 2. sync:归档并推送到 S3
    lines.length = 0;
    const syncCode = await run(['sync', '--since', 'all'], deps);
    expect(syncCode, lines.join('\n')).toBe(0);
    expect(lines.join('\n')).toContain('同步完成');

    // 3. 验证远端真的收到了东西
    const store = makeStore();
    const devices = await store.listDevices();
    expect(devices.length).toBeGreaterThan(0);
    const index = (await store.readJson(`raw/${devices[0]}/index.json`)) as {
      items: Record<string, unknown>;
    };
    expect(Object.keys(index.items).length).toBeGreaterThan(0);

    // 4. status 能探到远端
    lines.length = 0;
    const statusCode = await run(['status'], deps);
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
      createRemote: () => makeStore(),
      resolveAdapters: () => isolatedAdapters(),
    };
    const store = makeStore();

    await run(['sync', '--since', 'all'], deps);

    lines.length = 0;
    await run(['sync', '--since', 'all'], deps);
    // 第二次没有新内容 → 跳过,不重传
    expect(lines.join('\n')).toContain('跳过');
  });
});
