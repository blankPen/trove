import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 签名。
 *
 * 只实现 S3 需要的部分:Get/Put/Delete + ListObjectsV2。
 * 不引第三方 SDK —— 本项目只需要 4 个已签名请求,自己签省掉一整个依赖树。
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

export interface SignRequestInput extends SigV4Credentials {
  method: string;
  url: string;
  /** 未编码的原始路径;省略时从 url 解析。url.pathname 已被 WHATWG URL 预编码,直接喂给 canonicalUri 会二次编码。 */
  pathname?: string;
  headers: Record<string, string>;
  body: Buffer;
  date: Date;
}

export interface SignedRequest {
  headers: Record<string, string>;
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** S3 要求路径中这些字符原样保留,不参与百分号编码。 */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * URI 编码:非保留字符原样,其余 UTF-8 百分号编码。
 * AWS 的规则与 RFC3986 有两处差异:斜杠只在路径中保留,星号不编码。
 */
function uriEncode(value: string, encodeSlash: boolean): string {
  let out = '';
  for (const ch of Buffer.from(value, 'utf8')) {
    const s = String.fromCharCode(ch);
    if (UNRESERVED.test(s)) {
      out += s;
    } else if (s === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** canonical URI:路径部分,/ 分隔符不编码。 */
export function canonicalUri(pathname: string): string {
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return uriEncode(p, false);
}

/** canonical query:按 key 排序后逐项编码,= 与 & 分隔。 */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(params[k]!, true)}`)
    .join('&');
}

/** payload 的 sha256 十六进制。 */
export function payloadHash(body: Buffer): string {
  return sha256Hex(body);
}

/** 头部名小写、按序拼接;每个头部值去除多余空白并折叠。 */
function canonicalHeaders(headers: Record<string, string>): { signed: string; canonical: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signed = entries.map(([k]) => k).join(';');
  return { signed, canonical };
}

/**
 * 对一个请求签名,返回带 Authorization / x-amz-date / x-amz-content-sha256 的头部。
 */
export function signRequest(input: SignRequestInput): SignedRequest {
  const { method, url, body, date } = input;
  const u = new URL(url);
  const pathname = input.pathname ?? u.pathname;

  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...input.headers,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash(body),
  };

  const { signed, canonical } = canonicalHeaders(headers);
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(pathname),
    canonicalQuery(Object.fromEntries(u.searchParams.entries())),
    canonical,
    signed,
    payloadHash(body),
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signed}, Signature=${signature}`,
    },
  };
}
