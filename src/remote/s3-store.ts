import { open, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import type { RemoteEntry, RemoteStore } from './store.js';
import { signRequest } from './s3-sigv4.js';

export interface S3Options {
  /** S3 兼容 endpoint,例如 https://s3.oss-cn-hangzhou.aliyuncs.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** path-style 寻址(bucket 在路径里);virtual-hosted 时 bucket 在主机名里。 */
  forcePathStyle?: boolean;
  /** 并发连接数上限;对象存储允许并发,默认 8。 */
  maxSockets?: number;
  /** 并发上传块数;与连接池上限一致,默认 8。 */
  concurrency?: number;
  /** 单请求超时(ms)。 */
  timeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
/**
 * 并发上传块数。OSS 官方性能最佳实践建议高吞吐时用多连接并发
 * (大批量小文件场景建议 -j 100~500),这里取一个保守起点。
 */
const DEFAULT_CONCURRENCY = 8;

function strip(p: string): string {
  return p.replace(/^\/+|\/+$/g, '');
}

/** S3 key 不能以 / 开头,也不能含空段。 */
function toKey(path: string): string {
  return strip(path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}

/** 5xx 与 429 视为可重试;4xx 是配置或权限问题,立即失败。 */
function retryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status >= 500 || status === 429;
  const code = (err as NodeJS.ErrnoException)?.code;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code ?? '');
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

/** 从 S3 的 XML 错误体里取出 <Code> 与 <Message>。 */
function parseErrorBody(body: string): { code?: string; message?: string } {
  const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
  return { code, message };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * S3 存储实现:对象存储天然是扁平的 key,目录语义靠 ListObjectsV2 的 delimiter 模拟。
 *
 * 与 WebDAV 实现的差异:
 * - 目录不用创建(PutObject 自动建"目录")
 * - 索引写入直接覆盖同 key,天然原子(S3 的 PutObject 对同 key 是原子的)
 * - 允许并发:WebDAV 实测并发 PUT 会 ECONNRESET,对象存储不会
 */
export class S3Store implements RemoteStore {
  private endpoint: string;
  private region: string;
  private bucket: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private forcePathStyle: boolean;
  private timeoutMs: number;
  private maxSockets: number;
  private concurrency: number;
  /** keep-alive 连接池:对象存储允许并发,默认 8 条。 */
  private agents: {
    http: import('node:http').Agent;
    https: import('node:https').Agent;
  };

  constructor(opts: S3Options) {
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.region = opts.region;
    this.bucket = opts.bucket;
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.forcePathStyle = opts.forcePathStyle ?? false;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxSockets = opts.maxSockets ?? DEFAULT_CONCURRENCY;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

    this.agents = {
      http: new HttpAgent({ keepAlive: true, maxSockets: this.maxSockets }),
      https: new HttpsAgent({ keepAlive: true, maxSockets: this.maxSockets }),
    };
  }

  /** virtual-hosted:bucket 放主机名;path-style:bucket 放路径。 */
  private hostAndPath(key: string): { host: string; path: string } {
    const u = new URL(this.endpoint);
    if (this.forcePathStyle) {
      return { host: u.host, path: `/${this.bucket}/${key}` };
    }
    return { host: `${this.bucket}.${u.host}`, path: `/${key}` };
  }

  private async raw(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; body?: Buffer } = {},
  ): Promise<RawResponse> {
    const { host, path } = this.hostAndPath(key);
    const url = new URL(this.endpoint);
    url.host = host;
    url.pathname = path;
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const body = opts.body ?? Buffer.alloc(0);
    const signed = signRequest({
      method,
      url: url.toString(),
      pathname: path,
      headers: { host },
      body,
      region: this.region,
      service: 's3',
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      date: new Date(),
    });

    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    return new Promise<RawResponse>((resolve, reject) => {
      const req = reqFn(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          method,
          path: `${url.pathname}${url.search}`,
          headers: { ...signed.headers, 'content-length': String(body.length) },
          agent: isHttps ? this.agents.https : this.agents.http,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`S3 请求超时(${this.timeoutMs}ms): ${method} ${key}`));
      });
      req.on('error', reject);
      if (body.length) req.write(body);
      req.end();
    });
  }

  /** 带重试的请求;5xx/429 退避重试,4xx 立即抛。 */
  private async call(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; body?: Buffer; allow404?: boolean } = {},
  ): Promise<RawResponse | null> {
    let lastErr: unknown;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        const res = await this.raw(method, key, opts);
        if (res.status === 404) {
          if (opts.allow404) return null;
          const { code, message } = parseErrorBody(res.body.toString('utf8'));
          throw new S3Error(`对象不存在: ${key}${message ? ` (${message})` : ''}`, 404, code);
        }
        if (res.status >= 400) {
          const { code, message } = parseErrorBody(res.body.toString('utf8'));
          const err = new S3Error(
            `S3 ${method} 失败 (${res.status})${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
            res.status,
            code,
          );
          if (!retryable(err) || i === MAX_ATTEMPTS - 1) throw err;
          lastErr = err;
        } else {
          return res;
        }
      } catch (err) {
        lastErr = err;
        if (!retryable(err) || i === MAX_ATTEMPTS - 1) throw err;
      }
      await sleep(500 * 2 ** i * (0.7 + Math.random() * 0.6));
    }
    throw lastErr;
  }

  /** 列一层:prefix 下的直接子项;delimiter='/' 时把子目录折叠成目录项。 */
  private async listPage(
    prefix: string,
  ): Promise<Array<{ key: string; size: number; isDir: boolean }>> {
    const out: Array<{ key: string; size: number; isDir: boolean }> = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = {
        'list-type': '2',
        prefix,
        'delimiter': '/',
      };
      if (token) query['continuation-token'] = token;
      const res = await this.call('GET', '', { query });
      const xml = res!.body.toString('utf8');

      const contentRe = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m: RegExpExecArray | null;
      while ((m = contentRe.exec(xml))) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)?.[1];
        if (!key) continue;
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? '0');
        out.push({ key, size, isDir: false });
      }

      const prefixRe = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
      while ((m = prefixRe.exec(xml))) {
        const p = /<Prefix>([\s\S]*?)<\/Prefix>/.exec(m[1]!)?.[1];
        if (!p) continue;
        out.push({ key: p, size: 0, isDir: true });
      }

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated
        ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined;
    } while (token);
    return out;
  }

  async list(path: string, signal?: AbortSignal): Promise<RemoteEntry[]> {
    if (signal?.aborted) return [];
    const prefix = strip(path);
    const fullPrefix = prefix ? `${prefix}/` : '';
    const items = await this.listPage(fullPrefix);
    const out: RemoteEntry[] = [];
    for (const it of items) {
      const name = it.isDir
        ? strip(it.key).split('/').pop() ?? ''
        : it.key.slice(fullPrefix.length);
      if (!name) continue;
      out.push({ name, type: it.isDir ? 'directory' : 'file', size: it.size });
    }
    return out;
  }

  async listDevices(): Promise<string[]> {
    const items = await this.listPage('raw/');
    const out = new Set<string>();
    for (const it of items) {
      if (!it.isDir) continue;
      const name = strip(it.key).split('/').pop();
      if (name && name !== '.') out.add(name);
    }
    return [...out].sort();
  }

  async readJson(path: string, signal?: AbortSignal): Promise<unknown | null> {
    if (signal?.aborted) return null;
    const res = await this.call('GET', toKey(path), { allow404: true });
    if (!res) return null;
    const text = res.body.toString('utf8');
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // 远端索引写一半/被破坏:忽略它,让 push 从本地状态重建索引
      console.warn(`[trove] 远端 JSON 损坏,已忽略: ${path}`);
      return null;
    }
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    // S3 的 PutObject 对同 key 是原子覆盖,天然满足"索引是唯一提交点"
    await this.call('PUT', toKey(path), { body });
  }

  async writeFile(
    path: string,
    localPath: string,
    range?: { offset: number; length: number },
  ): Promise<void> {
    const key = toKey(path);
    // 读整个区间到内存再发:块最大 4MiB,内存占用可控
    const body = await this.readRange(localPath, range);
    await this.call('PUT', key, { body });
  }

  private async readRange(
    localPath: string,
    range?: { offset: number; length: number },
  ): Promise<Buffer> {
    if (!range) {
      return readFile(localPath);
    }
    const fh = await open(localPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(range.length);
      const { bytesRead } = await fh.read(buf, 0, range.length, range.offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async readFile(path: string, localPath: string): Promise<void> {
    const res = await this.call('GET', toKey(path));
    await writeFile(localPath, res!.body);
  }

  async delete(path: string): Promise<void> {
    // S3 删除不存在的对象也返回 204,不需要处理 404
    await this.call('DELETE', toKey(path), { allow404: true });
  }

  /** 对象存储允许并发上传;OSS 官方建议大批量小文件用较高并发。 */
  concurrencyHint(): number {
    return this.concurrency;
  }
}
