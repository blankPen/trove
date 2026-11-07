import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CHUNK_SIZE, chunkRanges, hashFile, hashRange, reusableChunks, type ChunkRef } from './chunker.js';
import { mapLimit } from './concurrency.js';
import { throwIfAborted } from './collect.js';
import type { State } from './state.js';
import {
  chunkRemotePath,
  chunksHash,
  deviceRemoteRoot,
  encodeKey,
  indexPath,
  indexStampPath,
  itemKey,
  objectRemotePath,
  validateRelPath,
  type ContentStamp,
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

interface IndexCache {
  stamp: ContentStamp;
  index: DeviceIndex;
}

/** 本机索引缓存:只有本设备写自己的 index.json,戳一致时不必再 GET 整份索引。 */
function indexCachePath(vaultRoot: string, deviceId: string): string {
  return join(vaultRoot, '.cache', 'index', `${deviceId}.json`);
}

async function readIndexCache(path: string, deviceId: string): Promise<IndexCache | null> {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8')) as IndexCache;
    if (cache.stamp?.v !== 1 || !cache.index || cache.index.deviceId !== deviceId) return null;
    if (!cache.index.items || typeof cache.index.items !== 'object') return null;
    // 缓存文件损坏/被手改时不能拿来当远端索引用
    if (stampOf(cache.index).hash !== cache.stamp.hash) return null;
    return cache;
  } catch {
    return null;
  }
}

async function writeIndexCache(path: string, cache: IndexCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(cache), 'utf8');
  await rename(tmp, path);
}

/** 与远端写入保持同一序列化,保证戳里的 hash 就是 index.json 的 hash。 */
function stampOf(index: DeviceIndex): ContentStamp {
  const body = JSON.stringify(index);
  return {
    v: 1,
    hash: createHash('sha256').update(body).digest('hex'),
    size: Buffer.byteLength(body),
    updatedAt: index.updatedAt,
  };
}

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

  const cachePath = indexCachePath(vaultRoot, deviceId);
  const dirEntries = await remote.list(deviceRemoteRoot(deviceId));
  const indexEntry = dirEntries.find((e) => e.name === 'index.json');
  const stamp = (await remote.readJson(indexStampPath(deviceId))) as ContentStamp | null;
  const cache = await readIndexCache(cachePath, deviceId);
  // shortcut: 中断可能留下"索引已写、戳未写";size 不同会回退全量读,同尺寸改写要等下次变更才发现。
  const useCache =
    stamp !== null && cache !== null && stamp.hash === cache.stamp.hash && indexEntry?.size === stamp.size;
  const previous = useCache && cache
    ? cache.index
    : ((await remote.readJson(indexPath(deviceId))) as DeviceIndex | null);
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
    const stamp = stampOf(index);
    await remote.writeJson(indexPath(deviceId), index);
    // 顺序:索引 → 本地缓存 → 戳。中断最多让下一轮回退到全量读,不会用旧缓存冒充新索引
    await writeIndexCache(cachePath, { stamp, index });
    await remote.writeJson(indexStampPath(deviceId), stamp);
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
  // 首次升级或上次中断:索引没变也补一个戳,否则对端会一直整份读索引
  if (!indexChanged && indexEntry) {
    const current = stampOf(index);
    if (!stamp || stamp.hash !== current.hash || stamp.size !== indexEntry.size) {
      await remote.writeJson(indexStampPath(deviceId), { ...current, size: indexEntry.size });
    }
  }
  // 记住这次推送属于哪个远端:下次换后端时,本地的复用记录会自动作废
  if (opts.remoteId) state.remoteId = opts.remoteId;
  return { uploadedChunks, uploadedBytes, uploadedItems, skippedItems };
}
