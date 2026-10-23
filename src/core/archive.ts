import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { decideFileAction, type FileAction, type FileCursor } from './cursor.js';
import { hashFile, hashRange } from './chunker.js';

export interface ArchiveInput {
  sourcePath: string;
  targetPath: string;
  cursor?: FileCursor;
  /** 本轮发现时的源文件元数据(一次 stat 的结果) */
  srcStat: { size: number; mtimeMs: number };
  newGeneration?: () => string;
}

export interface ArchiveResult {
  action: FileAction;
  cursor: FileCursor;
  bytesCopied: number;
}

/** 目标不存在时返回 null,用于判定 new/reset。 */
async function targetHash(path: string): Promise<string | null> {
  try {
    return await hashFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 把一个原始文件无损归档到本地 vault(设计:raw 原样副本)。
 *
 * - new/reset:临时文件 + rename,避免读者看到半个文件;reset 时换新世代
 * - append:只把源文件 [cursor.size, srcStat.size) 追加到目标;
 *   追加是"正确前缀"操作 —— 中途崩溃后再跑会因前缀哈希不符而重置,不会留下错误内容
 * - 源文件一个字都不改(只读)
 */
export async function archiveFile(input: ArchiveInput): Promise<ArchiveResult> {
  const { sourcePath, targetPath, cursor, srcStat } = input;
  const newGeneration = input.newGeneration ?? (() => randomUUID());
  const localHash = await targetHash(targetPath);
  const action = decideFileAction(cursor, srcStat, localHash);

  if (action === 'skip') return { action, cursor: cursor!, bytesCopied: 0 };

  await mkdir(dirname(targetPath), { recursive: true });

  if (action === 'append') {
    const offset = cursor!.size;
    // 关键:本地归档哈希只能证明"归档没坏",不能证明"源文件前 offset 字节没被改写"。
    // 就地改写后又增长时,直接追加会拼出源文件中从未存在过的内容,因此再校验源前缀。
    const srcPrefix = await hashRange(sourcePath, 0, offset);
    if (srcPrefix !== cursor!.prefixHash) {
      return resetCopy(sourcePath, targetPath, srcStat, newGeneration, 'reset');
    }
    // 目标大小必须等于游标位置,否则视作归档异常,退化为全量重置
    const tst = await stat(targetPath);
    if (tst.size !== offset) {
      return resetCopy(sourcePath, targetPath, srcStat, newGeneration, 'reset');
    }
    const length = srcStat.size - offset;
    if (length > 0) {
      const src = createReadStream(sourcePath, { start: offset, end: srcStat.size - 1 });
      const dst = createWriteStream(targetPath, { flags: 'a' });
      await pipeline(src, dst);
      // 严格对齐:源在复制期间若被截断,回退到重置,绝不半信半疑
      const now = await stat(targetPath);
      if (now.size !== srcStat.size) {
        return resetCopy(sourcePath, targetPath, srcStat, newGeneration, 'reset');
      }
    }
    return {
      action,
      cursor: {
        size: srcStat.size,
        mtimeMs: srcStat.mtimeMs,
        prefixHash: (await hashFile(targetPath))!,
        generation: cursor!.generation,
      },
      bytesCopied: length,
    };
  }

  return resetCopy(sourcePath, targetPath, srcStat, newGeneration, action);
}

/** 全量复制到临时文件再 rename,保证目标要么是旧内容要么是完整新内容。 */
async function resetCopy(
  sourcePath: string,
  targetPath: string,
  srcStat: { size: number; mtimeMs: number },
  newGeneration: () => string,
  action: 'new' | 'reset',
): Promise<ArchiveResult> {
  const tmp = `${targetPath}.tmp-${randomUUID()}`;
  try {
    await pipeline(createReadStream(sourcePath), createWriteStream(tmp));
    const st = await stat(tmp);
    if (st.size !== srcStat.size) {
      throw new Error(`归档字节数不一致: ${sourcePath} 期望 ${srcStat.size} 实得 ${st.size}`);
    }
    const prefixHash = (await hashFile(tmp))!;
    await rename(tmp, targetPath);
    if (srcStat.size === 0) {
      // 空文件无法从流式复制的日志判断,补一次 read 校验存在性
      const fh = await open(targetPath, 'r');
      await fh.close();
    }
    return {
      action,
      cursor: { size: srcStat.size, mtimeMs: srcStat.mtimeMs, prefixHash, generation: newGeneration() },
      bytesCopied: srcStat.size,
    };
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
