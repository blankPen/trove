import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { Fingerprint } from './types.js';

/** headHash 取文件前 N 字节(设计 §7.1)。 */
const HEAD_BYTES = 512;

/** 字节内容的 sha256 十六进制。纯函数,便于单独测试。 */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 计算单个文件的指纹(size + mtime + headHash)。含 IO,应在 SCAN 阶段调用。 */
export async function computeFingerprint(absPath: string): Promise<Fingerprint> {
  const st = await stat(absPath);
  const fh = await open(absPath, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
    return {
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      headHash: hashBytes(head.subarray(0, bytesRead)),
    };
  } finally {
    await fh.close();
  }
}
