import { describe, it, expect, vi, afterEach } from 'vitest';
import { TypeSafeJevScorer, PassThroughJev } from '../../../src/core/lessons/jev.js';

/** stub 全局 fetch,返回给定 JSON;ok=false 时模拟非 2xx。 */
function stubFetch(body: unknown, ok = true) {
  const fn = vi.fn(async (_input: unknown, _init?: unknown) => ({
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('Jev 打分(Stage 4)', () => {
  it('构建正确请求,解析 task_success 并归一化 mean_score', async () => {
    const fn = stubFetch({ answers: { task_success: { noul: 0.8 }, value: { score: 1.4 } } });
    const scorer = new TypeSafeJevScorer({ apiKey: 'k', model: 'jev-latest' });
    const r = await scorer.score({ summary: { outcome: 'success' } });
    expect(r.taskSuccess).toBe(0.8);
    expect(r.meanScore).toBeCloseTo(0.7); // value.score / (VALUE_LEVELS.length - 1) = 1.4 / 2
    expect(fn).toHaveBeenCalledOnce();
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer k' });
  });

  it('传 baseUrl 时覆盖官方端点', async () => {
    const fn = stubFetch({ answers: { task_success: { noul: 0.8 }, value: { score: 1.4 } } });
    const scorer = new TypeSafeJevScorer({ apiKey: 'k', model: 'jev-latest', baseUrl: 'https://proxy.example.com/systemone' });
    await scorer.score({ summary: { outcome: 'success' } });
    expect(fn.mock.calls[0]![0]).toBe('https://proxy.example.com/systemone');
  });

  it('非 2xx 抛错', async () => {
    stubFetch({ detail: 'bad' }, false);
    const scorer = new TypeSafeJevScorer({ apiKey: 'k', model: 'jev-latest' });
    await expect(scorer.score('x')).rejects.toThrow(/Jev 打分失败/);
  });

  it('响应结构不符抛错', async () => {
    stubFetch({ answers: {} });
    const scorer = new TypeSafeJevScorer({ apiKey: 'k', model: 'jev-latest' });
    await expect(scorer.score('x')).rejects.toThrow(/结构不符/);
  });

  it('PassThroughJev 恒返回通过分数', async () => {
    await expect(new PassThroughJev().score('x')).resolves.toEqual({ taskSuccess: 1, meanScore: 1 });
  });
});

describe('Jev 压缩判定 keepCalls', () => {
  it('构建 noul 批量请求,解析每个 key 的 0~1 概率', async () => {
    const fn = stubFetch({ answers: { a: { noul: 0.7 }, b: { noul: 0.2 } } });
    const scorer = new TypeSafeJevScorer({ apiKey: 'k', model: 'jev-latest' });
    const out = await scorer.keepCalls('state', { a: { instructions: 'q1' }, b: { instructions: 'q2' } });
    expect(out).toEqual({ a: 0.7, b: 0.2 });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.questions).toEqual({
      a: { type: 'noul', instructions: 'q1' },
      b: { type: 'noul', instructions: 'q2' },
    });
  });

  it('响应结构不符抛错', async () => {
    stubFetch({ answers: { a: {} } });
    const scorer = new TypeSafeJevScorer({ apiKey: 'k', model: 'jev-latest' });
    await expect(scorer.keepCalls('state', { a: { instructions: 'q' } })).rejects.toThrow(/压缩判定结构不符/);
  });

  it('PassThroughJev.keepCalls 恒返回 1', async () => {
    await expect(new PassThroughJev().keepCalls!('state', { a: { instructions: 'q' } })).resolves.toEqual({ a: 1 });
  });
});
