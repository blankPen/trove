import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashFile } from '../chunker.js';
import { throwIfAborted } from '../collect.js';
import { libraryDir, safeSessionName } from '../layout.js';
import { silentProgress, type Progress } from '../../progress.js';
import type { RemoteStore } from '../../remote/store.js';
import type { State } from '../state.js';
import { rebuildUnifiedIndex } from './index-file.js';
import type { IndexShard } from './schema.js';

async function walk(root: string, rel = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, p)));
    else if (e.isFile() && !e.name.includes('.tmp-')) out.push(p);
  }
  return out;
}

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

export interface PushLibraryOptions {
  remote: RemoteStore;
  vaultRoot: string;
  deviceId: string;
  state: State;
  progress?: Progress;
  signal?: AbortSignal;
}

export interface PushLibraryResult {
  uploaded: number;
  bytes: number;
  skipped: number;
}

/**
 * 推送 library 里本设备负责的文件:
 *   sessions/**、skills/**、index/<device>.json
 * 每台设备只写自己的分片;会话文件按大小+mtime 判断是否变化。
 */
/** library 里需要推送的文件(相对 library 根);status 的待同步计数复用同一口径。 */
export async function listLibraryFiles(vaultRoot: string): Promise<string[]> {
  const root = libraryDir(vaultRoot);
  return [
    ...(await walk(root, 'sessions')),
    ...(await walk(root, 'skills')),
    ...(await walk(root, 'index')).filter((rel) => rel.endsWith('.json')),
  ].sort();
}

export async function pushLibrary(opts: PushLibraryOptions): Promise<PushLibraryResult> {
  const { remote, vaultRoot, state } = opts;
  const progress = opts.progress ?? silentProgress;
  const root = libraryDir(vaultRoot);
  const files = await listLibraryFiles(vaultRoot);

  let uploaded = 0;
  let bytes = 0;
  let skipped = 0;
  let n = 0;

  for (const rel of files) {
    throwIfAborted(opts.signal);
    n++;
    const abs = join(root, ...rel.split('/'));
    const st = await stat(abs);
    const prev = state.library.pushed[rel];
    if (prev && prev.size === st.size && prev.mtimeMs === Math.round(st.mtimeMs)) {
      skipped++;
      continue;
    }
    await remote.writeFile(`library/${rel}`, abs);
    state.library.pushed[rel] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    uploaded++;
    bytes += st.size;
    progress.item(rel, n, files.length, st.size);
  }

  return { uploaded, bytes, skipped };
}

export interface PullLibraryOptions {
  remote: RemoteStore;
  vaultRoot: string;
  deviceId: string;
  state: State;
  progress?: Progress;
  signal?: AbortSignal;
}

export interface PullLibraryResult {
  downloaded: number;
  bytes: number;
  skipped: number;
}

async function localHash(path: string): Promise<string | null> {
  try {
    return await hashFile(path);
  } catch {
    return null;
  }
}

/**
 * 拉取所有设备的 library 分片与文件:
 *   index/*.json → 会话文件、技能版本
 * 已存在且 hash 一致的文件不重复下载;下载后校验 sha256。
 */
export async function pullLibrary(opts: PullLibraryOptions): Promise<PullLibraryResult> {
  const { remote, vaultRoot, state } = opts;
  const progress = opts.progress ?? silentProgress;
  const root = libraryDir(vaultRoot);

  let downloaded = 0;
  let bytes = 0;
  let skipped = 0;

  const shards = (await remote.list('library/index')).filter((e) => e.type === 'file');
  progress.phase('library', `${shards.length} 个设备分片`);

  let itemNo = 0;
  for (const shardEntry of shards) {
    throwIfAborted(opts.signal);
    const shardPath = `library/index/${shardEntry.name}`;
    const raw = await remote.readJson(shardPath);
    if (!raw || typeof raw !== 'object') continue;
    const shard = raw as IndexShard;
    if (shard.v !== 1 || !shard.sessions) continue;
    // 分片本身也要落地,统一索引才能离线重建
    await writeAtomic(
      join(root, 'index', shardEntry.name),
      JSON.stringify(shard, null, 2) + '\n',
    );
    const device = shard.device;
    const pulled = (state.library.pulled[device] ??= {});

    for (const entry of Object.values(shard.sessions)) {
      throwIfAborted(opts.signal);
      itemNo++;
      const remotePath = `library/${entry.path}`;
      const abs = join(root, ...entry.path.split('/'));
      if (pulled[entry.path] === entry.hash) {
        skipped++;
        continue;
      }
      if ((await localHash(abs)) === entry.hash) {
        pulled[entry.path] = entry.hash;
        skipped++;
        continue;
      }

      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      try {
        await mkdir(dirname(abs), { recursive: true });
        await remote.readFile(remotePath, tmp);
        const got = await hashFile(tmp);
        if (got !== entry.hash) throw new Error(`library 文件校验失败: ${entry.path}`);
        await rename(tmp, abs);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      pulled[entry.path] = entry.hash;
      downloaded++;
      bytes += (await stat(abs)).size;
      progress.item(entry.path, itemNo, shards.length * 100, bytes);
    }

    // 技能:meta 与版本文件
    for (const name of Object.keys(shard.skills ?? {})) {
      const safe = safeSessionName(name);
      const metaFiles = (await remote.list(`library/skills/${safe}/meta`)).filter(
        (e) => e.type === 'file' && e.name.endsWith('.json'),
      );
      for (const metaEntry of metaFiles) {
        const remoteMeta = `library/skills/${safe}/meta/${metaEntry.name}`;
        const localMeta = join(root, 'skills', safe, 'meta', metaEntry.name);
        const metaRaw = await remote.readJson(remoteMeta);
        if (!metaRaw || typeof metaRaw !== 'object') continue;
        await writeAtomic(localMeta, JSON.stringify(metaRaw, null, 2) + '\n');
        const versions = (metaRaw as { versions?: Array<{ hash: string; files?: Array<{ rel: string }> }> })
          .versions ?? [];
        for (const v of versions) {
          for (const f of v.files ?? []) {
            const rel = `skills/${safe}/versions/${v.hash}/${f.rel}`;
            const target = join(root, ...rel.split('/'));
            if (await localHash(target)) {
              skipped++;
              continue;
            }
            const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
            try {
              await mkdir(dirname(target), { recursive: true });
              await remote.readFile(`library/${rel}`, tmp);
              await rename(tmp, target);
            } catch (err) {
              await unlink(tmp).catch(() => {});
              throw err;
            }
            downloaded++;
            bytes += (await stat(target)).size;
          }
        }
      }
    }
  }

  await rebuildUnifiedIndex(vaultRoot);
  return { downloaded, bytes, skipped };
}
