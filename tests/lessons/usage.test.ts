import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createUsageSink,
  formatUsageSummary,
  readUsageRecords,
  summarizeUsage,
  type UsageRecord,
} from '../../src/core/lessons/usage.js';

let dir: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trove-usage-'));
  log = join(dir, 'usage.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-11-02T08:00:00.000Z');

describe('usage 台账', () => {
  it('sink 自动建目录并追加一行一次调用', async () => {
    const sink = createUsageSink(join(dir, 'nested', 'usage.jsonl'), fixedNow);
    await sink({ task: 'learn:summarize', model: 'deepseek-v4-flash', promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    await sink({ task: 'learn:classify', model: 'deepseek-v4-flash', promptTokens: 40, completionTokens: 5, totalTokens: 45 });

    const records = await readUsageRecords(join(dir, 'nested', 'usage.jsonl'));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      at: '2026-11-02T08:00:00.000Z',
      task: 'learn:summarize',
      model: 'deepseek-v4-flash',
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
  });

  it('台账不存在返回空数组,损坏行与缺字段行跳过', async () => {
    expect(await readUsageRecords(log)).toEqual([]);

    const good: UsageRecord = {
      at: '2026-11-02T08:00:00.000Z',
      task: 'learn:extract',
      model: 'm',
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    };
    await writeFile(log, `${JSON.stringify(good)}\n不是 JSON\n${JSON.stringify({ task: 'x' })}\n`, 'utf8');

    expect(await readUsageRecords(log)).toEqual([good]);
  });

  it('summary 汇总总数、任务与模型', () => {
    const records: UsageRecord[] = [
      { at: '2026-11-02T08:00:00.000Z', task: 'learn:summarize', model: 'm1', promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      { at: '2026-11-02T08:01:00.000Z', task: 'learn:summarize', model: 'm1', promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      { at: '2026-11-02T08:02:00.000Z', task: 'learn:extract', model: 'm2', promptTokens: 30, completionTokens: 5, totalTokens: 35 },
    ];

    const s = summarizeUsage(records);
    expect(s.total).toEqual({ calls: 3, promptTokens: 180, completionTokens: 35, totalTokens: 215 });
    expect(s.byTask['learn:summarize']).toEqual({ calls: 2, promptTokens: 150, completionTokens: 30, totalTokens: 180 });
    expect(s.byTask['learn:extract']).toEqual({ calls: 1, promptTokens: 30, completionTokens: 5, totalTokens: 35 });
    expect(s.byModel['m1']?.totalTokens).toBe(180);
    expect(s.byModel['m2']?.totalTokens).toBe(35);
  });

  it('格式化:空台账给提示,非空含总计与分组', () => {
    expect(formatUsageSummary(summarizeUsage([]))).toEqual(['暂无 LLM 用量记录']);

    const text = formatUsageSummary(
      summarizeUsage([
        { at: '2026-11-02T08:00:00.000Z', task: 'learn:summarize', model: 'deepseek-v4-flash', promptTokens: 1234, completionTokens: 56, totalTokens: 1290 },
      ]),
      '7d',
    ).join('\n');
    expect(text).toContain('LLM 用量(7d): 1 次调用');
    expect(text).toContain('输入 1,234');
    expect(text).toContain('输出 56');
    expect(text).toContain('合计 1,290 tokens');
    expect(text).toContain('learn:summarize');
    expect(text).toContain('deepseek-v4-flash');
  });
});
