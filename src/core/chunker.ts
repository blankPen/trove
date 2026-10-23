import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

/** 字节内容的 sha256(十六进制)。 */
export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 4 MiB:实测远端 16MB 级请求会 EPIPE,4MB 稳定且续传粒度更细。 */
export const CHUNK_SIZE = 4 * 1024 * 1024;

export interface ChunkRef {
  offset: number;
  length: number;
  sha256: string;
}

/** 把文件按固定大小切块;空文件零块。 */
export function chunkRanges(
  size: number,
  chunkSize: number = CHUNK_SIZE,
): Array<{ offset: number; length: number }> {
  const out: Array<{ offset: number; length: number }> = [];
  for (let offset = 0; offset < size; offset += chunkSize) {
    out.push({ offset, length: Math.min(chunkSize, size - offset) });
  }
  return out;
}

/** 计算文件指定区间的 sha256(十六进制)。 */
export async function hashRange(
  path: string,
  offset: number,
  length: number,
): Promise<string> {
  const fh = await open(path, 'r');
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, length)));
  try {
    let pos = offset;
    let left = length;
    while (left > 0) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
      left -= bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

/** 计算整个文件的 sha256(流式,避免整文件入内存)。 */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (b) => hash.update(b))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 续传:上次已上传的块里,只有「完整块且完全落在旧文件大小内」的能复用。
 * 旧尾块是半块,文件增长后同一 offset 的块内容已变,必须重算重传。
 */
export function reusableChunks(
  previous: readonly ChunkRef[],
  previousSize: number,
  chunkSize: number = CHUNK_SIZE,
): Map<number, ChunkRef> {
  const out = new Map<number, ChunkRef>();
  for (const c of previous) {
    if (c.length === chunkSize && c.offset + c.length <= previousSize) {
      out.set(c.offset, c);
    }
  }
  return out;
}

/** 远端块文件名:offset-length.bin,按 offset 自然排序即文件顺序。 */
export function chunkFileName(c: { offset: number; length: number }): string {
  return `${String(c.offset).padStart(16, '0')}-${c.length}.bin`;
}
