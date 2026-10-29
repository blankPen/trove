import { describe, it, expect } from 'vitest';
import {
  buildFilename,
  getMemoryType,
  listMemoryTypes,
  validateMemoryTypes,
  type MemoryTypeSchema,
} from '../../src/core/lessons/schema.js';

describe('Memory Schema', () => {
  it('用例 2-1:共 17 类,四类代表齐全', () => {
    const types = listMemoryTypes();
    expect(types.length).toBeGreaterThanOrEqual(17);
    const keys = new Set(types.map((t) => t.key));
    for (const k of [
      'preferences/writing_style',
      'experiences/debug_pattern',
      'events/decision',
      'entities/project',
    ]) {
      expect(keys.has(k)).toBe(true);
    }
    expect(types.map((t) => t.key).length).toBe(new Set(types.map((t) => t.key)).size);
  });

  it('用例 2-2:缺提取提示词时报错并指明类别', () => {
    const bad: MemoryTypeSchema[] = [
      {
        key: 'experiences/debug_pattern',
        category: 'experiences',
        filename: 'experiences/debug-{slug}.md',
        mergeOp: 'add',
        extractionPrompt: '',
      },
    ];
    expect(() => validateMemoryTypes(bad)).toThrow(/experiences\/debug_pattern/);
    expect(() => validateMemoryTypes(bad)).toThrow(/提取提示词/);
  });

  it('patch 类缺合并提示词同样报错', () => {
    const bad: MemoryTypeSchema[] = [
      {
        key: 'preferences/writing_style',
        category: 'preferences',
        filename: 'preferences/writing_style.md',
        mergeOp: 'patch',
        extractionPrompt: 'x',
      },
    ];
    expect(() => validateMemoryTypes(bad)).toThrow(/preferences\/writing_style/);
  });

  it('用例 2-3:debug_pattern 文件名规则 → debug-<slug>.md', () => {
    const schema = getMemoryType('experiences/debug_pattern');
    expect(schema).toBeDefined();
    const name = buildFilename(schema!, { title: 'ECONNRESET 时指数退避重试' });
    expect(name.startsWith('experiences/debug-')).toBe(true);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('决策文件名含日期前缀,资源文件名落到对应子目录', () => {
    const decision = buildFilename(getMemoryType('events/decision')!, {
      title: '用 pnpm 不用 npm',
      date: '2026-01-02',
    });
    expect(decision).toBe('events/2026-01-02-decided-用-pnpm-不用-npm.md');
    expect(buildFilename(getMemoryType('resources/repo')!, { title: 'trove' })).toBe(
      'resources/repos/trove.md',
    );
  });
});