import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Store } from '../src/remote/s3-store.js';

/**
 * 端到端:对着真实 S3 协议的服务端跑一遍。
 *
 * s3rver 会真的校验 SigV4 签名 —— 签名写错这里就会 403,
 * 所以这个测试能证明签名实现是对的,而不是"自己签自己验"。
 */

// s3rver 的默认凭证
const ACCOUNT = 'S3RVER';
const SECRET = 'S3RVER';
/** 每次跑用独立 bucket 名:端口可能撞上别的 s3rver 实例,同名 bucket 会读到别人的数据。 */
const BUCKET = `trove-e2e-${randomUUID().slice(0, 8)}`;

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
  run: (port: number) => Promise<{ port: number } | undefined>;
  close: () => void;
}

async function startServer(port: number): Promise<{ s: S3rverInstance; dir: string; port: number }> {
  const { default: S3rver } = (await import('s3rver')) as unknown as {
    default: new (opts: unknown) => S3rverInstance;
  };
  const dir = await mkdtemp(join(tmpdir(), 'trove-s3e2e-'));
  const s = new S3rver({
    port,
    address: '127.0.0.1',
    silent: true,
    configureBuckets: [{ name: BUCKET, configs: [] }],
    authentication: { accessKeyId: ACCOUNT, secretAccessKey: SECRET },
    storage: 'S3rverFileStorage',
    storageOptions: { directory: dir },
  });
  const addr = await s.run(port);
  // 以实际绑定的端口为准
  const actual = (addr as { port?: number } | undefined)?.port ?? port;
  return { s, dir, port: actual };
}

describe('S3Store(真实 S3 服务端端到端)', () => {
  let server: S3rverInstance;
  let dir: string;
  let store: S3Store;

  beforeAll(async () => {
    const port = await freePort();
    const started = await startServer(port);
    server = started.s;
    dir = started.dir;
    store = new S3Store({
      endpoint: `http://127.0.0.1:${started.port}`,
      region: 'us-east-1',
      bucket: BUCKET,
      accessKeyId: ACCOUNT,
      secretAccessKey: SECRET,
      forcePathStyle: true,
    });
  });

  afterAll(async () => {
    server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('写入 JSON → 读回一致', async () => {
    await store.writeJson('raw/dev1/index.json', { v: 1, 中文: '值' });
    await expect(store.readJson('raw/dev1/index.json')).resolves.toEqual({ v: 1, 中文: '值' });
  });

  it('不存在的对象读回 null', async () => {
    await expect(store.readJson('raw/dev1/nope.json')).resolves.toBeNull();
  });

  it('二进制块区间上传 → 读回字节一致', async () => {
    const local = join(dir, 'blob.bin');
    const all = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await writeFile(local, all);

    await store.writeFile('raw/dev1/chunks/h/g1/0004-4.bin', local, { offset: 4, length: 4 });
    const got = join(dir, 'got.bin');
    await store.readFile('raw/dev1/chunks/h/g1/0004-4.bin', got);
    expect((await readFile(got)).equals(all.subarray(4, 8))).toBe(true);
  });

  it('列目录 → 目录与文件区分', async () => {
    await store.writeJson('raw/devA/meta.json', { id: 'devA' });
    const entries = await store.list('raw');
    expect(entries.map((e) => e.name)).toContain('devA');
    expect(entries.find((e) => e.name === 'devA')!.type).toBe('directory');
  });

  it('listDevices 只返回 raw/ 下的设备目录', async () => {
    await expect(store.listDevices()).resolves.toContain('devA');
  });

  it('删除生效;删不存在的也不报错', async () => {
    await store.delete('raw/dev1/index.json');
    await expect(store.readJson('raw/dev1/index.json')).resolves.toBeNull();
    await expect(store.delete('raw/dev1/never.json')).resolves.toBeUndefined();
  });

  it('覆盖写同 key 后读到新值', async () => {
    await store.writeJson('raw/dev1/atomic.json', { v: 1 });
    await store.writeJson('raw/dev1/atomic.json', { v: 2 });
    await expect(store.readJson('raw/dev1/atomic.json')).resolves.toEqual({ v: 2 });
  });

  // 回归:key 里带空格、中文、括号、加号、井号、百分号时,
  // SigV4 的 canonical URI 必须与实际发送路径一致(否则签名对不上 → 403)
  it('key 含特殊字符仍能签名成功', async () => {
    const key = 'raw/dev1/我的 归档 (1)+#%.json';
    await store.writeJson(key, { ok: true });
    await expect(store.readJson(key)).resolves.toEqual({ ok: true });
  });
});
