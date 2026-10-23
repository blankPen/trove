import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CHUNK_SIZE, chunkRanges, hashRange, reusableChunks, type ChunkRef } from './chunker.js';
import { mapLimit } from './concurrency.js';
import { throwIfAborted } from './collect.js';
import type { State } from './state.js';
import {
  chunkRemotePath,
  chunksHash,
  encodeKey,
  indexPath,
  itemKey,
  validateRelPath,
  type DeviceIndex,
  type IndexItem,
} from './remote-layout.js';
import { silentProgress, type Progress } from '../progress.js';
import { rawFilePath } from './layout.js';
import type { RemoteStore } from '../remote/store.js';

export interface PushOptions {
  remote: RemoteStore;
  deviceId: string;
  vaultRoot: string;
  state: State;
  now?: () => number;
  chunkSize?: number;
  concurrency?: number;
  progress?: Progress;
  signal?: AbortSignal;
}

export interface PushResult {
  uploadedChunks: number;
  uploadedBytes: number;
  uploadedItems: number;
  skippedItems: number;
}

/** 索引检查点间隔(ms):长同步被打断最多损失一分钟的续传记录。 */
const INDEX_CHECKPOINT_MS = 60_000;

/**
 * 把本地 vault 中本设备的归档增量推到远端(块级)。
 *
 * 远端只有"块 + 单份索引":块先传,索引最后写(提交点)。
 * 重复运行只补缺失的块;世代变化时旧世代块保留(永不删除)。
 */
export async function pushLocal(opts: PushOptions): Promise<PushResult> {
  const { remote, deviceId, vaultRoot, state } = opts;
  const now = opts.now ?? Date.now;
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  // 实测服务端并发 PUT 会 ECONNRESET;单连接吞吐已足够,顺序更稳
  const concurrency = opts.concurrency ?? 1;
  const progress = opts.progress ?? silentProgress;

  const previous = (await remote.readJson(indexPath(deviceId))) as DeviceIndex | null;
  const index: DeviceIndex = {
    v: 1,
    deviceId,
    updatedAt: previous?.updatedAt ?? 0,
    items: { ...(previous?.items ?? {}) },
  };

  const tasks: Array<{
    harness: string;
    relPath: string;
    absPath: string;
    entry: NonNullable<State['sources'][string][string]>;
  }> = [];
  for (const [harness, bucket] of Object.entries(state.sources)) {
    for (const [relPath, entry] of Object.entries(bucket)) {
      if (!validateRelPath(relPath)) throw new Error(`非法路径(源状态): ${relPath}`);
      const absPath = rawFilePath(vaultRoot, deviceId, harness, relPath);
      try {
        if (!(await stat(absPath)).isFile()) continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      tasks.push({ harness, relPath, absPath, entry });
    }
  }

  progress.phase('push', `${tasks.length} 个文件`);
  let uploadedChunks = 0;
  let uploadedBytes = 0;
  let uploadedItems = 0;
  let skippedItems = 0;
  let indexChanged = false;
  let lastCheckpoint = Date.now();

  const commitIndex = async () => {
    index.updatedAt = now();
    await remote.writeJson(indexPath(deviceId), index);
    indexChanged = false;
    lastCheckpoint = Date.now();
  };

  for (let i = 0; i < tasks.length; i++) {
    throwIfAborted(opts.signal);
    const { harness, relPath, absPath, entry } = tasks[i]!;
    const key = encodeKey(relPath);
    const ik = itemKey(harness, key);
    const st = await stat(absPath);
    const pushed = state.pushed[harness]?.[relPath];
    const inIndex = index.items[ik];

    // 索引是远端权威:世代 + 大小一致即内容一致(append-only,改写会换世代)。
    // 即使本地 state 丢失,也能零重传地续上。
    if (inIndex && inIndex.generation === entry.generation && inIndex.size === st.size) {
      (state.pushed[harness] ??= {})[relPath] ??= {
        generation: inIndex.generation,
        size: inIndex.size,
        chunks: inIndex.chunks,
        chunksHash: inIndex.chunksHash,
      };
      skippedItems++;
      progress.item(relPath, i + 1, tasks.length, 0);
      continue;
    }

    const ranges = chunkRanges(st.size, chunkSize);
    const reuse =
      pushed && pushed.generation === entry.generation
        ? reusableChunks(pushed.chunks, pushed.size, chunkSize)
        : new Map<number, ChunkRef>();

    const chunks: ChunkRef[] = [];
    const toUpload: Array<{ chunk: ChunkRef; remotePath: string }> = [];
    for (const range of ranges) {
      const old = reuse.get(range.offset);
      if (old) {
        chunks.push(old);
        continue;
      }
      const chunk: ChunkRef = {
        ...range,
        sha256: await hashRange(absPath, range.offset, range.length),
      };
      chunks.push(chunk);
      toUpload.push({
        chunk,
        remotePath: chunkRemotePath(deviceId, harness, key, entry.generation, chunk),
      });
    }

    await mapLimit(toUpload, concurrency, async ({ chunk, remotePath }) => {
      await remote.writeFile(remotePath, absPath, {
        offset: chunk.offset,
        length: chunk.length,
      });
      uploadedChunks++;
      uploadedBytes += chunk.length;
    });

    const hash = chunksHash(chunks);
    (state.pushed[harness] ??= {})[relPath] = {
      generation: entry.generation,
      size: st.size,
      chunks,
      chunksHash: hash,
    };

    index.items[ik] = {
      harness,
      key,
      relPath,
      sessionKey: entry.sessionKey,
      generation: entry.generation,
      size: st.size,
      chunks,
      chunksHash: hash,
      updatedAt: now(),
    } satisfies IndexItem;
    indexChanged = true;
    uploadedItems++;
    progress.item(relPath, i + 1, tasks.length, st.size);

    if (Date.now() - lastCheckpoint >= INDEX_CHECKPOINT_MS) await commitIndex();
  }

  if (indexChanged) await commitIndex();
  return { uploadedChunks, uploadedBytes, uploadedItems, skippedItems };
}
