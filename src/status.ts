import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Manifest } from './core/types.js';
import { computeFingerprint } from './core/fingerprint.js';
import { plan } from './core/planner.js';

export interface DeviceStatus {
  id: string;
  name: string;
  sessionCount: number;
  bytes: number;
}

export interface PendingItem {
  path: string;
  reason: 'new' | 'changed';
  size: number;
}

export interface StatusReport {
  deviceId: string;
  deviceName: string;
  devices: DeviceStatus[];
  pending: PendingItem[];
  pendingCount: number;
  pendingBytes: number;
}

export interface StatusOptions {
  vaultRoot: string;
  deviceId: string;
  deviceName: string;
  manifest: Manifest;
}

/** 递归列出某目录下所有文件的绝对路径;目录不存在返回空。 */
async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** 读 meta.json 里的 name,失败回退到目录名。 */
async function readMetaName(metaPath: string, fallback: string): Promise<string> {
  try {
    const raw = await readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw) as { name?: string };
    return meta.name ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 计算 trove 状态(设计 §10.4)。
 * 会话数 = 各设备 claude-code/projects/**\/*.jsonl 的数量与字节数;
 * 待同步 = 本设备全部文件经 planner 判定为 full 的条目。
 */
export async function computeStatus(opts: StatusOptions): Promise<StatusReport> {
  const { vaultRoot, deviceId, deviceName, manifest } = opts;
  const devicesRoot = join(vaultRoot, 'devices');

  let deviceDirs: string[] = [];
  try {
    deviceDirs = (await readdir(devicesRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const devices: DeviceStatus[] = [];
  for (const id of deviceDirs) {
    const deviceDir = join(devicesRoot, id);
    const name =
      id === deviceId ? deviceName : await readMetaName(join(deviceDir, 'meta.json'), id);

    const sessionFiles = (await listFiles(join(deviceDir, 'claude-code', 'projects'))).filter(
      (p) => p.endsWith('.jsonl'),
    );
    let bytes = 0;
    for (const f of sessionFiles) bytes += (await stat(f)).size;

    devices.push({ id, name, sessionCount: sessionFiles.length, bytes });
  }

  const myDir = join(devicesRoot, deviceId);
  const byRel = new Map<string, string>();
  for (const abs of await listFiles(myDir)) {
    byRel.set(relative(myDir, abs).split(sep).join('/'), abs);
  }
  const scanned = [];
  for (const [rel, abs] of byRel) {
    scanned.push({ path: rel, fingerprint: await computeFingerprint(abs) });
  }

  const pending: PendingItem[] = [];
  let pendingBytes = 0;
  for (const item of plan(scanned, manifest)) {
    if (item.action === 'skip') continue;
    const size = scanned.find((s) => s.path === item.path)!.fingerprint.size;
    const reason = item.reason === 'new' ? 'new' : 'changed';
    pending.push({ path: item.path, reason, size });
    pendingBytes += size;
  }

  return {
    deviceId,
    deviceName,
    devices,
    pending,
    pendingCount: pending.length,
    pendingBytes,
  };
}
