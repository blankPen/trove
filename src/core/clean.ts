import { mapLimit } from './concurrency.js';
import {
  chunkRemotePath,
  indexPath,
  objectRemotePath,
  type DeviceIndex,
} from './remote-layout.js';
import type { IndexShard } from './library/schema.js';
import type { RemoteEntry, RemoteStore } from '../remote/store.js';

/** 远端孤儿对象扫描与清理。只删「能证明无人引用」且足够旧的对象。 */

export type OrphanCategory = 'raw-chunk' | 'raw-file' | 'library-session' | 'library-skill';

export interface OrphanObject {
  path: string;
  size: number;
  mtime: number;
  category: OrphanCategory;
}

export interface OrphanScan {
  objects: OrphanObject[];
  bytes: number;
  /** 索引缺失/损坏而整体跳过的设备 */
  skippedDevices: string[];
  /** library 分片不完整,本次跳过 library 清理 */
  librarySkipped: boolean;
  /** meta 读取失败/缺失而整体保留的技能目录 */
  skippedSkills: string[];
}

export interface CleanOptions {
  /** 只删早于 now - minAgeMs 的对象,默认 24 小时 */
  minAgeMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface DeleteResult {
  deleted: number;
  bytes: number;
  failed: number;
}

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_DEVICE = /^[A-Za-z0-9._-]+$/;

/** 递归枚举目录下的文件;优先用后端的批量列举,避免逐目录几千次往返。 */
async function walkEntries(
  remote: RemoteStore,
  dir: string,
): Promise<Array<{ path: string; size: number; mtime?: number }>> {
  if (remote.listAll) {
    return (await remote.listAll(dir)).map((e) => ({
      path: e.name,
      size: e.size,
      mtime: e.mtime,
    }));
  }
  const out: Array<{ path: string; size: number; mtime?: number }> = [];
  for (const e of await remote.list(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.type === 'directory') out.push(...(await walkEntries(remote, p)));
    else out.push({ path: p, size: e.size, mtime: e.mtime });
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function addOrphan(
  out: OrphanObject[],
  entry: { path: string; size: number; mtime?: number },
  category: OrphanCategory,
  cutoff: number,
): void {
  // 时间缺失或不够旧:无法证明是残留,一律不删
  if (entry.mtime === undefined || entry.mtime > cutoff) return;
  out.push({ path: entry.path, size: entry.size, mtime: entry.mtime, category });
}

/** 扫描远端,返回候选孤儿。任何读取异常都会抛出,由调用方中止整轮。 */
export async function scanOrphans(
  remote: RemoteStore,
  opts: CleanOptions = {},
): Promise<OrphanScan> {
  const now = opts.now ?? Date.now;
  const cutoff = now() - (opts.minAgeMs ?? DEFAULT_MIN_AGE_MS);
  const objects: OrphanObject[] = [];
  const skippedDevices: string[] = [];
  let librarySkipped = false;
  const skippedSkills: string[] = [];

  for (const device of (await remote.listDevices()).filter(
    (d) => SAFE_DEVICE.test(d) && d !== '.' && d !== '..',
  )) {
    const raw = await remote.readJson(indexPath(device));
    const index = raw as DeviceIndex | null;
    // 索引读不到/结构不对:无法判断引用关系,整个设备跳过
    if (!index || !isObject(index) || !isObject(index.items)) {
      skippedDevices.push(device);
      continue;
    }

    const keep = new Set<string>();
    for (const item of Object.values(index.items)) {
      if (!isObject(item) || typeof item.harness !== 'string') continue;
      if (item.layout === 'object' && typeof item.relPath === 'string') {
        keep.add(objectRemotePath(device, item.harness, item.relPath));
      } else if (typeof item.key === 'string' && typeof item.generation === 'string') {
        for (const c of Array.isArray(item.chunks) ? item.chunks : []) {
          if (!isObject(c)) continue;
          keep.add(
            chunkRemotePath(device, item.harness, item.key, item.generation, {
              offset: Number(c.offset),
              length: Number(c.length),
            }),
          );
        }
      }
    }

    for (const [prefix, category] of [
      [`raw/${device}/chunks`, 'raw-chunk'],
      [`raw/${device}/files`, 'raw-file'],
    ] as const) {
      for (const entry of await walkEntries(remote, prefix)) {
        if (keep.has(entry.path)) continue;
        addOrphan(objects, entry, category, cutoff);
      }
    }
  }

  // library:任一设备分片读不到/结构不对就整体跳过,避免把在用的文件当孤儿
  const shards = (await remote.list('library/index')).filter(
    (e: RemoteEntry) => e.type === 'file' && e.name.endsWith('.json'),
  );
  if (shards.length === 0) {
    librarySkipped = true;
  } else {
    const parsed: IndexShard[] = [];
    for (const shard of shards) {
      const raw = await remote.readJson(`library/index/${shard.name}`);
      if (!raw || !isObject(raw) || raw.v !== 1 || !isObject(raw.sessions)) {
        librarySkipped = true;
        break;
      }
      parsed.push(raw as unknown as IndexShard);
    }

    if (!librarySkipped) {
      const keep = new Set<string>();
      const keepPrefixes = new Set<string>();
      for (const shard of parsed) {
        for (const entry of Object.values(shard.sessions ?? {})) {
          if (entry?.path) keep.add(`library/${entry.path}`);
        }
      }

      const sessions = await walkEntries(remote, 'library/sessions');
      for (const e of sessions) {
        // 多设备并集文件不在任何分片里,但统一索引引用它:整组保留
        if (e.path.split('/').pop()!.startsWith('merged.')) keep.add(e.path);
      }

      const skills = await walkEntries(remote, 'library/skills');
      const metaBySkill = new Map<string, string[]>();
      const skillDirs = new Set<string>();
      for (const e of skills) {
        const m = /^library\/skills\/([^/]+)\//.exec(e.path);
        if (!m) continue;
        const safe = m[1]!;
        skillDirs.add(safe);
        if (/\/meta\/[^/]+\.json$/.test(e.path)) {
          metaBySkill.set(safe, [...(metaBySkill.get(safe) ?? []), e.path]);
          keep.add(e.path);
        }
      }

      for (const safe of skillDirs) {
        const metas = metaBySkill.get(safe);
        // 没有 meta 或读取失败:无法确认版本引用,整个技能目录保留
        if (!metas || metas.length === 0) {
          keepPrefixes.add(`library/skills/${safe}/`);
          skippedSkills.push(safe);
          continue;
        }
        let ok = true;
        for (const metaPath of metas) {
          const raw = await remote.readJson(metaPath);
          if (!raw || !isObject(raw)) {
            ok = false;
            break;
          }
          const versions = Array.isArray(raw.versions) ? raw.versions : [];
          for (const v of versions) {
            if (isObject(v) && typeof v.hash === 'string') {
              keepPrefixes.add(`library/skills/${safe}/versions/${v.hash}/`);
            }
          }
        }
        if (!ok) {
          keepPrefixes.add(`library/skills/${safe}/`);
          skippedSkills.push(safe);
        }
      }

      const prefixes = [...keepPrefixes];
      const isKept = (path: string): boolean =>
        keep.has(path) || prefixes.some((p) => path.startsWith(p));

      for (const entry of [...sessions, ...skills]) {
        if (entry.path.includes('.tmp-')) continue;
        if (isKept(entry.path)) continue;
        addOrphan(
          objects,
          entry,
          entry.path.startsWith('library/sessions/') ? 'library-session' : 'library-skill',
          cutoff,
        );
      }
    }
  }

  const bytes = objects.reduce((n, o) => n + o.size, 0);
  return { objects, bytes, skippedDevices, librarySkipped, skippedSkills };
}

/** 删除扫描结果;单条失败计入 failed,不中断整轮。 */
export async function deleteOrphans(
  remote: RemoteStore,
  scan: OrphanScan,
  opts: { signal?: AbortSignal } = {},
): Promise<DeleteResult> {
  let deleted = 0;
  let bytes = 0;
  let failed = 0;
  await mapLimit(scan.objects, remote.concurrencyHint?.() ?? 1, async (obj) => {
    if (opts.signal?.aborted) return;
    try {
      await remote.delete(obj.path);
      deleted++;
      bytes += obj.size;
    } catch {
      failed++;
    }
  });
  return { deleted, bytes, failed };
}
