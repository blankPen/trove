import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Fingerprint, Manifest } from './core/types.js';
import { computeFingerprint } from './core/fingerprint.js';
import { plan } from './core/planner.js';
import { loadManifest, saveManifest } from './manifest.js';
import type { Remote } from './remote/types.js';

/**
 * 远端布局(设计 §6.3):{device_id}/... 直接挂在远端根下,无 devices/ 前缀。
 * 本地布局(设计 §6.1):vault/devices/{device_id}/...。
 * push/pull 只是这条映射的正反两面:本地多一个 devices/ 层。
 */

interface DeviceFile {
  /** 相对 devices/{deviceId}/ 的路径(即 manifest 的 key) */
  relPath: string;
  absPath: string;
}

async function listDeviceFiles(
  vaultRoot: string,
  deviceId: string,
): Promise<DeviceFile[]> {
  const deviceDir = join(vaultRoot, 'devices', deviceId);
  let entries;
  try {
    entries = await readdir(deviceDir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: DeviceFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const absPath = join(e.parentPath, e.name);
    out.push({ relPath: relative(deviceDir, absPath).split(sep).join('/'), absPath });
  }
  return out;
}

// ── push ──────────────────────────────────────────────────────────────

export interface PushOptions {
  remote: Remote;
  deviceId: string;
  vaultRoot: string;
  manifest: Manifest;
  now?: () => number;
  dryRun?: boolean;
}

export interface PushResult {
  uploaded: number;
  skipped: number;
  manifest: Manifest;
}

/**
 * push:把 vault/devices/{我}/ 的增量推到远端 {我}/。
 * 判定由 planner 给出(阶段 1 仅 skip / full);成功后回写 manifest。
 */
export async function pushLocal(opts: PushOptions): Promise<PushResult> {
  const { remote, deviceId, vaultRoot, dryRun = false } = opts;
  const now = opts.now ?? Date.now;
  const files = await listDeviceFiles(vaultRoot, deviceId);

  const byPath = new Map<string, { fingerprint: Fingerprint; absPath: string }>();
  for (const f of files) {
    byPath.set(f.relPath, {
      fingerprint: await computeFingerprint(f.absPath),
      absPath: f.absPath,
    });
  }

  const scanned = [...byPath].map(([path, v]) => ({ path, fingerprint: v.fingerprint }));
  const items = plan(scanned, opts.manifest);

  // 远端即真相(设计 §7.2):列出本设备远端文件,manifest 判 skip 但远端缺失/尺寸不符仍要重传。
  const remoteSize = new Map<string, number>();
  for (const rf of await remote.listAll()) {
    if (rf.path.startsWith(`${deviceId}/`)) {
      remoteSize.set(rf.path.slice(deviceId.length + 1), rf.size);
    }
  }

  let uploaded = 0;
  let skipped = 0;
  for (const item of items) {
    const rec = byPath.get(item.path)!;
    const rs = remoteSize.get(item.path);
    const remoteMissingOrStale = rs === undefined || rs !== rec.fingerprint.size;
    if (item.action === 'skip' && !remoteMissingOrStale) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      await remote.upload(rec.absPath, `${deviceId}/${item.path}`);
    }
    opts.manifest[item.path] = {
      path: item.path,
      fingerprint: rec.fingerprint,
      syncedSize: rec.fingerprint.size,
      syncedAt: now(),
    };
    uploaded++;
  }

  return { uploaded, skipped, manifest: opts.manifest };
}

// ── pull ──────────────────────────────────────────────────────────────

export interface PullOptions {
  remote: Remote;
  deviceId: string;
  vaultRoot: string;
}

export interface PullResult {
  downloaded: number;
  skipped: number;
}

/**
 * pull:无状态地取回远端(设计 §9.6)。本地文件系统即状态:
 * 远端 {owner}/X → 本地 vault/devices/{owner}/X,owner 是自己则跳过。
 * 阶段 1 用 size 判定本地是否已一致;headHash 校验推迟到阶段 2。
 */
export async function pullRemote(opts: PullOptions): Promise<PullResult> {
  const { remote, deviceId, vaultRoot } = opts;
  const remoteFiles = await remote.listAll();

  let downloaded = 0;
  let skipped = 0;

  for (const rf of remoteFiles) {
    const slash = rf.path.indexOf('/');
    if (slash <= 0) continue; // 非 {device}/... 的顶层杂项,忽略
    if (rf.path.split('/').includes('..')) continue; // 拒绝路径穿越(远端不可信)
    const owner = rf.path.slice(0, slash);
    if (owner === deviceId) continue; // 自己的设备目录(设计 §10.3 ②)

    const local = join(vaultRoot, 'devices', owner, rf.path.slice(slash + 1));

    let sameSize = false;
    try {
      const st = await stat(local);
      sameSize = st.isFile() && st.size === rf.size;
    } catch {
      sameSize = false;
    }
    if (sameSize) {
      skipped++;
      continue;
    }

    await mkdir(dirname(local), { recursive: true });
    const tmp = `${local}.tmp-${randomUUID()}`;
    await remote.download(rf.path, tmp);
    await rename(tmp, local);
    downloaded++;
  }

  return { downloaded, skipped };
}

// ── sync ──────────────────────────────────────────────────────────────

export interface SyncOptions {
  remote: Remote;
  deviceId: string;
  deviceName: string;
  vaultRoot: string;
  manifestPath: string;
  now?: () => number;
  dryRun?: boolean;
  pullOnly?: boolean;
  pushOnly?: boolean;
}

export interface SyncReport {
  deviceId: string;
  pulled: number;
  pushed: number;
  skipped: number;
}

/** 写本设备的 meta.json {id, name, lastSeen}(设计 §6.3)。 */
async function writeDeviceMeta(
  vaultRoot: string,
  deviceId: string,
  deviceName: string,
  now: number,
): Promise<void> {
  const p = join(vaultRoot, 'devices', deviceId, 'meta.json');
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify({ id: deviceId, name: deviceName, lastSeen: now }));
  await rename(tmp, p);
}

/** 完整同步:先 pull 再 push(设计 §10.3、§9.6)。 */
export async function sync(opts: SyncOptions): Promise<SyncReport> {
  const now = opts.now ?? Date.now;

  if (!opts.dryRun) {
    await writeDeviceMeta(opts.vaultRoot, opts.deviceId, opts.deviceName, now());
  }

  let pulled = 0;
  if (!opts.dryRun && !opts.pushOnly) {
    const r = await pullRemote(opts);
    pulled = r.downloaded;
  }

  let pushed = 0;
  let skipped = 0;
  if (!opts.pullOnly) {
    const manifest = await loadManifest(opts.manifestPath);
    const r = await pushLocal({ ...opts, manifest, now });
    if (!opts.dryRun) await saveManifest(opts.manifestPath, r.manifest);
    pushed = r.uploaded;
    skipped = r.skipped;
  }

  return { deviceId: opts.deviceId, pulled, pushed, skipped };
}
