import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashFile } from '../chunker.js';
import { throwIfAborted } from '../collect.js';
import { validateRelPath } from '../remote-layout.js';
import { libraryDir, safeSessionName } from '../layout.js';
import {
  LESSONS_STAMP_PATH,
  libraryStampPath,
  type ContentStamp,
  type TokenStamp,
} from '../remote-layout.js';
import { silentProgress, type Progress } from '../../progress.js';
import type { RemoteStore } from '../../remote/store.js';
import type { State } from '../state.js';
import { rebuildUnifiedIndex } from './index-file.js';
import { saveState } from '../state.js';
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

/** 远端分片里的路径是不可信输入:绝对路径/穿越/反斜杠/NUL 一律拒绝。 */
function safeLibraryPath(root: string, rel: string): string | null {
  return validateRelPath(rel) ? join(root, ...rel.split('/')) : null;
}

/** 内容相同就不写:避免技能 meta 每轮重写、重传。 */
async function writeIfChanged(path: string, data: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === data) return;
  } catch {
    // 不存在或读不了:照常写
  }
  await writeAtomic(path, data);
}

async function readLocalShard(path: string): Promise<IndexShard | null> {
  try {
    const shard = JSON.parse(await readFile(path, 'utf8')) as IndexShard;
    return shard && shard.v === 1 && shard.sessions && typeof shard.sessions === 'object'
      ? shard
      : null;
  } catch {
    return null;
  }
}

/**
 * 本地分片引用的文件是否齐全:只有齐全时才能跳过远端分片,
 * 否则手工删掉的会话/技能文件就再也恢复不回来。
 */
async function shardFilesMissing(root: string, shard: IndexShard): Promise<boolean> {
  for (const entry of Object.values(shard.sessions ?? {})) {
    if (!entry?.path || !existsSync(join(root, ...entry.path.split('/')))) return true;
  }
  for (const name of Object.keys(shard.skills ?? {})) {
    const safe = safeSessionName(name);
    const metaDir = join(root, 'skills', safe, 'meta');
    let metas: string[];
    try {
      metas = (await readdir(metaDir)).filter((f) => f.endsWith('.json'));
    } catch {
      return true;
    }
    if (metas.length === 0) return true;
    for (const file of metas) {
      let meta: { versions?: Array<{ hash?: string; files?: Array<{ rel?: string }> }> };
      try {
        meta = JSON.parse(await readFile(join(metaDir, file), 'utf8')) as typeof meta;
      } catch {
        return true;
      }
      for (const v of meta.versions ?? []) {
        if (!v.hash) return true;
        for (const f of v.files ?? []) {
          if (!f.rel) continue;
          const target = join(root, 'skills', safe, 'versions', v.hash, ...f.rel.split('/'));
          if (!existsSync(target)) return true;
        }
      }
    }
  }
  return false;
}

/** 递归列远端目录;对象存储一次前缀列举,WebDAV 回退为逐层 list。 */
async function listRemoteFiles(remote: RemoteStore, dir: string): Promise<string[]> {
  if (remote.listAll) {
    try {
      return (await remote.listAll(dir)).map((e) => e.name);
    } catch {
      // 部分 WebDAV 禁用 Depth: infinity,退回逐层 list
    }
  }
  return walkRemote(remote, dir);
}

export interface PushLibraryOptions {
  remote: RemoteStore;
  vaultRoot: string;
  deviceId: string;
  state: State;
  /** 当前远端身份;变了说明推送水位属于旧后端,必须整份重推。 */
  remoteId?: string;
  /** 用于周期性落盘进度:中断后已完成文件不会被重推 */
  statePath: string;
  progress?: Progress;
  signal?: AbortSignal;
}

/** 检查点间隔(ms):中断最多损失一分钟的已推记录。 */
const CHECKPOINT_MS = 60_000;

export interface PushLibraryResult {
  uploaded: number;
  bytes: number;
  skipped: number;
}

/**
 * 推送 library 里本设备负责的文件:
 *   sessions/**、skills/**、lessons/**、index/<device>.json
 * 每台设备只写自己的分片;会话文件按大小+mtime 判断是否变化。
 * lessons 是共享沉淀,没有设备分片,多设备会互相覆盖(最后写赢)。
 */
/** library 里需要推送的本设备文件(相对 library 根);status 的待同步计数复用同一口径。 */
export async function listLibraryFiles(
  vaultRoot: string,
  deviceId: string,
): Promise<string[]> {
  const root = libraryDir(vaultRoot);
  const rank = (rel: string) => (rel.startsWith('index/') ? 1 : 0);
  const ownSession = (rel: string) => rel.split('/').pop() === `${deviceId}.jsonl`;
  return [
    ...(await walk(root, 'sessions')).filter(ownSession),
    ...(await walk(root, 'skills')),
    ...(await walk(root, 'lessons')),
    // 每台设备只写自己的分片;别的设备的分片由它们自己推,这里不能覆盖
    ...(await walk(root, 'index')).filter((rel) => rel === `index/${deviceId}.json`),
    // index 分片是引用其他文件的提交点:必须最后传,否则中断会留下指向不存在文件的悬空引用
  ].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export async function pushLibrary(opts: PushLibraryOptions): Promise<PushLibraryResult> {
  const { remote, vaultRoot, state } = opts;
  const progress = opts.progress ?? silentProgress;
  const root = libraryDir(vaultRoot);
  const files = await listLibraryFiles(vaultRoot, opts.deviceId);

  let uploaded = 0;
  let bytes = 0;
  let skipped = 0;
  let pushedLessons = false;
  let n = 0;
  let lastCheckpoint = Date.now();

  // 换后端时旧后端的推送记账对新远端无效:就地清空并立刻落盘。
  // 这样即使进程中途被杀,下次也只会补传未完成的文件,而不是把整份 library 重推。
  if (opts.remoteId && state.library.remoteId !== opts.remoteId) {
    state.library.pushed = {};
    state.library.remoteId = opts.remoteId;
    await saveState(opts.statePath, state);
  }
  const sameRemote = !opts.remoteId || state.library.remoteId === opts.remoteId;

  // 中断(abort/报错)时保住已完成文件的记账:重启后按 state 跳过,不整轮重推
  const checkpoint = async () => {
    await saveState(opts.statePath, state);
    lastCheckpoint = Date.now();
  };

  try {
    for (const rel of files) {
      throwIfAborted(opts.signal);
      n++;
      const abs = join(root, ...rel.split('/'));
      const st = await stat(abs);
      const prev = state.library.pushed[rel];
      if (sameRemote && prev && prev.size === st.size && prev.mtimeMs === Math.round(st.mtimeMs)) {
        skipped++;
        continue;
      }
      await remote.writeFile(`library/${rel}`, abs);
      state.library.pushed[rel] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
      uploaded++;
      bytes += st.size;
      if (rel.startsWith('lessons/')) {
        pushedLessons = true;
        // 先落盘「待补戳」,避免上传成功但戳没写成时对端永久漏拉
        state.library.lessonsDirty = true;
      }
      progress.item(rel, n, files.length, st.size);
      if (Date.now() - lastCheckpoint >= CHECKPOINT_MS) await checkpoint();
    }
  } finally {
    if (uploaded > 0) await checkpoint();
  }

  // 自己的分片戳:对端只读百字节就能判断整份分片有没有变
  const ownShard = join(root, 'index', `${opts.deviceId}.json`);
  try {
    const st = await stat(ownShard);
    const hash = await hashFile(ownShard);
    const stamp = (await remote.readJson(libraryStampPath(opts.deviceId))) as ContentStamp | null;
    if (!stamp || stamp.hash !== hash || stamp.size !== st.size) {
      await remote.writeJson(libraryStampPath(opts.deviceId), {
        v: 1,
        hash,
        size: st.size,
        updatedAt: Date.now(),
      } satisfies ContentStamp);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // lessons 变了才换 token;远端还没有戳或上次没写成功时补一个,
  // 让后续同步不必每轮递归列举
  const lessonsStamp = (await remote.readJson(LESSONS_STAMP_PATH)) as TokenStamp | null;
  if (pushedLessons || !lessonsStamp || state.library.lessonsDirty) {
    const token = randomUUID();
    await remote.writeJson(LESSONS_STAMP_PATH, {
      v: 1,
      token,
      updatedAt: Date.now(),
    } satisfies TokenStamp);
    state.library.lessonsToken = token;
    state.library.lessonsDirty = false;
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

/** 远端 404:索引引用的文件不存在(分片悬空),可跳过而不是中断整轮同步。 */
function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  return (e?.status ?? e?.statusCode ?? e?.response?.status) === 404;
}

/** 递归列远端目录下的文件(RemoteStore.list 只列一层)。 */
async function walkRemote(remote: RemoteStore, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await remote.list(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.type === 'directory') out.push(...(await walkRemote(remote, p)));
    else out.push(p);
  }
  return out;
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

  const shards = (await remote.list('library/index')).filter(
    (e) => e.type === 'file' && e.name.endsWith('.json'),
  );
  progress.phase('library', `${shards.length} 个设备分片`);

  // 分片是索引来源,必须最后落盘:先拉内容文件再写分片,中断时索引不会引用未下载的文件
  const pendingShards: Array<{ abs: string; shard: IndexShard }> = [];
  let itemNo = 0;
  for (const shardEntry of shards) {
    throwIfAborted(opts.signal);
    const shardPath = `library/index/${shardEntry.name}`;
    const shardAbs = join(root, 'index', shardEntry.name);
    const shardDevice = shardEntry.name.replace(/\.json$/, '');
    const localShard = await readLocalShard(shardAbs);
    const localComplete = localShard ? !(await shardFilesMissing(root, localShard)) : false;

    // 本机分片是权威,文件齐全时连远端同名分片都不用读
    if (localComplete && shardDevice === opts.deviceId) continue;

    // 别的设备:戳没变且本地文件齐全 → 整份分片不读
    let shardStamp: ContentStamp | null = null;
    if (shardDevice !== opts.deviceId) {
      shardStamp = (await remote.readJson(libraryStampPath(shardDevice))) as ContentStamp | null;
      if (
        localComplete &&
        shardStamp &&
        state.library.shardStamps?.[shardDevice] === shardStamp.hash &&
        shardEntry.size === shardStamp.size
      ) {
        continue;
      }
    }

    const raw = await remote.readJson(shardPath);
    if (!raw || typeof raw !== 'object') continue;
    const shard = raw as IndexShard;
    if (shard.v !== 1 || !shard.sessions) continue;
    const device = shard.device;
    const isSelf = device === opts.deviceId;
    // 分片本身也要落地,统一索引才能离线重建;本机分片是权威,只在缺失时恢复
    const writeShard = !isSelf || (await localHash(shardAbs)) === null;
    const pulled = (state.library.pulled[device] ??= {});

    for (const entry of Object.values(shard.sessions)) {
      throwIfAborted(opts.signal);
      itemNo++;
      const remotePath = `library/${entry.path}`;
      const abs = safeLibraryPath(root, entry.path);
      if (!abs) {
        console.warn(`[trove] 分片里的路径非法,已跳过: ${entry.path}`);
        continue;
      }
      // 本机文件是权威:存在就不拿远端(可能是旧分片)覆盖,只在缺失时恢复
      if (isSelf && (await localHash(abs)) !== null) {
        skipped++;
        continue;
      }
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
        if (got !== entry.hash) {
          await unlink(tmp).catch(() => {});
          // 分片可能陈旧或与远端对象不同步:跳过坏文件,不能中断整轮同步
          console.warn(`[trove] 远端文件与分片 hash 不一致,已跳过: ${entry.path}`);
          continue;
        }
        await rename(tmp, abs);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        // 分片可能来自已离线设备或旧数据,引用了不存在的对象:跳过,不影响其他文件
        if (isNotFound(err)) {
          console.warn(`[trove] 远端缺少索引引用的文件,已跳过: ${entry.path}`);
          continue;
        }
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
        const localMeta = safeLibraryPath(root, `skills/${safe}/meta/${metaEntry.name}`);
        if (!localMeta) {
          console.warn(`[trove] 技能 meta 路径非法,已跳过: ${metaEntry.name}`);
          continue;
        }
        const metaRaw = await remote.readJson(remoteMeta);
        if (!metaRaw || typeof metaRaw !== 'object') continue;
        await writeIfChanged(localMeta, JSON.stringify(metaRaw, null, 2) + '\n');
        const versions = (metaRaw as { versions?: Array<{ hash: string; files?: Array<{ rel: string }> }> })
          .versions ?? [];
        for (const v of versions) {
          for (const f of v.files ?? []) {
            const rel = `skills/${safe}/versions/${v.hash}/${f.rel}`;
            const target = safeLibraryPath(root, rel);
            if (!target) {
              console.warn(`[trove] 技能版本路径非法,已跳过: ${rel}`);
              continue;
            }
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
              if (isNotFound(err)) {
                console.warn(`[trove] 远端缺少技能文件,已跳过: ${rel}`);
                continue;
              }
              throw err;
            }
            downloaded++;
            bytes += (await stat(target)).size;
          }
        }
      }
    }
    if (writeShard) pendingShards.push({ abs: shardAbs, shard });
    if (shardStamp) (state.library.shardStamps ??= {})[device] = shardStamp.hash;
  }

  // lessons:共享沉淀,没有设备分片。本地已有就不覆盖(本机内容可能是刚 learn 的新版本),
  // 只在缺失时从远端恢复 —— 新设备能拿到经验库,又不会丢掉本机刚生成的内容。
const lessonsStamp = (await remote.readJson(LESSONS_STAMP_PATH)) as TokenStamp | null;
  if (!(lessonsStamp?.token && state.library.lessonsToken === lessonsStamp.token)) {
    const remoteLessons = await listRemoteFiles(remote, 'library/lessons');
    for (const remotePath of remoteLessons) {
      throwIfAborted(opts.signal);
      const rel = remotePath.slice('library/'.length);
      const target = safeLibraryPath(root, rel);
      if (!target) {
        console.warn(`[trove] 远端 lesson 路径非法,已跳过: ${rel}`);
        continue;
      }
      if (await localHash(target)) {
        skipped++;
        continue;
      }
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
      try {
        await mkdir(dirname(target), { recursive: true });
        await remote.readFile(remotePath, tmp);
        await rename(tmp, target);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
      downloaded++;
      bytes += (await stat(target)).size;
      progress.item(rel, itemNo, remoteLessons.length, bytes);
    }
    if (lessonsStamp?.token) state.library.lessonsToken = lessonsStamp.token;
  }

  // 内容文件全部落地后再写分片;剔除本地仍缺失的条目,统一索引不会指向不存在的文件
  for (const { abs, shard } of pendingShards) {
    const sessions = Object.fromEntries(
      Object.entries(shard.sessions).filter(([, e]) => {
        const abs = safeLibraryPath(root, e.path);
        return abs !== null && existsSync(abs);
      }),
    );
    await writeAtomic(abs, JSON.stringify({ ...shard, sessions }, null, 2) + '\n');
  }

  await rebuildUnifiedIndex(vaultRoot);
  return { downloaded, bytes, skipped };
}
