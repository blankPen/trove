import type { IncomingMessage, ServerResponse } from 'node:http';

/** 统一的 JSON 响应:状态码 + JSON 体,不带多余头。 */
export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** 404 的统一形状:前端据此显示"没有这个"。 */
export function notFound(res: ServerResponse, what: string): void {
  json(res, 404, { error: `没有找到${what}` });
}

/** 读取请求体(POST 用),限制 1 MB,超出即拒。 */
export async function readBody(req: IncomingMessage, limit = 1_048_576): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 取查询参数的一个值,空串视为未给。 */
export function param(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  return v && v.trim() ? v : undefined;
}

/** 取一个非负整数字符串,非法返回缺省值。 */
export function intParam(url: URL, name: string, fallback: number): number {
  const raw = param(url, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
