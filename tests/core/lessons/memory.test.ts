import { describe, it, expect } from 'vitest';
import { renderFrontmatter, parseFrontmatter } from '../../../src/core/lessons/frontmatter.js';
import {
  newMemoryId,
  inferKind,
  renderMemory,
  parseMemory,
  qualityTotal,
  type MemoryV2,
} from '../../../src/core/lessons/memory.js';

describe('newMemoryId', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it('前缀 + 26 字符,同 now/random 确定且字典序随时间递增', () => {
    const id = newMemoryId('exp_', now, () => 0.5);
    expect(id.startsWith('exp_')).toBe(true);
    expect(id.length).toBe('exp_'.length + 26);
    expect(id).toBe(newMemoryId('exp_', now, () => 0.5));

    const later = newMemoryId('exp_', new Date('2026-01-01T00:00:00.001Z'), () => 0);
    const earlier = newMemoryId('exp_', now, () => 0);
    expect(later > earlier).toBe(true);
  });

  it('同毫秒不同 random 仍唯一', () => {
    expect(newMemoryId('traj_', now, () => 0.5)).not.toBe(newMemoryId('traj_', now, () => 0.9));
  });
});

describe('inferKind', () => {
  it('按一级目录前缀映射六类 kind', () => {
    expect(inferKind('experiences/debug_pattern')).toBe('experience');
    expect(inferKind('preferences/profile')).toBe('preference');
    expect(inferKind('entities/tool')).toBe('entity');
    expect(inferKind('events/decision')).toBe('event');
    expect(inferKind('resources/doc')).toBe('resource');
    expect(inferKind('trajectories/capture')).toBe('trajectory');
  });
});

describe('renderMemory / parseMemory', () => {
  const full: MemoryV2 = {
    id: 'exp_000000000100000000000000',
    kind: 'experience',
    type: 'experiences/debug_pattern',
    title: '中文 "引号" 与\n换行',
    tags: ['a', 'b'],
    scope: 'project:trove',
    status: 'active',
    version: 2,
    confidence: 0.9,
    quality: { specific: 0.8, actionable: 0.7, transferable: 0.6, evidence: 0.9, non_duplicate: 0.5 },
    evidence: [{ session: 's1', seq: 3, quote: '报错 "ECONNRESET"', path: 'raw/x.jsonl', line: 10 }],
    sourceTrajectories: ['traj_1'],
    supersedes: 'exp_old',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastUsedAt: '2026-01-03T00:00:00.000Z',
    useCount: 5,
    helpfulCount: 2,
    promptVersion: 'exp-v3',
    pinned: false,
    body: '正文第一行\n第二行',
  };

  it('render→parse 全字段往返,evidence 空写 []', () => {
    expect(parseMemory(renderMemory(full))).toEqual(full);

    const noEvidence: MemoryV2 = { ...full, evidence: [], confidence: undefined, quality: undefined, supersedes: undefined, sourceTrajectories: undefined, lastUsedAt: undefined };
    const text = renderMemory(noEvidence);
    expect(text).toContain('evidence: []');
    expect(text).not.toContain('confidence:');
    expect(parseMemory(text)).toEqual({ ...noEvidence, lastUsedAt: undefined, confidence: undefined, quality: undefined, supersedes: undefined, sourceTrajectories: undefined });
  });

  it('旧 v1 文件 parseFrontmatter 与 parseMemory 都可读,缺 v2 字段补默认', () => {
    const v1 = renderFrontmatter({ type: 'experiences/gotcha', title: '旧坑', createdAt: '2026-01-01T00:00:00.000Z' }) + '\n旧正文\n';
    expect(parseFrontmatter(v1)).not.toBeNull();
    const m = parseMemory(v1)!;
    expect(m.type).toBe('experiences/gotcha');
    expect(m.id).toBe('');
    expect(m.kind).toBe('experience');
    expect(m.status).toBe('active');
    expect(m.version).toBe(1);
    expect(m.evidence).toEqual([]);
    expect(m.body).toContain('旧正文');
  });

  it('无 type 返回 null', () => {
    expect(parseMemory('---\ntitle: "x"\n---\n正文')).toBeNull();
    expect(parseMemory('没有 frontmatter')).toBeNull();
  });

  it('pinned:true 往返保留,未固定的文件不写该字段', () => {
    const pinned = renderMemory({ ...full, pinned: true });
    expect(pinned).toContain('pinned: true');
    expect(parseMemory(pinned)!.pinned).toBe(true);
    expect(renderMemory(full)).not.toContain('pinned:');
  });

  it('旧文件缺省 pinned=false', () => {
    const v1 = renderFrontmatter({ type: 'experiences/gotcha', title: '旧坑' }) + '\n旧正文\n';
    expect(parseMemory(v1)!.pinned).toBe(false);
  });
});

describe('qualityTotal', () => {
  it('按 0.20/0.20/0.15/0.30/0.15 加权求和', () => {
    expect(qualityTotal({ specific: 1, actionable: 1, transferable: 1, evidence: 1, non_duplicate: 1 })).toBe(1);
    expect(qualityTotal({ specific: 0.5, actionable: 0, transferable: 0, evidence: 0, non_duplicate: 0 })).toBeCloseTo(0.1);
  });
});
