/**
 * daemon 检索服务：本机唯一持有模型的 HTTP 端点。
 * 只绑 127.0.0.1 + Bearer token；/v1/* 给 CLI/MCP 代理用，/mcp 给支持 HTTP 的 agent 客户端直连。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/server.js';
import { SearchRuntime, type SearchRuntimeDeps } from '../core/search/runtime.js';
import {
  qmdIndexStatus,
  searchQmd,
  syncQmdIndex,
  touchQmdActivity,
  warmQmdStore,
  type QmdHit,
  type QmdSearchConfig,
} from '../core/search/qmd.js';
import type { LessonSearchTransport } from '../core/search/service.js';
import { SEARCH_PROTOCOL } from '../core/search/client.js';
import { json, readBody } from './http.js';

export interface SearchServerOptions {
  vaultRoot: string;
  cacheDir: string;
  version: string;
  qmd: QmdSearchConfig;
  token: string;
  /** 0 = 随机端口（测试用）。 */
  port?: number;
  /** 最近检索后保持模型热的分钟数；0 = 不保活。 */
  keepWarmMinutes?: number;
  /** 测试注入检索实现；缺省走 qmd。 */
  deps?: SearchRuntimeDeps;
  log?: (line: string) => void;
}

export interface RunningSearchServer {
  port: number;
  runtime: SearchRuntime;
  close(): Promise<void>;
}

const MAX_SEARCH_BODY = 16 * 1024;
const MAX_MCP_BODY = 256 * 1024;

function authorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

/** 默认检索实现：qmd 完整管线；保活用 qmd 的内部计时器（见 touchQmdActivity）。 */
function qmdDeps(vaultRoot: string, cfg: QmdSearchConfig): SearchRuntimeDeps {
  return {
    search: (query, opts) => searchQmd(vaultRoot, query, cfg, opts),
    warm: () => warmQmdStore(vaultRoot, cfg),
    touch: touchQmdActivity,
    reindex: () => syncQmdIndex(vaultRoot, cfg),
  };
}

export async function startSearchServer(opts: SearchServerOptions): Promise<RunningSearchServer> {
  const deps = opts.deps ?? qmdDeps(opts.vaultRoot, opts.qmd);
  const runtime = new SearchRuntime(deps, { keepWarmMinutes: opts.keepWarmMinutes ?? 0 });
  const log = opts.log ?? (() => {});
  const startedAt = Date.now();
  let healthCache: { at: number; value: { documents: number; needsEmbedding: number } | null } | null = null;

  const indexStatus = async (): Promise<{ documents: number; needsEmbedding: number } | null> => {
    if (healthCache && Date.now() - healthCache.at < 5000) return healthCache.value;
    const st = await qmdIndexStatus(opts.vaultRoot, opts.qmd);
    const value = st ? { documents: st.documents, needsEmbedding: st.needsEmbedding } : null;
    healthCache = { at: Date.now(), value };
    return value;
  };

  const runtimeTransport: LessonSearchTransport = {
    kind: 'daemon',
    search: (query, o) =>
      runtime.search(query, {
        ...(o.category ? { categories: [o.category] } : {}),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
      }),
  };

  const handleSearch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: { query?: unknown; limit?: unknown; category?: unknown };
    try {
      body = JSON.parse(await readBody(req, MAX_SEARCH_BODY)) as typeof body;
    } catch {
      json(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    if (typeof body.query !== 'string' || !body.query.trim()) {
      json(res, 400, { error: 'query 必填' });
      return;
    }
    const limit = Math.max(1, Math.min(50, Number(body.limit) || 10));
    const category = typeof body.category === 'string' && body.category ? body.category : undefined;
    try {
      const hits: QmdHit[] = await runtime.search(body.query, {
        limit,
        ...(category ? { categories: [category] } : {}),
      });
      json(res, 200, { hits });
    } catch (e) {
      log(`[search] 失败: ${(e as Error).message}`);
      json(res, 500, { error: (e as Error).message });
    }
  };

  // MCP 无状态模式：每个请求用独立 server+transport，不需要会话管理。
  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'MCP 只支持 POST' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_MCP_BODY));
    } catch {
      json(res, 400, { error: '请求体不是合法 JSON' });
      return;
    }
    const server = createMcpServer({
      vault: opts.vaultRoot,
      cacheDir: opts.cacheDir,
      version: opts.version,
      backend: opts.qmd,
      transport: runtimeTransport,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (!authorized(req, opts.token)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        json(res, 200, {
          protocol: SEARCH_PROTOCOL,
          version: opts.version,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          ...runtime.stats(),
          index: await indexStatus(),
        });
        return;
      }
      if (url.pathname === '/v1/lessons/search' && req.method === 'POST') {
        await handleSearch(req, res);
        return;
      }
      if (url.pathname === '/v1/lessons/reindex' && req.method === 'POST') {
        const result = await runtime.reindex();
        if (!result) json(res, 501, { error: '未配置索引同步' });
        else json(res, 200, result);
        return;
      }
      if (url.pathname === '/mcp') {
        await handleMcp(req, res);
        return;
      }
      json(res, 404, { error: 'not found' });
    })().catch((e: unknown) => {
      log(`[http] ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  runtime.startKeepWarm();
  // 预热不阻塞 daemon 的同步与 learn 循环
  void runtime.warmup().then((ok) => log(ok ? '检索模型已预热' : '检索模型预热失败(首查会慢)'));
  log(`检索服务监听 127.0.0.1:${port}`);

  return {
    port,
    runtime,
    close: async () => {
      runtime.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}