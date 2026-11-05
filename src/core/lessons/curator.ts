/** curator:按使用情况维护记忆生命周期(active → stale → archived),并把使用计数回写到 frontmatter。 */
import { setFrontmatterField } from './frontmatter.js';
import { parseMemory } from './memory.js';
import type { MemoryV2 } from './memory.js';
import { readMemoryUsage, summarizeMemoryUsage } from './memory-usage.js';
import type { MemoryUsageSummary } from './memory-usage.js';
import { removeIndexEntry } from './write.js';
import type { StorageAdapter } from './storage.js';

const DAY = 24 * 60 * 60 * 1000;

/** 生命周期参数:超期未使用 → stale,再超期 → 归档;轨迹按天数与单项目条数上限清理。 */
export interface CuratorOptions {
  now?: () => Date;
  staleDays: number;
  archiveDays: number;
  trajectoryDays: number;
  trajectoryMax: number;
  dryRun?: boolean;
}

export interface CuratorReport {
  /** 本次被标 stale 的记忆。 */
  stale: string[];
  /** 本次被归档的记忆/轨迹。 */
  archived: string[];
  /** 本次从 stale 恢复 active 的记忆。 */
  revived: string[];
  /** 本次回写了使用计数的记忆。 */
  usageUpdated: string[];
  /** 未参与生命周期的记忆(pinned / 状态不参与 / 无有效时间)。 */
  skipped: string[];
}

/** daemon 自动跑 curator 的标记文件(相对 lessons 根)。 */
export const CURATOR_MARKER = '.trove/curator.json';
/** daemon 自动跑 curator 的最小间隔(天)。 */
export const CURATOR_INTERVAL_DAYS = 7;

const SKIP_PREFIXES = ['archive/', 'audit/', 'trajectories/', '.trove/'];
const NON_MEMORY = new Set(['INDEX.md', 'README.md', '.overview.md']);

/** 记忆文件与解析结果。 */
export interface MemoryFile {
  path: string;
  text: string;
  memory: MemoryV2;
}

/** 非记忆文件(归档/审计/轨迹/元数据/点文件)不参与生命周期。 */
function isMemoryPath(path: string): boolean {
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return false;
  if (NON_MEMORY.has(path)) return false;
  if (path.split('/').some((seg) => seg.startsWith('.'))) return false;
  return path.endsWith('.md');
}

/** 扫描 lessons 下的记忆文件;非记忆或解析失败的文件跳过。 */
export async function listMemoryFiles(storage: StorageAdapter): Promise<MemoryFile[]> {
  const out: MemoryFile[] = [];
  for (const path of await storage.list()) {
    if (!isMemoryPath(path)) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const memory = parseMemory(text);
    if (!memory) continue;
    out.push({ path, text, memory });
  }
  return out;
}

/** 轨迹文件:trajectories/ 下能解析为记忆的文件(生命周期之外的独立层)。 */
export async function listTrajectoryFiles(storage: StorageAdapter): Promise<MemoryFile[]> {
  const out: MemoryFile[] = [];
  for (const path of await storage.list('trajectories')) {
    if (!path.endsWith('.md') || path.split('/').some((s) => s.startsWith('.'))) continue;
    const text = await storage.read(path);
    if (text === null) continue;
    const memory = parseMemory(text);
    if (!memory) continue;
    out.push({ path, text, memory });
  }
  return out;
}

/** 统计 stale 记忆数(只读 frontmatter,不跑 curator)。 */
export async function countStaleMemories(storage: StorageAdapter): Promise<number> {
  const files = await listMemoryFiles(storage);
  return files.filter((f) => f.memory.status === 'stale').length;
}

/** 最近活动时间 = max(updated_at, last_used_at, usage.lastUsedAt);无可用时间返回 null。 */
function lastActivity(mem: MemoryV2, sum?: MemoryUsageSummary): number | null {
  const times = [mem.updatedAt, mem.lastUsedAt ?? undefined, sum?.lastUsedAt]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => Date.parse(v))
    .filter((t) => Number.isFinite(t));
  return times.length ? Math.max(...times) : null;
}

/** 使用计数回写:use_count = 检索+查看+应用,helpful_count = 有用反馈;值不变不写。 */
function applyUsage(text: string, mem: MemoryV2, sum?: MemoryUsageSummary): string {
  if (!sum) return text;
  let out = text;
  const useCount = sum.retrieved + sum.viewed + sum.applied;
  if (mem.useCount !== useCount) out = setFrontmatterField(out, 'use_count', String(useCount));
  if (mem.helpfulCount !== sum.helpful) out = setFrontmatterField(out, 'helpful_count', String(sum.helpful));
  if (sum.lastUsedAt && mem.lastUsedAt !== sum.lastUsedAt) {
    out = setFrontmatterField(out, 'last_used_at', JSON.stringify(sum.lastUsedAt));
  }
  return out;
}

/** 归档:写到 archive/<path>(已存在则加时间戳后缀),删原文件并清 INDEX 行。 */
async function archiveFile(
  storage: StorageAdapter,
  path: string,
  text: string,
  stamp: string,
): Promise<string> {
  const base = `archive/${path}`;
  const target = (await storage.exists(base)) ? `${base}.${stamp}` : base;
  await storage.write(target, setFrontmatterField(text, 'status', 'archived'));
  await storage.delete(path);
  await removeIndexEntry(storage, path);
  return target;
}

/** scope 解析项目名;非 project:<slug> 归全局。 */
function projectOf(scope: string): string {
  return scope.startsWith('project:') ? scope.slice('project:'.length) || 'global' : 'global';
}

interface TrajectoryFile {
  path: string;
  text: string;
  id: string;
  updatedAt: string;
  scope: string;
}

/** 跑一轮 curator:回写使用计数 → 推进生命周期 → 清理轨迹。dryRun 只算不写。 */
export async function runCurator(storage: StorageAdapter, opts: CuratorOptions): Promise<CuratorReport> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const dry = opts.dryRun === true;
  const report: CuratorReport = { stale: [], archived: [], revived: [], usageUpdated: [], skipped: [] };

  const files = await listMemoryFiles(storage);
  const usage = summarizeMemoryUsage(await readMemoryUsage(storage));

  for (const f of files) {
    const mem = f.memory;
    const sum = mem.id ? usage.get(mem.id) : undefined;

    // 1. 使用计数回写(不动 version 与 updated_at)
    let text = applyUsage(f.text, mem, sum);
    if (text !== f.text) {
      report.usageUpdated.push(f.path);
      if (!dry) await storage.write(f.path, text);
    }

    // 2. 生命周期(pinned 不参与)
    if (mem.pinned || (mem.status !== 'active' && mem.status !== 'stale')) {
      report.skipped.push(f.path);
      continue;
    }
    const last = lastActivity(mem, sum);
    if (last === null) {
      report.skipped.push(f.path);
      continue;
    }
    const ageDays = (nowMs - last) / DAY;

    if (mem.status === 'active') {
      if (ageDays > opts.staleDays) {
        report.stale.push(f.path);
        if (!dry) await storage.write(f.path, setFrontmatterField(text, 'status', 'stale'));
      }
      continue;
    }
    // stale:超归档期 → 归档;最近有活动 → 复活
    if (ageDays > opts.archiveDays) {
      report.archived.push(f.path);
      if (!dry) await archiveFile(storage, f.path, text, stamp);
      continue;
    }
    if (ageDays <= opts.staleDays) {
      report.revived.push(f.path);
      if (!dry) await storage.write(f.path, setFrontmatterField(text, 'status', 'active'));
    }
  }

  await curateTrajectories(storage, opts, report, dry, nowMs, stamp, files);
  return report;
}

/** 轨迹清理:被记忆引用的保留;其余超期或超出单项目条数上限的最旧条目归档。 */
async function curateTrajectories(
  storage: StorageAdapter,
  opts: CuratorOptions,
  report: CuratorReport,
  dry: boolean,
  nowMs: number,
  stamp: string,
  memories: MemoryFile[],
): Promise<void> {
  const referenced = new Set<string>();
  for (const f of memories) {
    for (const t of f.memory.sourceTrajectories ?? []) referenced.add(t);
  }

  const groups = new Map<string, TrajectoryFile[]>();
  for (const f of await listTrajectoryFiles(storage)) {
    const mem = f.memory;
    if (referenced.has(mem.id)) continue; // 被引用:保留
    if (!Number.isFinite(Date.parse(mem.updatedAt))) continue; // 无时间:不动
    const item: TrajectoryFile = { path: f.path, text: f.text, id: mem.id, updatedAt: mem.updatedAt, scope: mem.scope };
    const key = projectOf(mem.scope);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const cap = Math.max(0, opts.trajectoryMax);
  for (const group of groups.values()) {
    group.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (let i = 0; i < group.length; i++) {
      const t = group[i]!;
      const tooOld = (nowMs - Date.parse(t.updatedAt)) / DAY > opts.trajectoryDays;
      const overCap = i < group.length - cap;
      if (!tooOld && !overCap) continue;
      report.archived.push(t.path);
      if (!dry) await archiveFile(storage, t.path, t.text, stamp);
    }
  }
}

/** daemon 周期任务:距上次运行不足 intervalDays 天则跳过;跑完写标记。 */
export async function maybeRunCurator(
  storage: StorageAdapter,
  opts: CuratorOptions & { intervalDays?: number },
): Promise<CuratorReport | null> {
  const now = opts.now ?? (() => new Date());
  const intervalDays = opts.intervalDays ?? CURATOR_INTERVAL_DAYS;
  const last = await readCuratorMarker(storage);
  if (last) {
    const t = Date.parse(last);
    if (Number.isFinite(t) && now().getTime() - t < intervalDays * DAY) return null;
  }
  const report = await runCurator(storage, opts);
  await storage.write(CURATOR_MARKER, JSON.stringify({ lastRunAt: now().toISOString() }, null, 2));
  return report;
}

/** 读上次 curator 运行时间(ISO);没有或损坏返回 null。 */
export async function readCuratorMarker(storage: StorageAdapter): Promise<string | null> {
  const text = await storage.read(CURATOR_MARKER);
  if (text === null) return null;
  try {
    const r = JSON.parse(text) as { lastRunAt?: unknown };
    return typeof r.lastRunAt === 'string' ? r.lastRunAt : null;
  } catch {
    return null;
  }
}
