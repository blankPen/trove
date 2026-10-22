import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hashBytes, computeFingerprint } from '../src/core/fingerprint.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('hashBytes', () => {
  it('返回 sha256 十六进制', () => {
    // 已知向量: sha256("abc")
    expect(hashBytes(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('computeFingerprint', () => {
  let dir: string;

  async function tmpFile(content: Buffer): Promise<string> {
    const p = join(dir, `${Math.random().toString(36).slice(2)}.bin`);
    await writeFile(p, content);
    return p;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'trove-fp-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('小文件(≤512 字节):headHash 等于整份内容的 hash', async () => {
    const content = Buffer.from('hello trove');
    const p = await tmpFile(content);
    const fp = await computeFingerprint(p);

    expect(fp.size).toBe(content.length);
    expect(fp.headHash).toBe(sha256(content));
  });

  it('大文件(>512 字节):headHash 只取前 512 字节', async () => {
    const content = Buffer.alloc(2048, 0xab);
    const p = await tmpFile(content);
    const fp = await computeFingerprint(p);

    expect(fp.size).toBe(content.length);
    expect(fp.headHash).toBe(sha256(content.subarray(0, 512)));
  });

  it('记录 mtime(毫秒)与文件系统一致', async () => {
    const content = Buffer.from('mtime check');
    const p = await tmpFile(content);
    const fp = await computeFingerprint(p);
    const st = await stat(p);

    expect(fp.mtime).toBe(Math.round(st.mtimeMs));
  });
});
