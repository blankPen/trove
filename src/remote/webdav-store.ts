import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { createClient, type WebDAVClient } from 'webdav';
import type { RemoteStore } from './store.js';

export interface WebDavOptions {
  url: string;
  username?: string;
  password?: string;
}

function strip(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

function withSlash(p: string): string {
  return `/${strip(p)}`;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status;
}

function retryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status >= 500 || status === 429;
  const code = (err as NodeJS.ErrnoException)?.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code ?? '');
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** 网络/5xx 重试 3 次;4xx 立即失败,避免把鉴权错误当成抖动。signal 中止后不再重试。 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (signal?.aborted || !retryable(err) || i === attempts - 1) throw err;
      await sleep(500 * 2 ** i, signal);
    }
  }
  throw last;
}

/**
 * WebDAV 存储实现。块是 8MiB 级小对象,目录按需创建并缓存,
 * 避免老实现"每个文件逐级 MKCOL"的数千次多余往返。
 */
export class WebDavStore implements RemoteStore {
  private client: WebDAVClient;
  private ensured = new Set<string>();

  constructor(opts: WebDavOptions) {
    // keep-alive 实测把单请求延迟从 ~0.66s 降到 ~0.30s(远端 WebDAV 的主要瓶颈)
    this.client = createClient(opts.url, {
      username: opts.username,
      password: opts.password,
      httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 1 }),
      httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 1 }),
    });
  }

  async listDevices(): Promise<string[]> {
    return withRetry(async () => {
      let entries;
      try {
        entries = await this.client.getDirectoryContents('/raw', { deep: false });
      } catch (err) {
        if (statusOf(err) === 404) return [];
        throw err;
      }
      const out = new Set<string>();
      for (const e of entries) {
        if (e.type !== 'directory') continue;
        const name = strip(e.filename).split('/').pop();
        if (name && name !== '.') out.add(name);
      }
      return [...out].sort();
    });
  }

  async list(path: string, signal?: AbortSignal): Promise<Array<{ name: string; type: 'file' | 'directory'; size: number }>> {
    const dir = strip(path);
    return withRetry(async () => {
      let entries;
      try {
        entries = await this.client.getDirectoryContents(dir ? `/${dir}` : '/', {
          deep: false,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (statusOf(err) === 404) return [];
        throw err;
      }
      return entries.map((e) => ({
        name: strip(e.filename).split('/').pop() ?? '',
        type: e.type === 'directory' ? ('directory' as const) : ('file' as const),
        size: typeof e.size === 'number' ? e.size : 0,
      }));
    }, 5, signal);
  }

  async readJson(path: string, signal?: AbortSignal): Promise<unknown | null> {
    return withRetry(async () => {
      try {
        const text = (await this.client.getFileContents(withSlash(path), {
          format: 'text',
          ...(signal ? { signal } : {}),
        })) as string;
        if (!text.trim()) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          // 远端索引写一半/被破坏:忽略它,让 push 从本地状态重建索引
          console.warn(`[trove] 远端 JSON 损坏,已忽略: ${path}`);
          return null;
        }
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    }, 5, signal);
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    await this.ensureDir(path);
    const body = JSON.stringify(value);
    const tmp = `${path}.tmp-${randomUUID()}`;
    await withRetry(async () => {
      await this.client.putFileContents(withSlash(tmp), body, { overwrite: true });
    });
    try {
      // MOVE 是原子的:读者要么看到旧索引,要么看到完整新索引
      await withRetry(() =>
        this.client.moveFile(withSlash(tmp), withSlash(path), { overwrite: true }),
      );
    } catch (err) {
      const status = statusOf(err);
      if (status !== 405 && status !== 501) throw err;
      // 服务端不支持 MOVE:退回直接覆盖
      await withRetry(async () => {
        await this.client.putFileContents(withSlash(path), body, { overwrite: true });
      });
    } finally {
      await this.delete(tmp).catch(() => {});
    }
  }

  async writeFile(
    path: string,
    localPath: string,
    range?: { offset: number; length: number },
  ): Promise<void> {
    await this.ensureDir(path);
    const size = range ? range.length : (await stat(localPath)).size;
    await withRetry(async () => {
      // 每次重试都新建流:ReadStream 被消费后不能复用
      const stream = range
        ? createReadStream(localPath, { start: range.offset, end: range.offset + range.length - 1 })
        : createReadStream(localPath);
      await this.client.putFileContents(withSlash(path), stream, {
        contentLength: size,
        overwrite: true,
      });
    });
  }

  async readFile(path: string, localPath: string): Promise<void> {
    const data = await withRetry(async () => {
      return (await this.client.getFileContents(withSlash(path), {
        format: 'binary',
      })) as Buffer;
    });
    await writeFile(localPath, data);
  }

  async delete(path: string): Promise<void> {
    await withRetry(async () => {
      try {
        await this.client.deleteFile(withSlash(path));
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }
    });
  }

  /** 逐段建父目录;已建过的段落直接跳过(缓存跨文件生效)。 */
  private async ensureDir(path: string): Promise<void> {
    const segments = strip(path).split('/');
    segments.pop();
    let acc = '';
    for (const seg of segments) {
      if (!seg) continue;
      acc += `/${seg}`;
      if (this.ensured.has(acc)) continue;
      try {
        await this.client.createDirectory(acc, { recursive: true });
      } catch (err) {
        const status = statusOf(err);
        if (status !== 405 && status !== 409) throw err;
      }
      this.ensured.add(acc);
    }
  }
}
