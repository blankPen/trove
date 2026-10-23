import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { chunkRanges, hashRange, reusableChunks, type ChunkRef } from '../src/core/chunker.js';

describe('chunkRanges(固定块大小,最后一块可短)', () => {
  it('空文件不产生块', () => {
    expect(chunkRanges(0, 4)).toEqual([]);
  });

  it('非整倍数:最后一块取余数', () => {
    expect(chunkRanges(10, 4)).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
      { offset: 8, length: 2 },
    ]);
  });

  it('整倍数:不产生零长度尾块', () => {
    expect(chunkRanges(8, 4)).toEqual([
      { offset: 0, length: 4 },
      { offset: 4, length: 4 },
    ]);
  });
});

describe('hashRange(按区间读文件)', () => {
  it('只哈希指定区间,结果等于该区间字节的 sha256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trove-chunk-'));
    const p = join(dir, 'a.bin');
    const bytes = Buffer.from('0123456789');
    await writeFile(p, bytes);
    const expectHash = createHash('sha256').update(bytes.subarray(4, 8)).digest('hex');
    await expect(hashRange(p, 4, 4)).resolves.toBe(expectHash);
  });
});

describe('reusableChunks(续传时复用已上传块)', () => {
  const ref = (offset: number, length: number): ChunkRef => ({
    offset,
    length,
    sha256: `${offset}-${length}`,
  });

  it('完整且已上传的块可复用,边界半块必须重传', () => {
    const prev = [ref(0, 4), ref(4, 4), ref(8, 2)];
    const reused = reusableChunks(prev, 10, 4);
    expect([...reused.keys()]).toEqual([0, 4]); // 8-10 是上次的尾块,现存内容已变长
  });

  it('上次恰好以整块结尾时,该块也可复用', () => {
    const prev = [ref(0, 4), ref(4, 4)];
    expect([...reusableChunks(prev, 8, 4).keys()]).toEqual([0, 4]);
  });
});
