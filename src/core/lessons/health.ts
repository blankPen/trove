/** Memory Health:仓库健康的只读摘要 —— stale/重复/覆盖缺口/使用信号/作业与检索索引,不写任何文件。 */
import { access } from 'node:fs/promises';
import { libraryLessonsDir } from '../layout.js';
import type { TrovePaths } from '../../paths.js';
import { LocalStorageAdapter } from './storage.js';
import { listMemoryFiles, listTrajectoryFiles, type MemoryFile } from './curator.js';
import { readMemoryUsage, type MemoryUsageEvent } from './memory-usage.js';
import { parseMemory, qualityTotal } from './memory.js';
import { readTrust } from './trust.js';
import { listInbox } from './inbox.js';
import { JobQueue } from './jobs.js';
import { qmdIndexStatus } from '../search/qmd.js';

export interface MemoryHealthUsage {
  retrieved: number;
  viewed: number;
  helpful: number;
  harmful: number;
  /** 近 7 天内的使用事件数(任意动作)。 */
  last7d: number;
}

export interface MemoryHealth {
  total: number;
  byCategory: Record<string, number>;
  stale: number;
  archived: number;
  pinned: number;
  /** 无 evidence 的 active 经验数(覆盖缺口的一部分)。 */
  missingEvidence: number;
  /** quality 总分 < 0.6 的 active 经验数。 */
  lowQuality: number;
  /** 同 type 内标题 2-gram Dice ≥ 0.8 的对数。 */
  duplicates: number;
  /** 活跃轨迹里没有被任何记忆引用的条数(覆盖缺口的另一半)。 */
  unreferencedTrajectories: number;
  inboxPending: number;
  trustLevel: number;
  usage: MemoryHealthUsage;
  jobs?: { queued: number; running: number; retry: number; dead: number } | null;
  searchIndex: { documents: number; needsEmbedding: number } | null;
}

export interface HealthMemoryMetrics {
  total: number;
  byCategory: Record<string, number>;
  stale: number;
  archived: number;
  pinned: number;
  missingEvidence: number;
  lowQuality: number;
  duplicates: number;
}

const LOW_QUALITY_FLOOR = 0.6;
const DUP_DICE_MIN = 0.8;

/** 纯函数:从已解析的记忆文件算出仓库健康指标;archived 单独传入(listMemoryFiles 不含 archive/)。 */
export function summarizeHealth(files: MemoryFile[], archivedCount: number): HealthMemoryMetrics {
  const byCategory: Record<string, number> = {};
  let stale = 0;
  let pinned = 0;
  let missingEvidence = 0;
  let lowQuality = 0;

  for (const f of files) {
    const m = f.memory;
    const cat = m.type.split('/')[0] || f.path.split('/')[0] || 'other';
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    if (m.status === 'stale') stale++;
    if (m.pinned) pinned++;
    if (m.status === 'active' && m.kind === 'experience') {
      if (m.evidence.length === 0) missingEvidence++;
      if (m.quality && qualityTotal(m.quality) < LOW_QUALITY_FLOOR) lowQuality++;
    }
  }

  return {
    total: files.length,
    byCategory,
    stale,
    archived: archivedCount,
    pinned,
    missingEvidence,
    lowQuality,
    duplicates: countDuplicates(files),
  };
}

/** 同 type 内标题字符 2-gram 交集(Dice)≥ 0.8 的对数;与 merge.ts 的 titleScore 同口径。 */
function countDuplicates(files: MemoryFile[]): number {
  const byType = new Map<string, MemoryFile[]>();
  for (const f of files) {
    const group = byType.get(f.memory.type);
    if (group) group.push(f);
    else byType.set(f.memory.type, [f]);
  }
  let pairs = 0;
  for (const group of byType.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (titleDice(group[i]!.memory.title, group[j]!.memory.title) >= DUP_DICE_MIN) pairs++;
      }
    }
  }
  return pairs;
}

function titleDice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function bigrams(s: string): Set<string> {
  const chars = [...s];
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

/** 纯函数:未被任何记忆引用的活跃轨迹数(覆盖缺口的另一半)。 */
export function countUnreferencedTrajectories(memories: MemoryFile[], trajectories: MemoryFile[]): number {
  const referenced = new Set<string>();
  for (const f of memories) for (const t of f.memory.sourceTrajectories ?? []) referenced.add(t);
  return trajectories.filter((f) => f.memory.status === 'active' && !referenced.has(f.memory.id)).length;
}

/** 纯函数:把使用事件汇总成各动作计数 + 近 7 天计数。 */
export function summarizeUsageEvents(events: MemoryUsageEvent[], now: number): MemoryHealthUsage {
  const out: MemoryHealthUsage = { retrieved: 0, viewed: 0, helpful: 0, harmful: 0, last7d: 0 };
  const weekAgo = now - 7 * 86_400_000;
  for (const e of events) {
    if (e.action === 'retrieved') out.retrieved++;
    else if (e.action === 'viewed') out.viewed++;
    else if (e.action === 'helpful') out.helpful++;
    else if (e.action === 'harmful') out.harmful++;
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && t >= weekAgo) out.last7d++;
  }
  return out;
}

/** 组装完整健康摘要;jobs/检索索引 读缓存,缺失或失败返回 null(不报错)。 */
export async function buildMemoryHealth(
  paths: TrovePaths,
  now: () => number = Date.now,
): Promise<MemoryHealth> {
  const storage = new LocalStorageAdapter(libraryLessonsDir(paths.vault));
  const [files, trajectories, usageEvents, trust, inbox] = await Promise.all([
    listMemoryFiles(storage),
    listTrajectoryFiles(storage),
    readMemoryUsage(storage),
    readTrust(storage),
    listInbox(storage),
  ]);
  const metrics = summarizeHealth(files, await countArchived(storage));
  return {
    ...metrics,
    unreferencedTrajectories: countUnreferencedTrajectories(files, trajectories),
    inboxPending: inbox.length,
    trustLevel: trust.level,
    usage: summarizeUsageEvents(usageEvents, now()),
    jobs: await readJobStats(paths),
    searchIndex: await readSearchIndexStats(paths),
  };
}

/** 归档记忆数:archive/ 下能解析为记忆的文件数。 */
async function countArchived(storage: LocalStorageAdapter): Promise<number> {
  let n = 0;
  for (const rel of await storage.list('archive')) {
    if (!rel.endsWith('.md') || rel.split('/').some((s) => s.startsWith('.'))) continue;
    const text = await storage.read(rel);
    if (text !== null && parseMemory(text)) n++;
  }
  return n;
}

async function readJobStats(paths: TrovePaths): Promise<MemoryHealth['jobs']> {
  if (!(await exists(paths.learnDb))) return null;
  try {
    const queue = JobQueue.open(paths.learnDb);
    try {
      const s = queue.stats();
      return { queued: s.queued, running: s.running, retry: s.retryWait, dead: s.dead };
    } finally {
      queue.close();
    }
  } catch {
    return null;
  }
}

async function readSearchIndexStats(paths: TrovePaths): Promise<MemoryHealth['searchIndex']> {
  if (!(await exists(paths.qmdDb))) return null;
  const status = await qmdIndexStatus(paths.vault, { dbPath: paths.qmdDb });
  if (!status) return null;
  return { documents: status.documents, needsEmbedding: status.needsEmbedding };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
