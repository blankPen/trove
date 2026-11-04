import { loadConfig } from '../config.js';
import { readLearnQueue } from '../core/lessons/queue.js';
import { readUsageRecords, summarizeUsage } from '../core/lessons/usage.js';
import type { TrovePaths } from '../paths.js';

/**
 * trove 自身的 LLM 用量台账。
 * 只统计 trove 调用 LLM 的消耗(learn 提取、summarize 等),
 * 不统计归档会话里的 token —— 那部分 trove 从不聚合。
 */
export async function buildUsage(
  paths: TrovePaths,
): Promise<
  ReturnType<typeof summarizeUsage> & {
    hasLedger: boolean;
    llmConfigured: boolean;
    llmFields: { baseUrl: boolean; model: boolean; apiKey: boolean };
    pendingExtraction: string[];
  }
> {
  const records = await readUsageRecords(paths.usageLog);
  const config = await loadConfig(paths.config);
  const llm = config.llm;
  const pending = await readLearnQueue(paths.learnQueue);
  return {
    ...summarizeUsage(records),
    hasLedger: records.length > 0,
    llmConfigured: Boolean(llm?.baseUrl && llm?.model && llm?.apiKey),
    // 只给「配没配」,不给值 —— apiKey 是密钥,不出进程
    llmFields: {
      baseUrl: Boolean(llm?.baseUrl),
      model: Boolean(llm?.model),
      apiKey: Boolean(llm?.apiKey),
    },
    // 队列里的会话还没提取经验 —— 提取一次就是一次 LLM 调用
    pendingExtraction: pending,
  };
}
