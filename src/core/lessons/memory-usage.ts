/** 记忆使用事件:检索/查看/应用/有用/有害的埋点,追加到 `.trove/usage.jsonl`(相对 lessons 根)。 */
import type { StorageAdapter } from './storage.js';

export type MemoryAction = 'retrieved' | 'viewed' | 'applied' | 'helpful' | 'harmful';

export interface MemoryUsageEvent {
  /** 事件时间(ISO-8601)。 */
  at: string;
  memory_id: string;
  action: MemoryAction;
  /** 来源会话(harness:session)。 */
  session?: string;
  /** 检索词。 */
  query?: string;
  /** 命中排名(1 起)。 */
  rank?: number;
  /** 附加权重(如反馈分值)。 */
  value?: number;
}

export interface MemoryUsageSummary {
  retrieved: number;
  viewed: number;
  applied: number;
  helpful: number;
  harmful: number;
  /** 最近一次使用时间(ISO-8601)。 */
  lastUsedAt?: string;
}

export const USAGE_PATH = '.trove/usage.jsonl';

const ACTIONS: MemoryAction[] = ['retrieved', 'viewed', 'applied', 'helpful', 'harmful'];

/** 追加一条使用事件;写失败由调用方决定是否忽略(检索路径必须忽略)。 */
export async function recordMemoryUsage(storage: StorageAdapter, e: MemoryUsageEvent): Promise<void> {
  const existing = (await storage.read(USAGE_PATH)) ?? '';
  const record: MemoryUsageEvent = { ...e, at: e.at || new Date().toISOString() };
  await storage.write(USAGE_PATH, existing + JSON.stringify(record) + '\n');
}

/** 批量追加:过滤掉无 memory_id 的事件,一次读+一次写;空数组不落盘。 */
export async function recordMemoryUsageBatch(storage: StorageAdapter, events: MemoryUsageEvent[]): Promise<void> {
  const valid = events.filter((e) => e.memory_id);
  if (valid.length === 0) return;
  const existing = (await storage.read(USAGE_PATH)) ?? '';
  const lines = valid.map((e) => JSON.stringify({ ...e, at: e.at || new Date().toISOString() }));
  await storage.write(USAGE_PATH, existing + lines.join('\n') + '\n');
}

/** 读取使用事件;损坏行与非法记录跳过,不抛错。 */
export async function readMemoryUsage(
  storage: StorageAdapter,
  filter?: { memoryId?: string },
): Promise<MemoryUsageEvent[]> {
  const text = await storage.read(USAGE_PATH);
  if (text === null) return [];
  const out: MemoryUsageEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 损坏行跳过
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const r = parsed as Partial<MemoryUsageEvent>;
    if (typeof r.memory_id !== 'string' || !r.memory_id) continue;
    if (!ACTIONS.includes(r.action as MemoryAction)) continue;
    if (filter?.memoryId && r.memory_id !== filter.memoryId) continue;
    out.push({
      at: typeof r.at === 'string' ? r.at : '',
      memory_id: r.memory_id,
      action: r.action as MemoryAction,
      ...(typeof r.session === 'string' ? { session: r.session } : {}),
      ...(typeof r.query === 'string' ? { query: r.query } : {}),
      ...(typeof r.rank === 'number' && Number.isFinite(r.rank) ? { rank: r.rank } : {}),
      ...(typeof r.value === 'number' && Number.isFinite(r.value) ? { value: r.value } : {}),
    });
  }
  return out;
}

/** 按记忆 id 汇总:各动作计数 + 最近使用时间。 */
export function summarizeMemoryUsage(events: MemoryUsageEvent[]): Map<string, MemoryUsageSummary> {
  const map = new Map<string, MemoryUsageSummary>();
  for (const e of events) {
    const s = map.get(e.memory_id) ?? {
      retrieved: 0,
      viewed: 0,
      applied: 0,
      helpful: 0,
      harmful: 0,
    };
    s[e.action]++;
    if (e.at && (!s.lastUsedAt || e.at > s.lastUsedAt)) s.lastUsedAt = e.at;
    map.set(e.memory_id, s);
  }
  return map;
}
