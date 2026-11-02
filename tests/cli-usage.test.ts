import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { trovePaths } from '../src/paths.js';
import { createUsageSink } from '../src/core/lessons/usage.js';

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
let base: string;
let lines: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'trove-usage-cli-'));
  lines = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function deps() {
  return {
    base,
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    rawOut: () => {},
    isTTY: false,
    now: () => NOW,
  };
}

async function seedUsage(): Promise<void> {
  // 1 小时前:窗口内;25 小时前:窗口外
  const recent = createUsageSink(trovePaths(base).usageLog, () => new Date(NOW - 3600_000));
  const old = createUsageSink(trovePaths(base).usageLog, () => new Date(NOW - 25 * 3600_000));
  await recent({ task: 'learn:summarize', model: 'deepseek-v4-flash', promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  await old({ task: 'learn:extract', model: 'deepseek-v4-flash', promptTokens: 40, completionTokens: 5, totalTokens: 45 });
  await recent({ task: 'learn:summarize', model: 'deepseek-v4-flash', promptTokens: 10, completionTokens: 2, totalTokens: 12 });
}

describe('trove usage', () => {
  it('按任务与模型汇总全部台账', async () => {
    await seedUsage();

    expect(await run(['usage'], deps())).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('LLM 用量(all): 3 次调用');
    expect(text).toContain('合计 177 tokens');
    expect(text).toContain('learn:summarize · 2 次');
    expect(text).toContain('deepseek-v4-flash · 3 次');
  });

  it('--since 只统计时间窗内的调用', async () => {
    await seedUsage();

    expect(await run(['usage', '--since', '24h'], deps())).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('LLM 用量(24h): 2 次调用');
    expect(text).toContain('合计 132 tokens');
    expect(text).not.toContain('learn:extract');
  });

  it('--json 输出可解析的汇总', async () => {
    await seedUsage();

    expect(await run(['usage', '--json'], deps())).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as {
      since: string;
      total: { calls: number; totalTokens: number };
    };
    expect(parsed.since).toBe('all');
    expect(parsed.total).toEqual({ calls: 3, promptTokens: 150, completionTokens: 27, totalTokens: 177 });
  });

  it('无台账时给出提示且不报错', async () => {
    expect(await run(['usage'], deps())).toBe(0);
    expect(lines.join('\n')).toContain('暂无 LLM 用量记录');
  });

  it('--since 非法时非零退出并提示时间范围', async () => {
    expect(await run(['usage', '--since', '7x'], deps())).toBe(1);
    expect(lines.join('\n')).toContain('时间范围');
  });
});
