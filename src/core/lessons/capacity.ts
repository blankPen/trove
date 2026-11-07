/** 容量预算:经验按项目/全局、实体按类型、偏好 profile 按字节限制;写满返回可解释拒绝与淘汰建议。 */
import type { MemoryOp } from './merge.js';
import type { ExistingMemory } from './existing.js';
import { qualityTotal } from './memory.js';

export interface CapacityConfig {
  /** 单个项目 scope 最多经验数。 */
  experiencesPerProject: number;
  /** global scope 最多经验数。 */
  experiencesGlobal: number;
  /** preferences/profile 文件最大字节数。 */
  profileBytes: number;
  /** 同 type 实体最多数。 */
  entitiesPerType: number;
}

export interface CapacitySuggestion {
  path: string;
  title: string;
  score: number;
}

export interface CapacityDecision {
  ok: boolean;
  reason?: string;
  suggestions?: CapacitySuggestion[];
}

export const DEFAULT_CAPACITY: CapacityConfig = {
  experiencesPerProject: 120,
  experiencesGlobal: 600,
  profileBytes: 8192,
  entitiesPerType: 200,
};

/** 只对净新增的 add 生效:patch/append 不计,supersede(add+归档)净增 0 也不计。被拒绝的 op 转成 skip。 */
export function applyCapacity(
  ops: MemoryOp[],
  existing: ExistingMemory[],
  cfg: CapacityConfig,
): { ops: MemoryOp[]; rejected: Array<{ op: Extract<MemoryOp, { op: 'add' }>; decision: CapacityDecision }> } {
  // 本批 add(排除 supersede)按 scope/type 的增量,供「同 scope/type 的 add 数」计数。
  const addExp = new Map<string, number>();
  const addEnt = new Map<string, number>();
  for (const op of ops) {
    if (!isCountedAdd(op)) continue;
    const top = op.type.split('/')[0];
    if (top === 'experiences') addExp.set(scopeOf(op), (addExp.get(scopeOf(op)) ?? 0) + 1);
    else if (top === 'entities') addEnt.set(op.type, (addEnt.get(op.type) ?? 0) + 1);
  }

  const existingExp = new Map<string, number>();
  const existingEnt = new Map<string, number>();
  for (const e of existing) {
    const top = e.type.split('/')[0];
    if (top === 'experiences') {
      const scope = e.scope ?? 'global';
      existingExp.set(scope, (existingExp.get(scope) ?? 0) + 1);
    } else if (top === 'entities') {
      existingEnt.set(e.type, (existingEnt.get(e.type) ?? 0) + 1);
    }
  }

  const out: MemoryOp[] = [];
  const rejected: Array<{ op: Extract<MemoryOp, { op: 'add' }>; decision: CapacityDecision }> = [];
  for (const op of ops) {
    const decision = check(op);
    if (decision.ok) {
      out.push(op);
    } else if (isCountedAdd(op)) {
      rejected.push({ op, decision });
      out.push({ op: 'skip', type: op.type, title: op.title, reason: decision.reason! });
    } else {
      out.push(op); // 兜底:非 add 永不拒绝
    }
  }
  return { ops: out, rejected };

  function check(op: MemoryOp): CapacityDecision {
    if (!isCountedAdd(op)) return { ok: true };
    const top = op.type.split('/')[0];
    const scope = scopeOf(op);
    if (top === 'experiences') {
      const total = (addExp.get(scope) ?? 0) + (existingExp.get(scope) ?? 0);
      if (scope === 'global') {
        if (total > cfg.experiencesGlobal) {
          return { ok: false, reason: 'capacity_exceeded:experiences_global', suggestions: suggestExperiences(scope) };
        }
      } else if (total > cfg.experiencesPerProject) {
        return { ok: false, reason: 'capacity_exceeded:experiences_project', suggestions: suggestExperiences(scope) };
      }
    } else if (top === 'entities') {
      const total = (addEnt.get(op.type) ?? 0) + (existingEnt.get(op.type) ?? 0);
      if (total > cfg.entitiesPerType) {
        return { ok: false, reason: 'capacity_exceeded:entities_type', suggestions: suggestEntities(op.type) };
      }
    } else if (op.type === 'preferences/profile') {
      if (Buffer.byteLength(op.content, 'utf8') > cfg.profileBytes) {
        return { ok: false, reason: 'capacity_exceeded:profile_bytes' };
      }
    }
    return { ok: true };
  }

  function suggestExperiences(scope: string): CapacitySuggestion[] {
    return suggestions(existing.filter((e) => e.type.startsWith('experiences/') && (e.scope ?? 'global') === scope));
  }

  function suggestEntities(type: string): CapacitySuggestion[] {
    return suggestions(existing.filter((e) => e.type === type));
  }

  function suggestions(list: ExistingMemory[]): CapacitySuggestion[] {
    return list
      .map((e) => ({ path: e.path, title: e.title, score: evictScore(e) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
  }

  /** 淘汰优先级:质量低、用得少的先淘汰;无 quality 记 0。 */
  function evictScore(e: ExistingMemory): number {
    const q = e.quality;
    return (q ? qualityTotal(q) : 0) * (1 + (e.useCount ?? 0));
  }

  function scopeOf(op: Extract<MemoryOp, { op: 'add' }>): string {
    return op.meta?.scope ?? 'global';
  }

  function isCountedAdd(op: MemoryOp): op is Extract<MemoryOp, { op: 'add' }> {
    return op.op === 'add' && !op.archivePath && !op.supersedePath;
  }
}
