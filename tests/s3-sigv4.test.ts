import { describe, it, expect } from 'vitest';
import { signRequest, canonicalUri, canonicalQuery, payloadHash } from '../src/remote/s3-sigv4.js';

/**
 * AWS SigV4 签名。
 * 参考:AWS 官方 "Signature Version 4 signing process" 与各厂商 S3 兼容文档。
 */

const CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'cn-hangzhou',
  service: 's3',
};

describe('SigV4 canonical request 组件', () => {
  it('canonicalUri 对路径做百分号编码,保留 / 分隔符', () => {
    expect(canonicalUri('raw/dev1/index.json')).toBe('/raw/dev1/index.json');
    // 空格 -> %20,中文 -> UTF-8 百分号编码
    expect(canonicalUri('raw/my dev/中文.json')).toBe('/raw/my%20dev/%E4%B8%AD%E6%96%87.json');
    // 已经是百分号编码的不重复编码 %
    expect(canonicalUri('a%20b')).toBe('/a%2520b');
  });

  it('canonicalUri 不编码 S3 保留字符与 / (路径语义)', () => {
    // S3 要求 path 中这些字符不被编码
    expect(canonicalUri('a-b_c.d~e')).toBe('/a-b_c.d~e');
  });

  it('canonicalQuery 按 key 排序并编码', () => {
    expect(canonicalQuery({ prefix: 'raw/', delimiter: '/' })).toBe(
      'delimiter=%2F&prefix=raw%2F',
    );
  });

  it('canonicalQuery 空值集合返回空串', () => {
    expect(canonicalQuery({})).toBe('');
  });

  it('payloadHash 对空 body 返回 UNSIGNED-PAYLOAD 之外的空串哈希', () => {
    // sha256("") 的十六进制
    expect(payloadHash(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('SigV4 签名', () => {
  it('产生 Authorization 头,含算法/凭据范围/签名/签名头', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://bucket.s3.oss-cn-hangzhou.aliyuncs.com/raw/index.json?list-type=2',
      headers: { host: 'bucket.s3.oss-cn-hangzhou.aliyuncs.com' },
      body: Buffer.alloc(0),
      ...CREDS,
      date: new Date('2026-11-03T12:00:00Z'),
    });

    expect(signed.headers['x-amz-date']).toBe('20261103T120000Z');
    expect(signed.headers['x-amz-content-sha256']).toBe(payloadHash(Buffer.alloc(0)));
    const auth = signed.headers.authorization!;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/cn-hangzhou\/s3\/aws4_request,/);
    expect(auth).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('同一请求签名稳定(相同输入 → 相同签名)', () => {
    const args = {
      method: 'GET',
      url: 'https://bucket.s3.oss-cn-hangzhou.aliyuncs.com/a',
      headers: { host: 'bucket.s3.oss-cn-hangzhou.aliyuncs.com' },
      body: Buffer.alloc(0),
      ...CREDS,
      date: new Date('2026-11-03T12:00:00Z'),
    };
    expect(signRequest(args).headers.authorization).toBe(signRequest(args).headers.authorization);
  });

  it('不同请求体得到不同签名', () => {
    const base = {
      method: 'PUT',
      url: 'https://bucket.s3.oss-cn-hangzhou.aliyuncs.com/a',
      headers: { host: 'bucket.s3.oss-cn-hangzhou.aliyuncs.com' },
      ...CREDS,
      date: new Date('2026-11-03T12:00:00Z'),
    };
    const a = signRequest({ ...base, body: Buffer.from('hello') });
    const b = signRequest({ ...base, body: Buffer.from('world') });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it('query 参数参与签名(同路径不同 query → 不同签名)', () => {
    const base = {
      method: 'GET',
      headers: { host: 'h' },
      body: Buffer.alloc(0),
      ...CREDS,
      date: new Date('2026-11-03T12:00:00Z'),
    };
    const a = signRequest({ ...base, url: 'https://h/x?list-type=2' });
    const b = signRequest({ ...base, url: 'https://h/x?list-type=2&prefix=a' });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it('空值 query 保留等号(分片上传的 uploads=)', () => {
    expect(canonicalQuery({ uploads: '' })).toBe('uploads=');
    const signed = signRequest({
      method: 'POST',
      url: 'https://h/key?uploads=',
      pathname: '/key',
      headers: { host: 'h' },
      body: Buffer.alloc(0),
      ...CREDS,
      date: new Date('2026-11-03T12:00:00Z'),
    });
    expect(signed.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    // 与「没有 query」的签名不同,证明 uploads= 进了 canonical request
    const plain = signRequest({
      method: 'POST',
      url: 'https://h/key',
      pathname: '/key',
      headers: { host: 'h' },
      body: Buffer.alloc(0),
      ...CREDS,
      date: new Date('2026-11-03T12:00:00Z'),
    });
    expect(signed.headers.authorization).not.toBe(plain.headers.authorization);
  });
});
