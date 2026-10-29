import { describe, it, expect } from 'vitest';
import { isValidScope, renderFrontmatter } from '../../src/core/lessons/frontmatter.js';

describe('frontmatter 规范', () => {
  it('用例 1-3:debug_pattern 生成文件头,含 type/scope/created_at/updated_at/source 且缺省合理', () => {
    const fm = renderFrontmatter({
      type: 'experiences/debug_pattern',
      title: 'ECONNRESET 时指数退避重试',
      source: 'session:s1/seq:3',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(fm).toContain('type: experiences/debug_pattern');
    expect(fm).toContain('title: "ECONNRESET 时指数退避重试"');
    expect(fm).toContain('scope: global');
    expect(fm).toContain('tags: []');
    expect(fm).toContain('source: "session:s1/seq:3"');
    expect(fm).toContain('created_at: "2026-01-01T00:00:00.000Z"');
    expect(fm).toContain('updated_at: "2026-01-01T00:00:00.000Z"');
    expect(fm.startsWith('---')).toBe(true);
  });

  it('用例 1-4:非法 scope 被拒绝,且不产生 frontmatter', () => {
    expect(isValidScope('火星')).toBe(false);
    expect(isValidScope('global')).toBe(true);
    expect(isValidScope('project:trove')).toBe(true);
    expect(() =>
      renderFrontmatter({ type: 'experiences/debug_pattern', title: 't', scope: '火星' }),
    ).toThrow(/scope/);
  });

  it('缺省 createdAt/updatedAt 用当前时间填充', () => {
    const fm = renderFrontmatter({ type: 'events/decision', title: '决定' });
    expect(fm).toMatch(/created_at: "\d{4}-\d{2}-\d{2}T/);
    expect(fm).toMatch(/updated_at: "\d{4}-\d{2}-\d{2}T/);
  });
});