import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hashFile } from './chunker.js';
import { throwIfAborted } from './collect.js';
import {
  chunkRemotePath,
  indexPath,
  itemKey,
  validateIndexItem,
  type DeviceIndex,
  type IndexItem,
} from './remote-layout.js';
import { silentProgress, type Progress } from '../progress.js';
import { EVENTS_PREFIX } from './events/schema.js';
import { rawFilePath } from './layout.js';
import type { State } from './state.js';
import type { RemoteStore } from '../remote/store.js';

export interface PullOptions {
  remote: RemoteStore;
  deviceId: string;
  vaultRoot: string;
  state: State;
  progress?: Progress;
  signal?: AbortSignal;
}

export interface PullResult {
  downloadedChunks: number;
  downloadedBytes: number;
  downloadedItems: number;
  skippedItems: number;
}

const SAFE_DEVICE = /^[A-Za-z0-9._-]+$/;
const SAFE_HARNESS = /^[a-z0-9-]+$/;

/**
 * 拉取其他设备的增量,重建到本地 vault(只增不删)。
 * 索引里已包含块清单,无需逐会话取清单;单条记录先写临时文件,
 * 全部块校验通过后才 rename,断电不会留下半个会话。
 */
export async function pullRemote(opts: PullOptions): Promise<PullResult> {
  const { remote, deviceId, vaultRoot, state } = opts;
  const progress = opts.progress ?? silentProgress;

  const devices = (await remote.listDevices()).filter(
    (d) => SAFE_DEVICE.test(d) && d !== '.' && d !== '..',
  );
  progress.phase('pull', `${devices.length} 台设备`);

  let downloadedChunks = 0;
  let downloadedBytes = 0;
  let downloadedItems = 0;
  let skippedItems = 0;
  let itemNo = 0;

  for (const dev of devices) {
    const rawIndex = await remote.readJson(indexPath(dev));
    if (!rawIndex || typeof rawIndex !== 'object') continue;
    const index = rawIndex as DeviceIndex;
    if (!index.items || typeof index.items !== 'object') continue;
    const pulled = (state.pulled[dev] ??= {});
    const entries = Object.values(index.items);

    for (const item of entries) {
      throwIfAborted(opts.signal);
      itemNo++;
      if (!SAFE_HARNESS.test(item.harness)) {
        throw new Error(`远端 harness 名非法: ${item.harness}`);
      }
      validateIndexItem(item);
      // 旧版派生数据(对话层)不再放进 raw;trove 端已迁移到 library
      if (item.relPath.startsWith(EVENTS_PREFIX)) {
        skippedItems++;
        continue;
      }
      const stateKey = itemKey(item.harness, item.key);

      if (pulled[stateKey]?.chunksHash === item.chunksHash) {
        skippedItems++;
        progress.item(`${dev}/${item.relPath}`, itemNo, entries.length, 0);
        continue;
      }

      // 本机设备且本地推送记录与索引一致:直接记账,省掉逐文件 stat
      if (dev === deviceId) {
        const pushed = state.pushed[item.harness]?.[item.relPath];
        if (pushed && pushed.generation === item.generation && pushed.size === item.size) {
          pulled[stateKey] = {
            generation: item.generation,
            size: item.size,
            chunksHash: item.chunksHash,
          };
          skippedItems++;
          progress.item(`${dev}/${item.relPath}`, itemNo, entries.length, 0);
          continue;
        }
      }

      const target = rawFilePath(vaultRoot, dev, item.harness, item.relPath);
      let localSize = -1;
      try {
        localSize = (await stat(target)).size;
      } catch {
        localSize = -1;
      }

      // 本机设备:只要本地文件存在就视为权威,绝不回拉覆盖自己。
      // (世代不一致 + 本地更小时,远端可能是更旧的快照;覆盖会永久丢失本地新内容。)
      if (dev === deviceId && localSize >= 0) {
        pulled[stateKey] = {
          generation: item.generation,
          size: item.size,
          chunksHash: item.chunksHash,
        };
        skippedItems++;
        continue;
      }

      const sameGeneration = pulled[stateKey]?.generation === item.generation;
      // 续传起点必须是清单里的真实块边界(清单可能来自不同块大小的旧版本)
      let start = 0;
      if (sameGeneration && localSize >= 0 && localSize <= item.size) {
        const incomplete = item.chunks.find((c) => c.offset + c.length > localSize);
        start = incomplete ? incomplete.offset : item.size;
      }

      const tmp = `${target}.tmp-${randomUUID()}`;
      try {
        await mkdir(dirname(target), { recursive: true });
        if (start > 0) {
          await pipeline(
            createReadStream(target, { start: 0, end: start - 1 }),
            createWriteStream(tmp),
          );
        } else {
          await writeFile(tmp, '');
        }

        for (const chunk of item.chunks) {
          if (chunk.offset < start) continue;
          const tmpChunk = `${tmp}.chunk-${chunk.offset}`;
          try {
            await remote.readFile(
              chunkRemotePath(dev, item.harness, item.key, item.generation, chunk),
              tmpChunk,
            );
            const got = await hashFile(tmpChunk);
            if (got !== chunk.sha256) {
              throw new Error(`远端块校验失败: ${item.relPath} @${chunk.offset}`);
            }
            await pipeline(createReadStream(tmpChunk), createWriteStream(tmp, { flags: 'a' }));
            downloadedChunks++;
            downloadedBytes += chunk.length;
          } finally {
            await unlink(tmpChunk).catch(() => {});
          }
        }

        const finalSize = (await stat(tmp)).size;
        if (finalSize !== item.size) {
          throw new Error(`拉取后大小不一致: ${item.relPath} 期望 ${item.size} 实得 ${finalSize}`);
        }
        await rename(tmp, target);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }

      pulled[stateKey] = {
        generation: item.generation,
        size: item.size,
        chunksHash: item.chunksHash,
      };
      downloadedItems++;
      progress.item(`${dev}/${item.relPath}`, itemNo, entries.length, item.size);
    }
  }

  return { downloadedChunks, downloadedBytes, downloadedItems, skippedItems };
}
