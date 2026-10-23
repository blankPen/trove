import { describe, it, expect, afterEach } from 'vitest';
import { trovePaths } from '../src/paths.js';

const ORIG = process.env.TROVE_HOME;

describe('trovePaths 目录推导(设计 §6.1)', () => {
  afterEach(() => {
    if (ORIG === undefined) delete process.env.TROVE_HOME;
    else process.env.TROVE_HOME = ORIG;
  });

  it('未设 TROVE_HOME 时默认 base 为 ~/.trove', () => {
    delete process.env.TROVE_HOME;
    const p = trovePaths();
    expect(p.base).toMatch(/\.trove$/);
    expect(p.vault).toBe(`${p.base}/vault`);
    expect(p.config).toBe(`${p.base}/config.json`);
    expect(p.state).toBe(`${p.base}/state.json`);
  });

  it('TROVE_HOME 覆盖整个 base,所有子路径随之迁移', () => {
    process.env.TROVE_HOME = '/Volumes/Data2/trove-home';
    const p = trovePaths();
    expect(p.base).toBe('/Volumes/Data2/trove-home');
    expect(p.vault).toBe('/Volumes/Data2/trove-home/vault');
    expect(p.state).toBe('/Volumes/Data2/trove-home/state.json');
  });

  it('空字符串 TROVE_HOME 视为未设置', () => {
    process.env.TROVE_HOME = '';
    const p = trovePaths();
    expect(p.base).toMatch(/\.trove$/);
  });

  it('显式 base 参数优先于 TROVE_HOME(测试注入仍生效)', () => {
    process.env.TROVE_HOME = '/Volumes/Data2/trove-home';
    const p = trovePaths('/tmp/injected-base');
    expect(p.base).toBe('/tmp/injected-base');
  });
});
