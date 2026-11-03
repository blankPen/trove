import { describe, it, expect } from 'vitest';
import {
  buildProjectStats,
  pickRecentSessions,
  renderRecentList,
  recentInputHash,
} from '../../src/core/lessons/recent.js';
import type { LibraryIndex, MergedSession } from '../../src/core/library/schema.js';

function mkSession(over: Partial<MergedSession> = {}): MergedSession {
  const harness = over.harness ?? 'claude-code';
  const session = over.session ?? 's1';
  const variant = { device: 'dev', path: `sessions/${harness}/${session}/dev.jsonl`, hash: 'h', events: 1 };
  return {
    harness,
    session,
    canonical: variant,
    variants: [variant],
    sources: ['dev'],
    ...over,
  };
}

function mkIndex(sessions: MergedSession[]): LibraryIndex {
  const map: Record<string, MergedSession> = {};
  for (const s of sessions) map[`${s.harness}:${s.session}`] = s;
  return { v: 1, generatedAt: '2026-11-01T00:00:00Z', hash: 'x', sessions: map, skills: {} };
}

describe('pickRecentSessions', () => {
  it('按 startedAt 降序排列并截断到 limit', () => {
    const idx = mkIndex([
      mkSession({ session: 'old', startedAt: '2026-10-01T00:00:00Z' }),
      mkSession({ session: 'mid', startedAt: '2026-10-15T00:00:00Z' }),
      mkSession({ session: 'newest', startedAt: '2026-10-30T00:00:00Z' }),
    ]);
    const picked = pickRecentSessions(idx, 2);
    expect(picked.map((s) => s.session)).toEqual(['newest', 'mid']);
  });

  it('缺 startedAt 的排到末尾', () => {
    const idx = mkIndex([
      mkSession({ session: 'a', startedAt: '2026-10-01T00:00:00Z' }),
      mkSession({ session: 'b' }),
    ]);
    expect(pickRecentSessions(idx, 10).map((s) => s.session)).toEqual(['a', 'b']);
  });
});

describe('renderRecentList', () => {
  it('cwd 取尾两段、日期取年月日、主题用 firstText', () => {
    const idx = mkIndex([
      mkSession({
        session: 's1',
        startedAt: '2026-10-30T12:34:56Z',
        cwd: '/Users/admin/orca/trove',
        firstText: '帮我改一下 recent_matters 的聚合逻辑',
      }),
    ]);
    const list = renderRecentList(pickRecentSessions(idx));
    expect(list).toContain('- 2026-10-30 | orca/trove | 帮我改一下 recent_matters 的聚合逻辑');
  });

  it('cwd 为空显示(项目未知)', () => {
    const idx = mkIndex([mkSession({ session: 's1', startedAt: '2026-10-30T00:00:00Z', firstText: 'x' })]);
    expect(renderRecentList(pickRecentSessions(idx))).toContain('(项目未知)');
  });

  it('firstText 缺失回退 title', () => {
    const idx = mkIndex([
      mkSession({ session: 's1', startedAt: '2026-10-30T00:00:00Z', title: '排查 profile 缺失' }),
    ]);
    expect(renderRecentList(pickRecentSessions(idx))).toContain('| 排查 profile 缺失');
  });

  it('firstText 超长按码点截断到 100 字', () => {
    const idx = mkIndex([
      mkSession({ session: 's1', startedAt: '2026-10-30T00:00:00Z', firstText: '长'.repeat(150) }),
    ]);
    const topic = renderRecentList(pickRecentSessions(idx)).split('| ')[2]!.trim();
    expect(topic).toHaveLength(101); // 100 字 + 省略号
    expect(topic.endsWith('…')).toBe(true);
  });
});

describe('recentInputHash', () => {
  it('相同输入 hash 确定,顺序敏感', () => {
    const a = [mkSession({ session: 's1', startedAt: '2026-10-30T00:00:00Z' }), mkSession({ session: 's2', startedAt: '2026-10-29T00:00:00Z' })];
    const b = [mkSession({ session: 's1', startedAt: '2026-10-30T00:00:00Z' }), mkSession({ session: 's2', startedAt: '2026-10-29T00:00:00Z' })];
    const swapped = [b[1]!, b[0]!];
    expect(recentInputHash(a)).toBe(recentInputHash(b));
    expect(recentInputHash(a)).not.toBe(recentInputHash(swapped));
  });

  it('事件规模变化改变 hash', () => {
    const a = [mkSession({ session: 's1', startedAt: '2026-10-30T00:00:00Z' })];
    const b = [mkSession({
      session: 's1',
      startedAt: '2026-10-30T00:00:00Z',
      variants: [{ device: 'dev', path: 'sessions/claude-code/s1/dev.jsonl', hash: 'h', events: 5 }],
    })];
    expect(recentInputHash(a)).not.toBe(recentInputHash(b));
  });
});

describe('buildProjectStats', () => {
  it('按项目聚类统计会话数、事件数与首末时间', () => {
    const idx = mkIndex([
      mkSession({ session: 'a', cwd: '/Users/admin/orca/trove', startedAt: '2026-10-01T00:00:00Z' }),
      mkSession({ session: 'b', cwd: '/Users/admin/orca/trove', startedAt: '2026-10-20T00:00:00Z' }),
      mkSession({ session: 'c', cwd: '/Users/admin/du/other', startedAt: '2026-10-15T00:00:00Z' }),
    ]);
    const st = buildProjectStats(idx).get('orca/trove')!;
    expect(st.count).toBe(2);
    expect(st.first).toBe('2026-10-01T00:00:00Z');
    expect(st.last).toBe('2026-10-20T00:00:00Z');
    expect(st.events).toBe(2); // 每会话默认 1 事件
  });

  it('无 cwd 的会话不参与聚类', () => {
    const idx = mkIndex([mkSession({ session: 'a' })]);
    expect(buildProjectStats(idx).size).toBe(0);
  });
});

describe('renderRecentList 频繁度标注', () => {
  it('带 stats 时标注同类次数与事件数', () => {
    const idx = mkIndex([
      mkSession({ session: 's1', startedAt: '2026-10-30T00:00:00Z', cwd: '/Users/admin/orca/trove', firstText: 'x' }),
      mkSession({ session: 's2', startedAt: '2026-10-20T00:00:00Z', cwd: '/Users/admin/orca/trove', firstText: 'y' }),
    ]);
    const list = renderRecentList(pickRecentSessions(idx), buildProjectStats(idx));
    expect(list).toContain('同类 2 次');
    expect(list).toContain('事件 1 条');
  });
});