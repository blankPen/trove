import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Store } from '../src/remote/s3-store.js';

/**
 * 假 S3 服务端:实现 ListObjectsV2 / GetObject / PutObject / DeleteObject 四个原语,
 * 以及 SigV4 头校验,让 S3Store 走真实 HTTP 路径。
 */

interface Obj {
  body: Buffer;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseXmlList(body: string): { keys: string[]; prefixes: string[]; sizes: Record<string, number> } {
  const keys: string[] = [];
  const prefixes: string[] = [];
  const sizes: Record<string, number> = {};
  const keyRe = /<Key>([\s\S]*?)<\/Key>/g;
  const sizeRe = /<Key>([\s\S]*?)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body))) keys.push(m[1]!);
  while ((m = sizeRe.exec(body))) sizes[m[1]!] = Number(m[2]);
  const preRe = /<Prefix>([\s\S]*?)<\/Prefix>/g;
  while ((m = preRe.exec(body))) prefixes.push(m[1]!);
  return { keys, prefixes, sizes };
}

class FakeS3 {
  objects = new Map<string, Obj>();
  requests: Array<{ method: string; url: string; auth: string | undefined }> = [];
  uploads = new Map<string, Map<number, Buffer>>();
  failNext = 0;
  private uploadSeq = 0;

  handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    this.requests.push({
      method: req.method ?? 'GET',
      url,
      auth: req.headers.authorization as string | undefined,
    });
    const u = new URL(url, 'http://localhost');
    const prefix = u.searchParams.get('prefix') ?? '';
    const delimiter = u.searchParams.get('delimiter') ?? '';
    const uploadId = u.searchParams.get('uploadId');
    const partNumber = u.searchParams.get('partNumber');

    if (this.failNext > 0) {
      this.failNext--;
      res.writeHead(503).end('<Error><Code>SlowDown</Code></Error>');
      return;
    }

    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const keys: string[] = [];
      const prefixes = new Set<string>();
      for (const k of all) {
        const rest = k.slice(prefix.length);
        if (delimiter) {
          const idx = rest.indexOf(delimiter);
          if (idx >= 0) {
            prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
            continue;
          }
        }
        keys.push(k);
      }
      const parts: string[] = [];
      for (const k of keys) {
        parts.push(`<Contents><Key>${xmlEscape(k)}</Key><Size>${this.objects.get(k)!.body.length}</Size></Contents>`);
      }
      for (const p of prefixes) parts.push(`<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${parts.join('')}</ListBucketResult>`;
      res.writeHead(200, { 'content-type': 'application/xml' }).end(xml);
      return;
    }

    // path-style 时路径含 /<bucket>/ 前缀,去掉它再当作对象 key
    const key = decodeURIComponent(u.pathname.replace(/^\//, '')).replace(/^[^/]+\//, '');

    // ---- Multipart Upload ----
    if (req.method === 'POST' && u.searchParams.has('uploads')) {
      const id = `upload-${++this.uploadSeq}`;
      this.uploads.set(id, new Map());
      res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    if (req.method === 'PUT' && uploadId && partNumber) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        this.uploads.get(uploadId)!.set(Number(partNumber), body);
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` }).end();
      });
      return;
    }
    if (req.method === 'POST' && uploadId) {
      req.on('data', () => {});
      req.on('end', () => {
        const parts = [...this.uploads.get(uploadId)!.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, body]) => body);
        this.objects.set(key, { body: Buffer.concat(parts) });
        this.uploads.delete(uploadId);
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end('<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>');
      });
      return;
    }
    if (req.method === 'DELETE' && uploadId) {
      this.uploads.delete(uploadId);
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'HEAD') {
      const o = this.objects.get(key);
      if (!o) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-length': String(o.body.length) }).end();
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.objects.set(key, { body: Buffer.concat(chunks) });
        res.writeHead(200).end();
      });
      return;
    }
    if (req.method === 'GET') {
      const o = this.objects.get(key);
      if (!o) {
        res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), o.body.length - 1);
        const slice = o.body.subarray(start, end + 1);
        res
          .writeHead(206, {
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${o.body.length}`,
          })
          .end(slice);
        return;
      }
      res.writeHead(200, { 'content-length': String(o.body.length) }).end(o.body);
      return;
    }
    if (req.method === 'DELETE') {
      this.objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  };
}

describe('S3Store(假 S3 服务端集成)', () => {
  let server: ReturnType<typeof createServer>;
  let store: S3Store;
  let fake: FakeS3;
  let dir: string;
  let port: number;

  beforeAll(async () => {
    fake = new FakeS3();
    server = createServer(fake.handler);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
    store = new S3Store({
      endpoint: `http://127.0.0.1:${port}`,
      region: 'cn-hangzhou',
      bucket: 'trove-bucket',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    });
    dir = await mkdtemp(join(tmpdir(), 'trove-s3-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('JSON 写入 → 读回一致;不存在返回 null', async () => {
    const value = { v: 1, items: { 'a:b': { size: 3 } }, 中文: '值' };
    await store.writeJson('dev1/index.json', value);
    await expect(store.readJson('dev1/index.json')).resolves.toEqual(value);
    await expect(store.readJson('dev1/nope.json')).resolves.toBeNull();
  });

  it('二进制块区间上传 → 读回字节一致', async () => {
    const local = join(dir, 'blob.bin');
    const all = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await writeFile(local, all);

    await store.writeFile('dev1/h/k/g1/0004-4.bin', local, { offset: 4, length: 4 });
    const got = join(dir, 'got.bin');
    await store.readFile('dev1/h/k/g1/0004-4.bin', got);
    expect((await readFile(got)).equals(all.subarray(4, 8))).toBe(true);
  });

  it('list 返回直接子项,目录与文件区分', async () => {
    await store.writeJson('raw/devA/meta.json', { id: 'devA' });
    await store.writeJson('raw/devA/chunks/h/x.bin', { z: 1 });
    await store.writeJson('raw/devB/meta.json', { id: 'devB' });

    const entries = await store.list('raw');
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['devA', 'devB']);
    expect(entries.find((e) => e.name === 'devA')!.type).toBe('directory');
  });

  it('listDevices 只返回 raw/ 下的设备目录', async () => {
    const devices = await store.listDevices();
    expect(devices).toContain('devA');
    expect(devices).toContain('devB');
    expect(devices.every((d) => !d.includes('/'))).toBe(true);
  });

  it('list 不存在的目录返回空数组', async () => {
    await expect(store.list('no/such/dir')).resolves.toEqual([]);
  });

  it('delete 不存在的对象不报错', async () => {
    await expect(store.delete('dev1/never-existed.bin')).resolves.toBeUndefined();
  });

  it('每次请求都带 SigV4 Authorization 头', async () => {
    fake.requests.length = 0;
    await store.writeJson('dev1/sig.json', { a: 1 });
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const r of fake.requests) {
      expect(r.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    }
  });

  it('5xx 可重试:503 后最终成功', async () => {
    fake.failNext = 2;
    await store.writeJson('dev1/retry.json', { ok: true });
    await expect(store.readJson('dev1/retry.json')).resolves.toEqual({ ok: true });
  });

  it('写 JSON 使用 tmp + 原子覆盖语义(不留半份)', async () => {
    await store.writeJson('dev1/atomic.json', { v: 1 });
    // 覆盖写后仍只有目标 key,没有残留 tmp
    await store.writeJson('dev1/atomic.json', { v: 2 });
    await expect(store.readJson('dev1/atomic.json')).resolves.toEqual({ v: 2 });
    expect([...fake.objects.keys()].filter((k) => k.includes('.tmp'))).toEqual([]);
  });

  it('大文件走 Multipart Upload,读回字节一致', async () => {
    const local = join(dir, 'big.bin');
    const body = Buffer.alloc(17 * 1024 * 1024, 7);
    await writeFile(local, body);
    fake.requests.length = 0;

    await store.writeFile('dev1/big.bin', local);

    expect(fake.requests.some((r) => r.url.includes('uploads'))).toBe(true);
    expect(fake.requests.filter((r) => r.url.includes('partNumber')).length).toBe(3); // 8+8+1 MiB
    const got = join(dir, 'big.got');
    await store.readFile('dev1/big.bin', got);
    expect((await readFile(got)).equals(body)).toBe(true);
  });

  it('小文件仍单 PUT,不走 Multipart', async () => {
    const local = join(dir, 'small.bin');
    await writeFile(local, 'hello');
    fake.requests.length = 0;

    await store.writeFile('dev1/small.bin', local);

    expect(fake.requests.some((r) => r.url.includes('uploads'))).toBe(false);
    expect(fake.requests.filter((r) => r.method === 'PUT').length).toBe(1);
  });

  it('对象路径含括号/加号/井号/百分号等特殊字符仍可读写', async () => {
    const local = join(dir, 'special.bin');
    await writeFile(local, 'special');
    const key = 'raw/dev1/files/claude-code/plans/a (1)+b#c%.md';

    await store.writeFile(key, local);
    const got = join(dir, 'special.got');
    await store.readFile(key, got);

    expect((await readFile(got)).toString()).toBe('special');
  });

  it('list 还原 XML 实体:路径含 & < > 引号时与写入 key 一致', async () => {
    const local = join(dir, 'xml.bin');
    await writeFile(local, 'xml');
    const dirKey = 'raw/dev1/files/claude-code/xml';
    const name = 'a&b<c>d"e\'f.md';

    await store.writeFile(`${dirKey}/${name}`, local);

    const entries = await store.list(dirKey);
    expect(entries.map((e) => e.name)).toContain(name);
    // 递归列同样还原,且能作为后续读取/删除的 key
    const all = await store.listAll(dirKey);
    expect(all.map((e) => e.name)).toContain(`${dirKey}/${name}`);
  });
});

describe('并发提示', () => {
  it('S3 后端给出大于 1 的并发建议', () => {
    const store = new S3Store({
      endpoint: 'http://127.0.0.1:1',
      region: 'cn-hangzhou',
      bucket: 'b',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
    });
    expect(store.concurrencyHint()).toBeGreaterThan(1);
  });

  it('可显式指定并发数', () => {
    const store = new S3Store({
      endpoint: 'http://127.0.0.1:1',
      region: 'cn-hangzhou',
      bucket: 'b',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      concurrency: 32,
    });
    expect(store.concurrencyHint()).toBe(32);
  });
});
