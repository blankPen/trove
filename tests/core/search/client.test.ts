import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DaemonSearchClient,
  SEARCH_PROTOCOL,
  openSearchTransport,
  readDaemonSearchInfo,
  resetSearchBreaker,
  type DaemonSearchInfo,
} from '../../../src/core/search/client.js';

let base: string;
let server: Server | null = null;
let handler: (body: { query?: string }, res: import('node:http').ServerResponse) => void;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'trove-search-client-'));
  resetSearchBreaker();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

async function startStub(): Promise<number> {
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocol: SEARCH_PROTOCOL }));
      return;
    }
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => handler(text ? (JSON.parse(text) as { query?: string }) : {}, res));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server!.address() as AddressInfo).port;
}

function writeInfo(port: number, extra: Partial<DaemonSearchInfo> = {}): Promise<void> {
  return writeFile(
    join(base, 'daemon.search.json'),
    JSON.stringify({ pid: process.pid, port, token: 'tok', protocol: SEARCH_PROTOCOL, startedAt: Date.now(), ...extra }),
  );
}

describe('readDaemonSearchInfo', () => {
  it('进程存活时返回端口与 token', async () => {
    await writeInfo(12345);
    const info = await readDaemonSearchInfo(base);
    expect(info?.port).toBe(12345);
    expect(info?.protocol).toBe(SEARCH_PROTOCOL);
  });

  it('进程已死或文件缺失时返回 null', async () => {
    await writeInfo(12345, { pid: 999999 });
    expect(await readDaemonSearchInfo(base)).toBeNull();
    await rm(join(base, 'daemon.search.json'));
    expect(await readDaemonSearchInfo(base)).toBeNull();
  });
});

describe('DaemonSearchClient', () => {
  const info = (port: number): DaemonSearchInfo => ({
    pid: process.pid,
    port,
    token: 'tok',
    protocol: SEARCH_PROTOCOL,
    startedAt: Date.now(),
  });

  it('成功时把 hits 原样返回，并带上 limit/category', async () => {
    const port = await startStub();
    let seen: unknown = null;
    handler = (body, res) => {
      seen = body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hits: [{ path: 'experiences/a.md', title: 'A', score: 0.9 }] }));
    };
    const client = new DaemonSearchClient(info(port), 1000);
    const hits = await client.search('trove', { limit: 3, category: 'experiences' });
    expect(hits?.[0]?.path).toBe('experiences/a.md');
    expect(seen).toEqual({ query: 'trove', limit: 3, category: 'experiences' });
  });

  it('非 2xx、超时、坏 JSON 都降级为 null（调用方回落本地）', async () => {
    const port = await startStub();
    handler = (_body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
    };
    expect(await new DaemonSearchClient(info(port), 500).search('x')).toBeNull();

    handler = (_body, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('{"hits":[]}');
      }, 300);
    };
    expect(await new DaemonSearchClient(info(port), 50).search('x')).toBeNull();

    handler = (_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"nope":1}');
    };
    expect(await new DaemonSearchClient(info(port), 500).search('x')).toBeNull();
  });

  it('reindex 解析 daemon 结果；失败返回 null', async () => {
    const port = await startStub();
    handler = (_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ documents: 3, chunksEmbedded: 1, needsEmbedding: 0 }));
    };
    expect(await new DaemonSearchClient(info(port), 1000).reindex()).toEqual({
      documents: 3,
      chunksEmbedded: 1,
      needsEmbedding: 0,
    });

    handler = (_body, res) => {
      res.writeHead(500);
      res.end('{}');
    };
    expect(await new DaemonSearchClient(info(port), 1000).reindex()).toBeNull();
  });

  it('health 校验 token 与协议', async () => {
    const port = await startStub();
    expect(await new DaemonSearchClient(info(port), 500).health()).toBe(true);
    expect(await new DaemonSearchClient({ ...info(port), token: 'bad' }, 500).health()).toBe(false);
  });
});

describe('openSearchTransport', () => {
  it('local 模式或 daemon 不存在时返回 undefined', async () => {
    expect(await openSearchTransport(base, 'local')).toBeUndefined();
    expect(await openSearchTransport(base, 'auto')).toBeUndefined();
  });

  it('健康检查通过时返回客户端', async () => {
    const port = await startStub();
    handler = (_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hits":[]}');
    };
    await writeInfo(port);
    const client = await openSearchTransport(base, 'auto', 1000);
    expect(client).toBeInstanceOf(DaemonSearchClient);
  });

  it('协议不匹配时回落本地', async () => {
    const port = await startStub();
    await writeInfo(port, { protocol: 999 });
    expect(await openSearchTransport(base, 'auto', 1000)).toBeUndefined();
  });
});