import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isSessionPath, type Adapter } from './adapters/index.js';
import type { State } from './core/state.js';

export interface HarnessStatus {
  id: string;
  displayName: string;
  sessionCount: number;
  bytes: number;
}

export interface StatusReport {
  deviceId: string;
  deviceName: string;
  harnesses: HarnessStatus[];
  pendingCount: number;
  pendingBytes: number;
  sessionTotal: number;
  bytesTotal: number;
}

export interface StatusOptions {
  state: State;
  deviceId: string;
  deviceName: string;
  adapters: Adapter[];
}

/**
 * 从状态文件直接汇总,不重新扫描源目录 —— status 必须秒开,
 * 即使 Claude/豆包有数万个文件。
 */
export function computeStatus(opts: StatusOptions): StatusReport {
  const { state, deviceId, deviceName, adapters } = opts;
  const harnesses: HarnessStatus[] = [];
  let pendingCount = 0;
  let pendingBytes = 0;

  for (const adapter of adapters) {
    const bucket = state.sources[adapter.id] ?? {};
    const sessions = new Set<string>();
    let bytes = 0;
    for (const [relPath, entry] of Object.entries(bucket)) {
      if (isSessionPath(adapter, relPath)) sessions.add(entry.sessionKey);
      bytes += entry.size;
      const pushed = state.pushed[adapter.id]?.[relPath];
      if (!pushed || pushed.size !== entry.size) {
        pendingCount++;
        pendingBytes += entry.size;
      }
    }
    harnesses.push({
      id: adapter.id,
      displayName: adapter.displayName,
      sessionCount: sessions.size,
      bytes,
    });
  }

  return {
    deviceId,
    deviceName,
    harnesses,
    pendingCount,
    pendingBytes,
    sessionTotal: harnesses.reduce((n, h) => n + h.sessionCount, 0),
    bytesTotal: harnesses.reduce((n, h) => n + h.bytes, 0),
  };
}

export interface OtherDeviceStatus {
  id: string;
  name: string;
  sessionCount: number;
  bytes: number;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** 其他设备(pull 回来的镜像)的会话概览;从 vault 目录直接统计。 */
export async function computeOtherDevices(
  vaultRoot: string,
  deviceId: string,
  adapters: Adapter[],
): Promise<OtherDeviceStatus[]> {
  const devicesRoot = join(vaultRoot, 'raw');
  let ids: string[] = [];
  try {
    ids = (await readdir(devicesRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name !== deviceId)
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const out: OtherDeviceStatus[] = [];
  for (const id of ids) {
    let name = id;
    try {
      const meta = JSON.parse(
        await readFile(join(devicesRoot, id, 'meta.json'), 'utf8'),
      ) as { name?: string };
      name = meta.name ?? id;
    } catch {
      // 没有 meta 就用目录名
    }
    const sessions = new Set<string>();
    let bytes = 0;
    for (const adapter of adapters) {
      const dir = join(devicesRoot, id, adapter.id);
      for (const abs of await listFiles(dir)) {
        const rel = relative(dir, abs).split(sep).join('/');
        if (!isSessionPath(adapter, rel)) continue;
        const key =
          adapter.kind === 'files' ? adapter.source.sessionKeyOf?.(rel) ?? rel : rel;
        sessions.add(key);
        bytes += (await stat(abs)).size;
      }
    }
    if (sessions.size > 0) out.push({ id, name, sessionCount: sessions.size, bytes });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
