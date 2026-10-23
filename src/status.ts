import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSessionPath, type Adapter } from './adapters/index.js';
import { libraryDir } from './core/layout.js';
import { listLibraryFiles } from './core/library/sync.js';
import { metaPath } from './core/remote-layout.js';
import type { State } from './core/state.js';
import type { RemoteStore } from './remote/store.js';

export interface HarnessStatus {
  id: string;
  displayName: string;
  sessionCount: number;
  bytes: number;
}

/** raw 层待推送:只统计本地已归档、尚未推到远端的文件。 */
export interface PendingHarness {
  id: string;
  displayName: string;
  sessions: number;
  files: number;
  bytes: number;
}

export interface PendingRaw {
  sessions: number;
  files: number;
  bytes: number;
  byHarness: PendingHarness[];
}

/** library 待推送:按会话文件 / 技能 / 索引分类。 */
export interface PendingLibrary {
  sessions: { count: number; files: number; bytes: number };
  skills: { count: number; files: number; bytes: number };
  index: { files: number; bytes: number };
}

export interface StatusReport {
  deviceId: string;
  deviceName: string;
  harnesses: HarnessStatus[];
  pending: PendingRaw;
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
  const byHarness: PendingHarness[] = [];
  const pendingKeys = new Map<string, Set<string>>();
  let pendingFiles = 0;
  let pendingBytes = 0;

  for (const adapter of adapters) {
    const bucket = state.sources[adapter.id] ?? {};
    const sessions = new Set<string>();
    const pendingSessions = new Set<string>();
    let bytes = 0;
    let files = 0;
    let pendingFileBytes = 0;
    for (const [relPath, entry] of Object.entries(bucket)) {
      if (isSessionPath(adapter, relPath)) sessions.add(entry.sessionKey);
      bytes += entry.size;
      // 与 pushLocal 同口径:世代或大小变化才算待推送(同尺寸改写会换世代)
      const pushed = state.pushed[adapter.id]?.[relPath];
      if (pushed && pushed.generation === entry.generation && pushed.size === entry.size) continue;
      files++;
      pendingFileBytes += entry.size;
      if (isSessionPath(adapter, relPath)) pendingSessions.add(entry.sessionKey);
    }
    harnesses.push({
      id: adapter.id,
      displayName: adapter.displayName,
      sessionCount: sessions.size,
      bytes,
    });
    if (files > 0) {
      pendingKeys.set(adapter.id, pendingSessions);
      pendingFiles += files;
      pendingBytes += pendingFileBytes;
      byHarness.push({
        id: adapter.id,
        displayName: adapter.displayName,
        sessions: pendingSessions.size,
        files,
        bytes: pendingFileBytes,
      });
    }
  }

  return {
    deviceId,
    deviceName,
    harnesses,
    pending: {
      sessions: [...pendingKeys.values()].reduce((n, s) => n + s.size, 0),
      files: pendingFiles,
      bytes: pendingBytes,
      byHarness,
    },
  };
}

/** library 待推送:判定规则与 pushLibrary 完全一致(size + 四舍五入后的 mtime)。 */
export async function computeLibraryPending(
  vaultRoot: string,
  state: State,
): Promise<PendingLibrary> {
  const root = libraryDir(vaultRoot);
  const sessionKeys = new Set<string>();
  const skillNames = new Set<string>();
  const out: PendingLibrary = {
    sessions: { count: 0, files: 0, bytes: 0 },
    skills: { count: 0, files: 0, bytes: 0 },
    index: { files: 0, bytes: 0 },
  };

  for (const rel of await listLibraryFiles(vaultRoot)) {
    const st = await stat(join(root, ...rel.split('/')));
    const prev = state.library.pushed[rel];
    if (prev && prev.size === st.size && prev.mtimeMs === Math.round(st.mtimeMs)) continue;
    const parts = rel.split('/');
    if (parts[0] === 'sessions') {
      sessionKeys.add(`${parts[1] ?? ''}/${parts[2] ?? ''}`);
      out.sessions.files++;
      out.sessions.bytes += st.size;
    } else if (parts[0] === 'skills') {
      skillNames.add(parts[1] ?? '');
      out.skills.files++;
      out.skills.bytes += st.size;
    } else {
      out.index.files++;
      out.index.bytes += st.size;
    }
  }
  out.sessions.count = sessionKeys.size;
  out.skills.count = skillNames.size;
  return out;
}

export interface RemoteDeviceInfo {
  id: string;
  name: string;
  lastSeen?: number;
}

export interface RemoteStatus {
  ok: boolean;
  devices: RemoteDeviceInfo[];
  error?: string;
}

/** 轻量远端探测:一次列目录 + 每设备一个小 meta.json;失败只降级为「不可达」。 */
export async function probeRemote(
  remote: RemoteStore,
  signal: AbortSignal,
): Promise<RemoteStatus> {
  try {
    const entries = await remote.list('library/index', signal);
    const ids = entries
      .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length))
      .sort();
    const devices = await Promise.all(
      ids.map(async (id) => {
        const meta = (await remote.readJson(metaPath(id), signal).catch(() => null)) as {
          name?: string;
          lastSeen?: number;
        } | null;
        return {
          id,
          name: meta?.name ?? id,
          ...(typeof meta?.lastSeen === 'number' ? { lastSeen: meta.lastSeen } : {}),
        };
      }),
    );
    return { ok: true, devices };
  } catch (err) {
    return {
      ok: false,
      devices: [],
      error: signal.aborted ? '探测超时(5s)' : (err as Error).message,
    };
  }
}
