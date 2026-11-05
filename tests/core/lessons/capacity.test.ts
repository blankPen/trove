import { describe, it, expect } from 'vitest';
import { applyCapacity, DEFAULT_CAPACITY } from '../../../src/core/lessons/capacity.js';
import type { CapacityConfig } from '../../../src/core/lessons/capacity.js';
import type { MemoryOp } from '../../../src/core/lessons/merge.js';
import type { ExistingForGate } from '../../../src/core/lessons/gateway.js';

const cfg: CapacityConfig = { experiencesPerProject: 3, experiencesGlobal: 5, profileBytes: 8192, entitiesPerType: 2 };

function add(op: Partial<MemoryOp> & { scope?: string } = {}): MemoryOp {
  return {
    op: 'add',
    type: op.type ?? 'experiences/gotcha',
    path: op.path ?? 'experiences/g-1.md',
    title: '标题',
    content: op.content ?? '正文',
    evidence: [],
    meta: {
      id: 'exp_1',
      kind: 'experience',
      status: 'active',
      version: 1,
      evidence: [],
      ...(op.scope ? { scope: op.scope } : {}),
    },
    ...(op.archivePath ? { archivePath: op.archivePath } : {}),
    ...(op.supersedePath ? { supersedePath: op.supersedePath } : {}),
  };
}

function ex(over: Partial<ExistingForGate> = {}): ExistingForGate {
  return {
    path: over.path ?? 'experiences/e.md',
    title: over.title ?? '旧标题',
    content: '旧正文',
    type: over.type ?? 'experiences/gotcha',
    scope: over.scope ?? 'project:a',
    ...(over.quality ? { quality: over.quality } : {}),
    ...(over.useCount !== undefined ? { useCount: over.useCount } : {}),
  };
}

describe('applyCapacity(写满返回可解释结果)', () => {
  it('默认配置 120/600/8192/200', () => {
    expect(DEFAULT_CAPACITY).toEqual({ experiencesPerProject: 120, experiencesGlobal: 600, profileBytes: 8192, entitiesPerType: 200 });
  });

  it('项目 scope 经验满 → 拒绝 experiences_project', () => {
    const existing = [1, 2, 3].map((i) => ex({ path: `experiences/e${i}.md` }));
    const r = applyCapacity([add({ scope: 'project:a' })], existing, cfg);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.decision.reason).toBe('capacity_exceeded:experiences_project');
    expect(r.ops[0]!.op).toBe('skip');
    if (r.ops[0]!.op === 'skip') expect(r.ops[0]!.reason).toBe('capacity_exceeded:experiences_project');
  });

  it('全局经验满 → 拒绝 experiences_global', () => {
    const existing = [1, 2, 3, 4, 5].map((i) => ex({ path: `experiences/e${i}.md`, scope: 'global' }));
    const r = applyCapacity([add({ scope: 'global' })], existing, cfg);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.decision.reason).toBe('capacity_exceeded:experiences_global');
  });

  it('entities 同 type 满 → 拒绝 entities_type', () => {
    const existing = [ex({ type: 'entities/tool', path: 'entities/tools/a.md' }), ex({ type: 'entities/tool', path: 'entities/tools/b.md' })];
    const op = add({ type: 'entities/tool', path: 'entities/tools/c.md' });
    const r = applyCapacity([op], existing, cfg);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.decision.reason).toBe('capacity_exceeded:entities_type');
  });

  it('profile 超 8KB → 拒绝 profile_bytes', () => {
    const big = 'x'.repeat(9000);
    const op = add({ type: 'preferences/profile', path: 'preferences/profile.md', content: big });
    const r = applyCapacity([op], [], cfg);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.decision.reason).toBe('capacity_exceeded:profile_bytes');
  });

  it('patch 不计新增,原样保留', () => {
    const patch: MemoryOp = { op: 'patch', type: 'experiences/gotcha', path: 'experiences/g-1.md', title: '新', content: '新正文', before: '旧' };
    const r = applyCapacity([patch], [], { ...cfg, experiencesPerProject: 0 });
    expect(r.rejected).toHaveLength(0);
    expect(r.ops).toEqual([patch]);
  });

  it('supersede(add + archivePath)净增 0,不拒绝', () => {
    const r = applyCapacity([add({ archivePath: 'experiences/old.md' })], [], { ...cfg, experiencesPerProject: 0 });
    expect(r.rejected).toHaveLength(0);
    expect(r.ops[0]!.op).toBe('add');
  });

  it('拒绝时按 qualityTotal*(1+useCount) 升序给前 3 建议', () => {
    const q = { specific: 0.5, actionable: 0.5, transferable: 0.5, evidence: 0.5, non_duplicate: 0.5 }; // qualityTotal = 0.5
    const existing = [
      ex({ path: 'experiences/high.md', title: 'high', quality: q, useCount: 3 }), // 0.5*4 = 2.0
      ex({ path: 'experiences/mid.md', title: 'mid', quality: q, useCount: 0 }), // 0.5
      ex({ path: 'experiences/none.md', title: 'none' }), // 无 quality → 0
    ];
    const r = applyCapacity([add({ scope: 'project:a' })], existing, { ...cfg, experiencesPerProject: 0 });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.decision.suggestions!.map((s) => s.path)).toEqual([
      'experiences/none.md',
      'experiences/mid.md',
      'experiences/high.md',
    ]);
  });
});
