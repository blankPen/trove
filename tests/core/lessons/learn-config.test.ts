import { describe, it, expect } from 'vitest';
import { readLearnConfig } from '../../../src/core/lessons/config.js';
import { defaultLearnConfig } from '../../../src/config.js';
import type { LearnConfig } from '../../../src/config.js';

const learn = (partial: Partial<LearnConfig>) => ({ learn: partial }) as never;

describe('readLearnConfig(v2 学习配置)', () => {
  it('缺省返回默认值', () => {
    expect(readLearnConfig()).toEqual(defaultLearnConfig());
    expect(readLearnConfig(undefined)).toEqual(defaultLearnConfig());
  });

  it('老配置(无 learn 或空 learn)补默认', () => {
    expect(readLearnConfig({} as never)).toEqual(defaultLearnConfig());
    expect(readLearnConfig(learn({}))).toEqual(defaultLearnConfig());
  });

  it('部分覆盖保留用户值,缺字段补默认', () => {
    const got = readLearnConfig(learn({ v2: true, mode: 'auto', quality: { autoAccept: 0.9 } }));
    expect(got.v2).toBe(true);
    expect(got.mode).toBe('auto');
    expect(got.quality.autoAccept).toBe(0.9);
    expect(got.quality.reviewFloor).toBe(0.6);
    expect(got.quality.evidenceMin).toBe(0.8);
    expect(got.jev).toEqual({ maxCallsPerSession: 8, timeoutMs: 2000 });
  });

  it('非法 mode 回退 shadow,quality 数值 clamp 到 [0,1]', () => {
    const got = readLearnConfig(
      learn({ mode: 'bogus' as never, quality: { autoAccept: 1.5, reviewFloor: -0.2, evidenceMin: 3 } }),
    );
    expect(got.mode).toBe('shadow');
    expect(got.quality).toEqual({ autoAccept: 1, reviewFloor: 0, evidenceMin: 1 });
  });

  it('v2 仅当显式 true 才开', () => {
    expect(readLearnConfig(learn({ v2: false })).v2).toBe(false);
    expect(readLearnConfig(learn({})).v2).toBe(false);
  });
});
