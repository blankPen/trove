/** daemon 检索通道的客户端：发现端口/token、探测、熔断、请求。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive } from '../lock.js';
import type { SearchMode } from '../../config.js';
import type { QmdHit, QmdSyncResult } from './qmd.js';
import type { LessonSearchTransport } from './service.js';

/** 客户端与 daemon 必须一致的协议版本；不一致时回落本地。 */
export const SEARCH_PROTOCOL = 1;

export interface DaemonSearchInfo {
  pid: number;
  port: number;
  token: string;
  protocol: number;
  startedAt: number;
}

/** 读取 daemon 发布的端口与 token；文件不存在、进程已死或格式不对都返回 null。 */
export async function readDaemonSearchInfo(base: string): Promise<DaemonSearchInfo | null> {
  try {
    const raw = JSON.parse(await readFile(join(base, 'daemon.search.json'), 'utf8')) as Partial<DaemonSearchInfo>;
    if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || typeof raw.pid !== 'number') {
      return null;
    }
    if (!isProcessAlive(raw.pid)) return null;
    return {
      pid: raw.pid,
      port: raw.port,
      token: raw.token,
      protocol: raw.protocol ?? 0,
      startedAt: raw.startedAt ?? 0,
    };
  } catch {
    return null;
  }
}

/** 连续失败后短暂跳过 daemon，避免每次检索都白等一个超时。 */
const breaker = { failures: 0, openUntil: 0 };
const BREAKER_COOLDOWN_MS = 5000;
const BREAKER_THRESHOLD = 3;

export function resetSearchBreaker(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

function markFailure(): void {
  breaker.failures++;
  if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
}

function markSuccess(): void {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

export class DaemonSearchClient implements LessonSearchTransport {
  readonly kind = 'daemon' as const;

  constructor(
    private readonly info: DaemonSearchInfo,
    private readonly timeoutMs = 15_000,
  ) {}

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.info.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.info.token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** 轻量探测：验证端口、token 与协议，不触发模型加载。 */
  async health(): Promise<boolean> {
    try {
      const res = await this.request('/v1/health', { method: 'GET' }, Math.min(250, this.timeoutMs));
      if (!res.ok) return false;
      const body = (await res.json()) as { protocol?: number };
      return body.protocol === SEARCH_PROTOCOL;
    } catch {
      return false;
    }
  }

  /** 让 daemon 增量重建索引；失败返回 null，调用方本地重建。 */
  async reindex(): Promise<QmdSyncResult | null> {
    try {
      // 冷索引可能要嵌入上千片段，给足时间（10 分钟）。
      const res = await this.request('/v1/lessons/reindex', { method: 'POST' }, 600_000);
      if (!res.ok) return null;
      return (await res.json()) as QmdSyncResult;
    } catch {
      return null;
    }
  }

  /** 返回 null 表示这条通道这次不可用，调用方回落本地加载。 */
  async search(
    query: string,
    opts: { category?: string; limit?: number } = {},
  ): Promise<QmdHit[] | null> {
    try {
      const res = await this.request(
        '/v1/lessons/search',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query,
            ...(opts.limit ? { limit: opts.limit } : {}),
            ...(opts.category ? { category: opts.category } : {}),
          }),
        },
        this.timeoutMs,
      );
      if (!res.ok) {
        markFailure();
        debug(`daemon 检索 HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { hits?: unknown };
      if (!Array.isArray(body.hits)) return null;
      markSuccess();
      return body.hits as QmdHit[];
    } catch (e) {
      markFailure();
      debug(`daemon 检索失败: ${(e as Error).message}`);
      return null;
    }
  }
}

/**
 * 按配置选择检索通道：local 直接返回 undefined；auto/daemon 探测 daemon，
 * 探测失败（未运行、协议不匹配、token 不对、熔断中）一律回落本地。
 */
export async function openSearchTransport(
  base: string,
  mode: SearchMode,
  timeoutMs = 15_000,
): Promise<DaemonSearchClient | undefined> {
  if (mode === 'local') return undefined;
  if (Date.now() < breaker.openUntil) {
    debug('熔断中，走本地');
    return undefined;
  }
  const info = await readDaemonSearchInfo(base);
  if (!info || info.protocol !== SEARCH_PROTOCOL) return undefined;
  // 只看进程与协议，不做健康探测：daemon 忙（同步/embed）时 250ms 探测会误判，
  // 误判的代价是本进程重新加载 2.5GB 模型，比多等一会儿贵得多。
  return new DaemonSearchClient(info, timeoutMs);
}

function debug(message: string): void {
  if (process.env.TROVE_DEBUG) console.error(`[search] ${message}`);
}