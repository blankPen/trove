/** trove 自身调用 LLM 的 token 用量台账:一次调用一行,只追加到 usage.jsonl。 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 单次 LLM 调用的用量与来源任务(如 learn:summarize)。 */
export interface LlmUsage {
  task: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageRecord extends LlmUsage {
  /** 记录时间,ISO-8601;由 sink 写入时打点。 */
  at: string;
}

export type UsageSink = (usage: LlmUsage) => void | Promise<void>;

/** 追加写 sink:目录不存在自建,单行 JSON;写失败由调用方决定是否忽略。 */
export function createUsageSink(path: string, now: () => Date = () => new Date()): UsageSink {
  // shortcut: 台账只追加不轮转,单行约 150B;增长到数十万行影响读取时再加轮转。
  return async (usage) => {
    const record: UsageRecord = { at: now().toISOString(), ...usage };
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  };
}

/** 读取台账;文件不存在或单行损坏都跳过,不阻断统计。 */
export async function readUsageRecords(path: string): Promise<UsageRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<UsageRecord>;
      if (typeof r.at !== 'string' || typeof r.task !== 'string' || typeof r.model !== 'string') continue;
      out.push({
        at: r.at,
        task: r.task,
        model: r.model,
        promptTokens: nonNegative(r.promptTokens),
        completionTokens: nonNegative(r.completionTokens),
        totalTokens: nonNegative(r.totalTokens),
      });
    } catch {
      // 损坏行跳过
    }
  }
  return out;
}

export interface UsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageSummary {
  total: UsageBucket;
  byTask: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
}

export function summarizeUsage(records: Iterable<UsageRecord>): UsageSummary {
  const total = emptyBucket();
  const byTask: Record<string, UsageBucket> = {};
  const byModel: Record<string, UsageBucket> = {};
  for (const r of records) {
    addTo(total, r);
    addTo((byTask[r.task] ??= emptyBucket()), r);
    addTo((byModel[r.model] ??= emptyBucket()), r);
  }
  return { total, byTask, byModel };
}

const NUMBER = new Intl.NumberFormat('en-US');

/** CLI 展示:总计 + 按任务/模型分组。 */
export function formatUsageSummary(summary: UsageSummary, since = 'all'): string[] {
  if (summary.total.calls === 0) return ['暂无 LLM 用量记录'];
  return [
    `LLM 用量(${since}): ${NUMBER.format(summary.total.calls)} 次调用 · ` +
      `输入 ${NUMBER.format(summary.total.promptTokens)} · 输出 ${NUMBER.format(summary.total.completionTokens)} · ` +
      `合计 ${NUMBER.format(summary.total.totalTokens)} tokens`,
    '按任务:',
    ...formatBuckets(summary.byTask),
    '按模型:',
    ...formatBuckets(summary.byModel),
  ];
}

function formatBuckets(buckets: Record<string, UsageBucket>): string[] {
  return Object.entries(buckets)
    .sort(([an, a], [bn, b]) => b.totalTokens - a.totalTokens || an.localeCompare(bn))
    .map(
      ([name, b]) =>
        `  ${name} · ${NUMBER.format(b.calls)} 次 · 输入 ${NUMBER.format(b.promptTokens)} · ` +
        `输出 ${NUMBER.format(b.completionTokens)} · 合计 ${NUMBER.format(b.totalTokens)}`,
    );
}

function emptyBucket(): UsageBucket {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addTo(bucket: UsageBucket, r: UsageRecord): void {
  bucket.calls++;
  bucket.promptTokens += r.promptTokens;
  bucket.completionTokens += r.completionTokens;
  bucket.totalTokens += r.totalTokens;
}

function nonNegative(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}
