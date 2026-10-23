import { collect, type CollectResult } from './collect.js';
import { pullRemote, type PullResult } from './pull.js';
import { pushLocal, type PushResult } from './push.js';
import { pullLibrary, pushLibrary, type PullLibraryResult, type PushLibraryResult } from './library/sync.js';
import { acquireLock } from './lock.js';
import { loadState, saveState } from './state.js';
import { metaPath } from './remote-layout.js';
import { silentProgress, type Progress } from '../progress.js';
import type { Adapter } from '../adapters/index.js';
import type { RemoteStore } from '../remote/store.js';

export interface SyncOptions {
  adapters: Adapter[];
  deviceId: string;
  deviceName: string;
  vaultRoot: string;
  statePath: string;
  remote: RemoteStore;
  /** 0 = 全量;否则只收集最近变更的会话 */
  cutoff: number;
  tmpDir?: string;
  chunkSize?: number;
  concurrency?: number;
  progress?: Progress;
  now?: () => number;
  pullOnly?: boolean;
  pushOnly?: boolean;
  /** false 时只同步对话层(_events/),raw 只归档到本地 */
  rawSync?: boolean;
  signal?: AbortSignal;
}

export interface SyncReport {
  collected: CollectResult;
  pulled: PullResult;
  pushed: PushResult;
  library: { pulled: PullLibraryResult; pushed: PushLibraryResult };
  durationMs: number;
}

const emptyCollect: CollectResult = {
  discovered: 0,
  archived: 0,
  appended: 0,
  skipped: 0,
  outOfWindow: 0,
  bytesCopied: 0,
  sessions: 0,
};
const emptyPull: PullResult = {
  downloadedChunks: 0,
  downloadedBytes: 0,
  downloadedItems: 0,
  skippedItems: 0,
};
const emptyPush: PushResult = {
  uploadedChunks: 0,
  uploadedBytes: 0,
  uploadedItems: 0,
  skippedItems: 0,
};

/**
 * 一次完整同步:collect(本机 → vault)→ pull(远端 → vault)→ push(vault → 远端)。
 * 每个阶段结束都落状态,长同步被打断也不必从头再来。
 */
/** 同一份 vault/state 只允许一个进程写:daemon 与手动 sync 共用此锁。 */
export async function sync(opts: SyncOptions): Promise<SyncReport> {
  const release = await acquireLock(`${opts.statePath}.lock`);
  try {
    return await syncUnlocked(opts);
  } finally {
    await release();
  }
}

async function syncUnlocked(opts: SyncOptions): Promise<SyncReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const progress = opts.progress ?? silentProgress;
  const state = await loadState(opts.statePath);

  let collected = emptyCollect;
  if (!opts.pullOnly) {
    collected = await collect({
      adapters: opts.adapters,
      deviceId: opts.deviceId,
      vaultRoot: opts.vaultRoot,
      state,
      cutoff: opts.cutoff,
      progress,
      tmpDir: opts.tmpDir,
      signal: opts.signal,
    });
    await saveState(opts.statePath, state);
  }

  const emptyLibrary = {
    pulled: { downloaded: 0, bytes: 0, skipped: 0 },
    pushed: { uploaded: 0, bytes: 0, skipped: 0 },
  };
  let pulled = emptyPull;
  let libraryPulled = emptyLibrary.pulled;
  if (!opts.pushOnly) {
    if (opts.rawSync !== false) pulled = await pullRemote({
      remote: opts.remote,
      deviceId: opts.deviceId,
      vaultRoot: opts.vaultRoot,
      state,
      progress,
      signal: opts.signal,
    });
    libraryPulled = await pullLibrary({
      remote: opts.remote,
      vaultRoot: opts.vaultRoot,
      deviceId: opts.deviceId,
      state,
      progress,
      signal: opts.signal,
    });
    await saveState(opts.statePath, state);
  }

  let pushed = emptyPush;
  let libraryPushed = emptyLibrary.pushed;
  if (!opts.pullOnly) {
    if (opts.rawSync !== false) pushed = await pushLocal({
      remote: opts.remote,
      deviceId: opts.deviceId,
      vaultRoot: opts.vaultRoot,
      state,
      now,
      chunkSize: opts.chunkSize,
      concurrency: opts.concurrency,
      progress,
      signal: opts.signal,
    });
    libraryPushed = await pushLibrary({
      remote: opts.remote,
      vaultRoot: opts.vaultRoot,
      deviceId: opts.deviceId,
      state,
      progress,
      signal: opts.signal,
    });
    if (opts.rawSync !== false) {
      await opts.remote.writeJson(metaPath(opts.deviceId), {
        id: opts.deviceId,
        name: opts.deviceName,
        lastSeen: now(),
      });
    }
    await saveState(opts.statePath, state);
  }

  return {
    collected,
    pulled,
    pushed,
    library: { pulled: libraryPulled, pushed: libraryPushed },
    durationMs: now() - started,
  };
}
