import { stat } from 'node:fs/promises';
import { CHUNK_SIZE, chunkRanges, hashFile, hashRange, reusableChunks, type ChunkRef } from './chunker.js';
import { mapLimit } from './concurrency.js';
import { throwIfAborted } from './collect.js';
import type { State } from './state.js';
import {
  chunkRemotePath,
  chunksHash,
  encodeKey,
  indexPath,
  itemKey,
  objectRemotePath,
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
  /** 当前远端的身份指纹;用于判断本地推送记录是否还作数(换后端时作废)。 */
  remoteId?: string;
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
  // 并发数由后端给建议:WebDAV 实测并发 PUT 会 ECONNRESET(给 1),
  // 对象存储允许并发(给更高值),这里显式传参时以传参为准。
  const concurrency = opts.concurrency ?? remote.concurrencyHint?.() ?? 1;
  // 对象存储一个文件一个对象(可读);WebDAV 保持应用层分块(服务端无 multipart)
  const layout = remote.layoutHint?.() ?? 'chunk';
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

    // 索引是远端权威:世代 + 大小 + 布局一致即内容一致(append-only,改写会换世代)。
    // 即使本地 state 丢失,也能零重传地续上。布局变化(如 S3 改单对象)会触发重推。
    if (
      inIndex &&
      inIndex.generation === entry.generation &&
      inIndex.size === st.size &&
      (inIndex.layout ?? 'chunk') === layout
    ) {
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

    const chunks: ChunkRef[] = [];
    if (layout === 'object') {
      // 整文件一个对象;分片交给 S3 Multipart,块清单退化为单块
      if (st.size > 0) {
        chunks.push({ offset: 0, length: st.size, sha256: await hashFile(absPath) });
      }
      await remote.writeFile(objectRemotePath(deviceId, harness, relPath), absPath);
      uploadedChunks += chunks.length;
      uploadedBytes += st.size;
    } else {
      const ranges = chunkRanges(st.size, chunkSize);
      // 可复用块的来源:
      // - 远端索引:远端自己说有这些块(最权威),且布局必须是 chunk
      // - 本地 state.pushed:只在"同一个远端"时可信(索引丢了但块还在,只补半块)
      // 换后端后本地记录属于旧远端,不能复用 —— 否则新远端只剩索引没有数据。
      const sameRemote = !opts.remoteId || !state.remoteId || opts.remoteId === state.remoteId;
      const reuse =
        inIndex &&
        inIndex.generation === entry.generation &&
        (inIndex.layout ?? 'chunk') === 'chunk'
          ? reusableChunks(inIndex.chunks, inIndex.size, chunkSize)
          : pushed && sameRemote && pushed.generation === entry.generation
            ? reusableChunks(pushed.chunks, pushed.size, chunkSize)
            : new Map<number, ChunkRef>();

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
    }

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
      layout,
      updatedAt: now(),
    } satisfies IndexItem;
    indexChanged = true;
    uploadedItems++;
    progress.item(relPath, i + 1, tasks.length, st.size);

    if (Date.now() - lastCheckpoint >= INDEX_CHECKPOINT_MS) await commitIndex();
  }

  if (indexChanged) await commitIndex();
  // 记住这次推送属于哪个远端:下次换后端时,本地的复用记录会自动作废
  if (opts.remoteId) state.remoteId = opts.remoteId;
  return { uploadedChunks, uploadedBytes, uploadedItems, skippedItems };
}
