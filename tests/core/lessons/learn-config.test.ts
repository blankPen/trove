import { describe, it, expect } from 'vitest';
import { readLearnConfig } from '../../../src/core/lessons/config.js';
import { defaultLearnConfig } from '../../../src/config.js';
import type { LearnConfig } from '../../../src/config.js';

const learn = (partial: Partial<LearnConfig>) => ({ learn: partial }) as never;

describe('readLearnConfig(v2 单轨学习配置)', () => {
  it('缺省返回默认值(review 模式 + autoMigrate)', () => {
    expect(readLearnConfig()).toEqual(defaultLearnConfig());
    expect(readLearnConfig(undefined)).toEqual(defaultLearnConfig());
  });

  it('老配置(无 learn 或空 learn)补默认', () => {
    expect(readLearnConfig({} as never)).toEqual(defaultLearnConfig());
    expect(readLearnConfig(learn({}))).toEqual(defaultLearnConfig());
  });

  it('部分覆盖保留用户值,缺字段补默认', () => {
    const got = readLearnConfig(learn({ mode: 'auto', quality: { autoAccept: 0.9 } }));
    expect(got.mode).toBe('auto');
    expect(got.autoMigrate).toBe(true);
    expect(got.quality.autoAccept).toBe(0.9);
    expect(got.quality.reviewFloor).toBe(0.6);
    expect(got.quality.evidenceMin).toBe(0.8);
    expect(got.jev).toEqual({ maxCallsPerSession: 8, timeoutMs: 2000 });
  });

  it('mode 只认 off/shadow/review/auto,其余兜底 review;quality 数值 clamp 到 [0,1]', () => {
    const got = readLearnConfig(
      learn({ mode: 'bogus' as never, quality: { autoAccept: 1.5, reviewFloor: -0.2, evidenceMin: 3 } }),
    );
    expect(got.mode).toBe('review');
    expect(readLearnConfig(learn({ mode: 'off' })).mode).toBe('off');
    expect(readLearnConfig(learn({ mode: 'shadow' })).mode).toBe('shadow');
    expect(readLearnConfig(learn({ mode: 'review' })).mode).toBe('review');
    expect(readLearnConfig(learn({ mode: 'auto' })).mode).toBe('auto');
    expect(got.quality).toEqual({ autoAccept: 1, reviewFloor: 0, evidenceMin: 1 });
  });

  it('autoMigrate 默认 true,显式 false 保留', () => {
    expect(readLearnConfig(learn({ autoMigrate: false })).autoMigrate).toBe(false);
    expect(readLearnConfig(learn({})).autoMigrate).toBe(true);
  });

  it('老配置里的 v2 字段被忽略,不再读', () => {
    const raw = { learn: { v2: true, mode: 'shadow', autoMigrate: false } } as never;
    const got = readLearnConfig(raw);
    expect(got.mode).toBe('shadow');
    expect(got.autoMigrate).toBe(false);
    expect((got as Record<string, unknown>).v2).toBeUndefined();
  });

  it('lifecycle 缺省补默认,部分覆盖保留', () => {
    expect(readLearnConfig().lifecycle).toEqual({
      staleDays: 14,
      archiveDays: 30,
      trajectoryDays: 90,
      trajectoryMax: 500,
    });
    const got = readLearnConfig(learn({ lifecycle: { staleDays: 7 } } as never));
    expect(got.lifecycle.staleDays).toBe(7);
    expect(got.lifecycle.archiveDays).toBe(30);
    expect(got.lifecycle.trajectoryMax).toBe(500);
  });

  it('capacity 缺省补默认,部分覆盖保留,负值钳 0', () => {
    expect(readLearnConfig().capacity).toEqual({
      experiencesPerProject: 120,
      experiencesGlobal: 600,
      profileBytes: 8192,
      entitiesPerType: 200,
    });
    const got = readLearnConfig(learn({ capacity: { experiencesPerProject: 5, experiencesGlobal: -1 } } as never));
    expect(got.capacity.experiencesPerProject).toBe(5);
    expect(got.capacity.experiencesGlobal).toBe(0);
    expect(got.capacity.entitiesPerType).toBe(200);
  });

  it('search 缺省补默认,部分覆盖保留,负值钳 0,空 host 回退默认', () => {
    expect(readLearnConfig().search).toEqual({
      enabled: true,
      model: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf',
      host: 'https://hf-mirror.com',
      minScore: 0,
    });
    const got = readLearnConfig(
      learn({ search: { enabled: false, model: 'Xenova/bge-m3', host: '', minScore: -1 } } as never),
    );
    expect(got.search).toEqual({
      enabled: false,
      model: 'Xenova/bge-m3',
      host: 'https://hf-mirror.com',
      minScore: 0,
    });
  });
});
