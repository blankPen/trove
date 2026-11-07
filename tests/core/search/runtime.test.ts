import { describe, it, expect, vi, afterEach } from 'vitest';
import { SearchRuntime } from '../../../src/core/search/runtime.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('SearchRuntime', () => {
  it('并发检索串行执行，不会同时进入模型', async () => {
    let inflight = 0;
    let peak = 0;
    const rt = new SearchRuntime(
      {
        search: async () => {
          inflight++;
          peak = Math.max(peak, inflight);
          await delay(10);
          inflight--;
          return [];
        },
      },
      { keepWarmMinutes: 0 },
    );
    await Promise.all([rt.search('a'), rt.search('b'), rt.search('c')]);
    expect(peak).toBe(1);
    expect(rt.stats().total).toBe(3);
  });

  it('前一个检索失败不会堵住后续请求', async () => {
    let n = 0;
    const rt = new SearchRuntime(
      {
        search: async () => {
          n++;
          if (n === 1) throw new Error('boom');
          return [];
        },
      },
      { keepWarmMinutes: 0 },
    );
    await expect(rt.search('a')).rejects.toThrow('boom');
    await expect(rt.search('b')).resolves.toEqual([]);
  });

  it('预热成功后标记 warm；失败不抛错', async () => {
    const warm = vi.fn(async () => {});
    const rt = new SearchRuntime({ search: async () => [], warm }, { keepWarmMinutes: 0 });
    expect(await rt.warmup()).toBe(true);
    expect(rt.stats().warm).toBe(true);

    const bad = new SearchRuntime(
      { search: async () => [], warm: async () => { throw new Error('no model'); } },
      { keepWarmMinutes: 0 },
    );
    expect(await bad.warmup()).toBe(false);
    expect(bad.stats().warm).toBe(false);
  });

  it('reindex 与检索共用闸门；未配置返回 null', async () => {
    let inflight = 0;
    let peak = 0;
    const rt = new SearchRuntime(
      {
        search: async () => {
          inflight++;
          peak = Math.max(peak, inflight);
          await delay(10);
          inflight--;
          return [];
        },
        reindex: async () => {
          inflight++;
          peak = Math.max(peak, inflight);
          await delay(10);
          inflight--;
          return { documents: 1, chunksEmbedded: 0, needsEmbedding: 0 };
        },
      },
      { keepWarmMinutes: 0 },
    );
    const [r] = await Promise.all([rt.reindex(), rt.search('x')]);
    expect(r).toEqual({ documents: 1, chunksEmbedded: 0, needsEmbedding: 0 });
    expect(peak).toBe(1);

    const bare = new SearchRuntime({ search: async () => [] }, { keepWarmMinutes: 0 });
    expect(await bare.reindex()).toBeNull();
  });

  it('保活窗口内周期 touch，超窗后停止', async () => {
    vi.useFakeTimers();
    const touch = vi.fn(() => true);
    const rt = new SearchRuntime({ search: async () => [], touch }, { keepWarmMinutes: 15, tickMs: 60_000 });
    await rt.search('x');
    rt.startKeepWarm();

    vi.advanceTimersByTime(60_000);
    expect(touch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(16 * 60_000);
    const calls = touch.mock.calls.length;
    vi.advanceTimersByTime(2 * 60_000);
    expect(touch.mock.calls.length).toBe(calls); // 超窗后不再保活
    expect(rt.stats().warm).toBe(false);
    rt.stop();
  });
});