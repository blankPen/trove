import { randomUUID } from 'node:crypto';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveFile } from './archive.js';
import { hashBytes } from './chunker.js';
import { discoverFiles } from '../adapters/file-source.js';
import { OPENCODE_EXPORT_VERSION, OpenCodeStore } from '../adapters/opencode.js';
import { isSessionPath, type Adapter } from '../adapters/index.js';
import { validateRelPath } from './remote-layout.js';
import { rawFilePath } from './layout.js';
import { buildLibrary } from './library/build.js';
import { silentProgress, type Progress } from '../progress.js';
import type { State } from './state.js';

export interface CollectOptions {
  adapters: Adapter[];
  deviceId: string;
  vaultRoot: string;
  state: State;
  /** 0 = 不限制;否则只处理 sessionMtimeMs >= cutoff 的会话(Beacon Recent) */
  cutoff: number;
  progress?: Progress;
  tmpDir?: string;
  newGeneration?: () => string;
  signal?: AbortSignal;
}

export interface CollectResult {
  /** 命中白名单的文件/会话数(含窗口外) */
  discovered: number;
  /** 全量写入(新文件或重置)的条数 */
  archived: number;
  /** 增量追加的条数 */
  appended: number;
  /** 未变化跳过 */
  skipped: number;
  /** 因 --since 窗口被过滤 */
  outOfWindow: number;
  bytesCopied: number;
  /** 本次涉及的会话数(按 harness + sessionKey 去重) */
  sessions: number;
}

function archivePath(vaultRoot: string, deviceId: string, harness: string, relPath: string): string {
  return rawFilePath(vaultRoot, deviceId, harness, relPath);
}

/**
 * collect:poll 骨架。发现 → 时间窗 → 游标对比 → 无损归档 → 落状态。
 * 文件源与 SQLite 源最终都归约为"一个可增量复制的字节流"。
 */
export async function collect(opts: CollectOptions): Promise<CollectResult> {
  const { adapters, deviceId, vaultRoot, state, cutoff } = opts;
  const progress = opts.progress ?? silentProgress;
  const tmpDir = opts.tmpDir ?? join(vaultRoot, '.trove-tmp');
  await mkdir(tmpDir, { recursive: true });

  const result: CollectResult = {
    discovered: 0,
    archived: 0,
    appended: 0,
    skipped: 0,
    outOfWindow: 0,
    bytesCopied: 0,
    sessions: 0,
  };
  const sessionSeen = new Set<string>();

  for (const adapter of adapters) {
    if (adapter.kind === 'files') {
      const files = await discoverFiles(adapter.source);
      result.discovered += files.length;
      progress.phase('collect', `${adapter.displayName}: ${files.length} 个文件`);
      const sessionFiles = new Map<string, string[]>();
      const changedSessions = new Set<string>();
      let n = 0;
      for (const f of files) {
        throwIfAborted(opts.signal);
        n++;
        if (isSessionPath(adapter, f.relPath)) sessionSeen.add(`${adapter.id}:${f.sessionKey}`);
        if (cutoff && f.sessionMtimeMs < cutoff) {
          result.outOfWindow++;
          continue;
        }
        if (!validateRelPath(f.relPath)) throw new Error(`非法路径(源文件): ${f.relPath}`);

        const bucket = (state.sources[adapter.id] ??= {});
        const r = await archiveFile({
          sourcePath: f.absPath,
          targetPath: archivePath(vaultRoot, deviceId, adapter.id, f.relPath),
          cursor: bucket[f.relPath],
          srcStat: { size: f.size, mtimeMs: f.mtimeMs },
          newGeneration: opts.newGeneration,
        });
        tally(result, r.action, r.bytesCopied);
        bucket[f.relPath] = {
          ...r.cursor,
          sessionKey: f.sessionKey,
          sessionMtimeMs: f.sessionMtimeMs,
        };
        const list = sessionFiles.get(f.sessionKey) ?? [];
        list.push(f.relPath);
        sessionFiles.set(f.sessionKey, list);
        if (r.action !== 'skip') changedSessions.add(f.sessionKey);
        progress.item(f.relPath, n, files.length, r.bytesCopied);
      }
      continue;
    }

    // SQLite(OpenCode):按会话导出确定性 JSONL,再走同一套归档逻辑
    const store = new OpenCodeStore(adapter.dbPath);
    try {
      const sessions = store.listSessions();
      result.discovered += sessions.length;
      progress.phase('collect', `${adapter.displayName}: ${sessions.length} 个会话`);
      const sessionFiles = new Map<string, string[]>();
      const changedSessions = new Set<string>();
      let n = 0;
      for (const s of sessions) {
        throwIfAborted(opts.signal);
        n++;
        sessionSeen.add(`${adapter.id}:${s.id}`);
        if (cutoff && s.updatedAt < cutoff) {
          result.outOfWindow++;
          continue;
        }
        const relPath = `sessions/${s.id}.jsonl`;
        sessionFiles.set(s.id, [relPath]);
        const target = archivePath(vaultRoot, deviceId, adapter.id, relPath);
        const exists = await fileExists(target);
        const bucket = (state.sources[adapter.id] ??= {});
        const entry = bucket[relPath];
        if (
          entry &&
          entry.formatVersion === OPENCODE_EXPORT_VERSION &&
          entry.mtimeMs === s.updatedAt &&
          exists
        ) {
          result.skipped++;
          continue;
        }

        const text = store.exportSession(s.id);
        if (!text) {
          result.skipped++;
          continue;
        }
        const size = Buffer.byteLength(text);
        // 内容没变(只是时间戳变了)→ 不重置世代、不重传
        if (
          exists &&
          entry &&
          entry.size === size &&
          entry.prefixHash === hashBytes(Buffer.from(text))
        ) {
          entry.mtimeMs = s.updatedAt;
          entry.sessionMtimeMs = s.updatedAt;
          entry.formatVersion = OPENCODE_EXPORT_VERSION;
          result.skipped++;
          continue;
        }

        const tmp = join(tmpDir, `opencode-${s.id}-${randomUUID()}.jsonl`);
        try {
          await writeFile(tmp, text, 'utf8');
          const r = await archiveFile({
            sourcePath: tmp,
            targetPath: target,
            cursor: entry,
            srcStat: { size, mtimeMs: s.updatedAt },
            newGeneration: opts.newGeneration,
          });
          tally(result, r.action, r.bytesCopied);
          if (r.action !== 'skip') changedSessions.add(s.id);
          bucket[relPath] = {
            ...r.cursor,
            sessionKey: s.id,
            sessionMtimeMs: s.updatedAt,
            formatVersion: OPENCODE_EXPORT_VERSION,
          };
          progress.item(relPath, n, sessions.length, r.bytesCopied);
        } finally {
          await unlink(tmp).catch(() => {});
        }
      }
    } finally {
      store.close();
    }
  }

  result.sessions = sessionSeen.size;
  // raw 落盘后立即构建个人资产层(library);未变化的会话按签名跳过
  await buildLibrary({ vaultRoot, deviceId, state });
  return result;
}

/** 协作式中止:daemon 收到 SIGTERM 后不必等整轮跑完。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已中止');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function tally(
  r: CollectResult,
  action: 'new' | 'skip' | 'append' | 'reset',
  bytes: number,
): void {
  if (action === 'skip') {
    r.skipped++;
    return;
  }
  r.bytesCopied += bytes;
  if (action === 'append') r.appended++;
  else r.archived++;
}
