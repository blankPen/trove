import { describe, it, expect } from 'vitest';
import { projectSlug, inferScope } from '../../../src/core/lessons/scope.js';

describe('projectSlug(取路径末段,非法字符折 _)', () => {
  it('取路径最后一段', () => {
    expect(projectSlug('/Users/x/trove')).toBe('trove');
    expect(projectSlug('/a/b/c')).toBe('c');
    expect(projectSlug('trove')).toBe('trove');
  });

  it('非 [A-Za-z0-9._-] 折成 _', () => {
    expect(projectSlug('/Users/x/tro ve')).toBe('tro_ve');
    expect(projectSlug('/Users/x/my-project')).toBe('my-project');
    expect(projectSlug('a/b!c@d')).toBe('b_c_d');
  });

  it('空串 / 无末段回退空字符串', () => {
    expect(projectSlug('')).toBe('');
    expect(projectSlug('/')).toBe('');
  });
});

describe('inferScope(按类型决定 project/global)', () => {
  it('preferences/* 与 entities/* 恒 global', () => {
    expect(inferScope('preferences/profile', '/Users/x/trove')).toBe('global');
    expect(inferScope('entities/tool', '/Users/x/trove')).toBe('global');
  });

  it('experiences/events/resources → project:<slug>', () => {
    expect(inferScope('experiences/gotcha', '/Users/x/trove')).toBe('project:trove');
    expect(inferScope('events/decision', '/Users/x/trove')).toBe('project:trove');
    expect(inferScope('resources/doc', '/Users/x/trove')).toBe('project:trove');
  });

  it('slug 为空时回退 global', () => {
    expect(inferScope('experiences/gotcha', '')).toBe('global');
    expect(inferScope('experiences/gotcha', '/')).toBe('global');
  });
});
