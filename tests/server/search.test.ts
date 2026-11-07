import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSearchServer, type RunningSearchServer } from '../../src/server/search.js';

const qmd = { dbPath: join(tmpdir(), 'nope.sqlite'), model: 'hf:test' };
let vault: string;
let running: RunningSearchServer | null = null;

afterEach(async () => {
  if (running) {
    await running.close();
    running = null;
  }
  if (vault) await rm(vault, { recursive: true, force: true });
});

async function start(deps?: Parameters<typeof startSearchServer>[0]['deps']): Promise<RunningSearchServer> {
  vault = await mkdtemp(join(tmpdir(), 'trove-search-server-'));
  running = await startSearchServer({
    vaultRoot: vault,
    cacheDir: vault,
    version: 'test',
    qmd,
    token: 'secret',
    port: 0,
    keepWarmMinutes: 0,
    deps: deps ?? { search: async () => [{ path: 'experiences/a.md', title: 'A', score: 0.9 }] },
  });
  return running;
}

const call = (port: number, path: string, init: RequestInit = {}, token = 'secret'): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

describe('startSearchServer', () => {
  it('没有 token 一律 401', async () => {
    const s = await start();
    expect((await call(s.port, '/v1/health', {}, 'wrong')).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${s.port}/v1/health`)).status).toBe(401);
  });

  it('health 返回协议与运行时统计', async () => {
    const s = await start();
    const body = (await (await call(s.port, '/v1/health')).json()) as Record<string, unknown>;
    expect(body.protocol).toBe(1);
    expect(body.warm).toBe(false); // 没预热过
    expect(body.pid).toBe(process.pid);
  });

  it('检索透传 query/limit/category 并返回 hits', async () => {
    let seen: unknown = null;
    const s = await start({
      search: async (query: string, opts: { categories?: readonly string[]; limit?: number }) => {
        seen = { query, opts };
        return [{ path: 'experiences/a.md', title: 'A', score: 0.9 }];
      },
    });
    const res = await call(s.port, '/v1/lessons/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'trove', limit: 3, category: 'experiences' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ path: string }> };
    expect(body.hits[0]?.path).toBe('experiences/a.md');
    expect(seen).toEqual({ query: 'trove', opts: { limit: 3, categories: ['experiences'] } });
    expect(s.runtime.stats().total).toBe(1);
  });

  it('reindex 走运行时；未配置时 501', async () => {
    const s = await start({
      search: async () => [],
      reindex: async () => ({ documents: 5, chunksEmbedded: 2, needsEmbedding: 0 }),
    });
    const res = await call(s.port, '/v1/lessons/reindex', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: 5, chunksEmbedded: 2, needsEmbedding: 0 });

    await s.close();
    running = null;
    const plain = await start({ search: async () => [] });
    expect((await call(plain.port, '/v1/lessons/reindex', { method: 'POST' })).status).toBe(501);
  });

  it('空 query 返回 400，检索异常返回 500', async () => {
    const s = await start();
    const bad = await call(s.port, '/v1/lessons/search', { method: 'POST', body: JSON.stringify({ query: '  ' }) });
    expect(bad.status).toBe(400);

    await s.close();
    running = null;
    const boom = await start({
      search: async () => {
        throw new Error('model exploded');
      },
    });
    const err = await call(boom.port, '/v1/lessons/search', { method: 'POST', body: JSON.stringify({ query: 'x' }) });
    expect(err.status).toBe(500);
  });
});