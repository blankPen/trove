import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChunkRef } from './chunker.js';
import type { FileCursor } from './cursor.js';

/** 源文件已归档状态(游标 + 会话归属)。 */
export interface SourceEntry extends FileCursor {
  /** 会话 id:同一次对话的多个文件共享(豆包目录/多文件会话) */
  sessionKey: string;
  /** 会话最近变更时间,用于 --since 过滤 */
  sessionMtimeMs: number;
  /** SQLite 类数据源的导出格式版本;变化时强制重新导出 */
  formatVersion?: number;
}

/** 已推送到远端的快照;size 是提交点,chunks 只增不改。 */
export interface PushedEntry {
  generation: string;
  size: number;
  chunks: ChunkRef[];
  /** chunks 数组的 sha256,与索引项比对,判断远端是否已是最新 */
  chunksHash: string;
}

/** 已从某个远端设备拉取的快照。 */
export interface PulledEntry {
  generation: string;
  size: number;
  chunksHash: string;
}

export interface DaemonStatus {
  pid: number;
  startedAt: number;
  intervalSeconds: number;
  since: string;
  lastRunAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  nextRunAt?: number;
}

/** 本设备已构建的会话(增量判断用)。 */
export interface BuiltEntry {
  sig: string;
  hash: string;
  events: number;
  path: string;
  /** 写入后的事件文件大小与 mtime,用于跳过未变化的文件 */
  size?: number;
  mtimeMs?: number;
  /** 映射后得到的会话 id(可能不同于路径推导值) */
  session?: string;
  title?: string;
  firstText?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
}

export interface LibraryState {
  built: Record<string, BuiltEntry>;
  /** 已推送的 library 文件: path → {size, hash} */
  pushed: Record<string, { size: number; mtimeMs?: number; hash?: string }>;
  /** 已拉取的 library 文件: device → path → hash */
  pulled: Record<string, Record<string, string>>;
}

export interface State {
  v: 1;
  /** harness → 本地文件(或 SQLite 会话) → 游标 */
  sources: Record<string, Record<string, SourceEntry>>;
  /** harness → 本地文件 key → 已推送快照 */
  pushed: Record<string, Record<string, PushedEntry>>;
  /** 远端设备 id → "harness:key" → 已拉取快照 */
  pulled: Record<string, Record<string, PulledEntry>>;
  library: LibraryState;
  daemon?: DaemonStatus;
}

export function emptyLibraryState(): LibraryState {
  return { built: {}, pushed: {}, pulled: {} };
}

export function emptyState(): State {
  return { v: 1, sources: {}, pushed: {}, pulled: {}, library: emptyLibraryState() };
}

/** 读取状态;不存在返回空状态。损坏 JSON 抛出可定位的错误。 */
export async function loadState(path: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw err;
  }
  let parsed: Partial<State>;
  try {
    parsed = JSON.parse(raw) as Partial<State>;
  } catch {
    throw new Error(`state 损坏,无法解析 JSON: ${path}`);
  }
  // 旧版对话层挂在 raw 下(_events/),已迁到 library:读入时清掉遗留条目
  for (const bucket of Object.values(parsed.sources ?? {})) {
    for (const key of Object.keys(bucket)) {
      if (key.startsWith('_events/')) delete bucket[key];
    }
  }
  return {
    v: 1,
    sources: parsed.sources ?? {},
    pushed: parsed.pushed ?? {},
    pulled: parsed.pulled ?? {},
    library: parsed.library ?? emptyLibraryState(),
    ...(parsed.daemon ? { daemon: parsed.daemon } : {}),
  };
}

/** 原子写入:临时文件 + rename,避免进程中断留下半个 JSON。 */
export async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.state.tmp-${randomUUID()}`);
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, path);
}

/** 取(或创建)某个 harness 的源状态表。 */
export function sourceBucket(state: State, harness: string): Record<string, SourceEntry> {
  return (state.sources[harness] ??= {});
}

export function pushedBucket(state: State, harness: string): Record<string, PushedEntry> {
  return (state.pushed[harness] ??= {});
}

export function pulledBucket(state: State, deviceId: string): Record<string, PulledEntry> {
  return (state.pulled[deviceId] ??= {});
}
